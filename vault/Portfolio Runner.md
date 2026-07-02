---
tags: [engine]
type: engine
---

# Portfolio Runner

`backend/services/portfolio_runner.py` — walks N strategies through **one shared cash pool** on a unified timeline; same-bar conflicts resolved by `priority`; cash-gated skips logged with counterfactual P&L. N=1 reproduces the single-strategy result.

This is the engine behind [[Dashboard V2]] (route `/api/backtest/portfolio`). It calls each strategy's `vectorized()` (where the [[HMM Regime]] fit happens for HMM-gated runs).

## Live run progress

Emits `backtest_progress` socket events to the requesting client's `sid` *during* the synchronous run (via `services/event_bus.py`): per-strategy stage, then `simulate`, then `stats`. For HMM it sets `strategy._progress` so the fit streams **per-refit** progress. The [[Dashboard V2]] strip shows these live.

Returns the rich payload [[Analytics]] reads (per-strategy stats, correlation block, skipped signals).

Related: [[Backtest Engine]] · [[Sizing and Fees]] · [[Walk-Forward]]
