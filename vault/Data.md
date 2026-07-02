---
tags: [area]
type: overview
---

# Data

`services/market_data.py`: `load_parquet(symbol, timeframe, broker=None)` → DataFrame with `[time (int sec), open, high, low, close, volume]`. Raises `FileNotFoundError` if not cached; `ensure_parquet(...)` downloads ~2yr first.

- Files: `backend/data/{binance,databento,tradestation}/{SYMBOL}_{TF}.parquet`
- Cached crypto: `BTCUSDT`, `FETUSDT`, `LTCUSDT` at `1m/5m/15m/1h`.
- CME futures (ES/NQ/CL/GC) via Databento → needs `DATABENTO_API_KEY` in `backend/.env`.
- Brokers in `services/brokers/` (binance, databento, tradestation, dukascopy).
- CL gotcha: raw `CL.v.0` has roll seams; a de-seamed `databento_v2` exists.

Consumed by [[Backtest Engine]], [[Portfolio Runner]], [[Market Lab]]. Sizing differs by asset → [[Sizing and Fees]].

Related: [[Backend]] · [[Architecture]]
