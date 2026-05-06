# Quantlab

Real-time crypto quant dashboard. Streams BTCUSDT and FETUSDT only, with a
**Backtest mode (default)** that replays cached historical klines and a
**Live mode** that consumes Binance WebSocket streams. Foundation for a
future signal/strategy/execution stack.

```
quantlab/
├── backend/       Flask + Flask-SocketIO + CCXT + websocket-client
└── frontend/      Vite + React + Tailwind + Lightweight Charts + Socket.IO
```

---

## Run

### Backend (PowerShell, Windows)
```
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Linux/macOS:
```
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Backend listens on `http://localhost:5000`.

### Frontend
```
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

### One-time backtest cache

The first time you select a (symbol, timeframe) in backtest mode, the
backend downloads ~2 years of klines via CCXT and writes
`backend/data/<symbol>_<tf>.parquet`. Subsequent loads are instant.

You can also pre-warm from the CLI:
```
curl -X POST http://localhost:5000/api/backtest/prepare ^
     -H "Content-Type: application/json" ^
     -d "{\"symbol\":\"BTCUSDT\",\"timeframe\":\"1m\"}"
```

---

## API

| Method | Path                       | Notes                                      |
|--------|----------------------------|--------------------------------------------|
| GET    | /api/health                | `{status: "ok"}`                           |
| GET    | /api/symbols               | symbols, timeframes, modes, default_mode    |
| GET    | /api/ohlcv                 | `?symbol=&timeframe=&limit=&mode=`         |
| POST   | /api/backtest/prepare      | body `{symbol, timeframe}`                 |

Socket.IO events (client → server): `subscribe`, `unsubscribe`, `set_speed`.
Server → client: `connected`, `subscribed`, `candle_update`, `speed_changed`, `error`.

`candle_update` payload (identical in both modes):
```json
{
  "time": 1730000000,
  "open": 67000.1, "high": 67050.0, "low": 66980.0, "close": 67042.5,
  "volume": 12.34,
  "isClosed": false,
  "mode": "live",
  "symbol": "BTCUSDT",
  "timeframe": "1m"
}
```

---

## Architecture

### Two modes, one chart contract

The browser doesn't care whether candles come from Binance live or from a
Parquet replay — it just renders `candle_update` frames. This is the
contract that future signal/strategy code will consume too: a strategy
debugged in backtest mode runs in live mode unchanged.

### Stream registry + Socket.IO rooms

`SocketManager` keeps one stream instance per `(mode, symbol, timeframe)`
key, regardless of how many browsers are subscribed. Each browser joins
the room `{mode}_{symbol}_{tf}` and Flask-SocketIO fans out updates. The
last subscriber to leave stops the underlying stream.

```
Browser A ─┐
Browser B ─┼─► room "live_BTCUSDT_1m" ◄─ BinanceKlineStream(BTCUSDT/1m)
Browser C ─┘
```

### Live: Binance kline WebSocket

Connects to `wss://stream.binance.com:9443/ws/<symbol_lower>@kline_<tf>`.
Binance pushes ~1 frame/sec while the candle is forming, plus a final
frame with `k.x == true` at the candle boundary. We parse and emit.

**Reconnect logic:** on socket close or error, sleep
`min(30, 2^attempts)` seconds, then reconnect. Backoff resets on the
first successful message.

### Backtest: timed Parquet replay

`BacktestStream` reads the cached DataFrame and emits candles at
`TIMEFRAME_SECONDS[tf] / speed` real seconds per bar. To match live
cadence we emit two events per bar — `isClosed:false` then
`isClosed:true` — so the chart's update path is identical between modes.
Loops back to start when the file is exhausted.

Speeds: 1× (real-time), 10×, 60× (default), 300×.

### Why WebSockets, not polling

| | Polling | WebSocket |
|---|---|---|
| Latency | 1–5s | ~100ms |
| Bandwidth | full payload each poll | incremental frames |
| Server load | 1 request × N clients | 1 connection × M streams |
| Boundary correctness | races at candle close | Binance flags `k.x` for you |

### Lightweight Charts behavior

`series.update(candle)` either replaces the in-progress bar (same `time`)
or appends a new bar (later `time`). That's exactly what we want for both
forming ticks and closed ticks — no manual book-keeping in the UI.

---

## Future scaling

- Replace in-memory `StreamRegistry` with Redis pub/sub for multi-worker
  Flask deploys.
- Promote `data/` cache to a partitioned Parquet store (`year=YYYY/month=MM`)
  for multi-year backtests; add a tick-level archive when sub-candle
  realism matters.
- `services/signals/` consumes the same `candle_update` callback that the
  socket fan-out uses — strategies become trivial to attach.
- `services/backtest/` (vectorbt or custom) reads the Parquet cache
  directly for batch optimization, bypassing the realtime replay.
- `services/execution/` behind a feature flag — paper first, broker
  (CCXT live) second. Live mode + execution = the trading bot.
- Frontend grows into the multi-pane layout (positions, PnL calendar,
  equity curve, win-rate widgets) in the design template.

---

## Verification checklist

1. `curl http://localhost:5000/api/health` → `{"status":"ok"}`
2. Prepare cache: `curl -X POST .../api/backtest/prepare -d '{"symbol":"BTCUSDT","timeframe":"1m"}' -H "Content-Type: application/json"` → first call ~30–60s, second instant.
3. Open `http://localhost:5173` — Backtest mode active by default; chart ticks at 60×.
4. Change speed to 300× — emission cadence visibly accelerates.
5. Toggle to Live — DevTools WS frames now carry `mode:"live"` at real-time cadence.
6. Switch symbol/timeframe — clean redraw + new stream.
7. Open a second tab on the same (mode, symbol, tf) — backend logs show ONE underlying stream serving both rooms.
