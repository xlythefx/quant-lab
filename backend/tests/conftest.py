"""
Shared fixtures for the live-mode tests.

Every test runs fully offline and isolated:
  - Binance REST / websockets and webhook POSTs are blocked (tests that need
    them install their own fakes);
  - the rules file, the SQLite store and the saved runner state all live in a
    temp dir — the real data/live_alerts.json and live_terminal.db are never touched.
"""
from __future__ import annotations

import logging
import os
import sys

import pytest

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

logging.getLogger("services").setLevel(logging.WARNING)

# A tiny fake Binance spot catalog (symbol -> quote asset).
FAKE_PAIRS = {
    "BTCUSDT": "USDT", "ETHUSDT": "USDT", "SOLUSDT": "USDT", "AVAXUSDT": "USDT",
    "LTCUSDT": "USDT", "ETHBTC": "BTC", "BTCUSDC": "USDC",
}


def _blocked(*_a, **_k):
    raise RuntimeError("network access is blocked in tests")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    import httpx
    import requests

    from services import alerts_daemon, live_alerts_config, ts_csv_stream
    from services.live import live_engine, live_store, live_symbols

    # No network, ever.
    monkeypatch.setattr(requests, "get", _blocked)
    monkeypatch.setattr(requests, "post", _blocked)
    monkeypatch.setattr(httpx, "post", _blocked)

    # Fake exchangeInfo, fresh cache per test.
    monkeypatch.setattr(live_symbols, "_fetch_exchange_info", lambda: dict(FAKE_PAIRS))
    monkeypatch.setattr(live_symbols, "_cache", {"pairs": None, "expires": 0.0, "source": ""})

    # No TradeStation CSVs unless a test creates one.
    monkeypatch.setattr(ts_csv_stream, "ROOT", tmp_path / "tradestation")

    # Temp rules file / SQLite store / runner state.
    monkeypatch.setattr(live_alerts_config, "_PATH", str(tmp_path / "live_alerts.json"))
    monkeypatch.setattr(live_alerts_config, "_cache", None)
    monkeypatch.setattr(live_store, "_PATH", str(tmp_path / "live_terminal.db"))
    monkeypatch.setattr(live_store, "_conn", None)
    monkeypatch.setattr(alerts_daemon, "_STATE_DIR", str(tmp_path / "live_state"))

    # Clean module-level runtime state.
    monkeypatch.setattr(alerts_daemon, "_runners", {})
    monkeypatch.setattr(alerts_daemon, "_socket_manager", None)
    for name in ("_last_eval", "_last_dispatch"):
        monkeypatch.setattr(live_engine, name, {})
    monkeypatch.setattr(live_engine, "_fired_keys", set())
    monkeypatch.setattr(live_engine, "_fired_order", [])

    yield tmp_path

    if live_store._conn is not None:
        live_store._conn.close()
        live_store._conn = None


class FakeSocketManager:
    """Records listeners; lets a test push live frames into a runner."""

    def __init__(self):
        self.listeners = []
        self.stream = type("S", (), {"connected": True, "is_running": lambda self: True})()

    def add_listener(self, mode, symbol, tf, fn, broker=None):
        self.listeners.append(fn)

    def remove_listener(self, mode, symbol, tf, fn, broker=None):
        if fn in self.listeners:
            self.listeners.remove(fn)

    def stream_for(self, mode, symbol, tf, broker=None):
        return self.stream


@pytest.fixture
def fake_sm():
    return FakeSocketManager()


def make_rule(**over) -> dict:
    rule = {
        "name": "test-rule",
        "strategy_id": "vwma_reversion",
        "symbol": "SOLUSDT",
        "timeframe": "1h",
        "enabled": True,
        "webhook_url": "https://example.invalid/binance_test_webhook",
        "secret": "s3cret-token-123",
        "strategy_alias": "VWMA-Reversion",
        "leverage": 10,
        "payload_template": None,
        "broker": "binance",
        "params": {},
        "account": "live",
    }
    rule.update(over)
    return rule
