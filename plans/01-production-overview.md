# 01 — QuantLab → production: the alert-thrower architecture (north star)

**Status:** 🟦 Active (anchor doc)
**Created:** Jul 07, 2026 · **Updated:** Jul 07, 2026 (increments + master equity built)
**Supersedes context of:** the "Live Terminal" series (archived in [DONE/](DONE/)).

## Goal

Turn QuantLab into a focused, production-ready **strategy brain + alert thrower**
that keeps its own local log and shows one real number (the master account) — and
stop it duplicating the stakeholder dashboards. We get there slowly, one phase at a
time, fixing the simulated pieces and wiring the real ones.

## The mental model (read this first)

Three systems, each with ONE job. The failure we avoid: QuantLab becoming a second
stats dashboard.

- **QuantLab** = the brain. Research, backtest, run strategies live, **throw webhook
  alerts**, keep its own **fire log** (what it threw + where), and show the **167
  master account equity** (a cheap local read). It does NOT display stakeholder stats
  and does NOT read 156.
- **The SaaS (`sinegu-api` + Flask bots)** = execution + source of truth. Receives
  the webhook, places the real order, sizes/counts increments server-side, records the
  fill into `sinegu_db`.
- **The dashboards (`sinequal-dash-fusion`)** = all stakeholder stats (per-strategy,
  per-asset, per-broker, trade logs). Each environment's dashboard reads its own DB.

## Environments & the promotion pipeline

QuantLab is **hosted** at 167 / localhost and **throws** to whichever env a deployment
targets — the target encodes how proven the strategy is:

- **localhost** — dev/testing (QuantLab dev + local WAMP).
- **156.67.30.81** (`andrea-orcelinvest`, staging) — **TESTED strategies.** Throw here.
- **167.86.109.159** (`sinegualfamily`, prod) — **PRODUCTION strategies.** QuantLab is
  hosted here and throws proven strategies here.

Lifecycle QuantLab owns: **backtest → deploy to 156 → watch it live → promote to 167.**
The throw target is a **per-deployment `webhook_url`** — "156 vs 167" is just that URL.

## Data flow

```
   QuantLab (hosted @167 / localhost)
   = research + backtest + live engine + ALERT THROWER + fire log + master-equity read
        │                                              ▲
        │ webhook {secret,strategy,action,symbol,lev}  │ reads ONLY its LOCAL DB
        │ target = 156 (tested) OR 167 (prod)          │ (167/localhost) for the
        ▼                                              │ master account equity
   SaaS Flask bots (that env) → place order, size increments server-side
        │ real fill recorded
        ▼
   that env's sinegu_db ──▶ that env's dashboard = ALL stats (strategy/asset/broker/logs)

   167 can't reach 156. Reconciliation (fired vs executed) is MANUAL, by eye,
   fire log vs the dashboard.
```

## What QuantLab reads and writes

- **Throws** webhooks to the target env's PUBLIC endpoint (works cross-env).
- **Reads ONE thing, locally:** the master Binance account equity (`name='master'` in
  `binance_accounts`) from the DB of whatever env it's deployed on (167/localhost),
  via the direct-MySQL path ([wamp_positions.py](../backend/services/live/wamp_positions.py)).
  It never reaches 156 and does no remote/cross-env reads.
- **Logs** every thrown alert to local SQLite (`alerts_history` + `activity_log`).
- **No** automated reconciliation, **no** stats fetch, **no** DB writes (only the webhook).

## Current state (Jul 07, 2026) — what's built vs pending

**✅ Built this cycle**
- **Live alerts with increments** ([02](02-live-alerts-increments.md)) — the
  `pyramiding=1` clamp removed in all 3 places (routes + `DeployModal` + `ParamForm`).
  A strategy can now throw one `BUY`/`SELL` per condition trigger up to its cap; the
  Flask receiver executes each as a full increment. Default stays 1; only multi-tranche
  strategies (`vwap_deviation`) actually stack.
- **Master equity header** — the top bar's fake "$20,020.35" is now the REAL master
  account equity + day P&L, read from the local (167/localhost) DB, labeled
  `Master Equity · <env>` (LOCAL/156/167, detected from hostname like `api.ts`). Shows
  "—" when WAMP is down (never a fake number). Backend: `wamp_positions.get_master_account()`
  + `GET /api/live/master-account`. Frontend: `useMasterAccount` → `TopBar`.
- **Removed** the top-bar `ACCT: DEMO` toggle.

**🟦 Pending (the "one-shot later" list)**
- **03 — Fire log with destination.** Record *where* each alert was thrown (env from
  the `webhook_url` host) and surface the fire log as QuantLab's live view.
- **04 — Funding → real.** Replace the simulated Funding panel with real Binance perp
  data (`premiumIndex` / `markPrice` / `openInterestHist`).
- **Later** — retire the (kept-for-now) Blotter + Analytics workspaces; optional 167-only
  validation view.

## Locked principles

1. QuantLab throws; the SaaS executes; the dashboard displays. No stats rebuilt here.
2. Fire-and-forget + local log; the only read is the local master account.
3. Real or clearly labeled — no silent fakes. Every SIMULATED panel gets real or removed.
4. Validate before promoting — manually (dashboard vs fire log), then 156 → 167.
5. Slowly, one phase at a time.

## What we are explicitly NOT building

- Strategy/asset/broker analytics in QuantLab (dashboards own them; can't reach both VPS).
- A `trade_logs` table of executed trades (they're in `sinegu_db`, shown in the dashboard).
- Automated reconciliation / cross-env reads (167 can't reach 156; manual is enough).
- A DB write layer (QuantLab's only outward write is the webhook).

## Phased roadmap

- **02 — Live alerts with increments.** ✅ Done. → [02](02-live-alerts-increments.md)
- **03 — Throw targets & the fire log.** 🟦 Pending → [03](03-fire-log.md)
- **04 — Funding & OI → real.** 🟦 Pending → [04](04-funding-real.md)
- **Later** — retire Blotter/Analytics; optional 167-only validation view.

## Done when

QuantLab reliably throws alerts (incl. increments) to the right env, keeps a clear
local fire log of what it threw and where, shows the real master account, has no
unlabeled simulated data, and leaves every stakeholder stat to the dashboards.

## Notes

- Commit subjects: `MMDDYYYY-{short-desc}` (e.g. `07072026-master-equity`).
- Session changes (increments + master equity) are in the code but **uncommitted**.
