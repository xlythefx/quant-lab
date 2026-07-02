---
tags: [concept]
type: idea
---

# Filters and Sessions

A **filter** is you saying *"my edge lives in this subset — don't trade outside it."* It only pays off if the asset's edge is *actually concentrated* there. **No filter is universal** — each must earn its place per **strategy + asset**, out-of-sample → [[Validation and Overfitting]].

Two independent filter kinds in [[VWMA Reversion]]:

- **Time-of-day** (`sessions` / `trade_24_7`) — *which hours* you trade. LTC: edge spread around the clock → 24/7. FET/BTC: edge clumps in hours → session windows help.
- **Market regime** ([[Regime Detection]]) — *what the market is doing*. Helps mean-reversion avoid trends; a trend-follower would want the opposite.

> Both reduce trade count (smaller sample, more variance) and add a knob (more overfit risk). Picking "the best hours/regimes" from one backtest is a classic data-snooping trap.

## Idea: data-driven session discovery (overfit-safe)

Run unfiltered, score each hour/session **out-of-sample across [[Walk-Forward]] windows**, keep only the hours that win *consistently* (average across windows = persistence test), collapse those into a session config. The hour×day heatmap in [[Market Lab]] / [[Analytics]] is the in-sample starting point.

Related: [[Regime Detection]] · [[Validation and Overfitting]]
