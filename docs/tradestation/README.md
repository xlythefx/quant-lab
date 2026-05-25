# TradeStation Ingestion Connector — Plan

QuantLab's planned TradeStation feed layer. Will pull **historical** and
**real-time** market data from the TradeStation WebAPI v3 and land it in
QuantLab's canonical bar store.

> **Status: documentation only.** No code has been written yet. We are
> waiting on TradeStation API credentials. Everything in this folder is
> the build spec to execute once credentials arrive.

## Why this folder exists

Christian's direction (paraphrased):
- Use the **official TradeStation WebAPI**, not desktop window/memory extraction.
- QuantLab does **not** need TradeStation desktop installed on the same machine.
- First deliverable is a **thin vertical prototype** — login → fetch NQ bars →
  stream live updates → save to DB → prove it survives a reconnect.
- After the prototype works, expand to multi-symbol + provider abstraction
  (so IBKR / Polygon / DXFeed / Binance / Capital.com / Dukascopy can slot in
  behind the same interface).

## Documents in this folder

| File | What it covers |
|---|---|
| [`README.md`](README.md) | This file. Status + index. |
| [`prototype-plan.md`](prototype-plan.md) | Concrete scope of the 5-step prototype (login → NQ bars → stream → save → reconnect test). What success looks like. |
| [`architecture.md`](architecture.md) | Module map: `FeedProvider → Normalizer → Storage`. How TradeStation slots in next to the existing Yahoo / Dukascopy / Binance brokers. |
| [`setup.md`](setup.md) | Credential acquisition path. Steps to register a TradeStation API app, get `client_id` / `client_secret`, complete the OAuth bootstrap. Pre-fill checklist for when access is granted. |
| [`endpoints.md`](endpoints.md) | TradeStation WebAPI v3 endpoint reference. Populated as Christian forwards documentation pages. |
| [`symbol-map.md`](symbol-map.md) | TradeStation symbol conventions (`@ES` continuous vs `ESM26` contract-specific), alias normalization rules, seed list from the Sinegual Lab sample exports. |
| [`storage.md`](storage.md) | Canonical bars schema. Why SQLite-now-via-SQLAlchemy with MySQL-later is the right path given the WAMP plan. |
| [`decisions.md`](decisions.md) | Open questions that need answers before code starts. Currently includes: SQLite/Postgres vs WAMP MySQL, continuous vs front-month symbol style, sim-environment base URL. |
| [`faq.md`](faq.md) | Official TradeStation WebAPI FAQ — API key types (Auth0 vs OAuth2), which API version to use (v3), support contacts, and AI usage notes. |
| [`auth-fundamentals.md`](auth-fundamentals.md) | Auth0 API key defaults: app type, refresh token settings, scopes, account access limits, all Application URI types, and additional key actions (disable/rotate). |
| [`auth-pkce.md`](auth-pkce.md) | Auth Code Flow with PKCE — code_verifier/challenge generation, authorize URL params, consent dialogs, token exchange, Auth0 SDK quickstart references. |
| [`auth-scopes.md`](auth-scopes.md) | Scope reference — TradeStation API scopes (MarketData, Trade, etc.) and OAuth/OIDC scopes (openid, offline_access, profile, email). |
| [`rate-limiting.md`](rate-limiting.md) | Rate limit overview — per-category quotas, fixed window behavior, 429 response format, headers, and best practices. |
| [`rate-limiting-bars.md`](rate-limiting-bars.md) | Historical bars data limits — 57,600 bar cap, 500k-minute barsback limit, 3-year date range cap, credit system formula and examples. |
| [`http-streaming.md`](http-streaming.md) | HTTP streaming mechanics — chunked encoding, v2/v3 content types, error/GoAway/EndSnapshot status messages, variable chunk parsing strategy. |
| [`auth-code-flow.md`](auth-code-flow.md) | Step-by-step OAuth2 Authorization Code Grant flow — redirect URL, consent dialogs, code exchange, token response, scopes table, and AI implementation notes. |
| [`auth-refresh-tokens.md`](auth-refresh-tokens.md) | Refresh token lifecycle — refreshing access tokens, rotating vs non-rotating modes, revocation, and background refresh loop guidance. |
| [`auth-logout.md`](auth-logout.md) | Logout endpoint — session termination, what tokens remain valid after logout, allowed redirect URLs, and broker shutdown notes. |
| [`sim-vs-live.md`](sim-vs-live.md) | SIM vs. LIVE environments — base URL difference, identical API surface, use cases, and env-var toggle pattern for the broker module. |
| [`http-requests.md`](http-requests.md) | HTTP request conventions — HTTPS only, JSON body, Bearer auth header, bar response field types (prices as strings, Epoch in ms), and null/omit handling. |

## How to use this folder when credentials arrive

1. Read `setup.md` and complete the credential checklist.
2. Read `decisions.md` and lock the open questions with Christian.
3. Read `prototype-plan.md` — that's the implementation order for the first PR.
4. Read `architecture.md` before placing files in the repo, so the module
   layout matches the existing broker pattern.
5. Use `endpoints.md` + `symbol-map.md` as live references during coding.
6. Update `README.md`'s status table as components actually get built.

## Build status (will change once code starts)

| Component | Status | Blocked on |
|---|---|---|
| OAuth + token refresh | 📋 Planned | TS credentials |
| Historical bars REST client | 📋 Planned | TS credentials |
| Streaming client | 📋 Planned | TS credentials |
| Reconnection / health watchdog | 📋 Planned | TS credentials |
| Symbol map (TradeStation aliases) | 📋 Planned (seed in `symbol-map.md`) | — |
| Normalizer (TS → canonical bars) | 📋 Planned | — |
| Storage (SQLAlchemy → SQLite / WAMP MySQL) | 📋 Planned | DB choice in `decisions.md` |
| FeedProvider abstraction | 📋 Planned | — |
| Provider-agnostic interfaces (IBKR/Polygon/etc.) | 🕒 Deferred — Post-prototype | Prototype shipped |
