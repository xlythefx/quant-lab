"""
TradeStation live bar stream.

TradeStation streams via chunked HTTP (not WebSocket). Each line is a
newline-delimited JSON event: a bar update, a Heartbeat, or an Error.

TSCandleStream subclasses CandleStream so socket_manager treats TradeStation
live data identically to the existing Binance/backtest streams.

Usage:
    stream = TSCandleStream("@NQ", "1m", on_update=lambda c: print(c))
    stream.start()
    # ... runs in background thread ...
    stream.stop()
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.parse
from typing import Callable, Dict

import httpx
from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(), override=False)

from ...stream_base import CandleStream
from .auth import get_access_token, refresh as refresh_token
from .client import _TF_TS, _parse_ts

log = logging.getLogger(__name__)

_BASE_URL        = os.getenv("TRADESTATION_BASE_URL", "https://api.tradestation.com")
_WATCHDOG_SECS   = 90                          # reconnect if silent this long
_BACKOFF          = [1, 2, 4, 8, 16, 32, 60]  # reconnect delays in seconds


class TSCandleStream(CandleStream):
    """Live bar stream from the TradeStation WebAPI."""

    def __init__(
        self,
        symbol: str,
        timeframe: str,
        on_update: Callable[[Dict], None],
        session_template: str = "Default",
    ):
        super().__init__(symbol, timeframe, on_update)
        self._session = session_template
        self._last_event_at: float = 0.0
        self._backoff_idx: int = 0

    # ── CandleStream interface ───────────────────────────────────────────────

    def _run(self):
        """Main loop: stream, catch errors, reconnect with backoff."""
        while not self._stop.is_set():
            try:
                self._stream_once()
                # _stream_once returned cleanly (stop requested)
            except Exception as exc:
                if self._stop.is_set():
                    break
                delay = _BACKOFF[min(self._backoff_idx, len(_BACKOFF) - 1)]
                self._backoff_idx += 1
                log.warning(
                    "stream %s/%s error (%s) — reconnecting in %ds",
                    self.symbol, self.timeframe, exc, delay,
                )
                self._stop.wait(delay)

    # ── internals ────────────────────────────────────────────────────────────

    def _stream_once(self):
        if self.timeframe not in _TF_TS:
            raise ValueError(f"Unsupported timeframe {self.timeframe!r}")

        interval, unit = _TF_TS[self.timeframe]
        encoded = urllib.parse.quote(self.symbol, safe="")
        url = f"{_BASE_URL}/v3/marketdata/stream/barcharts/{encoded}"
        params = {
            "interval":        interval,
            "unit":            unit,
            "sessiontemplate": self._session,
        }

        log.info("connecting stream %s %s", self.symbol, self.timeframe)
        self._last_event_at = time.time()
        self._backoff_idx = 0  # reset on successful connect

        headers = {"Authorization": f"Bearer {get_access_token()}"}

        with httpx.Client(timeout=None) as client:
            with client.stream("GET", url, params=params, headers=headers) as resp:
                if resp.status_code == 401:
                    log.warning("401 on stream connect — refreshing token")
                    refresh_token()
                    raise RuntimeError("401 — token refreshed, will reconnect")

                resp.raise_for_status()

                for raw_line in resp.iter_lines():
                    if self._stop.is_set():
                        return

                    # Watchdog: reconnect if silent too long.
                    if time.time() - self._last_event_at > _WATCHDOG_SECS:
                        raise RuntimeError(
                            f"watchdog: no event for {_WATCHDOG_SECS}s on "
                            f"{self.symbol}/{self.timeframe}"
                        )

                    line = raw_line.strip() if raw_line else ""
                    if not line:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        log.debug("non-JSON line: %r", line[:120])
                        continue

                    self._last_event_at = time.time()
                    self._dispatch(event)

    def _dispatch(self, event: dict):
        event_type = event.get("Type") or event.get("type", "")

        if event_type == "Heartbeat":
            log.debug("heartbeat %s/%s", self.symbol, self.timeframe)
            return

        if event_type == "Error":
            raise RuntimeError(
                f"TS stream error event: {event.get('Message', event)}"
            )

        # Bar event (forming bar update or closed bar).
        ts = _parse_ts(event.get("TimeStamp") or event.get("timestamp", ""))
        if ts is None:
            log.debug("bar event missing timestamp: %s", event)
            return

        candle = {
            "time":      ts,
            "open":      float(event.get("Open")        or event.get("open",        0)),
            "high":      float(event.get("High")        or event.get("high",        0)),
            "low":       float(event.get("Low")         or event.get("low",         0)),
            "close":     float(event.get("Close")       or event.get("close",       0)),
            "volume":    float(event.get("TotalVolume") or event.get("volume",      0)),
            "symbol":    self.symbol,
            "timeframe": self.timeframe,
        }
        self.on_update(candle)
