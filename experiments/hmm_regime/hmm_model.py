"""
Gaussian-HMM fit + interpretation for the regime experiment.

The HMM is implemented FROM SCRATCH in numpy/scipy (no hmmlearn) because hmmlearn
has no prebuilt wheel for Python 3.14 and would need a C++ compiler. This is the
same model class (Gaussian-emission HMM, full covariance, Baum-Welch EM) — just
small enough to read end to end, which also serves the "easier to debug" goal.

Pipeline:
  - GaussianHMM       : fit via Baum-Welch (log-space forward-backward), Viterbi decode
  - fit_hmm()         : fit, then RELABEL states into a stable order + diagnostics
  - human_label()     : turn a state's feature signature into a readable name
  - HMMResult         : everything needed to judge "how it reads"

WHY full-sample fit: this is a perception/diagnostic phase — we want to see how the
model segments BTCUSDT given all the data. That uses look-ahead and is NOT tradeable
as-is; a rolling/expanding refit comes later, before any strategy use. See README.

WHY a fixed seed: EM is sensitive to initialization. Pinning the seed (KMeans init)
makes the read reproducible run-to-run, so "it changed" means the data changed.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.special import logsumexp

from features import FEATURE_NAMES

_LOG_2PI = np.log(2.0 * np.pi)


def _lse(a, axis):
    """Numerically-stable log-sum-exp over one axis. Faster than scipy's in the
    tight forward/backward loops (less overhead, no kwargs machinery)."""
    amax = np.max(a, axis=axis, keepdims=True)
    amax = np.where(np.isfinite(amax), amax, 0.0)
    return np.log(np.sum(np.exp(a - amax), axis=axis)) + np.squeeze(amax, axis=axis)


# --------------------------------------------------------------------------- #
# Pure-numpy Gaussian HMM (full covariance, Baum-Welch EM)
# --------------------------------------------------------------------------- #
class GaussianHMM:
    """Minimal Gaussian-emission HMM. API mirrors the slice of hmmlearn we use:
    .fit / .predict (Viterbi) / .predict_proba (posteriors) / .score (log-lik),
    plus .means_ / .covars_ / .transmat_ / .startprob_ / .converged_.
    """

    def __init__(self, n_components, n_iter=500, tol=1e-4, seed=42, reg=1e-6):
        self.n_components = n_components
        self.n_iter = n_iter
        self.tol = tol
        self.seed = seed
        self.reg = reg              # covariance ridge (keeps matrices invertible)
        self.converged_ = False
        self.n_iter_run_ = 0

    # --- emissions: log N(x; mu_k, Sigma_k) for every bar and state -> (N, K) ---
    def _log_emission(self, X):
        n, d = X.shape
        out = np.empty((n, self.n_components))
        for k in range(self.n_components):
            cov = self.covars_[k] + self.reg * np.eye(d)
            sign, logdet = np.linalg.slogdet(cov)
            inv = np.linalg.inv(cov)
            diff = X - self.means_[k]
            maha = np.einsum("ni,ij,nj->n", diff, inv, diff)
            out[:, k] = -0.5 * (d * _LOG_2PI + logdet + maha)
        return out

    def _init_params(self, X):
        from sklearn.cluster import KMeans
        n, d = X.shape
        k = self.n_components
        km = KMeans(n_clusters=k, n_init=10, random_state=self.seed).fit(X)
        self.means_ = km.cluster_centers_.copy()
        self.covars_ = np.empty((k, d, d))
        for j in range(k):
            pts = X[km.labels_ == j]
            self.covars_[j] = np.cov(pts.T) if len(pts) > d else np.cov(X.T)
        # Slightly sticky transitions as a prior (regimes persist).
        self.transmat_ = np.full((k, k), 0.1 / max(k - 1, 1))
        np.fill_diagonal(self.transmat_, 0.9)
        self.startprob_ = np.full(k, 1.0 / k)

    def _forward_backward(self, log_e, log_t, log_pi):
        n, k = log_e.shape
        log_tT = log_t.T  # (to, from) so a single (k,) + (k,k) broadcast does the step
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

    def fit(self, X):
        X = np.asarray(X, dtype=float)
        n, d = X.shape
        self._init_params(X)
        prev = -np.inf
        for it in range(self.n_iter):
            log_t = np.log(self.transmat_ + 1e-300)
            log_pi = np.log(self.startprob_ + 1e-300)
            log_e = self._log_emission(X)

            log_alpha, log_beta, log_gamma, loglik = self._forward_backward(log_e, log_t, log_pi)
            gamma = np.exp(log_gamma)

            # --- xi summed over time: sum_t P(state i at t, j at t+1) ---
            # Vectorized over t (no Python loop): log_xi[t,i,j] =
            #   log_alpha[t,i] + log_t[i,j] + log_e[t+1,j] + log_beta[t+1,j] - loglik
            log_xi = (log_alpha[:-1, :, None]
                      + log_t[None, :, :]
                      + (log_e[1:] + log_beta[1:])[:, None, :]
                      - loglik)
            xi_sum = np.exp(log_xi).sum(axis=0)

            # --- M-step ---
            self.startprob_ = gamma[0] / gamma[0].sum()
            self.transmat_ = xi_sum / xi_sum.sum(axis=1, keepdims=True).clip(1e-300)
            gsum = gamma.sum(axis=0).clip(1e-300)
            self.means_ = (gamma.T @ X) / gsum[:, None]
            for k in range(self.n_components):
                diff = X - self.means_[k]
                self.covars_[k] = (gamma[:, k][:, None] * diff).T @ diff / gsum[k]

            self.n_iter_run_ = it + 1
            if loglik - prev < self.tol:
                self.converged_ = True
                break
            prev = loglik
        return self

    def score(self, X):
        log_t = np.log(self.transmat_ + 1e-300)
        log_pi = np.log(self.startprob_ + 1e-300)
        log_e = self._log_emission(np.asarray(X, dtype=float))
        _, _, _, loglik = self._forward_backward(log_e, log_t, log_pi)
        return float(loglik)

    def predict_proba(self, X):
        log_t = np.log(self.transmat_ + 1e-300)
        log_pi = np.log(self.startprob_ + 1e-300)
        log_e = self._log_emission(np.asarray(X, dtype=float))
        _, _, log_gamma, _ = self._forward_backward(log_e, log_t, log_pi)
        return np.exp(log_gamma)

    def predict(self, X):
        """Viterbi most-likely state path."""
        log_t = np.log(self.transmat_ + 1e-300)
        log_pi = np.log(self.startprob_ + 1e-300)
        log_e = self._log_emission(np.asarray(X, dtype=float))
        n, k = log_e.shape
        delta = np.empty((n, k))
        psi = np.empty((n, k), dtype=int)
        delta[0] = log_pi + log_e[0]
        for t in range(1, n):
            scores = delta[t - 1][:, None] + log_t      # (from, to)
            psi[t] = np.argmax(scores, axis=0)
            delta[t] = log_e[t] + scores[psi[t], np.arange(k)]
        path = np.empty(n, dtype=int)
        path[-1] = int(np.argmax(delta[-1]))
        for t in range(n - 2, -1, -1):
            path[t] = psi[t + 1, path[t + 1]]
        return path


@dataclass
class HMMResult:
    n_states: int
    states: np.ndarray              # per-bar relabeled state id (0..k-1), stable order
    posteriors: np.ndarray          # (N, k) gamma probabilities (regime confidence)
    means: np.ndarray               # (k, n_features) per-state feature means (RAW scale)
    stds: np.ndarray                # (k, n_features) per-state feature stds (RAW scale)
    transmat: np.ndarray            # (k, k) transition matrix in the relabeled order
    pct_time: np.ndarray            # (k,) fraction of bars in each state
    dwell: np.ndarray               # (k,) expected dwell time = 1/(1-p_ii)
    labels: list                    # (k,) human-readable name per state
    loglik: float
    aic: float
    bic: float
    converged: bool


def _order_states(means_scaled: np.ndarray) -> np.ndarray:
    """Return an index array that sorts raw HMM states into a stable, interpretable
    order: ascending by mean log-return, tie-broken by mean realized-vol.

    log_ret is feature 0, rv20 is feature 1 (see FEATURE_NAMES). Sorting by return
    puts "bear" states first and "bull" states last, so state colors are consistent
    across k and across runs.
    """
    ret = means_scaled[:, 0]
    vol = means_scaled[:, 1]
    return np.lexsort((vol, ret))   # primary key = ret (last), secondary = vol


def human_label(mean: np.ndarray, std: np.ndarray, vol_terciles: tuple) -> str:
    """Readable name from a state's RAW feature means.

    mean = [log_ret, rv20, hurst]. Uses sign of return, vol bucket (vs the
    cross-state terciles), and Hurst vs 0.5 (persistent vs mean-reverting).
    """
    ret, rv, hurst = float(mean[0]), float(mean[1]), float(mean[2])
    lo, hi = vol_terciles

    direction = "Bull" if ret > 0 else "Bear" if ret < 0 else "Flat"
    if rv >= hi:
        risk = "Volatile"
    elif rv <= lo:
        risk = "Calm"
    else:
        risk = "Normal"
    persistence = "trending" if hurst > 0.55 else "mean-rev" if hurst < 0.45 else "noisy"
    return f"{direction}/{risk} ({persistence})"


def fit_hmm(X_scaled: np.ndarray, X_raw: np.ndarray, n_states: int,
            n_iter: int = 500, seed: int = 42) -> HMMResult:
    """Fit the Gaussian HMM on standardized features, relabel into stable order,
    and compute all diagnostics on the RAW feature scale (for interpretability)."""
    model = GaussianHMM(n_components=n_states, n_iter=n_iter, seed=seed).fit(X_scaled)

    raw_states = model.predict(X_scaled)
    raw_post = model.predict_proba(X_scaled)
    loglik = model.score(X_scaled)

    # --- Stable relabeling: order by scaled mean return, remap everything ---
    order = _order_states(model.means_)          # old_id at each new position
    remap = np.empty(n_states, dtype=int)
    remap[order] = np.arange(n_states)           # remap[old_id] = new_id
    states = remap[raw_states]
    posteriors = raw_post[:, order]
    transmat = model.transmat_[np.ix_(order, order)]

    # --- Per-state diagnostics on RAW feature scale ---
    means = np.zeros((n_states, X_raw.shape[1]))
    stds = np.zeros((n_states, X_raw.shape[1]))
    pct_time = np.zeros(n_states)
    for s in range(n_states):
        mask = states == s
        pct_time[s] = mask.mean()
        if mask.any():
            means[s] = X_raw[mask].mean(axis=0)
            stds[s] = X_raw[mask].std(axis=0)

    dwell = np.array([
        1.0 / (1.0 - transmat[s, s]) if transmat[s, s] < 1.0 else np.inf
        for s in range(n_states)
    ])

    # Vol terciles across states, for human labeling.
    rv_means = means[:, 1]
    lo, hi = np.percentile(rv_means, [33.3, 66.7])
    labels = [human_label(means[s], stds[s], (lo, hi)) for s in range(n_states)]

    # --- Model selection scores. Free params for full-cov GaussianHMM:
    #   transitions: k*(k-1)   start: k-1   means: k*d   covars: k*d*(d+1)/2
    d = X_scaled.shape[1]
    n_obs = X_scaled.shape[0]
    n_params = (n_states * (n_states - 1)) + (n_states - 1) + (n_states * d) \
        + (n_states * d * (d + 1) // 2)
    aic = -2.0 * loglik + 2.0 * n_params
    bic = -2.0 * loglik + n_params * np.log(n_obs)

    return HMMResult(
        n_states=n_states, states=states, posteriors=posteriors,
        means=means, stds=stds, transmat=transmat, pct_time=pct_time,
        dwell=dwell, labels=labels, loglik=loglik, aic=aic, bic=bic,
        converged=bool(model.converged_),
    )
