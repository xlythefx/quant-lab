---
tags: [concept]
type: idea
---

# Validation and Overfitting

The core discipline of this project. A rising backtest equity curve is **evidence, not proof** — it measures the *past* and can't, by itself, tell a **real repeatable edge** from a strategy that just **fit this one history's noise**. Both make the same beautiful line.

## Why a good backtest can still break live

- **Overfitting** — every knob fits some noise; noise doesn't repeat.
- **Non-stationarity** — markets change; edges fade / get arbitraged.
- **Idealized sim** — real slippage, fills, latency, spread (worst exactly when it "made" money).
- **One sample** — the curve is one roll of the dice (see [[Monte Carlo]]).
- **Selection bias** — cherry-picking the best of many tries.

## How to upgrade the evidence

1. **Out-of-sample is the judge** → [[Walk-Forward]] (an equity curve built only from unseen data).
2. **Prefer a plateau, not a spike** (robust region of params, not a lucky peak) → [[Grid Search]].
3. **Beat the no-filter baseline** — a [[Filters and Sessions|filter]] must *earn its place*.
4. **Survive realistic costs** → [[Cost Sweep]].
5. **Final untouched holdout, then real-time paper.**

Honesty metrics live in [[Analytics]] (t-test / p-value, prob-of-ruin, top-10 luck flags). Applies to [[Regime Detection]] and every other filter.

Related: [[Filters and Sessions]]
