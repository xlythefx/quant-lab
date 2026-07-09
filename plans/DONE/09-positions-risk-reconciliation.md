# 09 — Real positions, risk & broker reconciliation (WAMP read)

**Status:** ✅ Done (Jul 02, 2026)
**Created:** Jul 01, 2026
**Depends on:** 05 (deployments fire), 06 (webhooks + activity log), 03 (channels).

## Goal

Make the Risk and Positions panels show REAL broker data, and reconcile what we fired
against what actually happened at the broker — so "the alert fired but nothing opened"
is impossible to miss. Read-only; nothing here writes to the broker or to WAMP.

## Context / why

The `sinegu-api` WAMP MySQL already stores real positions, auto-filled from the broker:
- `binance_positions` / `ig_positions` — current open: symbol, side, size, entry, mark
  price, unrealized P&L, notional, margin.
- `binance_pastpositions` / `ig_past_positions` — closed: entry, exit, realized P&L,
  closed-at (IG rows also carry the strategy name).

This is the one WAMP dependency, and only for these panels. Alerts stay stored inside
QuantLab (see 06). If WAMP is down, these panels fall back to SIMULATED (labeled).

## Checklist

- [x] Backend: read-only connection to the WAMP `sinegu-api` MySQL (host/db/creds in
      backend config/secrets — never in the frontend).
- [x] `GET /api/live/positions` — open positions for the selected Demo/Live account
      (from `binance_positions` / `ig_positions`, scoped by that account's api_key).
- [x] `GET /api/live/positions/closed` — closed positions (the `*_pastpositions` tables).
- [x] `GET /api/live/risk` — derive the risk cards from real positions (equity, day P&L,
      gross exposure, net delta, margin used, free margin). Mark VaR / maint-margin
      honestly as derived-or-SIMULATED where we don't have a real number.
- [x] Positions panel (Trading + Risk): real open positions with live unrealized P&L.
- [x] Reconciliation (item 9): for each fired alert in the activity log (06), check
      whether a matching real position opened/closed in WAMP. Show a per-alert status
      (matched / fired-but-no-position / position-without-signal) and flag mismatches.
- [x] Feed real outcomes into the live-vs-expectation compare (07): use
      `binance_pastpositions.realized_pnl` as the ACTUAL result, not just our own guess.
- [x] Fallback: when WAMP is unreachable, panels render the SIMULATED placeholder with a
      clear label — never a hard error.
- [x] Account scoping: everything filters by the selected Demo/Live account.

## Done when

The Risk and Positions panels show your real open positions and P&L for the selected
account; every fired alert shows whether a real position actually opened/closed; and the
whole thing degrades cleanly to SIMULATED when WAMP is down.

## Notes

- READ-ONLY. This phase never writes to WAMP or the broker.
- Pairs with 08: replaces 08's SIMULATED Risk/Positions with the real thing (08 keeps the
  order book / funding / liquidations / news / order entry as placeholders).
