# HMM Regime Experiment (isolated)

A **fully isolated** sandbox for evaluating a Gaussian Hidden Markov Model as an
alternative to QuantLab's deterministic regime detector. Nothing here is imported by
the backend, no strategy/route/`backend/requirements.txt` is touched. It only **reads**
the cached market data and imports the existing deterministic labels for comparison.

The goal of this phase is to judge **how the HMM reads BTCUSDT** — not to trade it.

## What it does

1. Loads BTCUSDT 1h from the backend parquet cache.
2. Builds a causal 3-feature observation vector:
   - **log return** — direction (is it moving?)
   - **realized vol (20)** — risk state (how violently?)
   - **rolling Hurst** — persistence (trending vs mean-reverting?)
3. Standardizes the features and fits a `GaussianHMM` (full covariance, **implemented
   from scratch in numpy/scipy** — see "Why no hmmlearn") for **k = 2, 3, 4**.
4. Relabels states into a stable order (by mean return) and auto-names them
   (e.g. `Bull/Calm (trending)`, `Bear/Volatile (mean-rev)`).
5. Emits, per k: a PNG (price + regime ribbon + feature panels), and a console report
   (state table, transition matrix, dwell times, AIC/BIC, and a cross-tab vs the
   deterministic 5-regime labels). Also a combined per-bar `hmm_bars.csv`.

## Run

```powershell
pip install -r experiments\hmm_regime\requirements-hmm.txt
python experiments\hmm_regime\run_hmm_btc.py
```

Options: `--symbol`, `--timeframe`, `--states 2 3 4`, `--rv-window 20`,
`--hurst-window 100`, `--seed 42`. Output lands in `experiments/hmm_regime/out/`.

## How to read the output

- **PNG ribbon** — do shaded regimes line up with visible bull runs, crashes, and chop?
  Are they *persistent* (meaningful blocks) rather than flickering bar-to-bar?
- **State table** — each state should have a distinct signature (e.g. a high-vol,
  negative-return crash state vs a calm positive-drift bull state).
- **Dwell time** `1/(1-p_ii)` — regimes should persist tens-to-hundreds of bars.
- **AIC/BIC** — which k the data actually supports (lower is better).
- **Cross-tab** — sanity that HMM high-vol states overlap the rule-based `High-Volatility`,
  while still adding nuance the thresholds miss.

## Why no hmmlearn

`hmmlearn` (the usual library) has **no prebuilt wheel for Python 3.14** — installing it
would compile from source and require the MSVC C++ Build Tools. Rather than downgrade the
whole project (it already runs fine on 3.14), the Gaussian HMM is implemented directly in
`hmm_model.py`: Baum-Welch EM with a log-space forward-backward pass, Viterbi decoding,
full-covariance Gaussian emissions, KMeans initialization. Same model class, ~150 readable
lines, only `numpy`/`scipy`/`scikit-learn` (already installed) + `matplotlib` for plots.

## Important caveat

The HMM here is fit on the **full sample**, which uses look-ahead — this is standard and
fine for *visual/diagnostic* exploration, but it is **not tradeable as-is**. Before any
strategy use, the fit must become rolling/expanding (refit on data up to bar i only). The
features are already built causally so that step is a localized change, not a rewrite.

## Files

| File | Role |
|------|------|
| `features.py` | causal feature builder (log-ret, RV20, rolling Hurst R/S) + standardization |
| `hmm_model.py` | from-scratch `GaussianHMM` (Baum-Welch/Viterbi), stable relabeling, human labels, diagnostics |
| `run_hmm_btc.py` | entry point: load → fit k=2/3/4 → plots + CSV + report |
| `requirements-hmm.txt` | isolated dep (`matplotlib` only) |
| `out/` | generated PNGs + CSV (created on first run) |
