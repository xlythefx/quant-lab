"""
Tracks active strategy runners per (sid, strategy_id, symbol, tf, mode).
"""
from __future__ import annotations

import logging
from threading import Lock

from services import event_bus
from services.strategy_registry import get_strategy_class
from services.strategy_runner import VectorizedRunner, LiveRunner

log = logging.getLogger(__name__)


class StrategyManager:
    def __init__(self, socket_manager):
        self._sm = socket_manager
        self._runners: dict = {}   # key -> runner
        self._lock = Lock()

    @staticmethod
    def _key(sid, strategy_id, symbol, tf, mode):
        return (sid, strategy_id, symbol, tf, mode)

    def start(self, sid, strategy_id, symbol, tf, mode, params: dict | None = None):
        params = params or {}
        cls = get_strategy_class(strategy_id)
        strategy = cls(params)
        if mode == "backtest":
            runner = VectorizedRunner(sid, strategy_id, strategy, symbol, tf, self._sm)
        elif mode == "live":
            runner = LiveRunner(sid, strategy_id, strategy, symbol, tf, self._sm)
        else:
            raise ValueError(f"unknown mode: {mode}")

        key = self._key(sid, strategy_id, symbol, tf, mode)
        with self._lock:
            existing = self._runners.pop(key, None)
            if existing:
                existing.stop()
            self._runners[key] = runner

        runner.start()
        event_bus.emit("strategy_started", {
            "strategy_id": strategy_id, "symbol": symbol,
            "timeframe": tf, "mode": mode, "params": strategy.p,
        }, to=sid)
        log.info("started runner %s", key)

    def stop(self, sid, strategy_id, symbol, tf, mode):
        key = self._key(sid, strategy_id, symbol, tf, mode)
        with self._lock:
            runner = self._runners.pop(key, None)
        if runner:
            runner.stop()
            event_bus.emit("strategy_stopped", {
                "strategy_id": strategy_id, "symbol": symbol,
                "timeframe": tf, "mode": mode,
            }, to=sid)
            log.info("stopped runner %s", key)

    def apply(self, sid, strategy_id, symbol, tf, mode, params: dict | None = None):
        """Stop + start with new params. Equity resets."""
        self.stop(sid, strategy_id, symbol, tf, mode)
        self.start(sid, strategy_id, symbol, tf, mode, params)

    def cleanup_sid(self, sid: str):
        with self._lock:
            keys = [k for k in self._runners if k[0] == sid]
        for k in keys:
            self.stop(*k)
