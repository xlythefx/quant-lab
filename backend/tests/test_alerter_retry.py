"""No double orders: retry only when the request provably never reached the receiver."""
import re

import httpx
import pytest

from services import live_alerter


class _Resp:
    def __init__(self, status, text=""):
        self.status_code = status
        self.text = text


@pytest.fixture
def harness(monkeypatch):
    """Scripted httpx.post outcomes; records calls and the final dispatch event."""
    state = {"script": [], "calls": [], "events": []}

    def fake_post(url, json=None, timeout=None):
        state["calls"].append({"url": url, "json": json, "timeout": timeout})
        outcome = state["script"].pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(live_alerter.httpx, "post", fake_post)
    monkeypatch.setattr(live_alerter.time, "sleep", lambda s: None)
    monkeypatch.setattr(live_alerter, "_emit_dispatched",
                        lambda *a, **k: state["events"].append(k))
    return state


def _fire():
    live_alerter._post("https://example.invalid/hook", {"action": "BUY"}, strategy_id="s",
                       symbol="SOLUSDT", action="BUY", rule_name="r")


def test_connect_error_is_retried_then_succeeds(harness):
    harness["script"] = [httpx.ConnectError("refused"), _Resp(200)]
    _fire()
    assert len(harness["calls"]) == 2
    assert harness["events"][-1]["ok"] is True


def test_connect_timeout_is_retried(harness):
    harness["script"] = [httpx.ConnectTimeout("slow dns"), httpx.ConnectTimeout("x"), _Resp(200)]
    _fire()
    assert len(harness["calls"]) == 3


@pytest.mark.parametrize("outcome", [
    httpx.ReadTimeout("no answer"),            # the receiver may be placing the order right now
    httpx.WriteTimeout("half sent"),
    httpx.RemoteProtocolError("server closed without response"),
    _Resp(504, "gateway timeout"),
    _Resp(500, "boom"),
    _Resp(400, "bad secret"),
])
def test_ambiguous_failures_are_never_retried(harness, outcome):
    harness["script"] = [outcome]
    _fire()
    assert len(harness["calls"]) == 1
    assert harness["events"][-1]["ok"] is False


def test_502_and_503_are_retried_up_to_three_attempts(harness):
    harness["script"] = [_Resp(502), _Resp(503), _Resp(502)]
    _fire()
    assert len(harness["calls"]) == 3
    ev = harness["events"][-1]
    assert ev["ok"] is False and ev["status_code"] == 502


def test_timeout_is_ten_seconds_and_payload_shape_unchanged(harness):
    harness["script"] = [_Resp(200)]
    rule = {"name": "r", "secret": "abc12345xyz", "strategy_alias": "VWMA", "leverage": 25}
    live_alerter._post("https://example.invalid/hook",
                       live_alerter.build_payload(rule, "EXIT_LONG", "SOLUSDT", sent_at="2026-10-26T14:15:02.812Z"),
                       strategy_id="s", symbol="SOLUSDT", action="EXIT_LONG", rule_name="r")
    call = harness["calls"][0]
    assert call["timeout"] == 10.0
    assert call["json"] == {"secret": "abc12345xyz", "strategy": "VWMA", "leverage": "25",
                            "action": "EXIT_LONG", "symbol": "SOLUSDT",
                            "sent_at": "2026-10-26T14:15:02.812Z"}


def test_sent_at_is_utc_millis_and_stays_the_same_on_retries(harness):
    harness["script"] = [httpx.ConnectError("refused"), _Resp(502), _Resp(200)]
    rule = {"name": "r", "secret": "abc12345xyz", "strategy_alias": "VWMA", "leverage": 25}
    payload = live_alerter.build_payload(rule, "BUY", "SOLUSDT")
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", payload["sent_at"])
    live_alerter._post("https://example.invalid/hook", payload,
                       strategy_id="s", symbol="SOLUSDT", action="BUY", rule_name="r")
    assert len(harness["calls"]) == 3
    assert {c["json"]["sent_at"] for c in harness["calls"]} == {payload["sent_at"]}


def test_sent_at_token_in_custom_template():
    rule = {"name": "r", "secret": "s3cr3t-token", "strategy_alias": "VWMA", "leverage": 5,
            "payload_template": '{"a": "{{action}}", "t": "{{sent_at}}"}'}
    p = live_alerter.build_payload(rule, "SELL", "SOLUSDT", sent_at="2026-10-26T00:00:00.001Z")
    assert p == {"a": "SELL", "t": "2026-10-26T00:00:00.001Z"}
