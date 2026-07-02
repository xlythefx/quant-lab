# 01 — Live Terminal: overview & north-star

**Status:** ⬜ Todo (anchor doc — not "executed"; it frames the phase files 02–08)
**Created:** Jul 01, 2026

## Goal

Fully separate **Backtest/Research** from **Live**. Add a top-level **Go Live**
switch that flips the whole app into a new **Live Terminal** shell styled after the
"XlytheAI Institutional Trading Terminal" design handoff. The Live Terminal is the
new home for **live alerts** and running strategies.

## Locked decisions (Jul 01, 2026)

- **Scope:** real-data **core** now + **faithful placeholders** for panels we have
  no feed for (order book, funding, liquidations, news, order entry) — clearly
  labeled "SIMULATED", wired for real later.
- **Execution model:** **alerts + webhook to broker**. A live strategy fires a
  signal → optionally POSTs to a broker webhook (TradingView-style). QuantLab does
  **not** build an in-app order/execution/margin engine.
- **Go Live:** a **top-level mode switch** — one control flips between
  "Research / Backtest" and "Live Terminal" (separate shells, separate nav).
- **Primary live feed:** **Binance (crypto)** via the existing CCXT path.

## Migration principles (non-destructive)

- **Keep the existing live on the backtest dashboard working.** The current
  `LiveAlerts` page + live alerter stay fully functional the whole time we build the
  new terminal. The Live Terminal is **additive** — nothing live is removed while we
  build. Only **after** we confirm the new terminal works do we retire the old surface,
  and that removal is its **own separate step** we schedule later (not part of 02–08).
- **Retain not-yet-real features for future use.** Panels QuantLab can't feed yet
  (order book, funding, OI, liquidations, news, risk/margin, order entry) are **built
  as SIMULATED scaffolding and kept**, not dropped — each structured so a real feed is
  a drop-in later. We're building the shells now so the future wiring is easy.

## What already exists (reuse, don't rebuild)

- Live signal engine: [live_alerter.py](../backend/services/live_alerter.py),
  [alerts_daemon.py](../backend/services/alerts_daemon.py),
  [live_alerts_config.py](../backend/services/live_alerts_config.py),
  [live_alerts_routes.py](../backend/routes/live_alerts_routes.py).
- Live UI today: [LiveAlerts.jsx](../frontend/src/pages/LiveAlerts.jsx), route `#livealerts`.
- Realtime transport: Socket.IO via `event_bus` (backend) +
  [socket.js](../frontend/src/services/socket.js) (frontend) — already used for
  backtest progress. **We layer live channels on this, not a new WS stack.**
- Strategies + `on_candle` live path (already parity-checked in backtest).
- Backtest analytics engine ([backtest_engine.py](../backend/services/backtest_engine.py)
  `_compute_analytics`) — reuse on the live trade log.

## Design reference

The design handoff docs are staged in [design-handoff/](design-handoff/) (extracted
from `Institutional Trading Terminal.zip`). The interactive mockup
(`XlytheAI Terminal.dc.html`) stays in the zip — open in a browser to see motion/density.

**Core visual tokens (from the handoff — keep these exact):**
- Colors: bg `#0a0a0f`, chrome `#0c0c12`, panel `#0f0f17`, border `#1e1e2e`,
  text `#e2e2f0`, muted `#6b6b8a`, green `#00d4a1`, red `#ff4d6d`, amber `#fbbf24`
  (brand/VWMA), cyan `#22d3ee` (z-band/LIVE), purple `#8b5cf6` (Asia session).
- **No border-radius** anywhere (sharp terminal look). High density (9–11px, mono
  for ALL numbers). 1px hairlines via `gap:1px` over a border-colored grid.
- Shell grid: `52px | 1fr` cols; `54px | 32px | 1fr | 24px` rows (rail, top bar,
  workspace tabs, content, footer).

> Note: QuantLab's existing dark theme tokens differ (`bg-panel #13141f` etc.). The
> Live Terminal uses the handoff's darker palette as its OWN scope so the two worlds
> look distinct — that's a feature, not a conflict.

## Scope map — real vs placeholder

**Real data now:**
- Trading chart: Binance candles + live ticker + this-strategy's live signals.
- Strategies / Deployments: from the live alerter (armed strategy × symbol).
- Alerts: re-homed `LiveAlerts`.
- Analytics: backtest analytics run over the live trade log.
- Footer/status, clock, LIVE dot, bell badge (running deployments count).

**Faithful placeholders (labeled SIMULATED, deferred wiring):**
- Order book (L2), Time & Sales, Funding/OI, Liquidations, News marquee.
- Markets table, Risk workspace (margin/VaR), Blotter order entry.

## Phased roadmap (each is its own plan file)

- **02** — App shell + Go Live mode switch (frontend skeleton, tokens, nav). Real.
- **03** — Realtime plumbing: live channels on the existing Socket.IO + REST snapshots. Backend.
- **04** — Trading workspace: chart + live price + strategy signal overlay. Real (+ book/tape placeholders).
- **05** — Strategies & Deployments: wire to `live_alerter`; deploy/pause/kill; webhook target. Real.
- **06** — Alerts & webhooks: re-home LiveAlerts; broker webhook config + test-signal. Real.
- **07** — Analytics (live): reuse backtest analytics on the live journal. Real.
- **08** — Placeholder panels: Markets / Risk / Blotter / perp panels / news, design-faithful + SIMULATED. Later-wire.

Suggested execution order: 02 → 03 → 04 → 05 → 06 → 07 → 08. We start only when you say so.

## Resolved decisions (Jul 01, 2026)

- ✅ **Hard flip.** Live mode fully swaps the app to the terminal shell; backtest
  pages are hidden while live (the Go Live / Exit Live switch stays visible in the top
  bar so you can flip back). Backtest world — including the existing `LiveAlerts` — is
  untouched and one click away.
- ✅ **Live trades → SQLite.** The live journal is a small SQLite table written by the
  alerter on each realized round-trip (drives phases 05 + 07 analytics).
- ✅ **First symbols:** **BTCUSDT** and **LTCUSDT** for the live Trading chart.
- ✅ **Alert storage stays in QuantLab (no WAMP).** Alert rules keep living in
  `data/live_alerts.json` (as today); fired-alert history goes to local SQLite
  (`alerts_history`), deletable in the terminal. The WAMP `sinegu-api`
  (`C:\wamp64\www\sinegu-api`) remains only the webhook *destination*, not a storage
  dependency. Alert creation reuses today's modal flow. (Details in 06.)

## Still to confirm while executing

- [ ] Webhook targets/secrets storage — reuse existing config + secrets, never in frontend.
- [ ] Single global socket vs per-channel — reuse existing `event_bus` rooms (simplest).

## Done when

The overview is agreed and the phase files 02–08 exist and are scoped. (This doc is
the map; the phase files are the work.)
