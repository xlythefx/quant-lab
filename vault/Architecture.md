---
tags: [area]
type: overview
---

# Architecture

Each `(mode, symbol, timeframe)` maps to one backend stream — a live broker WS consumer or a Parquet replay. Browsers join a Socket.IO room and receive fan-out updates; same payload shape in both modes so the UI is mode-agnostic.

- **[[Backend]]** — Flask + Flask-SocketIO on **:6173** (`backend/app.py`). REST routes (blueprints) + socket events.
- **[[Frontend]]** — React + Vite + Tailwind on **:5173**. Hash-based routing (`frontend/src/App.jsx`).
- **[[Data]]** — Parquet OHLCV cache per `(symbol, timeframe, broker)`.

Long jobs (downloads, [[Grid Search]], [[Walk-Forward]]) stream progress to the client over the socket via `services/event_bus.py`. [[Dashboard V2]]'s backtest reuses that channel for live run progress.

Run: `python ui.py` (GUI launcher) or `python backend/app.py` + the Vite dev server.

Related: [[Strategies]] · [[Backtest Engine]] · [[Portfolio Runner]]
