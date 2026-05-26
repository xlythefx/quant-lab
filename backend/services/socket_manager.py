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
from services.market_data import is_binance_symbol

log = logging.getLogger(__name__)

StreamKey = Tuple[str, str, str]  # (mode, symbol, timeframe)


def room_name(mode: str, symbol: str, timeframe: str) -> str:
    return f"{mode}_{symbol}_{timeframe}"


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
                     loop: bool = True) -> CandleStream:
        key = (mode, symbol, tf)

        def emit(candle):
            # Fan-out to everyone in this room.
            self._sio.emit("candle_update", candle, room=room_name(*key))
            # Fan-out to internal listeners (strategy runners, etc.)
            for fn in list(self._listeners.get(key, ())):
                try:
                    fn(candle)
                except Exception as e:
                    log.exception("listener for %s raised: %s", key, e)

        if mode == "live" and is_binance_symbol(symbol):
            return BinanceKlineStream(symbol, tf, emit)
        return BacktestStream(symbol, tf, emit, speed=speed,
                              start_time=start_time, end_time=end_time, loop=loop)

    # ---- internal listener API (for strategy runners) -----------------
    def add_listener(self, mode: str, symbol: str, tf: str, fn) -> None:
        key = (mode, symbol, tf)
        with self._lock:
            self._listeners.setdefault(key, []).append(fn)
            # Make sure the stream is alive even if no browser is listening yet.
            stream = self._streams.get(key)
            if stream is None or not stream.is_running():
                stream = self._make_stream(mode, symbol, tf, speed=60)
                self._streams[key] = stream
                stream.start()
                log.info("Started stream %s (listener-driven)", room_name(*key))

    def remove_listener(self, mode: str, symbol: str, tf: str, fn) -> None:
        key = (mode, symbol, tf)
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
                  loop: bool = True):
        key = (mode, symbol, tf)
        room = room_name(*key)

        with self._lock:
            members = self._room_members.setdefault(key, set())
            already = sid in members
            members.add(sid)
            self._sid_rooms.setdefault(sid, set()).add(key)

            stream = self._streams.get(key)
            if stream is None or not stream.is_running():
                stream = self._make_stream(mode, symbol, tf, speed,
                                           start_time=start_time, end_time=end_time,
                                           loop=loop)
                self._streams[key] = stream
                stream.start()
                log.info("Started stream %s (subscribers=1)", room)
            elif not already:
                log.info("Joined existing stream %s (subscribers=%d)", room, len(members))

        # join_room must run in the SocketIO server context.
        self._sio.server.enter_room(sid, room)

    def unsubscribe(self, sid: str, mode: str, symbol: str, tf: str):
        key = (mode, symbol, tf)
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
        for (mode, symbol, tf) in keys:
            self.unsubscribe(sid, mode, symbol, tf)

    # ---- backtest controls --------------------------------------------
    def set_speed(self, symbol: str, tf: str, speed: int) -> bool:
        key = ("backtest", symbol, tf)
        with self._lock:
            stream = self._streams.get(key)
        if isinstance(stream, BacktestStream):
            stream.set_speed(speed)
            return True
        return False
