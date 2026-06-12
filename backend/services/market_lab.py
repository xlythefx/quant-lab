"""
Market Lab — read-only structural analysis of historical OHLC.

Three transparent, no-ML modules answering "what is the market itself doing?",
independent of any strategy or trades:

  1. classify_regimes()    — label each bar's regime (trend/vol) + forward-return / transition stats
  2. forecast_volatility() — realized vol, clustering, honest EWMA/persistence forecast + skill
  3. explore_statistics()  — day/hour return patterns (UTC), autocorrelation, distribution, conditional stats

Design rules (kept deliberately honest so the numbers can be trusted and the user
learns the foundations rather than overfitting a black box):
  - All features are CAUSAL: a value at bar i uses only bars <= i (rolling windows).
    The regime ribbon is therefore not look-ahead-biased.
  - Regime thresholds are DESCRIPTIVE percentiles of the in-sample window — they are
    self-normalizing per symbol/timeframe and are NOT optimized against forward returns.
  - No arch/statsmodels (not installed): ACF / EWMA / vol math is hand-rolled numpy/scipy.
  - Every float in the response passes through quant_metrics._safe so nan/inf can never
    break JSON serialization.

All three functions return plain JSON-serializable dicts and are called synchronously
from routes/market_lab_routes.py (fast vectorized passes — no threads/sockets/jobs).
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
from scipy import stats

from services import market_data
from services import black_scholes
from services.quant_metrics import infer_bars_per_year, _safe
# Five-regime classifier lives in strategies/regime.py (neutral home) so both
# Market Lab and tradeable strategies share one causal implementation.
from services.strategies.regime import REGIME_LABELS, _regime_params, _regime_labels, _calc_adx

MIN_BARS = 50
MAX_SERIES_POINTS = 800  # cap on returned time-series length (payload safety)


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #
def _load_window(symbol: str, timeframe: str, start, end) -> pd.DataFrame:
    """Load parquet and slice to [start, end]. Raises ValueError if too few bars."""
    df = market_data.load_parquet(symbol, timeframe)
    if start is not None:
        df = df[df["time"] >= int(start)]
    if end is not None:
        df = df[df["time"] <= int(end)]
    df = df.reset_index(drop=True)
    if len(df) < MIN_BARS:
        raise ValueError(
            f"insufficient data: {len(df)} bars in window (need >= {MIN_BARS}). "
            "Widen the date range or pick a smaller timeframe."
        )
    return df


def _log_returns(close: np.ndarray) -> np.ndarray:
    """Bar-to-bar log returns; ret[i] is the return INTO bar i+1. Length N-1."""
    c = np.asarray(close, dtype=float)
    return np.diff(np.log(c))


def _downsample(times: np.ndarray, values: np.ndarray, cap: int = MAX_SERIES_POINTS):
    """Stride a (time, value) series down to <= cap points for a bounded payload."""
    n = len(times)
    if n <= cap:
        idx = range(n)
    else:
        step = int(np.ceil(n / cap))
        idx = range(0, n, step)
    return [
        {"time": int(times[i]), "value": _safe(values[i])}
        for i in idx
        if np.isfinite(values[i])
    ]


def _acf(x: np.ndarray, max_lag: int) -> list[dict]:
    """Sample autocorrelation at lags 1..max_lag (numpy, no statsmodels)."""
    x = np.asarray(x, dtype=float)
    out = []
    n = x.size
    if n < 3:
        return [{"lag": k, "acf": None} for k in range(1, max_lag + 1)]
    xm = x - x.mean()
    denom = float(np.dot(xm, xm))
    for k in range(1, max_lag + 1):
        if k >= n or denom <= 0:
            out.append({"lag": k, "acf": None})
            continue
        num = float(np.dot(xm[:-k], xm[k:]))
        out.append({"lag": k, "acf": _safe(num / denom)})
    return out


def _meta(symbol, timeframe, df, extra=None) -> dict:
    time_a = df["time"].to_numpy()
    m = {
        "symbol": symbol,
        "timeframe": timeframe,
        "bars": int(len(df)),
        "first_time": int(time_a[0]),
        "last_time": int(time_a[-1]),
        "bars_per_year": _safe(infer_bars_per_year(time_a)),
    }
    if extra:
        m.update(extra)
    return m


def _p(params: dict, key: str, default):
    """Read an optional numeric param with a fallback default."""
    if not params or params.get(key) is None:
        return default
    try:
        return type(default)(params[key])
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Module 1 — Regime Classifier
# --------------------------------------------------------------------------- #
def classify_regimes(symbol, timeframe, start, end, params=None) -> dict:
    params = params or {}
    rp = _regime_params(params)
    fwd_horizon = max(1, _p(params, "fwd_horizon", 1))

    df = _load_window(symbol, timeframe, start, end)
    time_a = df["time"].to_numpy()
    c = df["close"].to_numpy(dtype=float)
    n = len(df)
    labels = _regime_labels(df, rp)
    # Smoothing (smooth_bars > 1) merges short runs into their longer neighbor —
    # including the NEXT one — so smoothed labels are NOT causal. They're fine
    # for the display ribbon, but forward-return / transition stats must use the
    # raw causal labels or the honesty guarantee is broken.
    if int(rp.get("smooth_bars") or 0) > 1:
        labels_stats = _regime_labels(df, {**rp, "smooth_bars": 0})
    else:
        labels_stats = labels

    # --- Run-length-encode into ribbon segments ---
    segments = []
    seg_start = 0
    for i in range(1, n + 1):
        if i == n or labels[i] != labels[seg_start]:
            segments.append({
                "regime": labels[seg_start],
                "start_time": int(time_a[seg_start]),
                "end_time": int(time_a[i - 1]),
                "bars": int(i - seg_start),
            })
            seg_start = i

    # --- Distribution: % of time in each regime ---
    distribution = []
    for lab in REGIME_LABELS:
        cnt = int(np.sum(labels == lab))
        distribution.append({
            "regime": lab,
            "bars": cnt,
            "pct_time": _safe(100.0 * cnt / n) if n else 0.0,
        })

    # --- Forward returns conditioned on current regime (CAUSAL labels) ---
    # fwd[i] = close[i+h]/close[i] - 1, defined for i < n-h (drop last h: no look-ahead).
    forward_returns = []
    if n > fwd_horizon:
        fwd = c[fwd_horizon:] / c[:-fwd_horizon] - 1.0  # length n-h, aligned to bar i
        lab_valid = labels_stats[: n - fwd_horizon]
        for lab in REGIME_LABELS:
            mask = lab_valid == lab
            vals = fwd[mask]
            if vals.size:
                forward_returns.append({
                    "regime": lab,
                    "n": int(vals.size),
                    "avg_fwd_return_pct": _safe(100.0 * float(vals.mean())),
                    "median_fwd_return_pct": _safe(100.0 * float(np.median(vals))),
                    "win_rate": _safe(100.0 * float(np.mean(vals > 0))),
                })
            else:
                forward_returns.append({
                    "regime": lab, "n": 0,
                    "avg_fwd_return_pct": None, "median_fwd_return_pct": None, "win_rate": None,
                })

    # --- Transition matrix + average run duration per regime (causal labels) ---
    transitions = {lab: {l2: 0 for l2 in REGIME_LABELS} for lab in REGIME_LABELS}
    n_transitions = 0
    for i in range(1, n):
        a, b = labels_stats[i - 1], labels_stats[i]
        if a != b:
            transitions[a][b] += 1
            n_transitions += 1
    durations = {lab: [] for lab in REGIME_LABELS}
    for seg in segments:
        durations[seg["regime"]].append(seg["bars"])
    avg_duration_bars = {
        lab: _safe(float(np.mean(d))) if d else None for lab, d in durations.items()
    }

    return {
        "segments": segments,
        "last_regime": str(labels[-1]),
        "price": _downsample(time_a, c),  # [{time, value=close}] for ribbon alignment
        "distribution": distribution,
        "forward_returns": forward_returns,
        "transitions": {
            "matrix": transitions,
            "n_transitions": int(n_transitions),
            "avg_duration_bars": avg_duration_bars,
        },
        "meta": _meta(symbol, timeframe, df, {
            "method": {
                **rp,
                "fwd_horizon": fwd_horizon,
                "note": "Thresholds are descriptive percentiles, not optimized. All features "
                        "are causal: volatility is ranked within a trailing lookback window, so "
                        "a bar's label does not depend on the display range. Increase smooth_bars "
                        "to merge short regime runs and reduce flicker.",
            },
            "labels": REGIME_LABELS,
        }),
    }


# --------------------------------------------------------------------------- #
# Module 1b — Causal HMM Regime Classifier (data-driven alternative)
# --------------------------------------------------------------------------- #
_HMM_CACHE = {}          # bounded LRU-ish cache: fitting the HMM is slow (~10-30s)
_HMM_CACHE_MAX = 8


def classify_regimes_hmm(symbol, timeframe, start, end, params=None) -> dict:
    """Same response shape as classify_regimes(), but regimes come from a causal
    Gaussian HMM (rolling refit + online filtering) instead of the rule tree.

    Labels are the HMM's auto-named states (e.g. "Bull/Calm (trending)"). The first
    ~warmup bars are unlabeled ("Warmup"). The fit is causal, so forward-return stats
    are honest (no look-ahead). Results are cached because the fit is slow.
    See services/strategies/regime_hmm.py.
    """
    import json
    from services.strategies.regime_hmm import causal_hmm_labels

    params = params or {}
    fwd_horizon = max(1, _p(params, "fwd_horizon", 1))
    edge_horizon = max(1, _p(params, "edge_horizon", 10))

    key = json.dumps([symbol, timeframe, start, end, params], sort_keys=True, default=str)
    if key in _HMM_CACHE:
        return _HMM_CACHE[key]

    df = _load_window(symbol, timeframe, start, end)
    # Bound the work: the causal rolling-refit HMM is O(bars × refits), so a 250k-bar
    # 15m range would take many minutes and time out. Cap to the most-recent N bars
    # (the rolling refit means recent structure dominates anyway). Configurable.
    available_bars = len(df)
    max_bars = max(2000, _p(params, "max_bars", 15000))
    capped = available_bars > max_bars
    if capped:
        df = df.tail(max_bars).reset_index(drop=True)
    res = causal_hmm_labels(df, params)
    time_a = res["times"]
    c = res["close"].astype(float)
    labels = res["labels"]                 # per-bar str ("Warmup" before first fit)
    state_labels = res["state_labels"]     # ordered real-regime labels
    n = len(labels)

    # --- RLE into ribbon segments (Warmup included so the ribbon spans all bars) ---
    segments = []
    seg_start = 0
    for i in range(1, n + 1):
        if i == n or labels[i] != labels[seg_start]:
            segments.append({
                "regime": str(labels[seg_start]),
                "start_time": int(time_a[seg_start]),
                "end_time": int(time_a[i - 1]),
                "bars": int(i - seg_start),
            })
            seg_start = i

    # --- Distribution over the real (non-warmup) regimes ---
    labeled = labels != "Warmup"
    n_labeled = int(labeled.sum())
    distribution = []
    for lab in state_labels:
        cnt = int(np.sum(labels == lab))
        distribution.append({
            "regime": lab, "bars": cnt,
            "pct_time": _safe(100.0 * cnt / n_labeled) if n_labeled else 0.0,
        })

    # --- Forward returns conditioned on the (causal) regime ---
    forward_returns = []
    if n > fwd_horizon:
        fwd = c[fwd_horizon:] / c[:-fwd_horizon] - 1.0
        lab_valid = labels[: n - fwd_horizon]
        for lab in state_labels:
            vals = fwd[lab_valid == lab]
            if vals.size:
                forward_returns.append({
                    "regime": lab, "n": int(vals.size),
                    "avg_fwd_return_pct": _safe(100.0 * float(vals.mean())),
                    "median_fwd_return_pct": _safe(100.0 * float(np.median(vals))),
                    "win_rate": _safe(100.0 * float(np.mean(vals > 0))),
                })
            else:
                forward_returns.append({
                    "regime": lab, "n": 0, "avg_fwd_return_pct": None,
                    "median_fwd_return_pct": None, "win_rate": None})

    # --- Per-regime LONG vs SHORT directional edge over `edge_horizon` bars ---
    # Honest "which side works in which regime": the return to going long (or short)
    # in a regime, measured vs the symbol's unconditional drift (so a trending
    # symbol's drift can't masquerade as a regime edge), with a one-sided t-test.
    # Causal labels -> these stats are not look-ahead-biased. In-sample though:
    # use them to NARROW what you then confirm in Walk-Forward.
    side_edge = []
    if n > edge_horizon:
        efwd = c[edge_horizon:] / c[:-edge_horizon] - 1.0      # aligned to bar i
        elab = labels[: n - edge_horizon]
        emask = elab != "Warmup"
        drift = float(np.mean(efwd[emask])) if emask.any() else 0.0
        for lab in state_labels:
            f = efwd[elab == lab]
            side_edge.append({
                "regime": lab,
                "n": int(f.size),
                "long": _edge_stats(f, drift),      # go long in this regime
                "short": _edge_stats(-f, -drift),   # go short in this regime
            })

    # --- Transition matrix + durations over real regimes (skip Warmup edges) ---
    transitions = {a: {b: 0 for b in state_labels} for a in state_labels}
    n_transitions = 0
    for i in range(1, n):
        a, b = labels[i - 1], labels[i]
        if a in transitions and b in transitions[a] and a != b:
            transitions[a][b] += 1
            n_transitions += 1
    durations = {lab: [] for lab in state_labels}
    for seg in segments:
        if seg["regime"] in durations:
            durations[seg["regime"]].append(seg["bars"])
    avg_duration_bars = {
        lab: _safe(float(np.mean(d))) if d else None for lab, d in durations.items()}

    # --- OHLC candles (for the lightweight-charts candle view), capped for payload.
    # Aligned to the feature-valid bars; regime label attached for band coloring.
    candle_limit = max(500, _p(params, "candle_limit", 4000))
    csub = df.set_index("time").reindex(time_a)
    o = csub["open"].to_numpy(dtype=float)
    h = csub["high"].to_numpy(dtype=float)
    lo_ = csub["low"].to_numpy(dtype=float)
    cl = csub["close"].to_numpy(dtype=float)
    cstart = max(0, n - candle_limit)
    candles = [
        {"time": int(time_a[i]), "open": _safe(float(o[i])), "high": _safe(float(h[i])),
         "low": _safe(float(lo_[i])), "close": _safe(float(cl[i])), "regime": str(labels[i])}
        for i in range(cstart, n)
    ]

    # --- Per-state signature (trend / vol / Hurst means) for the HMM tab ---
    state_means = res["state_means"]
    states_info = []
    for s, lab in enumerate(state_labels):
        m = state_means[s]
        states_info.append({
            "regime": lab,
            "pct_time": _safe(100.0 * float(res["pct_time"][s])),
            "trend": _safe(float(m[0])),
            "rv20": _safe(float(m[1])),
            "hurst": _safe(float(m[2])),
            "avg_duration_bars": avg_duration_bars.get(lab),
        })

    result = {
        "segments": segments,
        "last_regime": str(labels[-1]),
        "price": _downsample(time_a, c),
        "confidence_series": _downsample(time_a, res["confidence"]),
        "candles": candles,
        "states": states_info,
        "distribution": distribution,
        "forward_returns": forward_returns,
        "side_edge": side_edge,
        "edge_horizon": edge_horizon,
        "transitions": {
            "matrix": transitions, "n_transitions": int(n_transitions),
            "avg_duration_bars": avg_duration_bars,
        },
        "meta": _meta(symbol, timeframe, df, {
            "method": {
                **{k: v for k, v in res["params"].items()},
                "fwd_horizon": fwd_horizon,
                "edge_horizon": edge_horizon,
                "n_refits": res["n_refits"],
                "warmup_bars": int(n - n_labeled),
                "analyzed_bars": int(len(df)),
                "available_bars": int(available_bars),
                "capped": bool(capped),
                "max_bars": int(max_bars),
                "avg_confidence": _safe(float(np.nanmean(res["confidence"]))),
                "engine": "causal Gaussian HMM (rolling refit + online filtering)",
                "note": "Data-driven regimes from a causal Gaussian HMM: re-fit on a "
                        "trailing window and labeled by the FILTERED posterior (no "
                        "look-ahead), so forward-return stats are honest. State names are "
                        "auto-derived from each state's trend/vol/Hurst signature. The first "
                        "~warmup bars are unlabeled while the first model trains.",
            },
            "labels": state_labels,
        }),
    }
    if len(_HMM_CACHE) >= _HMM_CACHE_MAX:
        _HMM_CACHE.pop(next(iter(_HMM_CACHE)))
    _HMM_CACHE[key] = result
    return result


# --------------------------------------------------------------------------- #
# Module 2 — Volatility Forecaster
# --------------------------------------------------------------------------- #
def forecast_volatility(symbol, timeframe, start, end, params=None) -> dict:
    params = params or {}
    rv_window = _p(params, "rv_window", 20)
    horizon = max(1, _p(params, "forecast_horizon", 10))
    lam = _p(params, "lambda", 0.94)
    max_lag = max(1, _p(params, "max_lag", 10))

    df = _load_window(symbol, timeframe, start, end)
    time_a = df["time"].to_numpy()
    close = df["close"].astype(float)
    bpy = infer_bars_per_year(time_a)
    ann = float(np.sqrt(bpy)) if bpy > 0 else 1.0

    r = _log_returns(close.to_numpy())  # length n-1, aligned to bars[1:]
    r_times = time_a[1:]

    # --- Realized vol series (rolling std of log returns), annualized ---
    rv = pd.Series(r).rolling(rv_window).std().to_numpy() * ann
    rv_series = _downsample(r_times, rv)

    finite_rv = rv[np.isfinite(rv)]
    current_rv = float(finite_rv[-1]) if finite_rv.size else float("nan")
    current_vol_percentile = (
        float(np.mean(finite_rv <= current_rv)) if finite_rv.size else None
    )

    # --- EWMA (RiskMetrics) variance, causal recursion on squared returns ---
    sigma2 = np.zeros(r.size)
    if r.size:
        sigma2[0] = r[0] ** 2
        for i in range(1, r.size):
            sigma2[i] = lam * sigma2[i - 1] + (1.0 - lam) * r[i - 1] ** 2
    ewma_vol = np.sqrt(sigma2) * ann
    # Multi-step EWMA forecast is flat (held at last estimate).
    ewma_next = float(ewma_vol[-1]) if ewma_vol.size else float("nan")
    persistence_next = current_rv  # naive baseline: next vol = current realized vol

    # --- Vol clustering: ACF of squared returns ---
    acf_sq = _acf(r ** 2, max_lag)
    low = [d["acf"] for d in acf_sq if d["lag"] <= 5 and d["acf"] is not None]
    clustering_score = _safe(float(np.mean(low))) if low else None

    # --- Forecast skill: causal predictors vs NON-overlapping FORWARD vol ---
    # Target = realized vol of the NEXT `horizon` returns (r[i+1 .. i+horizon]),
    # which shares no bars with the predictors. The old target (the trailing
    # 20-bar rv shifted by one) overlapped its own input on 19 of 20 bars, so
    # "skill" was mechanically ~1 for any series — it measured the
    # autocorrelation of a rolling window, not forecasting ability.
    ewma_skill = persistence_skill = None
    fwd_vol = pd.Series(r).rolling(horizon).std(ddof=1).shift(-horizon).to_numpy() * ann
    if rv.size > rv_window + horizon + 2:
        idx = np.arange(rv_window, rv.size)
        idx = idx[np.isfinite(rv[idx]) & np.isfinite(fwd_vol[idx]) & np.isfinite(ewma_vol[idx])]
        if idx.size >= 5:
            realized_fwd = fwd_vol[idx]
            try:
                ewma_skill = _safe(float(stats.pearsonr(ewma_vol[idx], realized_fwd)[0]))
            except Exception:
                ewma_skill = None
            try:
                persistence_skill = _safe(float(stats.pearsonr(rv[idx], realized_fwd)[0]))
            except Exception:
                persistence_skill = None

    # --- Heuristic verdict (clearly labeled, NOT a prediction) ---
    verdict = _vol_verdict(current_vol_percentile, clustering_score)

    return {
        "rv_series": rv_series,
        "current_rv_annualized": _safe(current_rv),
        "current_vol_percentile": _safe(current_vol_percentile),
        "forecast": {
            "horizon_bars": horizon,
            "lambda": lam,
            "ewma_next_vol_annualized": _safe(ewma_next),
            "persistence_next_vol_annualized": _safe(persistence_next),
        },
        "acf_sq_returns": acf_sq,
        "clustering_score": clustering_score,
        "forecast_skill_corr": ewma_skill,
        "persistence_skill_corr": persistence_skill,
        "verdict": verdict,
        "meta": _meta(symbol, timeframe, df, {
            "method": {
                "rv_window": rv_window,
                "forecast_horizon": horizon,
                "lambda": lam,
                "max_lag": max_lag,
                "note": "EWMA/RiskMetrics + persistence baseline. Volatility (size of moves) "
                        "is somewhat predictable because it clusters; direction is not forecast here.",
            },
        }),
    }


def _vol_verdict(percentile, clustering) -> dict:
    if percentile is None:
        return {"tone": "neutral", "text": "Not enough data to assess the volatility regime."}
    p = percentile
    clus = clustering or 0.0
    if p <= 0.30:
        if clus >= 0.10:
            return {"tone": "warn", "text": (
                "Volatility is compressed (low percentile) but clustering is positive — "
                "quiet periods like this often precede an expansion. Big-move risk elevated.")}
        return {"tone": "neutral", "text": (
            "Volatility is low and not strongly clustered — calm conditions, no expansion signal.")}
    if p >= 0.80:
        return {"tone": "warn", "text": (
            "Volatility is already elevated (high percentile). Vol tends to mean-revert, "
            "so expect it to subside rather than keep rising.")}
    return {"tone": "neutral", "text": (
        "Volatility is in its mid-range — no strong compression or blow-off signal.")}


# --------------------------------------------------------------------------- #
# Module 3 — Statistics Explorer
# --------------------------------------------------------------------------- #
_DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def explore_statistics(symbol, timeframe, start, end, params=None) -> dict:
    params = params or {}
    max_lag = max(1, _p(params, "max_lag", 20))
    hist_bins = max(5, _p(params, "hist_bins", 50))
    max_streak = max(1, _p(params, "max_streak", 5))
    fwd_horizon = max(1, _p(params, "fwd_horizon", 1))

    df = _load_window(symbol, timeframe, start, end)
    time_a = df["time"].to_numpy()
    close = df["close"].to_numpy(dtype=float)
    r = _log_returns(close)  # aligned to bars[1:]
    r_times = time_a[1:]
    dt = pd.to_datetime(r_times, unit="s", utc=True)  # UTC bucketing

    # --- Day-of-week & hour-of-day average returns (UTC) ---
    by_dow = _group_returns(r, dt.dayofweek.to_numpy(), range(7), _DOW_NAMES)
    by_hour = _group_returns(r, dt.hour.to_numpy(), range(24), [str(h) for h in range(24)])

    # --- Autocorrelation of returns ---
    autocorr = _acf(r, max_lag)
    lag1 = autocorr[0]["acf"] if autocorr else None

    # --- Distribution: histogram + moments + tails ---
    counts, edges = np.histogram(r, bins=hist_bins)
    rsz = r.size
    skew = _safe(float(stats.skew(r, bias=False))) if rsz >= 3 else None
    exkurt = _safe(float(stats.kurtosis(r, fisher=True, bias=False))) if rsz >= 4 else None
    p05, p95 = float(np.percentile(r, 5)), float(np.percentile(r, 95))
    tail_ratio = _safe(abs(p95) / abs(p05)) if (p05 < 0 and p95 > 0) else None
    distribution = {
        "histogram": {
            "bin_edges": [_safe(e) for e in edges.tolist()],
            "counts": [int(x) for x in counts.tolist()],
        },
        "mean": _safe(float(r.mean())),
        "std": _safe(float(r.std(ddof=1))) if rsz >= 2 else None,
        "skew": skew,
        "excess_kurtosis": exkurt,
        "tail_ratio": tail_ratio,
        "fat_tail_flag": bool(exkurt is not None and exkurt > 1.0),
    }

    # --- Conditional stats: returns after N consecutive down/up bars ---
    after_down = _after_streaks(r, close, max_streak, fwd_horizon, direction=-1)
    after_up = _after_streaks(r, close, max_streak, fwd_horizon, direction=1)

    return {
        "by_dow": by_dow,
        "by_hour": by_hour,
        "autocorr": autocorr,
        "lag1_autocorr": lag1,
        "distribution": distribution,
        "after_down_streaks": after_down,
        "after_up_streaks": after_up,
        "meta": _meta(symbol, timeframe, df, {
            "timezone": "UTC",
            "method": {"max_lag": max_lag, "hist_bins": hist_bins,
                       "max_streak": max_streak, "fwd_horizon": fwd_horizon},
            "caveat": "In-sample descriptive statistics over the chosen window — "
                      "not predictions and not out-of-sample tested.",
        }),
    }


def _group_returns(r, keys, all_keys, names) -> list[dict]:
    """Average return per bucket (e.g. weekday, hour). Returns % values."""
    out = []
    for k, name in zip(all_keys, names):
        vals = r[keys == k]
        if vals.size:
            out.append({
                "key": int(k), "label": name, "n": int(vals.size),
                "avg_return_pct": _safe(100.0 * float(vals.mean())),
                "median_return_pct": _safe(100.0 * float(np.median(vals))),
                "win_rate": _safe(100.0 * float(np.mean(vals > 0))),
                "std_pct": _safe(100.0 * float(vals.std(ddof=1))) if vals.size >= 2 else None,
            })
        else:
            out.append({"key": int(k), "label": name, "n": 0,
                        "avg_return_pct": None, "median_return_pct": None,
                        "win_rate": None, "std_pct": None})
    return out


def _after_streaks(r, close, max_streak, h, direction) -> list[dict]:
    """Forward return over next h bars after exactly-or-more consecutive moves.

    direction = -1 → down bars (r<0), +1 → up bars (r>0).
    A streak of length k ends at return-index j (bar j+1). Forward return uses
    close[(j+1)+h] / close[j+1] - 1, dropping cases that run past the end.
    """
    sign = np.sign(r)
    target = float(direction)
    n_close = close.size
    out = []
    for k in range(1, max_streak + 1):
        fwd_vals = []
        for j in range(k - 1, r.size):
            # last k returns up to index j all match the target direction?
            if np.all(sign[j - k + 1 : j + 1] == target):
                bar = j + 1            # bar that closed the streak (index into close)
                if bar + h < n_close:
                    fwd_vals.append(close[bar + h] / close[bar] - 1.0)
        fwd_vals = np.array(fwd_vals)
        if fwd_vals.size:
            out.append({
                "n": k, "count": int(fwd_vals.size),
                "avg_fwd_return_pct": _safe(100.0 * float(fwd_vals.mean())),
                "win_rate": _safe(100.0 * float(np.mean(fwd_vals > 0))),
            })
        else:
            out.append({"n": k, "count": 0, "avg_fwd_return_pct": None, "win_rate": None})
    return out


# --------------------------------------------------------------------------- #
# Module 4 — Mean-Reversion Alpha Scanner
# --------------------------------------------------------------------------- #
# Descriptively measures whether a VWMA z-score + RSI mean-reversion SETUP has a
# real edge — overall and broken down by regime — BEFORE any strategy/optimizer.
# Honesty math baked in:
#   - edge is measured vs a BASELINE (the unconditional directional drift), so a
#     trending symbol's drift can't masquerade as alpha;
#   - a one-sided t-test reports whether the edge is statistically significant,
#     so a great-looking average on 11 trades is flagged as not significant;
#   - sample size (n) is surfaced everywhere;
#   - a z-threshold sweep shows whether the edge grows smoothly with conviction
#     (a sign it's real) or spikes randomly (a sign it's noise).
# Indicator formulas mirror services/strategies/vwma_reversion.py exactly so the
# scan and the tradeable strategy agree on what a "setup" is.

def _vwma(close: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    pv = (close * volume).rolling(length).sum()
    vsum = volume.rolling(length).sum().replace(0, np.nan)
    return pv / vsum


def _rsi(close: pd.Series, length: int) -> pd.Series:
    diff = close.diff()
    up = diff.clip(lower=0)
    down = -diff.clip(upper=0)
    avg_up = up.ewm(alpha=1 / length, adjust=False).mean()
    avg_down = down.ewm(alpha=1 / length, adjust=False).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _edge_stats(trade_ret: np.ndarray, baseline: float) -> dict:
    """Summarize a setup's forward returns vs a directional baseline.
    `trade_ret` is the return TO THE TRADE (+fwd for longs, -fwd for shorts).
    `baseline` is the same-direction unconditional return (random-entry).
    """
    n = int(trade_ret.size)
    if n == 0:
        return {"n": 0, "avg_return_pct": None, "win_rate": None, "baseline_pct": _safe(baseline * 100),
                "edge_vs_baseline_pct": None, "t_stat": None, "p_value": None, "significance": "no_data"}
    avg = float(trade_ret.mean())
    win = float(np.mean(trade_ret > 0))
    t_stat = p_val = None
    significance = "insufficient"
    if n >= 5 and trade_ret.std(ddof=1) > 0:
        try:
            res = stats.ttest_1samp(trade_ret, popmean=baseline, alternative="greater")
            t_stat, p_val = float(res.statistic), float(res.pvalue)
            if math.isfinite(p_val):
                significance = ("significant" if p_val < 0.01
                                else "marginal" if p_val < 0.05 else "not_significant")
        except Exception:
            pass
    return {
        "n": n,
        "avg_return_pct": _safe(avg * 100),
        "win_rate": _safe(win * 100),
        "baseline_pct": _safe(baseline * 100),
        "edge_vs_baseline_pct": _safe((avg - baseline) * 100),
        "t_stat": _safe(t_stat),
        "p_value": _safe(p_val),
        "significance": significance,
    }


def scan_mean_reversion(symbol, timeframe, start, end, params=None) -> dict:
    params = params or {}
    vwma_length = _p(params, "vwma_length", 30)
    rsi_length = _p(params, "rsi_length", 14)
    z_threshold = _p(params, "z_threshold", 1.5)
    rsi_long_max = _p(params, "rsi_long_max", 35)
    rsi_short_min = _p(params, "rsi_short_min", 65)
    fwd_horizon = max(1, _p(params, "fwd_horizon", 10))

    df = _load_window(symbol, timeframe, start, end)
    close = df["close"].astype(float)
    vol = df["volume"].astype(float) if "volume" in df.columns else pd.Series(1.0, index=df.index)
    n = len(df)
    c = close.to_numpy()

    mean = _vwma(close, vol, vwma_length)
    std = close.rolling(vwma_length).std(ddof=0).replace(0, 1e-9)  # ddof=0 matches the strategy
    zscore = ((close - mean) / std).to_numpy()
    rsi = _rsi(close, rsi_length).to_numpy()
    # smooth_bars forced off: smoothed labels are future-dependent (a short run
    # is merged into its longer NEXT neighbor) and would bias the by-regime
    # edge stats. The smoothing knob remains a display-only concern.
    regimes = _regime_labels(df, {**_regime_params(params), "smooth_bars": 0})

    # Forward return over the next `fwd_horizon` bars, aligned to bar i.
    fwd = np.full(n, np.nan)
    if n > fwd_horizon:
        fwd[: n - fwd_horizon] = c[fwd_horizon:] / c[: n - fwd_horizon] - 1.0
    valid = np.isfinite(fwd) & np.isfinite(zscore) & np.isfinite(rsi)

    drift = float(np.nanmean(fwd[valid])) if valid.any() else 0.0

    long_setup = (zscore < -z_threshold) & (rsi < rsi_long_max) & valid
    short_setup = (zscore > z_threshold) & (rsi > rsi_short_min) & valid

    def side_block(setup_mask, direction):
        sign = float(direction)
        overall = _edge_stats(sign * fwd[setup_mask], sign * drift)
        by_regime = []
        for lab in REGIME_LABELS:
            rmask = (regimes == lab) & valid
            r_drift = float(np.nanmean(fwd[rmask])) if rmask.any() else 0.0
            s = _edge_stats(sign * fwd[setup_mask & (regimes == lab)], sign * r_drift)
            s["regime"] = lab
            by_regime.append(s)
        return {"overall": overall, "by_regime": by_regime}

    long_block = side_block(long_setup, +1)
    short_block = side_block(short_setup, -1)

    # z-threshold sweep — does the edge grow with conviction (real) or jump
    # around (noise)? Re-derive setups at each z; RSI filter held fixed.
    z_grid = [round(0.5 + 0.25 * k, 2) for k in range(11)]  # 0.5 .. 3.0
    z_sweep = []
    for z in z_grid:
        lm = (zscore < -z) & (rsi < rsi_long_max) & valid
        sm = (zscore > z) & (rsi > rsi_short_min) & valid
        lr = fwd[lm]
        sr = -fwd[sm]
        z_sweep.append({
            "z": z,
            "long_edge_pct": _safe(float(lr.mean()) * 100) if lr.size else None,
            "long_n": int(lr.size),
            "short_edge_pct": _safe(float(sr.mean()) * 100) if sr.size else None,
            "short_n": int(sr.size),
        })

    # (z × RSI) edge heatmap — the full surface, not just the z-sweep. Each cell
    # carries its sample size so the UI can grey out thinly-populated cells.
    z_axis = [round(0.5 + 0.25 * k, 2) for k in range(11)]      # 0.5 .. 3.0
    rsi_long_axis = [25, 30, 35, 40]
    rsi_short_axis = [60, 65, 70, 75]

    def _cell(mask, direction):
        r = direction * fwd[mask]
        return {"edge_pct": _safe(float(r.mean()) * 100) if r.size else None, "n": int(r.size)}

    long_grid = [[_cell((zscore < -z) & (rsi < rt) & valid, +1) for rt in rsi_long_axis] for z in z_axis]
    short_grid = [[_cell((zscore > z) & (rsi > rt) & valid, -1) for rt in rsi_short_axis] for z in z_axis]

    edge_heatmap = {
        "z_axis": z_axis,
        "rsi_long_axis": rsi_long_axis, "rsi_short_axis": rsi_short_axis,
        "long": long_grid, "short": short_grid,
    }

    return {
        "long": long_block,
        "short": short_block,
        "baseline": {"drift_pct": _safe(drift * 100), "fwd_horizon": fwd_horizon},
        "z_sweep": z_sweep,
        "edge_heatmap": edge_heatmap,
        "meta": _meta(symbol, timeframe, df, {
            "setup": {
                "vwma_length": vwma_length, "rsi_length": rsi_length,
                "z_threshold": z_threshold, "rsi_long_max": rsi_long_max,
                "rsi_short_min": rsi_short_min, "fwd_horizon": fwd_horizon,
            },
            "caveat": "In-sample, descriptive edge measurement — not a backtest and not "
                      "out-of-sample. 'Edge vs baseline' isolates the setup from the market's "
                      "drift; significance is a one-sided t-test of trade return vs that baseline. "
                      "Use it to NARROW what you then validate in Walk-Forward.",
        }),
    }


# --------------------------------------------------------------------------- #
# Module — Black-Scholes fade safety
# --------------------------------------------------------------------------- #
# Question this answers (straight from docs/black-scholes.md): do VWMA-reversion
# setups that fire INSIDE the Black-Scholes "normal move" (low stretch) actually
# carry the edge, while high-stretch / tail setups bleed? If yes, gating entries
# on `fade_safe` has a real reason to exist; if not, it's just curve-fitting.
#
# It reuses the EXACT setup definition from scan_mean_reversion (same VWMA z-score
# + RSI gate) and slices those setups by stretch instead of by regime. Causal:
# every feature at bar i uses only bars <= i (rolling realized vol, rolling VWMA).
#
# `stretch` = |close - VWMA| / (close * realized_vol_per_bar * sqrt(1) * n_sigma).
# Buckets mirror the doc's table: <=0.5 calm, <=1 normal, 1-2 stretched, >2 tail.
_STRETCH_BUCKETS = [
    ("Calm (<=0.5)",      0.0,        0.5),
    ("Normal (0.5-1)",    0.5,        1.0),
    ("Stretched (1-2)",   1.0,        2.0),
    ("Tail (>2)",         2.0,        float("inf")),
]


def fade_safety_scan(symbol, timeframe, start, end, params=None) -> dict:
    params = params or {}
    vwma_length = _p(params, "vwma_length", 30)
    rsi_length = _p(params, "rsi_length", 14)
    z_threshold = _p(params, "z_threshold", 1.5)
    rsi_long_max = _p(params, "rsi_long_max", 35)
    rsi_short_min = _p(params, "rsi_short_min", 65)
    fwd_horizon = max(1, _p(params, "fwd_horizon", 10))
    vol_window = _p(params, "vol_window", 20)
    n_sigma = _p(params, "n_sigma", 1.0)
    # Timescale of the "normal" BS move. A deviation from a `vwma_length`-bar VWMA
    # builds up over ~vwma_length bars, so the expected move must be measured over
    # that same horizon (move ∝ √T) or every setup looks like a tail event. Default
    # to vwma_length; expose as a knob so the user can probe the sensitivity.
    bs_horizon = max(1, _p(params, "bs_horizon", vwma_length))

    df = _load_window(symbol, timeframe, start, end)
    close = df["close"].astype(float)
    vol = df["volume"].astype(float) if "volume" in df.columns else pd.Series(1.0, index=df.index)
    n = len(df)
    c = close.to_numpy()

    mean = _vwma(close, vol, vwma_length)
    std = close.rolling(vwma_length).std(ddof=0).replace(0, 1e-9)  # ddof=0 matches the strategy
    zscore = ((close - mean) / std).to_numpy()
    rsi = _rsi(close, rsi_length).to_numpy()

    # Black-Scholes expected move + stretch, anchored to the SAME VWMA the z-score
    # uses. fade_safety() reads a "vwma" column if present, else a rolling mean —
    # pass mean explicitly so the reference level matches the setup exactly.
    fs = black_scholes.fade_safety(
        df.assign(vwma=mean), vol_window=vol_window, n_sigma=n_sigma,
        ref_col="vwma", horizon_bars=bs_horizon,
    )
    stretch = fs["stretch"].to_numpy()
    bs_move = fs["bs_move"].to_numpy()

    # Forward return over the next `fwd_horizon` bars, aligned to bar i.
    fwd = np.full(n, np.nan)
    if n > fwd_horizon:
        fwd[: n - fwd_horizon] = c[fwd_horizon:] / c[: n - fwd_horizon] - 1.0
    valid = np.isfinite(fwd) & np.isfinite(zscore) & np.isfinite(rsi) & np.isfinite(stretch)

    drift = float(np.nanmean(fwd[valid])) if valid.any() else 0.0

    long_setup = (zscore < -z_threshold) & (rsi < rsi_long_max) & valid
    short_setup = (zscore > z_threshold) & (rsi > rsi_short_min) & valid
    any_setup = long_setup | short_setup

    # --- Edge per stretch bucket (long, short, and combined "fade" return) ---
    def bucket_mask(lo, hi):
        return (stretch >= lo) & (stretch < hi)

    by_bucket = []
    for label, lo, hi in _STRETCH_BUCKETS:
        bm = bucket_mask(lo, hi)
        lset = long_setup & bm
        sset = short_setup & bm
        # combined fade return: +fwd for longs, -fwd for shorts (return TO the trade)
        fade_ret = np.concatenate([fwd[lset], -fwd[sset]]) if (lset.any() or sset.any()) else np.array([])
        by_bucket.append({
            "bucket": label,
            "n_setups": int(lset.sum() + sset.sum()),
            "long": _edge_stats(fwd[lset], drift),
            "short": _edge_stats(-fwd[sset], -drift),
            "fade": _edge_stats(fade_ret, 0.0),  # vs zero: is fading net-profitable here?
        })

    # --- stretch ceiling sweep: edge if you only fade when stretch <= X ---
    # This is the actual filter VWMA Reversion would apply. Does tightening the
    # ceiling improve the per-trade fade edge (filter helps) or just cut sample
    # size with no improvement (filter is noise)?
    ceil_grid = [round(0.25 * k, 2) for k in range(1, 13)]  # 0.25 .. 3.0
    stretch_sweep = []
    for x in ceil_grid:
        lm = long_setup & (stretch <= x)
        sm = short_setup & (stretch <= x)
        fade_ret = np.concatenate([fwd[lm], -fwd[sm]]) if (lm.any() or sm.any()) else np.array([])
        stretch_sweep.append({
            "max_stretch": x,
            "n": int(lm.sum() + sm.sum()),
            "fade_edge_pct": _safe(float(fade_ret.mean()) * 100) if fade_ret.size else None,
            "win_rate": _safe(float(np.mean(fade_ret > 0)) * 100) if fade_ret.size else None,
        })

    # --- stretch distribution across the setups (where do setups actually fire?) ---
    setup_stretch = stretch[any_setup]
    setup_stretch = setup_stretch[np.isfinite(setup_stretch)]
    if setup_stretch.size:
        pcts = np.percentile(setup_stretch, [25, 50, 75, 90])
        safe_frac = float(np.mean(setup_stretch <= 1.0))
        tail_frac = float(np.mean(setup_stretch > 2.0))
    else:
        pcts = [np.nan] * 4
        safe_frac = tail_frac = float("nan")

    # baseline "do nothing different" fade edge across ALL setups, any stretch.
    all_fade = np.concatenate([fwd[long_setup], -fwd[short_setup]]) if any_setup.any() else np.array([])
    unfiltered_edge = _safe(float(all_fade.mean()) * 100) if all_fade.size else None
    safe_only = np.concatenate([fwd[long_setup & (stretch <= 1.0)], -fwd[short_setup & (stretch <= 1.0)]])
    safe_edge = _safe(float(safe_only.mean()) * 100) if safe_only.size else None

    return {
        "by_bucket": by_bucket,
        "stretch_sweep": stretch_sweep,
        "baseline": {
            "drift_pct": _safe(drift * 100),
            "fwd_horizon": fwd_horizon,
            "unfiltered_fade_edge_pct": unfiltered_edge,
            "safe_only_fade_edge_pct": safe_edge,  # stretch <= 1 only
            "n_setups": int(any_setup.sum()),
        },
        "setup_stretch": {
            "p25": _safe(pcts[0]), "p50": _safe(pcts[1]),
            "p75": _safe(pcts[2]), "p90": _safe(pcts[3]),
            "pct_safe": _safe(safe_frac * 100),   # share of setups inside the normal range
            "pct_tail": _safe(tail_frac * 100),   # share that are tail (>2x) events
        },
        "meta": _meta(symbol, timeframe, df, {
            "setup": {
                "vwma_length": vwma_length, "rsi_length": rsi_length,
                "z_threshold": z_threshold, "rsi_long_max": rsi_long_max,
                "rsi_short_min": rsi_short_min, "fwd_horizon": fwd_horizon,
                "vol_window": vol_window, "n_sigma": n_sigma, "bs_horizon": bs_horizon,
            },
            "caveat": "In-sample, descriptive. Tests whether the Black-Scholes fade-safety "
                      "filter (only fade when the move is within the normal range) actually "
                      "separates winning from losing VWMA-reversion setups. The z-score entry "
                      "and the stretch filter both measure distance from VWMA in different "
                      "units, so they overlap — read 'fade edge' per bucket, not stretch alone. "
                      "If low-stretch buckets win and high-stretch bleed, the filter has a real "
                      "reason to exist. Confirm in Walk-Forward before trading it.",
        }),
    }


# --------------------------------------------------------------------------- #
# Shared causal feature builder (used by Feature Importance AND the Model Bench)
# --------------------------------------------------------------------------- #
def _build_features(df: pd.DataFrame, params: dict):
    """Return (feature_df, feature_names). Every column at bar i uses only bars <= i."""
    p = params or {}
    vwma_length = _p(p, "vwma_length", 30)
    rsi_length = _p(p, "rsi_length", 14)
    adx_period = _p(p, "adx_period", 14)
    vol_window = _p(p, "vol_window", 20)

    close = df["close"].astype(float)
    vol = df["volume"].astype(float) if "volume" in df.columns else pd.Series(1.0, index=df.index)
    ret = close.pct_change()
    mean = _vwma(close, vol, vwma_length)
    std = close.rolling(vwma_length).std(ddof=0).replace(0, 1e-9)
    vstd = vol.rolling(vol_window).std().replace(0, 1e-9)

    feats = {
        "ret_1": ret,
        "ret_2": close.pct_change(2),
        "ret_3": close.pct_change(3),
        "ret_5": close.pct_change(5),
        "mom_10": close.pct_change(10),
        "rsi": _rsi(close, rsi_length),
        "zscore": (close - mean) / std,
        "dist_vwma_pct": (close - mean) / mean.replace(0, np.nan) * 100.0,
        "adx": _calc_adx(df, adx_period),
        "realized_vol": ret.rolling(vol_window).std(),
        "ret_skew": ret.rolling(vol_window).skew(),
        "vol_z": (vol - vol.rolling(vol_window).mean()) / vstd,
    }
    X = pd.DataFrame(feats, index=df.index)
    return X, list(X.columns)


def _forward_target(close: np.ndarray, h: int, kind: str, train_frac: float):
    """Binary target aligned per bar; last h bars are NaN (no future). For
    'big_move' the magnitude threshold is taken from the TRAIN slice only."""
    n = close.size
    fwd = np.full(n, np.nan)
    fwd[: n - h] = close[h:] / close[: n - h] - 1.0
    return fwd


def feature_importance(symbol, timeframe, start, end, params=None) -> dict:
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.inspection import permutation_importance
    from sklearn.feature_selection import mutual_info_classif

    params = params or {}
    h = max(1, _p(params, "fwd_horizon", 10))
    target_kind = (params.get("target") or "direction")
    method = (params.get("method") or "rf")
    max_samples = _p(params, "max_samples", 20000)
    seed = _p(params, "seed", 0)

    df = _load_window(symbol, timeframe, start, end)
    X, names = _build_features(df, params)
    close = df["close"].to_numpy(dtype=float)
    n = len(df)
    fwd = np.full(n, np.nan)
    fwd[: n - h] = close[h:] / close[: n - h] - 1.0

    Xv = X.to_numpy(dtype=float)
    valid = np.isfinite(fwd) & np.all(np.isfinite(Xv), axis=1)
    Xv, fwdv = Xv[valid], fwd[valid]
    if len(Xv) > max_samples:               # keep the most recent window for speed
        Xv, fwdv = Xv[-max_samples:], fwdv[-max_samples:]
    if len(Xv) < 200:
        raise ValueError("insufficient data after feature warm-up (need >= 200 usable rows)")

    split = int(len(Xv) * 0.7)              # time-ordered holdout (no shuffle)
    if target_kind == "big_move":
        thresh = float(np.quantile(np.abs(fwdv[:split]), 0.8))  # TRAIN-only threshold
        y = (np.abs(fwdv) >= thresh).astype(int)
    else:
        y = (fwdv > 0).astype(int)
    Xtr, Xte, ytr, yte = Xv[:split], Xv[split:], y[:split], y[split:]

    rf = RandomForestClassifier(n_estimators=200, max_depth=8, random_state=seed, n_jobs=-1)
    rf.fit(Xtr, ytr)
    train_acc = float(rf.score(Xtr, ytr))
    test_acc = float(rf.score(Xte, yte))
    baseline = float(max(yte.mean(), 1 - yte.mean())) if yte.size else None

    impurity = rf.feature_importances_
    perm = permutation_importance(rf, Xte, yte, n_repeats=5, random_state=seed, n_jobs=-1).importances_mean
    if method == "mutual_info":
        primary = mutual_info_classif(Xtr, ytr, random_state=seed)
    else:
        primary = perm  # permutation importance on the held-out fold is the honest default

    order = np.argsort(primary)[::-1]
    importances = [{
        "feature": names[i],
        "importance": _safe(float(primary[i])),
        "permutation_importance": _safe(float(perm[i])),
        "impurity_importance": _safe(float(impurity[i])),
        "rank": rank + 1,
    } for rank, i in enumerate(order)]

    return {
        "importances": importances,
        "scores": {
            "train_accuracy": _safe(train_acc),
            "test_accuracy": _safe(test_acc),
            "baseline_accuracy": _safe(baseline),
            "test_minus_baseline": _safe(test_acc - baseline) if baseline is not None else None,
            "method": method,
            "target": target_kind,
        },
        "n_features": len(names),
        "n_train": int(Xtr.shape[0]),
        "n_test": int(Xte.shape[0]),
        "meta": _meta(symbol, timeframe, df, {
            "method": {"fwd_horizon": h, "target": target_kind, "estimator": method,
                       "max_samples": max_samples, "split": "70/30 time-ordered"},
            "caveat": "Importances describe in-sample structure, not a guaranteed edge. The honest "
                      "signal is TEST accuracy minus baseline: if it's ~0, no feature here predicts "
                      "the next move out-of-sample. A big train-minus-test gap means overfitting. "
                      "Permutation importance (held-out) is shown alongside the biased impurity score.",
        }),
    }


# --------------------------------------------------------------------------- #
# Module — Multi-symbol mean-reversion batch scan
# --------------------------------------------------------------------------- #
def scan_batch(symbols, timeframe, start, end, params=None) -> dict:
    """Run the MR scan across many symbols → a ranked overall-edge table.
    Per-symbol failures (e.g. no dataset) are isolated, not fatal."""
    rows = []
    for sym in symbols[:20]:  # hard cap; sequential, each scan is a fast pass
        try:
            r = scan_mean_reversion(sym, timeframe, start, end, params)
            lo, so = r["long"]["overall"], r["short"]["overall"]
            rows.append({
                "symbol": sym,
                "long_edge_pct": lo["edge_vs_baseline_pct"], "long_n": lo["n"], "long_sig": lo["significance"],
                "short_edge_pct": so["edge_vs_baseline_pct"], "short_n": so["n"], "short_sig": so["significance"],
                "bars": r["meta"]["bars"],
            })
        except Exception as e:
            rows.append({"symbol": sym, "error": str(e)})
    return {
        "results": rows,
        "meta": {"timeframe": timeframe, "n_symbols": len(rows),
                 "fwd_horizon": max(1, _p(params or {}, "fwd_horizon", 10)),
                 "caveat": "In-sample edge per symbol; significant rows are candidates to validate in "
                           "Walk-Forward, not ready-to-trade signals."},
    }


# --------------------------------------------------------------------------- #
# Module — Pattern Finder (KMeans clustering of normalized candle shapes)
# --------------------------------------------------------------------------- #
def cluster_patterns(symbol, timeframe, start, end, params=None) -> dict:
    from sklearn.cluster import KMeans

    params = params or {}
    W = max(4, _p(params, "window_len", 20))
    k = max(2, _p(params, "k", 6))
    stride = max(1, _p(params, "stride", 2))
    h = max(1, _p(params, "fwd_horizon", 10))
    seed = _p(params, "seed", 0)

    df = _load_window(symbol, timeframe, start, end)
    close = df["close"].to_numpy(dtype=float)
    time_a = df["time"].to_numpy()
    n = close.size

    # Build z-normalized shape vectors for windows ending at i (causal), keeping
    # only windows that have a realized forward return (i + h < n). `stride`
    # thins the window set — it was previously parsed but unused, which made
    # adjacent near-identical windows dominate the clusters.
    shapes, ends, fwd = [], [], []
    for i in range(W - 1, n, stride):
        if i + h >= n:
            break
        win = close[i - W + 1: i + 1]
        mu, sd = win.mean(), win.std()
        if sd <= 0 or not np.isfinite(sd):
            continue
        shapes.append((win - mu) / sd)          # shape, not level
        ends.append(i)
        fwd.append(close[i + h] / close[i] - 1.0)
    if len(shapes) < k * 10:
        raise ValueError("insufficient data to cluster (need more bars or a smaller window/k)")
    Xs = np.array(shapes)
    fwd = np.array(fwd)
    drift = float(fwd.mean())

    km = KMeans(n_clusters=k, n_init=10, random_state=seed)
    lab = km.fit_predict(Xs)

    clusters = []
    for cid in range(k):
        m = lab == cid
        f = fwd[m]
        stat = _edge_stats(f, drift)            # t-test vs unconditional drift
        clusters.append({
            "id": cid,
            "centroid": [_safe(float(v)) for v in km.cluster_centers_[cid]],
            "n": int(m.sum()),
            "frequency_pct": _safe(100.0 * m.sum() / len(lab)),
            "avg_fwd_return_pct": stat["avg_return_pct"],
            "win_rate": stat["win_rate"],
            "edge_vs_drift_pct": stat["edge_vs_baseline_pct"],
            "significance": stat["significance"],
        })
    clusters.sort(key=lambda c: (c["edge_vs_drift_pct"] is not None, c["edge_vs_drift_pct"] or -1e9), reverse=True)

    return {
        "clusters": clusters,
        "k": k, "window_len": W, "fwd_horizon": h,
        "drift_pct": _safe(drift * 100),
        "meta": _meta(symbol, timeframe, df, {
            "method": {"window_len": W, "k": k, "stride": stride, "fwd_horizon": h,
                       "normalization": "per-window z-score (shape, not level)"},
            "caveat": "Unsupervised shapes; forward stats are in-sample with a t-test vs drift. "
                      "A significant cluster is a hypothesis to validate out-of-sample, not an edge yet.",
        }),
    }


# --------------------------------------------------------------------------- #
# Module — Similarity Search (nearest historical windows to 'now')
# --------------------------------------------------------------------------- #
def similarity_search(symbol, timeframe, start, end, params=None) -> dict:
    params = params or {}
    W = max(4, _p(params, "window_len", 20))
    K = max(1, _p(params, "k", 25))
    h = max(1, _p(params, "fwd_horizon", 10))
    metric = (params.get("metric") or "euclidean")

    df = _load_window(symbol, timeframe, start, end)
    close = df["close"].to_numpy(dtype=float)
    time_a = df["time"].to_numpy()
    n = close.size

    def _znorm(win):
        mu, sd = win.mean(), win.std()
        return (win - mu) / sd if sd > 0 else None

    query = _znorm(close[n - W:])               # most recent window (ends at last bar)
    if query is None:
        raise ValueError("latest window has zero variance — cannot compare")

    cand = []
    # Candidate windows end at j with a realized forward return and no overlap with the query.
    for j in range(W - 1, n - h):
        if j > (n - 1) - W:                     # exclude windows overlapping the query window
            continue
        s = _znorm(close[j - W + 1: j + 1])
        if s is None:
            continue
        if metric == "correlation":
            c = float(np.corrcoef(query, s)[0, 1])
            dist = 1.0 - (c if np.isfinite(c) else -1.0)
        else:
            dist = float(np.sqrt(np.sum((query - s) ** 2)))
        cand.append((dist, j, s, close[j + h] / close[j] - 1.0))

    if not cand:
        raise ValueError("no comparable historical windows found")
    cand.sort(key=lambda t: t[0])
    top = cand[:K]
    outcomes = np.array([t[3] for t in top])
    drift = float(np.mean([t[3] for t in cand]))
    agg = _edge_stats(outcomes, drift)

    neighbors = [{
        "end_time": int(time_a[j]),
        "distance": _safe(d),
        "fwd_return_pct": _safe(o * 100),
        "shape": [_safe(float(v)) for v in s],
    } for (d, j, s, o) in top]

    return {
        "query_shape": [_safe(float(v)) for v in query],
        "neighbors": neighbors,
        "aggregate": {
            "n": int(outcomes.size),
            "avg_fwd_return_pct": agg["avg_return_pct"],
            "win_rate": agg["win_rate"],
            "edge_vs_drift_pct": agg["edge_vs_baseline_pct"],
            "significance": agg["significance"],
        },
        "window_len": W, "fwd_horizon": h, "metric": metric,
        "meta": _meta(symbol, timeframe, df, {
            "method": {"window_len": W, "k": K, "fwd_horizon": h, "metric": metric,
                       "normalization": "per-window z-score"},
            "caveat": "Analogy, not prediction: a small sample of look-alike windows, in-sample. "
                      "Treat the aggregate outcome as a weak prior, not a signal.",
        }),
    }
