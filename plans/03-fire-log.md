# 03 — Throw targets & the fire log (what fired, where)

**Status:** 🟦 Pending
**Created:** Jul 07, 2026
**Depends on:** [01](01-production-overview.md). QuantLab-side only, no SaaS change.

## Goal

Make QuantLab's own record of "what I threw and where" clear and first-class, so you
can eyeball it against the target environment's dashboard (manual reconciliation).
Each fired alert should show its **destination environment** (156 / 167 / local).

## Context / why

QuantLab is fire-and-forget: it can't read back what executed (167 can't reach 156).
So its *own* fire log is the one thing only it has — the intent record. The plumbing
already exists; the gap is just labeling and surfacing the destination.

## What already exists

- `alerts_history` ([live_store.py](../backend/services/live/live_store.py)) already
  logs every dispatch: `ts, rule_name, strategy_id, symbol, action, price, ok,
  status_code, error, url, test, dry_run, account`. **It already stores the `url`.**
- `activity_log` — the black box (armed/paused/fired/webhook ok-fail/reconnect).
- `AlertsView` ([AlertsView.jsx](../frontend/src/components/live/AlertsView.jsx)) already
  renders both.
- Env labeling from a host already exists in the top bar (`envLabel()` in
  [TopBar.jsx](../frontend/src/components/live/TopBar.jsx)) — mirror it server-side.

## Checklist

- [ ] **Label the destination from the URL.** Add a small helper (backend) that maps a
      `webhook_url` host → env: `localhost→LOCAL`, `andrea-orcelinvest→156`,
      `sinegualfamily→167`, else the host. No schema change needed — the `url` is already
      stored; derive `dest` on read (or add a `dest` column if you prefer it denormalized).
- [ ] **Surface it in the alerts-history API** — include `dest` (the env label) on each
      row returned by `GET /api/live/alerts-history`.
- [ ] **Show a DEST column** in the `AlertsView` fire-log list (e.g. a colored chip:
      167=red/prod, 156=cyan/staging, LOCAL=muted), so "I fired 3 BUYs to 156" is obvious.
- [ ] **(Optional)** tag the deployment row with its target env too (derive from its
      `webhook_url`) so the Deployments list shows where each one throws.
- [ ] **Make the fire log the primary live view** — it's what QuantLab uniquely owns.

## Done when

Every fired alert in the terminal shows which environment it was thrown to, so you can
compare the fire log against 156/167's dashboard by eye and confirm what executed.

## Notes

- No reconciliation code — manual by design (167 can't read 156).
- `dry_run` / `test` fires should be visibly distinct from real throws in the list.
