# TradeStation Integration — Checklist

Status: **Blocked — waiting on API credentials**

---

## Phase 1 — Get Credentials

- [ ] Fund TradeStation account to **$10,000 minimum**
- [ ] Receive API key email from TradeStation (sent automatically after funding)
- [ ] Note the key type:
  - **Auth0** — mixed case, no dashes (e.g. `8P07Yx...`)
  - **OAuth2** — all-caps with dashes (e.g. `EAC7BF97-B3HE-...`)
- [ ] Confirm `client_id` and `client_secret` are in hand

---

## Phase 2 — Lock Decisions with Christian (1 hour, no code)

See [`decisions.md`](decisions.md) for full context on each item.

- [ ] **D-1** — SQLite now / WAMP MySQL later confirmed?
- [ ] **D-2** — `@NQ` (continuous) or `NQM26` (June contract) for prototype?
- [ ] **D-3** — What is the sim environment base URL?
- [ ] **D-4** — Which session template for NQ bars? (`Default`, `USEQPreAndPost`, etc.)
- [ ] **D-5** — OAuth bootstrap runs on dev machine only (not the server)?
- [ ] **D-6** — Refresh token stored in `.env`?
- [ ] **D-7** — Reconnect test scope (4 failure modes)?
- [ ] **D-8** — Keep `brokers/` folder name or rename to `feeds/`?
- [ ] **D-9** — Prototype writes SQL only (no parquet dual-write)?
- [ ] **D-10** — Which key type does our flow target (Auth0 or OAuth2)?

---

## Phase 3 — Build (once credentials + decisions are done)

Follow the full build plan in [`prototype-plan.md`](prototype-plan.md).

### Step 1 — Login (OAuth 2.0)
- [ ] Add credentials to `backend/.env`
- [ ] Run `python -m backend.services.brokers.tradestation.auth bootstrap`
  - Opens browser, you log in, refresh token is saved
- [ ] Run `python -m backend.services.brokers.tradestation.auth refresh`
  - Prints a new access token without opening the browser
  - If this works, login is done

### Step 2 — Fetch Historical Bars
- [ ] Run `python -m backend.services.brokers.tradestation.client fetch_bars @NQ 60m 100`
  - Should print 100 hourly bars with valid OHLCV prices
  - Timestamps must be UTC

### Step 3 — Save to Database
- [ ] Confirm `backend/data/quantlab.sqlite` exists after step 2
- [ ] Confirm it contains **100 rows** for `NQ_CONT` 60m
- [ ] Re-run step 2 — confirm no duplicate rows appear

### Step 4 — Stream Live Bars
- [ ] Run during US futures market hours (Sun 6pm ET → Fri 5pm ET)
- [ ] Stream for 5+ minutes — confirm bars arrive on the expected cadence
- [ ] Confirm each received bar is written to the DB

### Step 5 — Test Reconnections
- [ ] **Network drop:** Disable Wi-Fi 30s, re-enable → no gaps in DB
- [ ] **Token expiry:** Wait past 20 min or clear token → auto-refreshes, resumes
- [ ] **Server disconnect:** Force-close stream → reconnects automatically
- [ ] **Duplicate check:** After forced reconnect → no duplicate rows in DB

---

## Phase 4 — Review with Christian

- [ ] Walk through all 5 steps with Christian before expanding scope
- [ ] Confirm bar data matches expectations (prices, timestamps, volumes)
- [ ] Decide next slice: multi-symbol, Sinegual parity check, or WAMP MySQL migration

---

## What's Explicitly Out of Scope for the Prototype

- Multi-symbol support (only `@NQ`)
- WAMP MySQL (SQLite until prototype passes)
- Sinegual Lab parity check (next slice after prototype)
- UI changes (Dashboard, Analytics)
- Options data
- Order execution (MultiCharts handles that)
