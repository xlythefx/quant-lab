# Reference — Binance order book API (for the live Order Book panel)

**Purpose:** how to wire the Trading workspace's **Order Book** panel to real Binance
data when we move it off SIMULATED. Verified against Binance's official docs, Jul 2026.

## TL;DR recommendation

For a **display panel** showing the top ~15–20 levels, use the **Partial Book Depth
Stream** — it pushes a full top-N snapshot each tick, so there's **no local-book
reconciliation** to maintain. Only use the diff-stream + REST-snapshot dance if we ever
need the *full* depth of book.

- Stream: `btcusdt@depth20@100ms` (and `ltcusdt@depth20@100ms`)
- Optional first paint: one REST `depth` call, then let the stream drive updates.

## REST snapshot — `GET /api/v3/depth`

- URL: `https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=20`
- Params: `symbol` (required), `limit` (default 100, max 5000; use 20 for the panel).
- Response:
  ```json
  { "lastUpdateId": 1027024,
    "bids": [ ["67890.10", "1.234"], ... ],   // [price, qty] as STRINGS, best first
    "asks": [ ["67891.00", "0.512"], ... ] }
  ```
- Request weight by limit: 1–100 → 5, 101–500 → 25, 501–1000 → 50, 1001–5000 → 250.

## WebSocket — Partial Book Depth Stream (use this for the panel)

- Base URL: `wss://stream.binance.com:9443` (or `:443`).
- Stream name: `<symbol>@depth<levels>` or `<symbol>@depth<levels>@100ms`
  - Valid `<levels>`: **5, 10, 20**
  - Update speed: 1000ms (default) or **100ms**
  - `<symbol>` is lowercase, no slash: `btcusdt`, `ltcusdt`.
- Combined stream (both symbols on one socket):
  `wss://stream.binance.com:9443/stream?streams=btcusdt@depth20@100ms/ltcusdt@depth20@100ms`
- Payload (per push):
  ```json
  { "lastUpdateId": 160,
    "bids": [ ["0.0024","10"], ... ],
    "asks": [ ["0.0026","100"], ... ] }
  ```
  → map straight to the panel's `PRICE / SIZE / TOTAL` (cumulative depth) rows.

## WebSocket — Diff. Depth Stream (only if we need the FULL book)

- Stream: `<symbol>@depth` or `<symbol>@depth@100ms`.
- Payload: `{ e:"depthUpdate", E, s, U (first update id), u (final update id), b:[[p,q]], a:[[p,q]] }`.
- To maintain a correct local book: get a REST snapshot, buffer stream events, drop
  events with `u <= lastUpdateId`, ensure the first applied event has
  `U <= lastUpdateId+1 <= u`, then apply `b`/`a` deltas (qty `0` = remove level).
  (This is the fiddly path — avoid unless a full book is required.)

## Notes for QuantLab integration

- Spot vs perps: the design is perp-centric (funding/liquidations). If we later want
  those, the **USDⓈ-M Futures** feed is `fapi` (`https://fapi.binance.com/fapi/v1/depth`,
  WS `wss://fstream.binance.com`). For the order book panel, spot `btcusdt@depth20` is
  fine to start; switch host if we go perps.
- No API key needed for public market-data depth streams.
- Coalesce/throttle to the panel's ~1.5s render cadence server-side (per 03) — we don't
  need every 100ms frame on screen.
- CCXT (already in the stack) can also fetch the snapshot (`fetch_order_book`), but for
  the live stream a direct websocket to the partial-depth stream is simplest.

## Sources

- [Spot WebSocket Streams (partial + diff depth)](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md)
- [Spot REST market-data endpoints (/api/v3/depth)](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints)
- [Manage a local order book correctly](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)
