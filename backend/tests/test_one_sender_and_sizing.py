"""Only the daemon sends webhooks; the journal's $ estimate reads risk_pct as a percent."""
from conftest import FakeSocketManager, make_rule
from services import live_alerter, risk_config, strategy_runner
from services.live import live_engine
from services.strategies.base import Signal, Strategy


class _Always(Strategy):
    def on_candle(self, candle, state):
        return Signal(side="long", kind="entry", price=candle["close"], time=candle["time"])

    def vectorized(self, df):
        return df


def test_legacy_browser_live_runner_never_sends_webhooks(monkeypatch):
    def forbidden(*a, **k):
        raise AssertionError("the legacy LiveRunner tried to send a webhook")

    monkeypatch.setattr(live_alerter, "dispatch_for_rule", forbidden)
    monkeypatch.setattr(live_alerter, "_post", forbidden)
    monkeypatch.setattr(strategy_runner.LiveRunner, "_save_state", lambda self: None)
    runner = strategy_runner.LiveRunner("sid", "x", _Always({}), "SOLUSDT", "1h", FakeSocketManager())
    runner._on_candle({"time": 1_700_000_000, "open": 1, "high": 1, "low": 1, "close": 1, "isClosed": True})
    assert not hasattr(live_alerter, "dispatch")      # the fan-out sender is gone entirely


def test_notional_estimate_treats_risk_pct_as_percent(monkeypatch):
    monkeypatch.setattr(risk_config, "get", lambda: {"starting_capital": 100_000.0})
    rule = make_rule(params={"risk_pct": 3.0}, leverage=10)
    assert live_engine._notional_estimate(rule) == 100_000.0 * 0.03 * 10
    # No override -> the strategy's own default (3.0% for vwma_reversion).
    assert live_engine._notional_estimate(make_rule(params={}, leverage=1)) == 3_000.0
