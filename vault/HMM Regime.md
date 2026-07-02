---
tags: [method]
type: method
---

# HMM Regime

`backend/services/strategies/regime_hmm.py` — a **causal Gaussian HMM** implemented from scratch (Baum-Welch EM, log-space forward-backward, full-covariance emissions, KMeans init) because `hmmlearn` won't build on Python 3.14.

- **Causal**: features are trailing-window only; the model is re-fit on a rolling window every `refit_every` bars; labels come from the *filtered* posterior (no look-ahead). So forward-return stats are honest.
- Features: log return, 20-bar realized vol, rolling Hurst (R/S), standardized.
- `causal_hmm_labels(df, params, on_progress=None)` — the public entry. `on_progress(done, total)` reports per-refit progress (used by [[Dashboard V2]]'s live run bar).

## Mood taxonomy (the names)

Fixed, merged set: **Bearish Volatile, Bearish Normal, Ranging, Bullish Normal, Bullish Volatile**, plus **Undecided** (low confidence) and **Warmup** (pre-fit). Direction comes from a drift-to-noise ratio (`trend/rv`), volatility from a cross-state split. Hurst is *not* used to name states (its R/S estimate is biased high — it made everything read "trending"). Tunable: `n_states` (default 5), `ranging_ratio`, `undecided_below`.

Caveats: capped to recent ~15k bars for speed (Market Lab knob up to 60k). Gating a backtest with HMM is **slow** (re-fit) → cached.

Related: [[Regime Detection]] · [[Market Lab]] · [[VWMA Reversion]]
