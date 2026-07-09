# Python Backend — API & Data Contracts

The prototype fakes everything client-side. For integration, the **Python backend** owns market data ingestion, the order/execution layer, the strategy engine, and analytics. The React frontend consumes **REST for snapshots/commands** and **WebSocket for live streams**. Shapes below match what the UI already expects (see `ARCHITECTURE_REACT.md` for the TS interfaces) — keep field names/units aligned so the frontend mapping is trivial.

Framework-agnostic, but the natural fit is **FastAPI** (async REST + native WebSocket) with **Pydantic** models, a pub/sub fan-out (Redis pub/sub or asyncio queues) bridging exchange feeds to client sockets, and the strategy engine as async workers (asyncio tasks or Celery) emitting events.

> Auth/transport conventions (JWT, base path, error envelope, pagination) should follow the existing backend. Examples below omit auth headers for brevity.

---

## REST endpoints (snapshots & commands)

### Reference data
```
GET  /api/instruments
→ Instrument[]   # venue, cls, symbol, base, meta (class-specific)

GET  /api/instruments/{venue}/{symbol}
→ Instrument     # includes live-ish meta (mcap/pe/... | adv/dec/movers | swaps/rateDiff)
```

### Market snapshots (initial paint; live updates come over WS)
```
GET  /api/candles?venue=&symbol=&tf=5m&limit=50
→ Candle[]                         # {t,o,h,l,c,v}; tf ∈ 1m,5m,15m,1H,4H,1D

GET  /api/orderbook?venue=&symbol=&depth=15
→ { bids: BookLevel[], asks: BookLevel[], ts }

GET  /api/trades?venue=&symbol=&limit=42            # time & sales
→ Trade[]

GET  /api/funding?venue=&symbol=
→ { rate, predicted, nextFundingTs, longShortRatio }   # perp only

GET  /api/open-interest?venue=&symbol=&window=24h
→ { series: number[], current }    # series in $B

GET  /api/liquidations?venue=&symbol=&limit=14
→ Liquidation[] + { longUsd, shortUsd }                # perp only

GET  /api/markets                                       # MARKETS table
→ { instruments: Array<{ symbol, last, chg24h, funding, volume, spark: number[] }> }
```

### Portfolio / risk / blotter
```
GET  /api/account            → { equity, dayPnl }
GET  /api/positions          → Position[]
GET  /api/risk               → { cards:{equity,dayPnl,gross,netDelta,marginUsed,freeMargin,var1d,maintMargin,leverage,utilPct},
                                  exposures:[{symbol,side,notional}], correlation:number[][], symbols:string[],
                                  positionRisk:[{symbol,lev,notional,liqPrice,distPct,uPnl}] }

GET  /api/orders             → WorkingOrder[]
POST /api/orders             body:{symbol,venue,side,type,price,size,lev,postOnly}
   → MARKET ⇒ { fill: Fill }     LIMIT/etc ⇒ { workingOrder: WorkingOrder }
DELETE /api/orders/{id}      → { ok: true }
GET  /api/fills?limit=       → Fill[]
```

### Strategies / deployments / journal
```
GET  /api/strategies                 → Strategy[]            # static catalog (5 types)
GET  /api/deployments                → Deployment[]
POST /api/deployments                body:{stratId,symbol,venue,tf,preset,params,webhookId}
   → Deployment
PATCH /api/deployments/{id}          body:{status:'RUNNING'|'PAUSED'}   → Deployment
DELETE /api/deployments/{id}         → { ok:true }
POST /api/deployments/{id}/test-signal → { ok:true }         # emit a manual test signal
GET  /api/webhooks                   → Webhook[]

GET  /api/trades/journal?period=30D&strat=&symbol=&venue=     # TRADE LOG
→ JournalTrade[]

GET  /api/analytics?period=30D&group=strat&filter=...        # ANALYTICS
→ { stats:{net,win,pf,sharpe,maxdd,exp,avgHold,n}, curve:number[],
    breakdown:[{ key, label, net, win, pf, sharpe, exp, n }] }
```

### Alerts
```
GET  /api/alerts             → Alert[]
POST /api/alerts             body:{symbol,venue,type,cond,val}   → Alert
DELETE /api/alerts/{id}      → { ok:true }
```

---

## WebSocket streams (live)

One multiplexed socket is recommended: `wss://…/ws`. Client subscribes per channel; server fans out. Envelope:

```jsonc
// client → server
{ "op": "subscribe",   "channel": "orderbook", "venue": "BINANCE", "symbol": "BTC/USDT" }
{ "op": "unsubscribe", "channel": "orderbook", "venue": "BINANCE", "symbol": "BTC/USDT" }

// server → client
{ "channel": "ticker", "venue": "BINANCE", "symbol": "BTC/USDT", "ts": 1730000000000,
  "data": { "price": 68120.7, "changePct": -0.04, "high": 68297, "low": 68026, "vol": 83900 } }
```

| Channel | Push cadence (guideline) | `data` payload |
|---|---|---|
| `ticker` | on tick (≤1–2/s) | `{ price, changePct, high, low, vol }` — updates price header, candle close |
| `candles` | on bar close / partial | `{ candle: Candle, partial: bool }` — append or replace last |
| `orderbook` | ≤2/s or on change | `{ bids: BookLevel[], asks: BookLevel[] }` (top 15) |
| `trades` | per print | `Trade` (append, cap ~42) |
| `funding` | on update | `{ rate, predicted, nextFundingTs, longShortRatio }` |
| `openInterest` | periodic | `{ value }` (append to 24h series) |
| `liquidations` | per event | `Liquidation` (append + accumulate long/short totals) |
| `positions` | on fill / mark | `Position[]` (or deltas) — also recomputes account equity/day-P&L |
| `news` | on headline | `{ t, headline, sentiment: 'Bullish'|'Bearish'|'Neutral' }` |
| `strategy` | on engine event | `{ deploymentId, trade: JournalTrade, signal? }` — append to journal, bump deployment pnl/n, refresh analytics if open |
| `gateway` | ~0.5 Hz | `{ latencyMs, session, feed: 'OK'|'DEGRADED' }` — footer |

**Subscription lifecycle:** subscribe to `ticker/candles/orderbook/trades` (and perp-only `funding/openInterest/liquidations`) for the **currently selected instrument**; resubscribe on symbol switch. `positions/news/strategy/gateway` are account-global (subscribe once). Throttle/coalesce high-rate channels server-side to roughly the cadences in the table — the UI doesn't need every L2 delta, it renders snapshots.

---

## Strategy engine (backend)
The prototype's `engineTick()` is a placeholder for a real **automated execution engine**:
- Each `Deployment` binds a `Strategy` (params/preset) to an `(instrument, timeframe)` and a `Webhook` target.
- A `RUNNING` deployment evaluates its rule on each new bar/event and, on a signal, fires the order (directly or by POSTing to the configured **webhook URL** — e.g. a TradingView-style `{secret}` payload to the broker bridge).
- Realized trades are persisted as `JournalTrade` rows and streamed on the `strategy` channel; deployment `pnl`/`n` accumulate.
- Analytics (`/api/analytics`, journal) are computed server-side from persisted trades — port `computeStats` (net, win%, profit factor, Sharpe (annualized), max drawdown, expectancy in R, avg hold, cumulative equity curve) to Python so the frontend just renders.

Strategy catalog to seed (id, name, type, asset classes, key params):
- `vwma_z` — **VWMA Z-Reversion** (Mean Reversion; perp/stock/index/fx): lookback, zEntry σ, zExit σ, stop %, target %, size %eq, leverage.
- `momo` — **Momentum Breakout** (Momentum; perp/stock/index): channel, confirm bars, stop, target, size, leverage.
- `funding` — **Funding Arbitrage** (Carry; perp only): funding ≥ threshold, hold hours, size, leverage.
- `liqfade` — **Liquidation Fade** (Contrarian; perp only): liq-spike ≥ $M, stop, target, size, leverage.
- `trend` — **Trend Follower (EMA X)** (Trend; perp/stock/index/fx): fast EMA, slow EMA, stop, target, size, leverage.
Each has Conservative / Balanced / Aggressive presets (param overrides).

---

## Units & conventions (match the prototype)
- Prices: native instrument precision (crypto perps 1–2 dp, FX 4 dp, stocks 2 dp). The prototype derives decimals per instrument — expose a `priceDecimals` per instrument or infer.
- Funding rate: percent per 8h (e.g. `0.0082` = +0.0082%). Positive ⇒ longs pay shorts.
- Open interest series: $ billions.
- Liquidation `usd`: $ thousands in the feed labels (`$154.3K`).
- P&L / R: P&L in account currency (USD); `R` = multiple of risk. Win rate in %.
- Timestamps: epoch ms (UTC). Clock/labels render `HH:MM:SS UTC`.
- Sign convention drives color everywhere: `value >= 0` → green, `< 0` → red.

> **Security note:** the prototype's seeded webhook URLs/secrets are dummy placeholders for layout only — do not ship them. Real webhook targets/secrets must come from backend config/secrets management, never hardcoded in the frontend.
