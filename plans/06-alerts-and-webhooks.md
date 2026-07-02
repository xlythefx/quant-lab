# 06 — Alerts & webhooks (re-home LiveAlerts + broker bridge)

**Status:** ✅ Done (Jul 02, 2026)
**Created:** Jul 01, 2026
**Depends on:** 05 (deployments emit signals).

## Goal

Make the Live Terminal the **home for live alerts**. Bring the existing `LiveAlerts`
**create/edit modal** into the terminal so you can create alerts + webhooks exactly like
today, and wire the **alerts + webhook-to-broker** execution model: a signal fires an
alert AND optionally POSTs a TradingView-style payload to a configured broker webhook.

## Context / why

- This is the execution model you chose: **alerts + webhook**, no in-app OMS.
- Creation UX already exists — reuse it: [LiveAlerts.jsx](../frontend/src/pages/LiveAlerts.jsx)
  has an "Add / Edit rule" modal (name, strategy, symbol, timeframe, webhook URL, secret,
  alias, leverage) + delete + webhook presets. The new page reuses this, not a rewrite.
- Backend pieces: [live_alerter.py](../backend/services/live_alerter.py),
  [live_alerts_config.py](../backend/services/live_alerts_config.py) (rules →
  `data/live_alerts.json`), [live_alerts_routes.py](../backend/routes/live_alerts_routes.py).

## Storage decision (Jul 01, 2026)

**Self-contained in QuantLab — no WAMP/sinegu-api dependency.**
- Alert **rules** stay in `data/live_alerts.json` (exactly as today).
- Fired-alert **history** goes to a local **SQLite** table (`alerts_history`), viewable
  and **deletable** in the terminal. (Same SQLite DB as the trade journal in 07.)
- WAMP `sinegu-api` (`C:\wamp64\www\sinegu-api`) stays only the *webhook destination*
  (the remote Sinegu bots), never a storage dependency. Revisit only if we later want a
  central cross-product alert log.

## Checklist

- [x] Surface `LiveAlerts` content in a terminal Alerts view (bell → Alerts) **without removing** the existing `#livealerts` page — both read the same backend. The old page stays live until the new terminal is confirmed; its removal is a separate, later step (see 01 migration principles).
- [x] **Create/edit alerts + webhooks via a modal** on the new live page — reuse the existing `LiveAlerts` "Add / Edit rule" modal (name, strategy, symbol, timeframe, webhook URL + preset picker, secret, alias, leverage) so creation works "just like today".
- [x] Rules persist to `data/live_alerts.json` via the existing `live_alerts_routes` (unchanged); can be created, edited, and deleted from the modal/list.
- [x] Add a local **SQLite `alerts_history`** table: every fired alert is appended (time, rule name, strategy, symbol, side, price, webhook status). List view can filter and **delete** past alerts.
- [x] **Activity log:** a chronological feed of everything the system did — armed / paused / killed / signal fired / webhook sent (ok/failed) / reconnected. This is the black box for trust + debugging; store alongside `alerts_history`.
- [x] Alerts list matches handoff shape `Alert[]`; empty-state uses terminal muted text.
- [x] Backend: webhook config store (URL + secret) in backend config/secrets — **never** returned to the frontend in full; frontend sees only a label + masked hint.
- [x] Backend: on a live signal, POST the webhook payload (e.g. `{secret, action, symbol, price, ...}`) to the configured broker bridge; log success/failure.
- [x] Frontend: webhook target picker in the Deploy modal (05) referencing configured targets by id/label only.
- [x] "Test signal" (05) also exercises the webhook POST (dry-run flag so it doesn't hit a live broker by accident).
- [x] Delivery status surfaced (last POST ok/failed) per deployment.
- [x] Verify a test signal → alert appears + webhook POST logged (against a mock endpoint).

## Done when

A live signal produces an alert in the terminal AND (when a webhook is configured)
POSTs a broker payload, with secrets kept server-side and delivery status visible —
verified end-to-end against a mock webhook.

## Notes

- Security: dummy webhook URLs/secrets from the design are placeholders — never ship them.
- Consider a global kill-switch ("disarm all webhooks") for safety.
