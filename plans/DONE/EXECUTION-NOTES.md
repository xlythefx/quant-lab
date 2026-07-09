# Execution notes — read before building any phase

Created: Jul 01, 2026 · The playbook for whoever executes plans 02–10 (e.g. Fable 5).
These are the cross-cutting rules that apply to every phase, so they are not repeated
in each file. Read this first, then the phase file you are on.

## How to work

1. Work the phases in order (02 → 10), one at a time. Tick each `- [ ]` box to `- [x]`
   as you finish it, and keep the file's "Done when" as the gate for moving on.
2. Small commits on the `new-live-dashboard` branch, one per phase (or per meaningful
   step). Do not commit secrets. Keep the existing live alerts working the whole time.
3. After each phase: run `vite build` (frontend) and do the phase's manual smoke test.
   Nothing is "done" until it builds and was actually clicked through.

## The golden rule: pristine new UI, shared connections only

1. The Live Terminal is its OWN fresh UI, built faithfully to the institutional design.
   Build new components for it under `frontend/src/components/live/`.
2. Do NOT import the backtest UI components (TradingChart.jsx, StrategyEditor.jsx, the
   dashboardv2 panels, etc.) into the Live Terminal — the terminal gets its own chart,
   its own panels, its own forms in the new design.
3. Do NOT import the new Live Terminal components back into the backtest dashboard either.
   The two worlds never share visual components — only the plumbing below.
4. What the two worlds DO share is connections/data: backend endpoints, the live feed,
   the socket, the alert engine, the analytics math, and the strategy PARAM_SCHEMA
   definitions (data, not the form component).

## Where things go (conventions)

1. Live frontend: `frontend/src/pages/live/` (pages) and `frontend/src/components/live/`
   (the terminal's own panels/widgets/chart).
2. Live backend: reuse existing services where possible; new live-only code under
   `backend/services/live/`. New endpoints as a `live_*_routes.py` blueprint.
3. Terminal theme: one scoped stylesheet / CSS-vars module for the handoff palette
   (see 01 tokens), applied under a `.live-terminal` root. Never edit the global theme.
4. Display formatting still follows the project rules: dates `Mon DD, YYYY`, numbers
   comma + 2dp via `fmtUsd`/`fmtNum`/`fmtInt`, percentages via `fmtPct`.

## Reuse connections, not components

Wire to these; do not re-implement them, and do not import their UI:
1. Analytics math: `backtest_engine._compute_stats` / `_compute_analytics` + `quant_metrics`
   (call server-side; the terminal draws its own cards/curve).
2. Realtime: `event_bus` (backend) + `frontend/src/services/socket.js` — layer live
   channels on this; do not add a second websocket stack.
3. Live signals: `live_alerter.py` / `alerts_daemon.py` / `live_alerts_config.py`.
4. Strategy params: the registry's PARAM_SCHEMA (data) drives the terminal's own deploy
   form — reuse the schema, not `StrategyEditor.jsx`.
5. The chart is the terminal's own (canvas or a chart lib styled to the design), fed by
   the shared candle/ticker feed — not the backtest's `TradingChart.jsx`.

## Demo vs Live account

1. A deployment carries a simple `account` select: Demo or Live. Keep it that simple.
2. That choice decides which webhook target / account the signal is sent to (a demo
   account for Demo, the real account for Live). Same firing path, different destination.
3. Demo lets a strategy run fully live with fake money before committing real funds.

## Real position / risk data (read-only from WAMP)

1. The Risk and Positions panels pull REAL data from the existing `sinegu-api` WAMP MySQL
   tables — `binance_positions` / `ig_positions` (current open: size, entry, mark,
   unrealized P&L, margin) and `binance_pastpositions` / `ig_past_positions` (closed:
   entry, exit, realized P&L, closed-at). These auto-fill from the broker.
2. This is READ-ONLY and only for the positions/risk/reconciliation panels. Alerts are
   still stored inside QuantLab (local) — do NOT move alert storage to WAMP.
3. If WAMP is unreachable, those panels fall back to the SIMULATED placeholder (labeled),
   so the terminal never hard-breaks when the SaaS DB is down.

## Mock vs live data

1. Every live panel reads through a data hook (e.g. `useTicker`, `useOrderBook`) with two
   backends: a seeded `simFeed` (client-side) and the real feed.
2. A single terminal-level toggle flips mock ⇄ live so the whole terminal can be built
   and demoed with no live connection.
3. The SIMULATED badge is driven by whether a panel is on the mock backend — always
   truthful, and it disappears automatically when a real feed is wired in.

## Safety rules (live can move real money — non-negotiable)

1. Webhooks default to DRY-RUN / Demo. Sending to a real Live account requires an
   explicit, deliberate action — never the default.
2. Global kill-switch: one visible "Disarm all" that pauses every deployment and blocks
   all webhook POSTs immediately.
3. Confirm-before-arm: going Live opens a confirmation showing what will fire (strategy,
   symbol, Demo/Live account, webhook target).
4. Signal idempotency: a given (rule, bar-time, side) fires at most once — guard against
   duplicate/replayed signals so a reconnect or double-tick never double-sends.
5. Secrets stay server-side. The frontend only sees a label + masked hint.
6. Keep live at `pyramiding = 1` so live matches the backtest (memory: live-vs-backtest-parity).

## Resilience rules

1. Socket: auto-reconnect and re-subscribe the current instrument on drop; show the
   footer feed status (OK / DEGRADED) from the real heartbeat.
2. Binance stream: on reconnect, backfill with a REST snapshot before resuming live
   updates so the chart/book are not left stale or gapped.
3. Loud, obvious warning when the price feed drops or a webhook POST fails — silence must
   never read as "all good".
4. Every panel handles empty and loading states with the terminal's muted styling.

## Auth

The Live Terminal sits behind the existing login (same session as the rest of the app).
No new auth system.

## Definition of done (whole project)

The finish line in [01](01-live-terminal-overview.md) plus the acceptance walkthrough in
[10](10-cutover.md) all pass, with the old live surface only retired after parity is
confirmed.
