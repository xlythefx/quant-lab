# TradeStation WebAPI v3 — Endpoint Reference

Reference notes for the endpoints quant-laptop's ingestion connector will
call. Populated incrementally as Christian forwards documentation pages.

> Sections marked **[to populate]** are placeholders. Drop the relevant
> doc content under each one verbatim, then translate into the implementation
> notes below it. **Do not invent endpoint behavior** — only document what
> the official TS docs say.

---

## Documentation portal

- Main portal: <https://api.tradestation.com>
- Docs landing: <https://api.tradestation.com/docs/>
- Implementation specifications: API Specifications page (linked from
  the docs landing) — **[to populate]** with the specific URL.

## API versions

TradeStation supports two versions concurrently:

| Version | Base URL | Status |
|---|---|---|
| v3 | `https://api.tradestation.com/v3` | **Recommended** — new features land here |
| v2 | `https://api.tradestation.com/v2` | Maintained but feature-frozen; sunsetting once all v2 services are upgraded |

Both versions support stocks, options, futures.

**Decision:** quant-laptop uses **v3 only.** No v2 fallback code.

**Open questions** (track in `decisions.md`):
- Sim/dev base URL — the welcome page only documents the production URL.
  Typically TS exposes a sim environment at a different host. **[verify]**

---

## Authentication

Full coverage in dedicated documents — keep this section as a pointer
to avoid drift:

- [`auth-code-flow.md`](auth-code-flow.md) — OAuth2 Authorization Code
  Grant flow (verbatim from official TS docs): authorize URL,
  token-exchange URL, all required params, scopes reference, example
  request/response.
- [`auth-fundamentals.md`](auth-fundamentals.md) — Auth0 API key
  defaults: app type, refresh token behavior (non-expiring by default),
  default scopes, allowed callback URLs.
- [`faq.md`](faq.md) — distinction between **Auth0** and **OAuth2**
  key formats, key-issuance contact, version recommendation.
- [`setup.md`](setup.md) — operational checklist that wires the above
  into a working credential.

Confirmed facts (no `[verify]` needed):
- Authorize URL: `https://signin.tradestation.com/authorize`
- Token URL: `https://signin.tradestation.com/oauth/token`
- Required `audience`: `https://api.tradestation.com`
- Access token lifetime: **1200 seconds (20 minutes)**.
- Refresh tokens: **non-expiring by default** (can be set to rotate
  every 40 min on request to Client Experience).
- Required scopes for market data ingestion:
  `openid offline_access MarketData`.

Still open:
- Sim vs live environment differences — tracked as D-3 in
  [`decisions.md`](decisions.md). The OAuth host appears env-agnostic
  (single `signin.tradestation.com`), but the API base URL is.
- Auth0-vs-OAuth2 key flow reconciliation — tracked as D-10.

---

## Market Data — Historical Bars

**Endpoint:** `GET /v3/marketdata/barcharts/{symbol}`

**Used by:** prototype step 2.

**[to populate]** — drop the full barcharts docs here when forwarded.

What we know from Christian's brief:
- Returns OHLCV bar data for a single symbol.
- Symbol in URL path (URL-encoded — `@NQ` becomes `%40NQ`).

What we need to confirm from the docs:
- Query parameter names. Most likely (based on TS v3 conventions):
  - `interval` (number) + `unit` (`Minute`, `Daily`, `Weekly`, `Monthly`)
  - `barsback` (number) for fixed count, OR
  - `firstdate` + `lastdate` (ISO 8601) for explicit range
  - `sessiontemplate` — e.g. `Default`, `USEQPreAndPost`, `USEQPre`,
    `USEQPost`. **[verify full list]**
  - `extendedhours` (bool) — **[verify]** may overlap with sessiontemplate
- Response shape:
  - Top-level field name (`Bars`? `bars`?)
  - Per-bar fields: `TimeStamp` / `Open` / `High` / `Low` / `Close` /
    `TotalVolume` / `DownTicks` / `UpTicks` / `DownVolume` / `UpVolume`
    / `OpenInterest` — **[verify exact field names]**
- Timestamp format: ISO 8601, timezone marker — **[verify]**.
- Max bars per request: historically ~57k, but verify current limit.
- Pagination: typically `lastdate` walks backward — **[verify pattern]**.

---

## Market Data — Quotes (Snapshot)

**Endpoint:** `GET /v3/marketdata/quotes/{symbols}`

**Used by:** post-prototype (snapshot quote needs).

**[to populate]** — drop the full quotes docs here when forwarded.

What we know:
- Multi-symbol — comma-separated symbol list in URL path.

What we need to confirm:
- Response shape per symbol — typically includes `Ask`, `Bid`, `Last`,
  `Volume`, `TradeTime`, etc. **[verify]**
- Max symbols per request **[verify]**.

---

## Market Data — Streaming Quotes

**Endpoint:** `GET /v3/marketdata/stream/quotes/{symbols}` **[verify path]**

**Used by:** post-prototype (only if quant-laptop needs sub-bar updates).

**[to populate]**

What we know:
- Long-lived HTTP response, chunked transfer, newline-delimited JSON.
- Heartbeat events interleaved with data events.

---

## Market Data — Streaming Bars

**Endpoint:** `GET /v3/marketdata/stream/barcharts/{symbol}` **[verify path]**

**Used by:** prototype step 3.

**[to populate]** — drop the full streaming barcharts docs here.

What we know:
- Long-lived HTTP response, chunked transfer, newline-delimited JSON.
- Emits forming-bar updates (same `ts_utc` re-sent) and final closed bars.
- Emits heartbeats — used as liveness signal by our watchdog.

What we need to confirm:
- Exact query parameters (probably mirrors the REST `barcharts` endpoint).
- Heartbeat event payload — field name, frequency.
- Error event payload.
- TS-side connection time cap (historically ~25–30 min before forced
  disconnect — implementation must handle gracefully).

---

## Endpoints intentionally not used

The data connector deliberately scopes itself to market data:

| Endpoint family | Reason for exclusion |
|---|---|
| `/v3/orderexecution/*` | Execution is MultiCharts' responsibility per Christian's brief. |
| `/v3/brokerage/accounts/*` | Not needed for ingestion. Adds scope/auth surface. |
| `/v3/marketdata/options/*` | Out of initial scope. Add when options strategies arrive. |

---

## Rate limits, errors, retries

**[to populate]** — TS docs section on rate limiting.

What we need to know:
- Requests/second cap per app / per IP.
- Burst allowance.
- How rate-limit responses are signaled (429 status? `Retry-After` header?).
- How to recover gracefully — exponential backoff parameters.

---

## How to update this file

1. When Christian forwards a TS docs page, paste it verbatim under the
   matching `**[to populate]**` marker. Wrap long doc content in
   `<details>` blocks if it bloats the file.
2. Then write a short "What this means for us" section directly under
   the pasted content, translating the spec into:
   - exact request shape we'll send
   - exact fields we'll extract
   - any edge cases the docs flag
3. Update the **[verify]** flags above as facts get confirmed.
4. If the docs reveal new endpoint families we'll use, add a new section.
