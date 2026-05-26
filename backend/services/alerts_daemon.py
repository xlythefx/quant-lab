"""
Headless live-alert daemon.

Starts one background live runner per unique (strategy_id, symbol, timeframe)
found in enabled alert rules. Keeps running as long as the Flask process is
alive — no browser connection required.

Call `start(socket_manager)` once at app startup.
Call `refresh()` whenever rules are saved so new/removed rules take effect.
"""
from __future__ import annotations

import logging
from threading import Lock
from typing import Optional

from services import live_alerter, live_alerts_config
from services.strategy_registry import get_strategy_class

log = logging.getLogger(__name__)

_lock = Lock()
_socket_manager = None

# Active headless runners keyed by (strategy_id, symbol, timeframe).
_runners: dict[tuple, "_HeadlessRunner"] = {}


# ---------------------------------------------------------------------------

class _HeadlessRunner:
    """Minimal live runner — no sid, no Socket.IO emissions, just dispatch."""

    def __init__(self, strategy_id: str, symbol: str, timeframe: str, socket_manager):
        self.strategy_id = strategy_id
        self.symbol = symbol
        self.timeframe = timeframe
        self._sm = socket_manager
        self._state: dict = {}
        self._listener = None

        cls = get_strategy_class(strategy_id)
        self.strategy = cls({})

    def start(self):
        def listener(candle):
            self._on_candle(candle)
        self._listener = listener
        self._sm.add_listener("live", self.symbol, self.timeframe, self._listener)
        log.info("[alerts_daemon] started headless runner %s/%s/%s",
                 self.strategy_id, self.symbol, self.timeframe)

    def _on_candle(self, candle):
        if not bool(candle.get("isClosed", False)):
            return
        try:
            sig = self.strategy.on_candle(candle, self._state)
        except Exception:
            log.exception("[alerts_daemon] on_candle error %s/%s",
                          self.strategy_id, self.symbol)
            return
        if sig is None:
            return
        live_alerter.dispatch(self.strategy_id, self.symbol, sig)

    def stop(self):
        if self._listener:
            self._sm.remove_listener("live", self.symbol, self.timeframe, self._listener)
            self._listener = None
        log.info("[alerts_daemon] stopped headless runner %s/%s/%s",
                 self.strategy_id, self.symbol, self.timeframe)


# ---------------------------------------------------------------------------

def _wanted_keys() -> set[tuple]:
    """Return the set of (strategy_id, symbol, timeframe) for all enabled rules."""
    rules = live_alerts_config.load_rules()
    keys = set()
    for r in rules:
        if not r.get("enabled"):
            continue
        tf = r.get("timeframe", "").strip()
        if not tf:
            continue
        keys.add((r["strategy_id"], r["symbol"], tf))
    return keys


def refresh():
    """Reconcile running headless runners against the current enabled rules.
    Safe to call from any thread (e.g. after saving rules via the UI).
    """
    if _socket_manager is None:
        return
    wanted = _wanted_keys()

    with _lock:
        # Stop runners no longer needed.
        for key in list(_runners):
            if key not in wanted:
                _runners.pop(key).stop()

        # Start runners for new keys.
        for key in wanted:
            if key in _runners:
                continue
            strategy_id, symbol, timeframe = key
            try:
                runner = _HeadlessRunner(strategy_id, symbol, timeframe, _socket_manager)
                runner.start()
                _runners[key] = runner
            except Exception:
                log.exception("[alerts_daemon] failed to start runner %s/%s/%s",
                              strategy_id, symbol, timeframe)


def start(socket_manager):
    """Call once at Flask app startup."""
    global _socket_manager
    _socket_manager = socket_manager
    log.info("[alerts_daemon] initialising from saved rules")
    refresh()
