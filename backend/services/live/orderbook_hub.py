"""
Real Binance order book for the terminal's Order Book panel.

Partial Book Depth Stream (see plans/ref-binance-orderbook.md): each push is
a full top-20 snapshot — no local-book reconciliation needed. Default 1000ms
update speed ≈ the panel's render cadence, so no extra throttling.

One stream thread per symbol, refcounted by subscriber sid; emits
`orderbook` to Socket.IO room "ob_{SYMBOL}". Public market data — no key.
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Dict

from websocket import WebSocketApp

from services import event_bus

log = logging.getLogger(__name__)

_WS_BASE = "wss://stream.binance.com:9443/ws"
_LEVELS = 20


def room_name(symbol: str) -> str:
    return f"ob_{symbol.upper()}"


class _DepthStream:
    def __init__(self, symbol: str, socketio):
        self.symbol = symbol.upper()
        self._sio = socketio
        self._ws: WebSocketApp | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _url(self) -> str:
        return f"{_WS_BASE}/{self.symbol.lower()}@depth{_LEVELS}@1000ms"

    def _on_message(self, _ws, raw):
        try:
            d = json.loads(raw)
            bids_raw = d.get("bids") or []
            asks_raw = d.get("asks") or []

            def levels(rows):
                out, cum = [], 0.0
                for p, q in rows:
                    size = float(q)
                    cum += size
                    out.append({"price": float(p), "size": size, "cum": cum})
                return out

            self._sio.emit("orderbook", {
                "symbol": self.symbol,
                "bids": levels(bids_raw),
                "asks": levels(asks_raw),
                "lastUpdateId": d.get("lastUpdateId"),
            }, room=room_name(self.symbol))
        except Exception:
            log.exception("[ob:%s] bad depth frame", self.symbol)

    def _run(self):
        while not self._stop.is_set():
            try:
                self._ws = WebSocketApp(self._url(), on_message=self._on_message)
                self._ws.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as e:
                log.warning("[ob:%s] stream error: %s", self.symbol, e)
            if self._stop.is_set():
                break
            self._stop.wait(3)  # simple reconnect backoff

    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"ob-{self.symbol}", daemon=True)
        self._thread.start()
        log.info("[ob:%s] depth stream started", self.symbol)

    def stop(self):
        self._stop.set()
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass
        log.info("[ob:%s] depth stream stopped", self.symbol)


class OrderBookHub:
    def __init__(self, socketio):
        self._sio = socketio
        self._streams: Dict[str, _DepthStream] = {}
        self._members: Dict[str, set[str]] = {}   # symbol -> sids
        self._sid_symbols: Dict[str, set[str]] = {}
        self._lock = threading.Lock()

    def subscribe(self, sid: str, symbol: str):
        symbol = symbol.upper()
        self._sio.server.enter_room(sid, room_name(symbol))
        with self._lock:
            self._members.setdefault(symbol, set()).add(sid)
            self._sid_symbols.setdefault(sid, set()).add(symbol)
            if symbol not in self._streams:
                s = _DepthStream(symbol, self._sio)
                self._streams[symbol] = s
                s.start()

    def unsubscribe(self, sid: str, symbol: str):
        symbol = symbol.upper()
        self._sio.server.leave_room(sid, room_name(symbol))
        with self._lock:
            members = self._members.get(symbol, set())
            members.discard(sid)
            self._sid_symbols.get(sid, set()).discard(symbol)
            if not members:
                self._members.pop(symbol, None)
                stream = self._streams.pop(symbol, None)
                if stream:
                    stream.stop()

    def cleanup_sid(self, sid: str):
        for symbol in list(self._sid_symbols.get(sid, set())):
            self.unsubscribe(sid, symbol)
        self._sid_symbols.pop(sid, None)
