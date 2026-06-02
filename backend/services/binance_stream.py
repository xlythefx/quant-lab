"""
Live Binance kline WebSocket consumer.

Endpoint: wss://stream.binance.com:9443/ws/<symbol_lower>@kline_<tf>

Binance pushes ~1 frame/sec per symbol while the candle is forming, plus a
final frame with k.x == True at the candle boundary.

Resilience:
  - Exponential backoff reconnect (1s -> 2s -> ... cap 30s).
  - Backoff resets on first successful message after reconnect.
  - Daemon thread; stop() flips an Event that closes the socket cleanly.
"""
import json
import time
import logging
from typing import Callable, Dict

from websocket import WebSocketApp, WebSocketConnectionClosedException

from config import BINANCE_WS_BASE
from services.stream_base import CandleStream

log = logging.getLogger(__name__)

_MAX_RECONNECTS = 50
_STABLE_MSG_THRESHOLD = 5   # consecutive good messages before backoff resets


class BinanceKlineStream(CandleStream):
    def __init__(self, symbol: str, timeframe: str, on_update: Callable[[Dict], None]):
        super().__init__(symbol, timeframe, on_update)
        self._ws: WebSocketApp | None = None
        self._attempts = 0
        self._stable_count = 0

    def _url(self) -> str:
        return f"{BINANCE_WS_BASE}/{self.symbol.lower()}@kline_{self.timeframe}"

    def _on_message(self, _ws, raw):
        self._stable_count += 1
        if self._stable_count >= _STABLE_MSG_THRESHOLD:
            self._attempts = 0   # proven stable — reset backoff counter
            self._stable_count = 0
        try:
            payload = json.loads(raw)
            k = payload.get("k")
            if not k:
                return
            candle = {
                "time": int(k["t"] // 1000),
                "open": float(k["o"]),
                "high": float(k["h"]),
                "low": float(k["l"]),
                "close": float(k["c"]),
                "volume": float(k["v"]),
                "isClosed": bool(k["x"]),
                "mode": "live",
                "symbol": self.symbol,
                "timeframe": self.timeframe,
            }
            self.on_update(candle)
        except Exception as e:
            log.exception("Failed to parse kline frame: %s", e)

    def _on_error(self, _ws, err):
        self._stable_count = 0
        log.warning("[%s] ws error: %s", self._name(), err)

    def _on_close(self, _ws, code, reason):
        log.info("[%s] ws closed code=%s reason=%s", self._name(), code, reason)

    def _on_open(self, _ws):
        log.info("[%s] ws open", self._name())

    def stop(self):
        super().stop()
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

    def _run(self):
        while not self._stop.is_set():
            if self._attempts >= _MAX_RECONNECTS:
                log.error("[%s] giving up after %d reconnect attempts", self._name(), _MAX_RECONNECTS)
                self.on_update({"__stream_error": True,
                                "message": f"Binance stream lost after {_MAX_RECONNECTS} reconnects"})
                return

            try:
                self._ws = WebSocketApp(
                    self._url(),
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                # ping_interval keeps the connection alive across NATs/firewalls.
                self._ws.run_forever(ping_interval=20, ping_timeout=10)
            except WebSocketConnectionClosedException as e:
                log.warning("[%s] connection closed: %s", self._name(), e)
            except Exception as e:
                log.exception("[%s] run_forever crashed: %s", self._name(), e)

            if self._stop.is_set():
                break

            self._attempts += 1
            delay = min(30, 2 ** min(self._attempts, 5))
            log.info("[%s] reconnecting in %ds (attempt %d/%d)",
                     self._name(), delay, self._attempts, _MAX_RECONNECTS)
            self._stop.wait(delay)
