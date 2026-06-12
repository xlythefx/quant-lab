"""
Causal (look-ahead-free) HMM regime labeling.

The full-sample fit in hmm_model.py uses EM + Viterbi over the WHOLE series, so a
bar's label depends on future bars — fine for visual exploration, not tradeable.
This module produces labels where bar i uses only information available at bar i:

  1. ROLLING REFIT — re-fit the HMM every `refit_every` bars on a trailing
     `train_window` of data up to that point (or expanding from the start). The
     feature scaler (StandardScaler equivalent) is also fit per-window, so even the
     standardization is causal.
  2. ONLINE FORWARD-FILTERING — the label at bar i is argmax of the FILTERED
     posterior P(state_i | obs_1..i): the forward (alpha) recursion only. No
     backward/smoothing pass (that would use future bars). Filtering lags a touch
     and flickers more than smoothing — that honesty is the whole point.
  3. CANONICAL STATE ALIGNMENT — each refit's states are relabeled by ascending
     mean trend (feature 0), so "state 0 = most bearish" stays fixed across refits.
     That lets the running filter belief carry across refit boundaries unchanged.

Reuses the from-scratch GaussianHMM (Baum-Welch) from hmm_model.py for each refit.
"""
from __future__ import annotations

import numpy as np

from features import FEATURE_NAMES
from hmm_model import GaussianHMM, _order_states, human_label, _lse, _LOG_2PI


def _log_emission(X, means, covars, reg=1e-6):
    """log N(x; mu_k, Sigma_k) for every row of X and state -> (n, k)."""
    n, d = X.shape
    k = means.shape[0]
    out = np.empty((n, k))
    eye = reg * np.eye(d)
    for j in range(k):
        cov = covars[j] + eye
        _sign, logdet = np.linalg.slogdet(cov)
        inv = np.linalg.inv(cov)
        diff = X - means[j]
        maha = np.einsum("ni,ij,nj->n", diff, inv, diff)
        out[:, j] = -0.5 * (d * _LOG_2PI + logdet + maha)
    return out


def _fit_canonical(X_scaled, n_states, seed, n_iter):
    """Fit one GaussianHMM and return its params reordered into canonical
    (ascending-mean-trend) state order, so state ids are comparable across refits."""
    m = GaussianHMM(n_components=n_states, n_iter=n_iter, seed=seed).fit(X_scaled)
    order = _order_states(m.means_)
    return {
        "means": m.means_[order],
        "covars": m.covars_[order],
        "transmat": m.transmat_[np.ix_(order, order)],
        "startprob": m.startprob_[order],
    }


def causal_labels(F, n_states=4, train_window=8760, refit_every=720,
                  warmup=2160, expanding=False, seed=42, n_iter=300):
    """Causal per-bar regime labels via rolling-refit online filtering.

    F            : (N, d) RAW (un-scaled) causal feature matrix (FEATURE_NAMES order).
    train_window : trailing bars used to fit at each refit (ignored if expanding).
    refit_every  : bars between refits.
    warmup       : bars before the first fit; those bars get label -1.
    expanding    : True -> train on all bars [0:i]; False -> trailing window.

    Returns dict: states (N,), posteriors (N,k), n_refits, refit_points (list).
    Warmup bars are state -1 / NaN posterior.
    """
    F = np.asarray(F, dtype=float)
    N, d = F.shape
    states = np.full(N, -1, dtype=int)
    post = np.full((N, n_states), np.nan)

    active = None                 # canonical-ordered params of the current model
    sc_mean = sc_std = None       # causal scaler from the active model's train window
    running = None                # running filtered log-belief (k,), in canonical order
    refit_points = []
    next_refit = warmup

    for i in range(N):
        # --- refit on data up to and including bar i (causal) ---
        if i >= warmup and i >= next_refit:
            lo = 0 if expanding else max(0, i - train_window + 1)
            train = F[lo:i + 1]
            mu = train.mean(axis=0)
            sd = train.std(axis=0)
            sd[sd == 0] = 1.0
            active = _fit_canonical((train - mu) / sd, n_states, seed, n_iter)
            sc_mean, sc_std = mu, sd
            refit_points.append(i)
            next_refit = i + refit_every

        if active is None:
            continue              # pre-first-fit warmup

        # --- online filtering step for bar i with the active model ---
        x = (F[i] - sc_mean) / sc_std
        log_e = _log_emission(x[None, :], active["means"], active["covars"])[0]
        if running is None:
            log_alpha = np.log(active["startprob"] + 1e-300) + log_e
        else:
            log_t = np.log(active["transmat"] + 1e-300)
            log_alpha = log_e + _lse(log_t.T + running, axis=1)
        log_alpha = log_alpha - _lse(log_alpha[None, :], axis=1)[0]   # normalize
        running = log_alpha
        p = np.exp(log_alpha)
        post[i] = p
        states[i] = int(np.argmax(p))

    return {
        "states": states,
        "posteriors": post,
        "n_refits": len(refit_points),
        "refit_points": refit_points,
    }


def state_signatures(F, states, n_states):
    """Per-state RAW feature means/stds + %time + human label, over labeled bars."""
    means = np.zeros((n_states, F.shape[1]))
    stds = np.zeros((n_states, F.shape[1]))
    pct = np.zeros(n_states)
    labeled = states >= 0
    total = int(labeled.sum())
    for s in range(n_states):
        mask = states == s
        pct[s] = mask.sum() / total if total else 0.0
        if mask.any():
            means[s] = F[mask].mean(axis=0)
            stds[s] = F[mask].std(axis=0)
    lo, hi = np.percentile(means[:, 1], [33.3, 66.7])
    labels = [human_label(means[s], stds[s], (lo, hi)) for s in range(n_states)]
    return means, stds, pct, labels


def switch_count(states):
    """Number of regime changes among labeled bars (flicker measure)."""
    s = states[states >= 0]
    return int(np.sum(s[1:] != s[:-1])) if s.size > 1 else 0
