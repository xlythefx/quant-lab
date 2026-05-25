# Prototype Plan — TradeStation Tracer Bullet

Source: Christian's 5-step ask. Goal is the **smallest end-to-end slice that
proves the whole pipeline works** on one symbol (`@NQ`). Once green, expand
to multi-symbol + provider abstraction.

> **Do not skip the reconnect test (step 5).** A connector that "works"
> in a happy-path demo but silently dies on the first network blip is
> the most common failure mode for these systems.

---

## Step 1 — Login (OAuth 2.0)

**What:** Implement the Authorization Code Grant → refresh-token →
access-token flow per [`auth-code-flow.md`](auth-code-flow.md).

**Concretely:**
- One-time, manual bootstrap: redirect user to
  `https://signin.tradestation.com/authorize` with
  `response_type=code`, `client_id`, `audience=https://api.tradestation.com`,
  `redirect_uri=http://localhost:8080`, `scope=openid offline_access MarketData`,
  random `state`. User logs in + consents; TS redirects to
  `http://localhost:8080?code=...&state=...`. We catch with a tiny
  local HTTP listener.
- Exchange code at `https://signin.tradestation.com/oauth/token` (POST,
  form-encoded, `grant_type=authorization_code`). Response includes
  `access_token`, `refresh_token`, `id_token`, `expires_in: 1200`.
- Persist the **refresh token** to `.env` (`TRADESTATION_REFRESH_TOKEN`).
  Per [`auth-fundamentals.md`](auth-fundamentals.md), default refresh
  tokens are **non-expiring** — one bootstrap should last indefinitely.
- Programmatic, repeated: when an access token nears expiry, POST the
  refresh token to the same `/oauth/token` endpoint with
  `grant_type=refresh_token` for a new access token.
- Wrap all REST + stream calls in a helper that injects
  `Authorization: Bearer <access_token>` and refreshes on 401.

**Configurable:**
- `TRADESTATION_ENV` = `sim` or `live` — selects API base URL + the
  `client_id` to use. (OAuth endpoints at `signin.tradestation.com`
  appear to be env-agnostic — needs confirmation, tracked as D-3.)
- `TRADESTATION_CLIENT_ID`, `TRADESTATION_CLIENT_SECRET`,
  `TRADESTATION_REDIRECT_URI` from `.env`.

**Success criteria:**
- `python -m tradestation.auth bootstrap` walks the user through the
  one-time authorization, stores the refresh token, and prints a valid
  access token.
- A second invocation `python -m tradestation.auth refresh` produces a new
  access token using only the stored refresh token (no browser).

**Watch out for:**
- `redirect_uri` must byte-match between authorize and token-exchange
  requests. Mismatched values return `redirect_uri_mismatch` from
  TS. The bootstrap and refresh helpers must read the same env var.
- Default callback URLs are constrained to specific localhost ports
  (`80 / 3000 / 3001 / 8080 / 31022`). The prototype uses `8080`. Any
  other URL requires a Client Experience request — don't pick one
  arbitrarily.
- Refresh tokens are non-expiring by default but **can** be revoked
  (password change, key rotation, key disabled, scope change). Surface
  a clear error and prompt for re-bootstrap rather than retry-looping
  on 401.
- Access tokens expire in 20 minutes (`expires_in: 1200`). Refresh
  proactively (e.g. when <2 min remaining) rather than reactively on
  401, to avoid mid-stream drops.
- `state` parameter must be generated fresh per bootstrap and verified
  on callback — CSRF protection.
- Two TS key formats exist (Auth0 vs OAuth2 — see [`faq.md`](faq.md)).
  Whether they share the same authorize URL or differ is tracked as
  D-10 in [`decisions.md`](decisions.md). The flow above is documented
  for Auth0 keys; if we receive an OAuth2 key, recheck the endpoints.

---

## Step 2 — Request NQ Bars (REST historical)

**What:** Single GET to `/v3/marketdata/barcharts/@NQ` returning N bars.

**Concretely:**
- Endpoint: `GET https://api.tradestation.com/v3/marketdata/barcharts/@NQ`
- Query params (per TS docs — verify exact names in `endpoints.md` as they're collected):
  - `interval=1&unit=Minute` → 1-minute bars (use `60` for 60-min, etc.)
  - `barsback=100` for a fixed count (or `firstdate`/`lastdate` for a range)
  - `sessiontemplate=USEQPreAndPost` / `Default` / etc. — match the session
    template used by the Sinegual sample CSVs.
- Parse JSON response → list of `{TimeStamp, Open, High, Low, Close, TotalVolume, ...}`.

**Decision required (see `decisions.md`):**
- `@NQ` (continuous, back-adjusted) vs `NQM26` (June 2026 contract).
  Christian wrote "NQ" without a prefix — most likely means continuous,
  but the Sinegual sample exports were run on contract-specific symbols
  (`@ESM26`), so be explicit before coding.

**Success criteria:**
- Function `fetch_bars("@NQ", interval="60m", barsback=100)` returns a
  list of dicts with UTC timestamps and OHLCV floats.
- Timestamps are normalized to UTC unix-seconds (matches quant-laptop's
  existing parquet schema; see `architecture.md`).

**Watch out for:**
- TS returns timestamps as ISO 8601 strings in their own timezone — convert
  to UTC explicitly. Do not trust the local zone.
- Per-request bar count is capped (historically ~57k bars). For deep
  backfills, paginate by `lastdate`. The prototype only needs ~100 bars,
  so pagination is post-prototype.

---

## Step 3 — Stream Live Updates

**What:** Long-lived HTTP connection to `/v3/marketdata/stream/barcharts/@NQ`
delivering new bars as they form.

**Concretely:**
- TradeStation streams as **chunked HTTP** (newline-delimited JSON), not
  WebSocket. Use `httpx` (already in `requirements.txt`) with
  `client.stream("GET", url)` and iterate `response.iter_lines()`.
- Each line is either: a bar update (same schema as historical), a
  `Heartbeat` event, or an `Error` event. Branch accordingly.
- Push received bars onto the same `CandleStream` callback interface as
  `stream_base.CandleStream` (existing pattern in
  `backend/services/stream_base.py`) so downstream consumers don't care
  what feed they're on.

**Success criteria:**
- Streaming for 5+ minutes during market hours produces bar updates on
  the expected cadence (one per minute for 1m bars).
- Each received bar is written to the DB (step 4).
- Heartbeats are observed and logged at DEBUG.

**Watch out for:**
- Market closed → stream still connects but emits no bar events. Plan
  the prototype demo for during US futures session.
- TS may send the **forming** bar repeatedly (last-bar updates) plus a
  final "closed" bar. Dedupe on timestamp; the latest payload wins.

---

## Step 4 — Save into DB (SQLite for prototype)

**What:** Append received bars to a `bars` table in a SQL DB.

**Concretely (see `storage.md` for full schema):**
- Use **SQLAlchemy Core** (not the ORM — bars are bulk inserts, not objects).
- Prototype DB = SQLite file at `backend/data/quantlab.sqlite`.
- Future DB = WAMP MySQL — same SQLAlchemy code, swap connection string.
- Single table for the prototype: `bars(symbol, timeframe, ts_utc, open, high, low, close, volume, source, PRIMARY KEY (symbol, timeframe, source, ts_utc))`.
- Use `INSERT OR REPLACE` (SQLite) / `INSERT … ON DUPLICATE KEY UPDATE`
  (MySQL) — SQLAlchemy's `dialect.insert(...).on_conflict_do_update` handles
  both. This makes the writer idempotent — replays after reconnects don't
  duplicate or fail.

**Success criteria:**
- After step 2, the DB contains 100 rows for `@NQ` 60m.
- After step 3 runs for 5 minutes, the DB has 5 new rows (or replaces
  the last partial bar with closed values).
- Re-running step 2 produces no duplicate rows.

**Decision required (see `decisions.md`):**
- Confirm SQLite-now / MySQL-later via SQLAlchemy is acceptable, vs going
  straight to WAMP MySQL even for the prototype.

---

## Step 5 — Test Stability / Reconnections

**What:** Prove the stream survives network drops, token expiry, and TS
server-side disconnects without losing or duplicating bars.

**Concretely — at least four failure modes to inject:**
1. **Network drop:** Disable Wi-Fi for 30s while streaming. Re-enable.
   Expected: connector detects no-data (watchdog timeout, e.g. 90s),
   reconnects, resumes from last-seen timestamp.
2. **Token expiry mid-stream:** Wait past `expires_in` while streaming
   (or manually clear the access token). Expected: 401 on the stream,
   connector refreshes token, reconnects, resumes.
3. **TS server disconnect:** Close the stream from the client side
   periodically (every 30 min, to simulate TS's max-connection-time
   policy). Expected: same as #1.
4. **Duplicate prevention:** After a forced reconnect, verify no bar
   appears twice in the DB (the `INSERT OR REPLACE` upsert handles this).

**Concretely — infrastructure pieces this requires:**
- A **watchdog** task: tracks `last_bar_received_at`. If `now - last_bar
  > threshold`, mark stream stale, trigger reconnect.
- A **reconnect-with-backoff** policy: 1s, 2s, 4s, 8s, max 60s.
- A **resume cursor**: last successfully-stored bar's `(symbol, timeframe,
  ts_utc)`. On reconnect, request bars from cursor forward via a one-shot
  REST backfill before re-attaching the stream — this closes any gap
  the outage created.

**Success criteria:**
- After each of the four failure injections, the DB contains a continuous
  bar series with no gaps and no duplicates.
- Logs show reconnect events, gap-fill REST calls, and resumed streaming.

---

## What's explicitly **out of scope** for the prototype

To keep the tracer bullet small:
- Quotes endpoint (`/v3/marketdata/quotes/...`) — bars are enough for
  the validation goal.
- Multi-symbol — only `@NQ`.
- Full provider abstraction (FeedProvider base class) — the prototype
  hardcodes TradeStation; refactor to abstract after it works.
- WAMP MySQL — SQLite for the prototype if Christian agrees.
- Feed-health HTTP endpoint in `market_routes.py` — internal logging is enough.
- UI surfacing — no Dashboard/Analytics changes.
- The Sinegual Lab parity check (run quant-laptop strategies on TS-ingested
  bars, export to Sinegual format, compare). This is the **next** slice
  after the prototype, and is the real proof that the whole chain is correct.

---

## Order of operations once credentials arrive

1. Lock the open questions in `decisions.md` (1 hour, no code).
2. Build step 1 (auth). Verify `bootstrap` + `refresh` work. (1 day)
3. Build step 2 (historical REST). Verify NQ bars come back with
   correct timestamps and prices. (½ day)
4. Build step 4 (DB writer + schema). Wire step 2's output into it. (½ day)
5. Build step 3 (stream). Wire into step 4. (1 day)
6. Build step 5 (watchdog + reconnect + gap-fill). Run the four
   failure-injection tests. (1–2 days)
7. **Stop and review with Christian before expanding scope.**

Total realistic estimate: ~1 week of focused work, post-credentials.
