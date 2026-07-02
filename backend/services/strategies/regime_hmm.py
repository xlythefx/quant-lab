"""
Causal Gaussian-HMM regime detection (Market Lab alternative to the rule-based
detector in regime.py).

Lives next to regime.py (neutral home) so Market Lab can import it without circular
deps. The model is implemented from scratch in numpy/scipy/sklearn — NOT hmmlearn,
which has no prebuilt wheel for Python 3.14. This is a productionized copy of the
validated sandbox in experiments/hmm_regime/ (that folder stays standalone).

CAUSAL by construction — a bar's label uses only data up to that bar:
  * features are trailing-window only (trend slope, realized vol, rolling Hurst);
  * the HMM is re-fit on a rolling trailing window every `refit_every` bars
    (feature standardization re-fit per window too);
  * labels are the argmax of the FILTERED posterior P(state | obs<=i) — forward
    recursion only, no backward/smoothing pass that would peek at the future;
  * each refit's states are relabeled into canonical (ascending-mean-trend) order so
    state identity is stable across refits and the running belief carries over;
  * refits warm-start from the previous model -> converge in a few EM iterations.

Public entry: causal_hmm_labels(df, params) -> dict consumed by market_lab.
"""
from __future__ import annotations

import numpy as np
from scipy.special import logsumexp

FEATURE_NAMES = ["trend", "rv20", "hurst"]
_LOG_2PI = float(np.log(2.0 * np.pi))


# --------------------------------------------------------------------------- #
# Defaults (1h-tuned; all overridable via params)
# --------------------------------------------------------------------------- #
def hmm_params(params: dict) -> dict:
    p = params or {}

    def _g(key, default, cast):
        v = p.get(key)
        if v is None:
            return default
        try:
            return cast(v)
        except (TypeError, ValueError):
            return default

    return {
        "n_states": max(2, min(6, _g("n_states", 5, int))),
        "trend_window": _g("trend_window", 36, int),
        "rv_window": _g("rv_window", 20, int),
        "hurst_window": _g("hurst_window", 250, int),
        "train_window": _g("train_window", 4380, int),    # ~6mo of 1h bars
        "refit_every": _g("refit_every", 1080, int),       # ~6 weeks
        "warmup": _g("warmup", 2160, int),
        "expanding": bool(p.get("expanding", False)),
        "seed": _g("seed", 42, int),
        "n_iter": _g("n_iter", 25, int),       # low: refits warm-start from prev model
        # --- mood naming (display only; does not affect the fit) ---
        # A state is "Ranging" when its directional drift is weak relative to its
        # noise: |trend / rv| < ranging_ratio. Both are ~%/bar so the ratio is
        # scale-free across symbols/timeframes.
        "ranging_ratio": max(0.0, _g("ranging_ratio", 0.10, float)),
        # A bar is "Undecided" when the filtered-posterior confidence in its
        # best state is below this. 0 disables it.
        "undecided_below": min(1.0, max(0.0, _g("undecided_below", 0.5, float))),
    }


# --------------------------------------------------------------------------- #
# Causal features
# --------------------------------------------------------------------------- #
def _rolling_slope(close: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling linreg slope of close, normalized to %/bar (mirrors regime.py)."""
    c = np.asarray(close, dtype=float)
    n = c.size
    out = np.full(n, np.nan)
    if n < window:
        return out
    x = np.arange(window, dtype=float)
    x_dev = x - x.mean()
    x_ss = float(np.dot(x_dev, x_dev))
    for i in range(window - 1, n):
        win = c[i - window + 1: i + 1]
        beta = float(np.dot(x_dev, win - win.mean())) / x_ss if x_ss > 0 else 0.0
        out[i] = (beta / win[-1]) if win[-1] > 0 else 0.0
    return out


def _rolling_hurst(log_ret: np.ndarray, window: int) -> np.ndarray:
    """Causal rolling Hurst exponent via R/S analysis over a trailing window."""
    x = np.asarray(log_ret, dtype=float)
    n = x.size
    out = np.full(n, np.nan)
    if window < 16 or n < window:
        return out
    sizes = []
    s = 8
    while s <= window:
        sizes.append(s)
        s *= 2
    if len(sizes) < 2:
        sizes = [window // 2, window]
    for end in range(window - 1, n):
        seg = x[end - window + 1: end + 1]
        rs_vals, ok_sizes = [], []
        for size in sizes:
            n_chunks = window // size
            if n_chunks < 1:
                continue
            rs_chunk = []
            for k in range(n_chunks):
                chunk = seg[k * size: (k + 1) * size]
                dev = np.cumsum(chunk - chunk.mean())
                R = dev.max() - dev.min()
                S = chunk.std()
                if S > 0 and np.isfinite(R):
                    rs_chunk.append(R / S)
            if rs_chunk:
                rs_vals.append(np.mean(rs_chunk))
                ok_sizes.append(size)
        if len(rs_vals) >= 2:
            out[end] = float(np.polyfit(np.log(ok_sizes), np.log(rs_vals), 1)[0])
    return out


def _build_features(df, p):
    """Return (times, close, F) where F is the RAW (n, 3) causal feature matrix,
    with warmup NaN rows dropped. times/close are aligned to F."""
    close = df["close"].to_numpy(dtype=float)
    time_a = df["time"].to_numpy()
    lr = np.diff(np.log(close))                          # aligned to bars[1:]
    import pandas as pd
    rv = pd.Series(lr).rolling(p["rv_window"]).std().to_numpy()
    hurst = _rolling_hurst(lr, p["hurst_window"])
    trend = _rolling_slope(close, p["trend_window"])[1:]

    feat = pd.DataFrame({
        "time": time_a[1:], "close": close[1:],
        "trend": trend, "rv20": rv, "hurst": hurst,
    }).dropna().reset_index(drop=True)
    F = feat[FEATURE_NAMES].to_numpy(dtype=float)
    return feat["time"].to_numpy(), feat["close"].to_numpy(dtype=float), F


# --------------------------------------------------------------------------- #
# From-scratch Gaussian HMM (Baum-Welch), with optional warm-start init
# --------------------------------------------------------------------------- #
def _lse(a, axis):
    amax = np.max(a, axis=axis, keepdims=True)
    amax = np.where(np.isfinite(amax), amax, 0.0)
    return np.log(np.sum(np.exp(a - amax), axis=axis)) + np.squeeze(amax, axis=axis)


class GaussianHMM:
    def __init__(self, n_components, n_iter=60, tol=1e-4, seed=42, reg=1e-6):
        self.n_components = n_components
        self.n_iter = n_iter
        self.tol = tol
        self.seed = seed
        self.reg = reg

    def _log_emission(self, X):
        n, d = X.shape
        out = np.empty((n, self.n_components))
        eye = self.reg * np.eye(d)
        for k in range(self.n_components):
            cov = self.covars_[k] + eye
            _s, logdet = np.linalg.slogdet(cov)
            inv = np.linalg.inv(cov)
            diff = X - self.means_[k]
            maha = np.einsum("ni,ij,nj->n", diff, inv, diff)
            out[:, k] = -0.5 * (d * _LOG_2PI + logdet + maha)
        return out

    def _init(self, X, init=None):
        n, d = X.shape
        k = self.n_components
        if init is not None:
            self.means_ = init["means"].copy()
            self.covars_ = init["covars"].copy()
            self.transmat_ = init["transmat"].copy()
            self.startprob_ = init["startprob"].copy()
            return
        from sklearn.cluster import KMeans
        km = KMeans(n_clusters=k, n_init=10, random_state=self.seed).fit(X)
        self.means_ = km.cluster_centers_.copy()
        self.covars_ = np.empty((k, d, d))
        for j in range(k):
            pts = X[km.labels_ == j]
            self.covars_[j] = np.cov(pts.T) if len(pts) > d else np.cov(X.T)
        self.transmat_ = np.full((k, k), 0.1 / max(k - 1, 1))
        np.fill_diagonal(self.transmat_, 0.9)
        self.startprob_ = np.full(k, 1.0 / k)

    def _forward_backward(self, log_e, log_t, log_pi):
        n, k = log_e.shape
        log_tT = log_t.T
        log_alpha = np.empty((n, k))
        log_alpha[0] = log_pi + log_e[0]
        for t in range(1, n):
            log_alpha[t] = log_e[t] + _lse(log_tT + log_alpha[t - 1], axis=1)
        log_beta = np.zeros((n, k))
        for t in range(n - 2, -1, -1):
            log_beta[t] = _lse(log_t + (log_e[t + 1] + log_beta[t + 1]), axis=1)
        loglik = float(logsumexp(log_alpha[-1]))
        log_gamma = log_alpha + log_beta - loglik
        return log_alpha, log_beta, log_gamma, loglik

    def fit(self, X, init=None):
        X = np.asarray(X, dtype=float)
        n, d = X.shape
        self._init(X, init)
        prev = -np.inf
        for _ in range(self.n_iter):
            log_t = np.log(self.transmat_ + 1e-300)
            log_pi = np.log(self.startprob_ + 1e-300)
            log_e = self._log_emission(X)
            log_alpha, log_beta, log_gamma, loglik = self._forward_backward(log_e, log_t, log_pi)
            gamma = np.exp(log_gamma)
            log_xi = (log_alpha[:-1, :, None] + log_t[None, :, :]
                      + (log_e[1:] + log_beta[1:])[:, None, :] - loglik)
            xi_sum = np.exp(log_xi).sum(axis=0)
            self.startprob_ = gamma[0] / gamma[0].sum()
            self.transmat_ = xi_sum / xi_sum.sum(axis=1, keepdims=True).clip(1e-300)
            gsum = gamma.sum(axis=0).clip(1e-300)
            self.means_ = (gamma.T @ X) / gsum[:, None]
            for k in range(self.n_components):
                diff = X - self.means_[k]
                self.covars_[k] = (gamma[:, k][:, None] * diff).T @ diff / gsum[k]
            if loglik - prev < self.tol:
                break
            prev = loglik
        return self


def _order_states(means_scaled):
    return np.lexsort((means_scaled[:, 1], means_scaled[:, 0]))   # by trend, then vol


# Fixed, human-readable mood taxonomy. Two states that land in the same bucket
# are MERGED into one mood (see causal_hmm_labels) — no "#1/#2" suffixes. Listed
# bearish -> ranging -> bullish so legends read in a sensible order.
ORDER = [
    "Bearish Volatile", "Bearish Normal", "Ranging",
    "Bullish Normal", "Bullish Volatile",
]


def _mood_label(mean, rv_median, ranging_ratio):
    """Name one state from its RAW per-state feature means.

    Direction comes from a drift-to-noise ratio r = trend / rv (both ~%/bar, so
    r is scale-free): |r| < ranging_ratio -> "Ranging", else Bullish/Bearish by
    sign. Volatility is a 2-level split vs the cross-state median rv. "Ranging"
    carries no volatility qualifier. Hurst is intentionally NOT used (its R/S
    estimate is biased high, which made every state read "trending").
    """
    trend, rv = float(mean[0]), float(mean[1])
    r = trend / rv if rv > 1e-9 else 0.0
    if abs(r) < ranging_ratio:
        return "Ranging"
    direction = "Bullish" if trend > 0 else "Bearish"
    risk = "Volatile" if rv >= rv_median else "Normal"
    return f"{direction} {risk}"


def _fit_canonical(X_scaled, k, seed, n_iter, init=None, reg=1e-6):
    m = GaussianHMM(n_components=k, n_iter=n_iter, seed=seed, reg=reg).fit(X_scaled, init=init)
    order = _order_states(m.means_)
    means = m.means_[order]
    covars = m.covars_[order]
    # Precompute emission constants once per refit (reused for every bar's filter
    # step) — inverting covariances per-bar is the avoidable cost.
    d = X_scaled.shape[1]
    eye = reg * np.eye(d)
    inv = np.empty_like(covars)
    logdet = np.empty(k)
    for j in range(k):
        cov = covars[j] + eye
        _s, logdet[j] = np.linalg.slogdet(cov)
        inv[j] = np.linalg.inv(cov)
    return {
        "means": means, "covars": covars,
        "transmat": m.transmat_[np.ix_(order, order)],
        "startprob": m.startprob_[order],
        "inv": inv, "logdet": logdet,
    }


def _emit_point(x, active):
    """log N(x; mu_k, Sigma_k) per state, using the active model's cached inv/logdet."""
    means, inv, logdet = active["means"], active["inv"], active["logdet"]
    d = x.size
    k = means.shape[0]
    out = np.empty(k)
    for j in range(k):
        diff = x - means[j]
        out[j] = -0.5 * (d * _LOG_2PI + float(diff @ inv[j] @ diff) + logdet[j])
    return out


# --------------------------------------------------------------------------- #
# Public: causal labels
# --------------------------------------------------------------------------- #
def causal_hmm_labels(df, params=None, on_progress=None) -> dict:
    """Causal per-bar HMM regime labels for the given OHLC DataFrame.

    Returns dict: times, close (aligned arrays), labels (str per bar; pre-fit bars
    -> "Warmup", low-confidence bars -> "Undecided"), confidence (max filtered
    posterior), state_labels (the distinct merged moods present, canonically
    ordered — may be fewer than n_states), state_means (len(state_labels), 3) and
    pct_time (len(state_labels),) aligned 1:1 with state_labels, n_refits, params.

    on_progress(done, total): optional callback fired after each rolling refit so
    callers can report progress during the (slow) fit. `total` is an estimate of
    the number of refits. Pure otherwise (no I/O); the model still self-learns.
    """
    p = hmm_params(params)
    k = p["n_states"]
    times, close, F = _build_features(df, p)
    n = len(F)
    if n < max(p["warmup"] + p["refit_every"], 500):
        raise ValueError(
            f"insufficient data for causal HMM: {n} usable bars after feature warmup "
            f"(need >= warmup+refit_every). Widen the date range or lower warmup/windows."
        )

    # Estimated total refits, for the progress callback (the loop refits every
    # `refit_every` bars starting at `warmup`).
    total_refits = max(1, 1 + (n - 1 - p["warmup"]) // p["refit_every"]) if n > p["warmup"] else 1

    states = np.full(n, -1, dtype=int)
    conf = np.full(n, np.nan)
    active = None
    prev_canon = None          # warm-start seed for the next refit
    sc_mean = sc_std = None
    running = None
    n_refits = 0
    next_refit = p["warmup"]

    for i in range(n):
        if i >= p["warmup"] and i >= next_refit:
            lo = 0 if p["expanding"] else max(0, i - p["train_window"] + 1)
            train = F[lo:i + 1]
            mu = train.mean(axis=0)
            sd = train.std(axis=0)
            sd[sd == 0] = 1.0
            active = _fit_canonical((train - mu) / sd, k, p["seed"], p["n_iter"], init=prev_canon)
            prev_canon = active
            sc_mean, sc_std = mu, sd
            n_refits += 1
            next_refit = i + p["refit_every"]
            if on_progress is not None:
                try:
                    on_progress(n_refits, total_refits)
                except Exception:
                    pass  # progress reporting must never break the fit
        if active is None:
            continue
        x = (F[i] - sc_mean) / sc_std
        log_e = _emit_point(x, active)
        if running is None:
            log_alpha = np.log(active["startprob"] + 1e-300) + log_e
        else:
            log_t = np.log(active["transmat"] + 1e-300)
            log_alpha = log_e + _lse(log_t.T + running, axis=1)
        log_alpha = log_alpha - _lse(log_alpha[None, :], axis=1)[0]
        running = log_alpha
        pr = np.exp(log_alpha)
        conf[i] = float(pr.max())
        states[i] = int(np.argmax(pr))

    # --- per-state signatures (over labeled bars) ---
    labeled = states >= 0
    total = int(labeled.sum())
    counts = np.zeros(k, dtype=int)
    means = np.zeros((k, F.shape[1]))
    pct = np.zeros(k)
    for s in range(k):
        m = states == s
        counts[s] = int(m.sum())
        pct[s] = counts[s] / total if total else 0.0
        if m.any():
            means[s] = F[m].mean(axis=0)

    # --- name each state, then MERGE states sharing a mood into one bucket ---
    # Drift/vol naming uses the cross-state median rv as the Normal|Volatile split.
    rv_median = float(np.median(means[:, 1])) if k else 0.0
    per_state_name = [_mood_label(means[s], rv_median, p["ranging_ratio"]) for s in range(k)]

    # Aggregate per mood: bar-count-weighted means, summed pct (exact — shared
    # denominator `total`). Empty buckets (0 bars) are dropped so a never-visited
    # state can't pollute the legend. Output is canonically ordered + aligned 1:1.
    bucket_bars = {}
    bucket_msum = {}
    bucket_pct = {}
    for s in range(k):
        name = per_state_name[s]
        bucket_bars[name] = bucket_bars.get(name, 0) + counts[s]
        bucket_msum[name] = bucket_msum.get(name, np.zeros(F.shape[1])) + counts[s] * means[s]
        bucket_pct[name] = bucket_pct.get(name, 0.0) + pct[s]

    state_labels = [name for name in ORDER if bucket_bars.get(name, 0) > 0]
    state_means = np.array(
        [bucket_msum[name] / bucket_bars[name] for name in state_labels]
    ) if state_labels else np.zeros((0, F.shape[1]))
    pct_time = np.array([bucket_pct[name] for name in state_labels])

    # Per-bar labels carry the merged mood name (or "Warmup" before the first fit).
    per_bar = np.array(
        [per_state_name[s] if s >= 0 else "Warmup" for s in states], dtype=object)

    # "Undecided" overlay: low-confidence bars. Applied to the per-bar labels ONLY
    # (never to `states`), so per-state stats are computed exactly as before — the
    # same way "Warmup" is excluded. Disabled when undecided_below == 0.
    ub = p["undecided_below"]
    if ub > 0:
        und = (states >= 0) & (conf < ub)
        per_bar[und] = "Undecided"

    return {
        "times": times,
        "close": close,
        "labels": per_bar,
        "confidence": conf,
        "state_labels": state_labels,
        "state_means": state_means,
        "pct_time": pct_time,
        "n_refits": n_refits,
        "params": p,
    }
