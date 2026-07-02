import { socket } from "../../services/socket.js";

/**
 * Live Terminal channels, layered on the app's ONE Socket.IO connection
 * (services/socket.js) — no second websocket stack. The terminal keeps its
 * own subscription registry so reconnects re-join live rooms without
 * touching the backtest dashboard's subscription bookkeeping.
 */

const liveSubs = new Map(); // key -> subscribe payload
const obSubs = new Map();   // symbol -> refcount

socket.io.on("reconnect", () => {
  for (const payload of liveSubs.values()) socket.emit("subscribe", payload);
  for (const symbol of obSubs.keys()) socket.emit("live_ob_subscribe", { symbol });
});

/**
 * Subscribe to the live Binance candle stream for (symbol, timeframe).
 * Frames: {time, open, high, low, close, volume, isClosed, mode, symbol, timeframe}
 * Returns an unsubscribe fn.
 */
export function subscribeLiveCandles(symbol, timeframe, onCandle, onError) {
  const payload = { mode: "live", symbol, timeframe };
  const key = `live|${symbol}|${timeframe}`;
  liveSubs.set(key, payload);

  const handler = (c) => {
    if (c.mode === "live" && c.symbol === symbol && c.timeframe === timeframe) onCandle(c);
  };
  const errHandler = (e) => onError?.(e?.message || "live stream failed");

  socket.on("candle_update", handler);
  socket.on("stream_error", errHandler);
  if (socket.connected) socket.emit("subscribe", payload);
  else socket.once("connect", () => socket.emit("subscribe", payload));

  return () => {
    socket.off("candle_update", handler);
    socket.off("stream_error", errHandler);
    liveSubs.delete(key);
    socket.emit("unsubscribe", payload);
  };
}

/** Live order book channel (phase 08 real wiring). Returns unsubscribe fn. */
export function subscribeOrderBook(symbol, onBook) {
  const handler = (b) => { if (b.symbol === symbol) onBook(b); };
  socket.on("orderbook", handler);
  obSubs.set(symbol, (obSubs.get(symbol) || 0) + 1);
  if (socket.connected) socket.emit("live_ob_subscribe", { symbol });
  else socket.once("connect", () => socket.emit("live_ob_subscribe", { symbol }));
  return () => {
    socket.off("orderbook", handler);
    const n = (obSubs.get(symbol) || 1) - 1;
    if (n <= 0) {
      obSubs.delete(symbol);
      socket.emit("live_ob_unsubscribe", { symbol });
    } else {
      obSubs.set(symbol, n);
    }
  };
}

/** Footer gateway heartbeat: {latencyMs, session, feed, ts}. */
export function onGateway(cb) {
  socket.on("gateway", cb);
  return () => socket.off("gateway", cb);
}

/** Strategy signals from the live alerter (phase 05): chart markers + toasts. */
export function onLiveSignal(cb) {
  socket.on("live_signal", cb);
  return () => socket.off("live_signal", cb);
}

/** Webhook dispatch outcomes (existing event — shared with #livealerts). */
export function onAlertDispatched(cb) {
  socket.on("live_alert_dispatched", cb);
  return () => socket.off("live_alert_dispatched", cb);
}

/** Deployments changed on the backend (armed/paused/killed) — refetch. */
export function onDeploymentsChanged(cb) {
  socket.on("deployments_changed", cb);
  return () => socket.off("deployments_changed", cb);
}

/** Socket reconnected — callers refetch REST snapshots to backfill gaps. */
export function onSocketReconnect(cb) {
  socket.io.on("reconnect", cb);
  return () => socket.io.off("reconnect", cb);
}

export function isSocketConnected() {
  return socket.connected;
}
