import { io } from "socket.io-client";

const url = "http://localhost:5000";

export const socket = io(url, {
  autoConnect: true,
  transports: ["websocket"],
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
});

let activeSub = null; // {mode, symbol, timeframe, speed}

socket.on("connect", () => console.log("[socket] connected", socket.id));
socket.on("disconnect", (r) => console.log("[socket] disconnected", r));
socket.on("connect_error", (e) => console.warn("[socket] connect_error", e?.message));
socket.on("error", (p) => console.warn("[socket] server error", p));

// On reconnect, re-emit the active subscription so the room is re-joined.
socket.io.on("reconnect", () => {
  if (activeSub) {
    console.log("[socket] re-subscribing after reconnect", activeSub);
    socket.emit("subscribe", activeSub);
  }
});

/**
 * Subscribe to a candle stream. Returns an unsubscribe fn.
 *
 * onUpdate receives the full candle payload:
 *   {time, open, high, low, close, volume, isClosed, mode, symbol, timeframe}
 */
export function subscribeCandles({ mode, symbol, timeframe, speed = 60, start_time, end_time, loop }, onUpdate) {
  // Tear down any prior subscription first so we never run two streams.
  if (activeSub) {
    socket.emit("unsubscribe", activeSub);
  }
  activeSub = { mode, symbol, timeframe, speed };
  if (start_time != null) activeSub.start_time = start_time;
  if (end_time != null) activeSub.end_time = end_time;
  if (loop != null) activeSub.loop = loop;

  const handler = (candle) => {
    if (
      candle.mode === mode &&
      candle.symbol === symbol &&
      candle.timeframe === timeframe
    ) {
      onUpdate(candle);
    }
  };

  socket.on("candle_update", handler);

  if (socket.connected) {
    socket.emit("subscribe", activeSub);
  } else {
    // Will be re-emitted on reconnect via the reconnect listener,
    // but also try once on first connect:
    socket.once("connect", () => socket.emit("subscribe", activeSub));
  }

  return () => {
    socket.off("candle_update", handler);
    if (
      activeSub &&
      activeSub.mode === mode &&
      activeSub.symbol === symbol &&
      activeSub.timeframe === timeframe
    ) {
      socket.emit("unsubscribe", activeSub);
      activeSub = null;
    }
  };
}

export function setSpeed({ symbol, timeframe, speed }) {
  socket.emit("set_speed", { symbol, timeframe, speed });
  if (activeSub) activeSub.speed = speed;
}

export function getSocketId() {
  return socket.id || null;
}

/**
 * Wait until the socket is connected, then return its id.
 * Lets callers (e.g. download requests) ensure the server has a sid to
 * route progress events to.
 */
// ---------------------------------------------------------------------------
// Strategy events
// ---------------------------------------------------------------------------
// We track active strategy starts so we can re-emit them on reconnect
// (similar to candle subscriptions). Each entry is keyed by a string id
// the caller passes in (e.g. `${strategy_id}|${symbol}|${tf}|${mode}`).
const activeStrategyStarts = new Map();

socket.io.on("reconnect", () => {
  for (const payload of activeStrategyStarts.values()) {
    socket.emit("strategy_start", payload);
  }
});

export function startStrategy(payload) {
  // payload: {strategy_id, symbol, timeframe, mode, params}
  const k = `${payload.strategy_id}|${payload.symbol}|${payload.timeframe}|${payload.mode}`;
  activeStrategyStarts.set(k, payload);
  if (socket.connected) socket.emit("strategy_start", payload);
  else socket.once("connect", () => socket.emit("strategy_start", payload));
}

export function stopStrategy(payload) {
  const k = `${payload.strategy_id}|${payload.symbol}|${payload.timeframe}|${payload.mode}`;
  activeStrategyStarts.delete(k);
  socket.emit("strategy_stop", payload);
}

export function applyStrategy(payload) {
  const k = `${payload.strategy_id}|${payload.symbol}|${payload.timeframe}|${payload.mode}`;
  activeStrategyStarts.set(k, payload);
  socket.emit("strategy_apply", payload);
}

export function clearAllStrategySubscriptions() {
  activeStrategyStarts.clear();
}

export function waitForSocketId(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (socket.connected && socket.id) return resolve(socket.id);
    const t = setTimeout(() => {
      socket.off("connect", onConnect);
      reject(new Error("socket not connected"));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(t);
      resolve(socket.id);
    };
    socket.once("connect", onConnect);
  });
}
