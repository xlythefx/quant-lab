"""
Live Binance kline WebSocket consumer (+ the REST helper live runners use to
warm up and backfill).

Endpoint: wss://stream.binance.com:9443/ws/<symbol_lower>@kline_<tf>

Binance pushes ~1 frame/sec per symbol while the candle is forming, plus a
final frame with k.x == True at the candle boundary.

Resilience:
  - Reconnects FOREVER with exponential backoff (1s -> 2s -> ... capped at 60s).
    A live deployment must never be left silently dead.
  - Backoff resets once the connection has proven stable.
  - After a reconnect, listeners get a {"__event": "reconnected"} notice so the
    live runners can backfill the closed bars they missed via REST.
  - `connected` says whether the socket is open right now (deployment health).
  - Daemon thread; stop() flips an Event that closes the socket cleanly.
"""
import json
import time
import logging
from typing import Callable, Dict

import requests
from websocket import WebSocketApp, WebSocketConnectionClosedException

from config import BINANCE_WS_BASE
from services.stream_base import CandleStream
from services.live import live_store

log = logging.getLogger(__name__)

_MAX_BACKOFF_SECONDS = 60
_STABLE_MSG_THRESHOLD = 5   # consecutive good messages before backoff resets

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"


def fetch_closed_klines(symbol: str, timeframe: str, limit: int = 500,
                        start_time: int | None = None) -> list[Dict]:
    """Recent CLOSED klines from Binance spot public REST, oldest first, as the
    same candle dicts the websocket emits (isClosed=True). The still-forming
    bar is dropped. `start_time` (epoch s) asks for bars opening at/after it."""
    params = {"symbol": symbol.upper(), "interval": timeframe,
              "limit": max(1, min(1000, int(limit)))}
    if start_time is not None:
        params["startTime"] = int(start_time) * 1000
    r = requests.get(BINANCE_KLINES_URL, params=params, timeout=10)
    r.raise_for_status()
    now_ms = int(time.time() * 1000)
    out = []
    for k in r.json():
        if int(k[6]) >= now_ms:      # close time still in the future → forming
            continue
        out.append({
            "time": int(k[0]) // 1000,
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
            "isClosed": True,
            "mode": "live",
            "symbol": symbol.upper(),
            "timeframe": timeframe,
        })
    return out


class BinanceKlineStream(CandleStream):
    def __init__(self, symbol: str, timeframe: str, on_update: Callable[[Dict], None]):
        super().__init__(symbol, timeframe, on_update)
        self._ws: WebSocketApp | None = None
        self._attempts = 0
        self._stable_count = 0
        self.connected = False

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
        self.connected = False
        log.warning("[%s] ws error: %s", self._name(), err)

    def _on_close(self, _ws, code, reason):
        self.connected = False
        log.info("[%s] ws closed code=%s reason=%s", self._name(), code, reason)

    def _on_open(self, _ws):
        self.connected = True
        log.info("[%s] ws open", self._name())
        # First connect is _attempts == 0; anything above means we dropped and
        # recovered — record it in the activity "black box" so silent reconnects
        # leave a trail. Never let a logging hiccup disturb the stream.
        if self._attempts > 0:
            try:
                live_store.add_activity(
                    "reconnect", symbol=self.symbol,
                    detail=f"{self.timeframe} stream reconnected (attempt {self._attempts})",
                )
            except Exception:
                log.debug("[%s] reconnect activity log failed", self._name(), exc_info=True)
            # Tell the live runners so they backfill bars that closed while we were down.
            self.on_update({"__event": "reconnected", "symbol": self.symbol,
                            "timeframe": self.timeframe})

    def stop(self):
        super().stop()
        self.connected = False
        try:
            if self._ws:
                self._ws.close()
        except Exception:
            pass

    def _run(self):
        while not self._stop.is_set():
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
            self.connected = False

            if self._stop.is_set():
                break

            self._attempts += 1
            delay = min(_MAX_BACKOFF_SECONDS, 2 ** min(self._attempts, 6))
            log.info("[%s] reconnecting in %ds (attempt %d)", self._name(), delay, self._attempts)
            self._stop.wait(delay)
