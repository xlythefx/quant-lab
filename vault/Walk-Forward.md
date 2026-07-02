---
tags: [validation]
type: tool
---

# Walk-Forward

`backend/services/walkforward.py` + `pages/WalkForward.jsx`. The **honest test** for whether a strategy has a real edge or just fit the past → [[Validation and Overfitting]].

## What it does, in plain words
1. Take a chunk of history, **tune the params on it** (this chunk is *in-sample*).
2. **Test those params on the *next* chunk** the tuning never saw (*out-of-sample*).
3. Slide the window forward and repeat, across the whole history.
4. **Glue all the out-of-sample pieces end-to-end** into one equity curve.

That stitched out-of-sample curve is the closest thing to *"what live would have looked like,"* because every point on it came from data the strategy hadn't seen when its params were chosen. If *that* line goes up, you have something. If only the full-history backtest looked good but this one doesn't, it was overfit.

## The words on the page (glossary)
- **In-sample (IS)** — the window you *tune* on.
- **Out-of-sample (OOS)** — the next window you *test* on; untouched during tuning. The trustworthy part.
- **Window / fold** — one IS→OOS pair. You get many across the history.
- **Stitched OOS equity** — all the OOS pieces joined into one curve.
- **Walk-forward efficiency (WFE)** — how much of the in-sample performance *survives* out-of-sample. ~100% = it held up; low = the in-sample result was mostly fitting.
- **Parameter stability score** — does the tuner keep picking *similar* values each window? High = stable.
- **Parameter drift chart** — a picture of the chosen value wandering window to window (flat lines = stable choices). See [[Parameter Sensitivity]].
- **Deflated Sharpe** — Sharpe knocked down to account for *how many things you tried* (guards against "found by luck").
- **Seed robustness verdict** — re-runs across optimizer seeds → **robust / mixed / fragile / weak** (`walkforward_robustness.py`).

## How to read a run (quick checklist)
- Does the **OOS curve** rise? (the main thing)
- Is **WFE** decent, not near zero?
- Are the **params stable** (low drift)?
- Is the **verdict robust**, not fragile?
- All yes → trust it more. Any strong no → be skeptical.

> Note: Walk-Forward shows *drift/stability*, **not** a Grid-Search-style plateau (performance across values). That plateau is in-sample only → [[Parameter Sensitivity]].

Related: [[Portfolio Runner]] · [[Grid Search]] · [[Filters and Sessions]]
