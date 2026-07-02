# 03 — Realtime plumbing (live channels + REST snapshots)

**Status:** ✅ Done (Jul 02, 2026)
**Created:** Jul 01, 2026
**Depends on:** 02 (shell to render into). Backend + a thin frontend hook.

## Goal

Give the Live Terminal a real-time spine **on the existing Socket.IO**, not a new
WebSocket stack. Define the handful of live channels the core needs and the REST
snapshot endpoints for initial paint. Keep it lightweight (self-use scale).

## Context / why

- QuantLab already streams over Socket.IO via `event_bus` (backend) +
  [socket.js](../frontend/src/services/socket.js) (frontend) — used for backtest progress.
- The handoff's `BACKEND_PYTHON.md` proposes a multiplexed `/ws` with per-channel
  subscribe. We map that concept onto Socket.IO rooms/events instead of rebuilding it.
- Only wire channels we have real data for now: `ticker`, `candles`, `strategy`
  (signals), `gateway` (heartbeat). `positions` is stubbed until 05/07 define the journal.

## Checklist

- [x] Decide channel transport: reuse `event_bus.emit(channel, payload, to=room)`; room = `f"{venue}:{symbol}"` for market channels, a global room for account channels.
- [x] Backend: a small live feed service that, for a subscribed (venue, symbol, tf), polls/streams Binance via CCXT and emits `ticker` (≤1–2/s) and `candles` (on close/partial).
- [x] Backend: `gateway` heartbeat emit (~0.5 Hz) with `{latencyMs, session, feed}` (session from UTC hour; latency best-effort).
- [x] Connection + broker health: surface feed status (OK/DEGRADED) and webhook-delivery health; a dropped price feed or a failed webhook POST must raise a loud, obvious warning — never fail silently.
- [x] Auto-reconnect + re-subscribe the selected instrument on socket drop; on Binance stream reconnect, backfill via a REST snapshot before resuming so the chart/book aren't stale.
- [x] Backend REST snapshots (match handoff shapes): `GET /api/live/candles`, `/api/live/ticker`, `/api/live/instruments` (Binance symbols we have). Keep field names `{t,o,h,l,c,v}` etc.
- [x] Frontend: `useLiveChannel(channel, {venue, symbol})` hook — subscribes on mount, unsubscribes on unmount / symbol switch; returns latest snapshot.
- [x] Frontend: `subscribe/unsubscribe` messages so the backend only streams the selected instrument.
- [x] Throttle/coalesce high-rate emits server-side to the handoff cadences (don't flood).
- [x] First instruments: **BTCUSDT** and **LTCUSDT** (Binance) — seed `/api/live/instruments` with these.
- [x] Sanity check: open Trading shell, watch `ticker`/`candles` update in console.

## Done when

The Live Terminal receives live Binance `ticker` + `candles` for the selected symbol
over Socket.IO, subscribes/unsubscribes correctly on symbol switch, and the footer
`gateway` line updates from a real heartbeat.

## Notes

- No Redis/Celery — asyncio/thread + `event_bus` is enough for one user.
- `strategy` channel is emitted by the live alerter (phase 05); here just define its shape `{deploymentId, trade, signal?}`.
- Reuse existing auth/session; don't invent a new transport.
