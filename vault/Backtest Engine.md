---
tags: [engine]
type: engine
---

# Backtest Engine

`backend/services/backtest_engine.py`. `run(strategy_id, symbol, timeframe, ...)` → candles / trades / equity / stats / analytics. Also builds the chart's regime bands via `_regime_segments(sig_df, params)` → `{five, adx, default}` (the `default` lens follows `regime_method`).

> **Two engines exist.** Single-strategy runs from [[Dashboard V2]] actually go through [[Portfolio Runner]] (its own sim loop), *not* this `run()`. Both reuse `_compute_stats` / `_compute_analytics`, so they must stay in sync.

Stats/analytics come from `services/quant_metrics.py` (Sharpe, Sortino, Calmar, t-test, VaR/CVaR, prob-of-ruin) → surfaced in [[Analytics]].

Sizing/fee branch (futures vs crypto) lives here → [[Sizing and Fees]].

Related: [[Portfolio Runner]] · [[Walk-Forward]] · [[Strategies]]
