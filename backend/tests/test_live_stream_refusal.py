"""Live mode never replays history: no feed -> a clear refusal, never BacktestStream."""
import pytest

from services import socket_manager as sm_mod
from services.socket_manager import LiveFeedUnavailable, SocketManager


class _FakeSio:
    def __init__(self):
        self.emitted = []
        self.server = type("Srv", (), {"enter_room": lambda *a: None, "leave_room": lambda *a: None})()

    def emit(self, event, payload, room=None, to=None):
        self.emitted.append((event, payload, room or to))


class _DummyStream:
    made = []

    def __init__(self, symbol, tf, emit, *a, **k):
        self.symbol, self.tf = symbol, tf
        _DummyStream.made.append(self)

    def start(self):
        pass

    def stop(self):
        pass

    def is_running(self):
        return True


@pytest.fixture
def manager(monkeypatch):
    _DummyStream.made = []

    def replay_forbidden(*a, **k):
        raise AssertionError("BacktestStream must never be built in live mode")

    monkeypatch.setattr(sm_mod, "BinanceKlineStream", _DummyStream)
    monkeypatch.setattr(sm_mod, "BacktestStream", replay_forbidden)
    return SocketManager(_FakeSio())


def test_add_listener_refuses_ineligible_symbol(manager):
    with pytest.raises(LiveFeedUnavailable) as e:
        manager.add_listener("live", "MEXC.SOLUSDT", "1h", lambda c: None)
    assert "never replays" in str(e.value)
    assert manager._listeners == {}                      # nothing half-registered
    with pytest.raises(LiveFeedUnavailable):
        manager.add_listener("live", "ES", "1h", lambda c: None)   # no TradeStation CSV here


def test_browser_subscribe_gets_stream_error_not_replay(manager):
    ok = manager.subscribe("sid-1", "live", "FOOUSDT", "1h")
    assert ok is False
    event, payload, target = manager._sio.emitted[-1]
    assert event == "stream_error" and target == "sid-1"
    assert "FOOUSDT" in payload["message"]
    assert not manager._room_members                      # not left as a member


def test_eligible_symbol_gets_the_binance_stream(manager):
    manager.add_listener("live", "AVAXUSDT", "15m", lambda c: None)
    assert [s.symbol for s in _DummyStream.made] == ["AVAXUSDT"]
    assert manager.stream_for("live", "AVAXUSDT", "15m") is _DummyStream.made[0]


def test_backtest_mode_still_replays(monkeypatch, manager):
    monkeypatch.setattr(sm_mod, "BacktestStream", _DummyStream)
    assert manager.subscribe("sid-2", "backtest", "MEXC.SOLUSDT", "1h") is True
    assert _DummyStream.made[-1].symbol == "MEXC.SOLUSDT"


def test_reconnected_notice_reaches_listeners_not_browsers(monkeypatch, manager):
    captured = {}

    class Capture(_DummyStream):
        def __init__(self, symbol, tf, emit_fn, *a, **k):
            super().__init__(symbol, tf, emit_fn)
            captured["emit"] = emit_fn

    monkeypatch.setattr(sm_mod, "BinanceKlineStream", Capture)
    seen = []
    manager.add_listener("live", "SOLUSDT", "1h", seen.append)
    captured["emit"]({"__event": "reconnected"})
    assert seen == [{"__event": "reconnected"}]
    assert not any(ev == "candle_update" for ev, _, _ in manager._sio.emitted)
