"""
Mode-aware stream registry + Socket.IO room fan-out.

One backend stream per (mode, symbol, timeframe) — shared across every
browser subscribed to that key. When the last subscriber leaves, the
underlying stream is stopped.

Room name convention: "{mode}_{symbol}_{tf}"
"""
import logging
from threading import Lock
from typing import Dict, Tuple

from services.binance_stream import BinanceKlineStream
from services.backtest_stream import BacktestStream
from services.stream_base import CandleStream
from services.live.live_symbols import is_live_eligible, is_binance_spot
from services.ts_csv_stream import TsCsvStream, _csv_path

log = logging.getLogger(__name__)


class LiveFeedUnavailable(RuntimeError):
    """No real live feed exists for this symbol. Raised instead of silently
    replaying history — replayed bars in live mode would fire REAL webhooks."""

StreamKey = Tuple[str, str, str, str]  # (mode, symbol, timeframe, broker)


def room_name(mode: str, symbol: str, timeframe: str, broker: str = "") -> str:
    return f"{mode}_{symbol}_{timeframe}_{broker}"


class SocketManager:
    def __init__(self, socketio):
        self._sio = socketio
        self._streams: Dict[StreamKey, CandleStream] = {}
        self._room_members: Dict[StreamKey, set[str]] = {}
        self._sid_rooms: Dict[str, set[StreamKey]] = {}
        # Internal (non-browser) consumers of a stream — strategy runners
        # hook here to receive every candle. Stream stays alive as long as
        # either a browser room member OR an internal listener is present.
        self._listeners: Dict[StreamKey, list] = {}
        self._lock = Lock()

    # ---- internal stream factory --------------------------------------
    def _make_stream(self, mode: str, symbol: str, tf: str, speed: int,
                     start_time: int | None = None, end_time: int | None = None,
                     loop: bool = True, broker: str | None = None) -> CandleStream:
        key = (mode, symbol, tf, broker or "")

        def emit(candle):
            if candle.get("__stream_error"):
                # Propagate load failures to the browser room so it doesn't hang.
                self._sio.emit("stream_error", candle, room=room_name(*key))
                return
            if candle.get("__event"):
                # Stream control notice (e.g. "reconnected") — for internal
                # listeners only, never painted as a candle.
                for fn in list(self._listeners.get(key, ())):
                    try:
                        fn(candle)
                    except Exception as e:
                        log.exception("listener for %s raised: %s", key, e)
                return
            # Fan-out to everyone in this room.
            self._sio.emit("candle_update", candle, room=room_name(*key))
            # Fan-out to internal listeners (strategy runners, etc.)
            for fn in list(self._listeners.get(key, ())):
                try:
                    fn(candle)
                except Exception as e:
                    log.exception("listener for %s raised: %s", key, e)

        if mode == "live":
            # LIVE NEVER REPLAYS: a real feed or a refusal, nothing in between.
            ok, reason = is_live_eligible(symbol, tf)
            if not ok:
                raise LiveFeedUnavailable(
                    f"no live feed for {symbol} {tf}: {reason} (live mode never replays history)")
            if is_binance_spot(symbol):
                return BinanceKlineStream(symbol, tf, emit)
            p = _csv_path(symbol, tf)   # eligible + not Binance => the TradeStation CSV exists
            log.info("TsCsvStream [%s/%s]: watching %s", symbol, tf, p)
            return TsCsvStream(symbol, tf, emit, p)
        return BacktestStream(symbol, tf, emit, speed=speed,
                              start_time=start_time, end_time=end_time, loop=loop,
                              broker=broker)

    # ---- internal listener API (for strategy runners) -----------------
    def add_listener(self, mode: str, symbol: str, tf: str, fn, broker: str | None = None) -> None:
        """Raises LiveFeedUnavailable when mode == "live" has no real feed."""
        key = (mode, symbol, tf, broker or "")
        with self._lock:
            # Make sure the stream is alive even if no browser is listening yet.
            stream = self._streams.get(key)
            if stream is None or not stream.is_running():
                stream = self._make_stream(mode, symbol, tf, speed=60, broker=broker)
                self._streams[key] = stream
                stream.start()
                log.info("Started stream %s (listener-driven)", room_name(*key))
            self._listeners.setdefault(key, []).append(fn)

    def stream_for(self, mode: str, symbol: str, tf: str, broker: str | None = None):
        """The running stream for a key (or None) — used for feed health."""
        with self._lock:
            return self._streams.get((mode, symbol, tf, broker or ""))

    def remove_listener(self, mode: str, symbol: str, tf: str, fn, broker: str | None = None) -> None:
        key = (mode, symbol, tf, broker or "")
        with self._lock:
            lst = self._listeners.get(key)
            if lst and fn in lst:
                lst.remove(fn)
            if lst is not None and not lst:
                self._listeners.pop(key, None)
            self._maybe_stop_stream_locked(key)

    def _maybe_stop_stream_locked(self, key: StreamKey) -> None:
        if self._room_members.get(key):
            return
        if self._listeners.get(key):
            return
        stream = self._streams.pop(key, None)
        if stream:
            stream.stop()
            log.info("Stopped stream %s (no subscribers, no listeners)", room_name(*key))

    # ---- subscribe / unsubscribe --------------------------------------
    def subscribe(self, sid: str, mode: str, symbol: str, tf: str, speed: int = 60,
                  start_time: int | None = None, end_time: int | None = None,
                  loop: bool = True, broker: str | None = None) -> bool:
        """Returns False (and emits stream_error to the sid) when live mode has
        no real feed for the symbol."""
        key = (mode, symbol, tf, broker or "")
        room = room_name(*key)

        with self._lock:
            stream = self._streams.get(key)
            if stream is None or not stream.is_running():
                try:
                    stream = self._make_stream(mode, symbol, tf, speed,
                                               start_time=start_time, end_time=end_time,
                                               loop=loop, broker=broker)
                except LiveFeedUnavailable as e:
                    log.warning("subscribe refused: %s", e)
                    self._sio.emit("stream_error", {"__stream_error": True, "message": str(e),
                                                    "mode": mode, "symbol": symbol, "timeframe": tf},
                                   to=sid)
                    return False
                self._streams[key] = stream
                stream.start()
                log.info("Started stream %s (subscribers=1)", room)
            members = self._room_members.setdefault(key, set())
            already = sid in members
            members.add(sid)
            self._sid_rooms.setdefault(sid, set()).add(key)
            if not already and len(members) > 1:
                log.info("Joined existing stream %s (subscribers=%d)", room, len(members))

        # join_room must run in the SocketIO server context.
        self._sio.server.enter_room(sid, room)
        return True

    def unsubscribe(self, sid: str, mode: str, symbol: str, tf: str, broker: str | None = None):
        key = (mode, symbol, tf, broker or "")
        room = room_name(*key)
        self._sio.server.leave_room(sid, room)

        with self._lock:
            members = self._room_members.get(key, set())
            members.discard(sid)
            self._sid_rooms.get(sid, set()).discard(key)

            if not members:
                self._room_members.pop(key, None)
            self._maybe_stop_stream_locked(key)

    def cleanup_sid(self, sid: str):
        keys = list(self._sid_rooms.pop(sid, set()))
        for (mode, symbol, tf, broker) in keys:
            self.unsubscribe(sid, mode, symbol, tf, broker=broker)

    # ---- backtest controls --------------------------------------------
    def set_speed(self, symbol: str, tf: str, speed: int, broker: str | None = None) -> bool:
        key = ("backtest", symbol, tf, broker or "")
        with self._lock:
            stream = self._streams.get(key)
            if isinstance(stream, BacktestStream):
                stream.set_speed(speed)
                return True
        return False
