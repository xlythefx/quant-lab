---
tags: [area]
type: overview
---

# Backend

Flask + SocketIO entrypoint: `backend/app.py` (port 6173). Routes are blueprints under `backend/routes/`; logic lives in `backend/services/`.

## Key services

- `services/market_data.py` — Parquet cache → [[Data]]
- `services/backtest_engine.py` → [[Backtest Engine]]
- `services/portfolio_runner.py` → [[Portfolio Runner]]
- `services/walkforward.py` → [[Walk-Forward]]
- `services/market_lab.py` → [[Market Lab]]
- `services/quant_metrics.py` — Sharpe/Sortino/Calmar, t-test, VaR, prob-of-ruin (see [[Analytics]])
- `services/strategy_registry.py` — auto-discovers [[Strategies]]
- `services/event_bus.py` — `emit(event, payload, to=sid)` socket progress channel

Strategies live in `services/strategies/` → [[Strategies]]. Regime math: `services/strategies/regime.py` (deterministic) and `regime_hmm.py` (HMM) → [[Regime Detection]].

Related: [[Architecture]] · [[Frontend]]
