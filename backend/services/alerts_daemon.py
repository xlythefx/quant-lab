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

# Active headless runners keyed by rule name (unique per rule).
_runners: dict[str, "_HeadlessRunner"] = {}


# ---------------------------------------------------------------------------

class _HeadlessRunner:
    """Minimal live runner — no sid, no Socket.IO emissions, just dispatch."""

    def __init__(self, rule: dict, socket_manager):
        self.rule = rule
        self.strategy_id = rule["strategy_id"]
        self.symbol = rule["symbol"]
        self.timeframe = rule["timeframe"]
        self._sm = socket_manager
        self._state: dict = {}
        self._listener = None

        cls = get_strategy_class(self.strategy_id)
        self.strategy = cls(rule.get("params") or {})

    def start(self):
        def listener(candle):
            self._on_candle(candle)
        self._listener = listener
        self._sm.add_listener("live", self.symbol, self.timeframe, self._listener)
        log.info("[alerts_daemon] started headless runner %s/%s/%s (rule=%s)",
                 self.strategy_id, self.symbol, self.timeframe, self.rule["name"])

    def _on_candle(self, candle):
        if not bool(candle.get("isClosed", False)):
            return
        try:
            sig = self.strategy.on_candle(candle, self._state)
        except Exception:
            log.exception("[alerts_daemon] on_candle error %s/%s (rule=%s)",
                          self.strategy_id, self.symbol, self.rule["name"])
            return
        if sig is None:
            return
        live_alerter.dispatch_for_rule(self.rule, self.symbol, sig)

    def stop(self):
        if self._listener:
            self._sm.remove_listener("live", self.symbol, self.timeframe, self._listener)
            self._listener = None
        log.info("[alerts_daemon] stopped headless runner %s/%s/%s (rule=%s)",
                 self.strategy_id, self.symbol, self.timeframe, self.rule["name"])


# ---------------------------------------------------------------------------

def _wanted_rules() -> dict[str, dict]:
    """Return {rule_name: rule} for all enabled rules that have a timeframe."""
    rules = live_alerts_config.load_rules()
    return {
        r["name"]: r
        for r in rules
        if r.get("enabled") and r.get("timeframe", "").strip()
    }


def refresh():
    """Reconcile running headless runners against the current enabled rules.
    Safe to call from any thread (e.g. after saving rules via the UI).
    Restarts a runner when its params change so the new config takes effect.
    """
    if _socket_manager is None:
        return
    wanted = _wanted_rules()

    with _lock:
        # Stop runners no longer needed.
        for name in list(_runners):
            if name not in wanted:
                _runners.pop(name).stop()

        # Start runners for new/changed rules.
        for name, rule in wanted.items():
            if name in _runners:
                # Restart if params changed so the strategy picks up the new config.
                if _runners[name].rule.get("params") == rule.get("params"):
                    continue
                _runners.pop(name).stop()
            try:
                runner = _HeadlessRunner(rule, _socket_manager)
                runner.start()
                _runners[name] = runner
            except Exception:
                log.exception("[alerts_daemon] failed to start runner for rule %s", name)


def start(socket_manager):
    """Call once at Flask app startup."""
    global _socket_manager
    _socket_manager = socket_manager
    log.info("[alerts_daemon] initialising from saved rules")
    refresh()
