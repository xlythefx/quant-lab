"""
Gateway heartbeat for the Live Terminal footer.

A daemon thread pings Binance every couple of seconds and emits a `gateway`
Socket.IO event (global — no room) with:
    {latencyMs, session, feed, ts}

feed is "OK" when the ping succeeded, "DEGRADED" otherwise — the frontend
also has its own staleness watchdog on candle frames, so a dead price feed
is loud in two places (footer + chart banner), never silent.

Session by UTC hour, matching the chart's session shading:
    08–13 LONDON · 13–22 NEW YORK · else ASIA
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

import httpx

from services import event_bus

log = logging.getLogger(__name__)

_INTERVAL_SECONDS = 2.0
_PING_URL = "https://api.binance.com/api/v3/ping"

_thread: threading.Thread | None = None
_stop = threading.Event()


def session_for_utc_hour(hour: int) -> str:
    if 8 <= hour < 13:
        return "LONDON"
    if 13 <= hour < 22:
        return "NEW YORK"
    return "ASIA"


def _beat() -> dict:
    latency_ms = None
    feed = "DEGRADED"
    t0 = time.perf_counter()
    try:
        r = httpx.get(_PING_URL, timeout=2.0)
        if r.status_code == 200:
            latency_ms = (time.perf_counter() - t0) * 1000.0
            feed = "OK"
    except Exception:
        pass
    return {
        "latencyMs": round(latency_ms, 1) if latency_ms is not None else None,
        "session": session_for_utc_hour(datetime.now(timezone.utc).hour),
        "feed": feed,
        "ts": int(time.time()),
    }


def _run():
    while not _stop.is_set():
        try:
            event_bus.emit("gateway", _beat())
        except Exception:
            log.exception("[live_feed] gateway beat failed")
        _stop.wait(_INTERVAL_SECONDS)


def start():
    """Call once at app startup (after event_bus.set_socketio)."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_run, name="live-gateway-heartbeat", daemon=True)
    _thread.start()
    log.info("[live_feed] gateway heartbeat started (%.1fs)", _INTERVAL_SECONDS)
