# QuantLab — Plans

Master index of plan files. Each plan is a focused, self-contained checklist we
work through **one at a time**. Nothing here is executed until we agree to start
a specific file.

## How we work these

1. We discuss a chunk of work and I write it up as `plans/NN-topic.md`.
2. Each plan file holds a `- [ ]` checklist of concrete steps + a "Done when…" line.
3. When you say "let's start `NN`", we execute that file's steps one by one and I
   tick the boxes (`- [x]`) as each is finished.
4. This index tracks the running order and status of every plan.

## Status legend

- ⬜ **Todo** — written, not started
- 🟦 **In progress** — actively being executed
- ✅ **Done** — all steps checked off
- 💤 **Parked** — paused / deferred

## Plans (in order)

### Live Terminal (separate live/backtest dashboards) — from `Institutional Trading Terminal.zip`

📖 **Start here (plain English):** [SUMMARY.md](SUMMARY.md) — the whole plan, non-technical.

Decisions: real-data core + faithful SIMULATED placeholders · alerts + webhook to broker ·
top-level Go Live mode switch · Binance feed. Design docs in [design-handoff/](design-handoff/).

- ⬜ **01** — [Live Terminal: overview & north-star](01-live-terminal-overview.md) · the map for 02–08
- ⬜ **02** — [App shell + Go Live mode switch](02-app-shell-and-go-live.md) · frontend skeleton, tokens, nav
- ⬜ **03** — [Realtime plumbing](03-realtime-plumbing.md) · live channels on Socket.IO + REST snapshots
- ⬜ **04** — [Trading workspace](04-trading-workspace.md) · chart + live price + signals (book/tape SIMULATED)
- ⬜ **05** — [Strategies & Deployments](05-strategies-deployments.md) · wire to the live alerter; deploy/pause/kill
- ⬜ **06** — [Alerts & webhooks](06-alerts-and-webhooks.md) · re-home LiveAlerts; broker webhook + test-signal
- ⬜ **07** — [Analytics (live)](07-analytics-live.md) · reuse backtest analytics on the live journal
- ⬜ **08** — [Placeholder panels](08-placeholder-panels.md) · Markets/Risk/Blotter/perp/news, SIMULATED

Suggested order: 02 → 03 → 04 → 05 → 06 → 07 → 08.

**References:** [ref-binance-orderbook.md](ref-binance-orderbook.md) — Binance depth API for the live Order Book.
