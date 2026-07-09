# 05 — Strategies & Deployments (wire to the live alerter)

**Status:** ✅ Done (Jul 02, 2026)
**Created:** Jul 01, 2026
**Depends on:** 02 (shell), 03 (strategy channel). Core of "live".

## Goal

The **Strategies** workspace: a roster of QuantLab strategies + a **Deployments** list
(strategy × symbol × timeframe × preset, RUNNING/PAUSED, live P&L, trade count) with
deploy / pause / resume / kill. A **Deploy** modal arms a strategy live, optionally
POSTing signals to a **broker webhook**. Bell badge = count of RUNNING deployments.

## Context / why

- This maps directly onto the existing live alerter:
  [live_alerter.py](../backend/services/live_alerter.py),
  [alerts_daemon.py](../backend/services/alerts_daemon.py),
  [live_alerts_config.py](../backend/services/live_alerts_config.py),
  [live_alerts_routes.py](../backend/routes/live_alerts_routes.py).
- "Deployment" ≈ an armed live-alert config (strategy + symbol + tf + params + webhook).
  We may just re-shape existing config into the handoff's `Deployment` model.

## Checklist

- [x] Map concepts: existing live-alert entry → `Deployment {id, stratId, symbol, venue, tf, preset, params, webhookId, status, pnl, n}`.
- [x] Backend: `GET /api/deployments`, `POST /api/deployments`, `PATCH /api/deployments/{id}` (status), `DELETE /api/deployments/{id}`, `POST /api/deployments/{id}/test-signal` — thin wrappers over the alerter config/daemon.
- [x] Backend: on each live signal, the alerter emits on the `strategy` channel `{deploymentId, trade, signal?}`, updates `pnl`/`n`, and (on a realized round-trip) writes a row to the SQLite `journal_trades` table (see 07).
- [x] **Keep the existing live alerter / `#livealerts` fully working** — deployments are a new view over the same backend, not a replacement. Retiring the old page is a later, separate step (see 01 migration principles).
- [x] Strategies roster: cards from the real strategy registry ([strategy_registry.py](../backend/services/strategy_registry.py)), accent-colored, with a **Deploy** action.
- [x] Deploy modal: pick strategy, symbol (Binance), timeframe, preset (Conservative/Balanced/Aggressive → param overrides), tune params (reuse [StrategyEditor.jsx](../frontend/src/components/StrategyEditor.jsx) form), choose webhook target, deploy.
- [x] Deployments list: status toggle (pause/resume), kill, live P&L / n, per-strategy accent.
- [x] Bell badge in top bar (02) = number of RUNNING deployments.
- [x] **Demo/Live account select** in the deploy modal — a simple `account` = Demo | Live dropdown that sets which account/webhook target the signal is sent to (Demo = run live with fake money). Shown in the confirm-before-arm step.
- [x] **Backtest → live handoff:** a "Go Live with this strategy" action on the backtest side that flips to live mode and opens the deploy modal pre-filled with the same strategy + params. (Nav + params only — do NOT import live UI into the backtest dashboard.)
- [x] **"Why did/didn't it fire":** each deployment shows its last evaluation (last bar seen, whether the condition was met) so quiet periods are explainable and you can trust it's watching.
- [x] "Test signal" fires a manual signal end-to-end (daemon → `strategy` channel → chart marker + alert).
- [x] `vite build` + a real arm/pause/kill cycle on BTCUSDT.

## Done when

You can deploy a QuantLab strategy live on a Binance symbol from the terminal, see it
in the Deployments list as RUNNING with live P&L/trade count, pause/resume/kill it, the
bell badge reflects running count, and a test signal shows up on the chart + alerts.

## Notes

- Presets map to existing [presets_config.py](../backend/services/presets_config.py) if suitable.
- Webhook config lives in backend/secrets — never expose secrets to the frontend (see 06).
- Keep live at `pyramiding=1` for parity (see memory: live-vs-backtest-parity).
