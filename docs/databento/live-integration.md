# Live integration design (later phase)

> **Future phase — not part of the historical milestone.** This is a design sketch
> for when quantlab streams live CME data. Build the historical feed first
> ([historical-integration.md](historical-integration.md)).

quantlab already has a clean live-streaming abstraction; a Databento live feed
slots in as one more `CandleStream` implementation that emits the existing live
candle payload. No frontend or socket-protocol changes needed.

## The existing streaming layer

- `CandleStream` base (`backend/services/stream_base.py`) — subclassed by
  [binance_stream.py](../../backend/services/binance_stream.py)
  (`BinanceKlineStream`) and the backtest replay stream.
- `socket_manager._make_stream(mode, symbol, tf, ...)`
  ([socket_manager.py:42](../../backend/services/socket_manager.py#L42)) selects
  which stream to build per `(mode, symbol, timeframe)` room and fans candle
  updates out over Socket.IO.
- **Live candle payload** every stream emits (from
  [binance_stream.py:50-61](../../backend/services/binance_stream.py#L50-L61)):

  ```python
  {
    "time": int,        # epoch SECONDS
    "open": float, "high": float, "low": float, "close": float, "volume": float,
    "isClosed": bool,   # True on the final frame at the bar boundary
    "mode": "live",
    "symbol": str,
    "timeframe": str,
  }
  ```

A Databento live stream just has to produce this same dict.

## The Live client

```python
import databento as db

live = db.Live()  # DATABENTO_API_KEY from env

live.subscribe(
    dataset="GLBX.MDP3",
    schema="ohlcv-1s",        # or ohlcv-1m / trades / mbp-1
    stype_in="continuous",
    symbols="ES.c.0",
)

for record in live:           # blocking iterator of decoded records
    ...                       # build/emit candles
# or: live.add_stream(file_or_callback) to tee the raw stream
```

Run it on a daemon thread with the same resilience pattern as
`BinanceKlineStream` (reconnect/backoff, `stop()` via an Event).

## Pieces to add

### 1. `backend/services/brokers/databento_stream.py`

A `DatabentoStream(CandleStream)` subclass:

- `subscribe(...)` on start; iterate records on its thread.
- For each record, build the live candle dict above (`time` in **seconds**,
  `isClosed` at the bar boundary) and call `self.on_update(candle)`.
- Reconnect/backoff + clean `stop()`, mirroring
  [binance_stream.py](../../backend/services/binance_stream.py).

### 2. Wire into `socket_manager._make_stream`

Add a branch in
[socket_manager.py:42](../../backend/services/socket_manager.py#L42) that picks
`DatabentoStream` for live mode when the symbol is a Databento/CME instrument
(e.g. present in `assets/databento.json`), the way Binance symbols route to
`BinanceKlineStream` today.

## Candle-construction options

| Source schema | How bars form | Trade-off |
|---|---|---|
| `ohlcv-1s` / `ohlcv-1m` | Databento sends finished bars; aggregate up to the room's TF, emit partials | simplest, lowest cost; minimum granularity is the subscribed bar |
| `trades` | aggregate prints into bars in-process (track O/H/L/C/V per bar window) | full control, true intrabar updates; more code, higher volume |
| `mbp-1` | bars from trades + live BBO for spread modeling | richest; only if microstructure/spread matters |

**Recommended start:** subscribe to `ohlcv-1s` (or `ohlcv-1m`) and aggregate to
the requested timeframe — least code, predictable cost, and it produces the same
"forming bar + closed bar" cadence the frontend already handles via `isClosed`.

## Notes

- Encoding: live records carry the same nanosecond timestamps / 1e-9 fixed-point
  prices as historical (reference.md §4). Convert ns→seconds and (for raw records)
  scale prices by 1e-9; if you decode via the SDK's df/record accessors, prices are
  already real floats — **don't double-scale**.
- Cost/entitlement: live streaming is billed and requires live entitlement for
  `GLBX.MDP3`; `ohlcv-*` is far cheaper than `trades`/`mbp-*`.
- Continuous symbology (`ES.c.0`) is supported on the live API too, so the same
  symbol mapping as historical applies.
