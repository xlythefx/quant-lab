---
tags: [area]
type: overview
---

# Strategies

A `Strategy` subclass in `backend/services/strategies/` with a `META` and `PARAM_SCHEMA` auto-registers (`services/strategy_registry.py`). Implement:

- `vectorized(df)` — batch backtest → entry/exit/stop columns (+ `cond_*` for the pyramiding/MTM path).
- `on_candle(candle, state)` — live, one bar at a time.

Base classes + param types: `services/strategies/base.py` (`ParamSpec`, `ParamType` = int/float/bool/**select**/sessions/sides/regimes; `Signal`, `OverlaySpec`).

## Notable strategies

- [[VWMA Reversion]] — `vwma_reversion.py`, the reference (z-score mean reversion); the only one using [[Regime Detection]] gating.
- `vwma_momentum.py`, `pivot_breakout.py`, `rsi2_reversion.py`, `donchian_breakout.py`, `lunar.py`, …

The AI Strategy Builder writes/edits files here safely via `services/strategy_files.py` (AST-checked, smoke-tested, reversible to `_trash/`). UI: [[Frontend]] → `pages/StrategySandbox.jsx`.

Backtest a strategy → [[Backtest Engine]] / [[Portfolio Runner]]. Sizing/fees → [[Sizing and Fees]].

Related: [[Backend]] · [[Dashboard V2]]
