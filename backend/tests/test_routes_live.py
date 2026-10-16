"""REST guards: test endpoints default to dry-run; deployments are validated server-side."""
import pytest
from flask import Flask

from conftest import make_rule
from services import live_alerter, live_alerts_config


@pytest.fixture
def client():
    from routes.live_alerts_routes import live_alerts_bp
    from routes.live_terminal_routes import live_bp
    app = Flask(__name__)
    app.register_blueprint(live_alerts_bp)
    app.register_blueprint(live_bp)
    return app.test_client()


@pytest.fixture
def no_real_posts(monkeypatch):
    """Fail loudly if anything tries a real webhook POST."""
    def forbidden(*a, **k):
        raise AssertionError("a real webhook POST was attempted")
    monkeypatch.setattr(live_alerter, "_post", forbidden)
    events = []
    monkeypatch.setattr(live_alerter, "_emit_dispatched", lambda *a, **k: events.append(k))
    return events


# ---- dry-run defaults -----------------------------------------------------------

def test_legacy_test_endpoint_defaults_to_dry_run(client, no_real_posts):
    live_alerts_config.save_rules([make_rule()])
    r = client.post("/api/live-alerts/test", json={"rule_name": "test-rule", "action": "BUY"})
    assert r.status_code == 200 and r.get_json()["dry_run"] is True
    assert no_real_posts[-1]["dry_run"] is True


def test_terminal_test_signal_defaults_to_dry_run(client, no_real_posts):
    live_alerts_config.save_rules([make_rule()])
    r = client.post("/api/live/deployments/test-rule/test-signal", json={"action": "SELL"})
    assert r.status_code == 200 and r.get_json()["dry_run"] is True


def test_test_dispatch_function_defaults_to_dry_run(no_real_posts):
    live_alerts_config.save_rules([make_rule()])
    assert live_alerter.test_dispatch("test-rule", "BUY")["dry_run"] is True


# ---- validation -------------------------------------------------------------------

def _post(client, **over):
    body = make_rule(**over)
    body.pop("broker")
    return client.post("/api/live/deployments", json=body)


def test_valid_deployment_is_created(client):
    r = _post(client, symbol="AVAXUSDT", params={"vwma_length": 40, "regime_method": "five"})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["deployment"]["symbol"] == "AVAXUSDT"


@pytest.mark.parametrize("over, expect", [
    ({"strategy_id": "nope"}, "does not exist"),
    ({"strategy_id": "lunar"}, "archived"),
    ({"timeframe": "2h"}, "not supported live"),
    ({"symbol": "MEXC.SOLUSDT"}, "research symbol"),
    ({"symbol": "FOOUSDT"}, "not a trading Binance spot pair"),
    ({"params": {"vwma_length": 5000}}, "above the maximum"),
    ({"params": {"vwma_length": 3}}, "below the minimum"),
    ({"params": {"vwma_length": 12.5}}, "whole number"),
    ({"params": {"z_threshold": "big"}}, "must be a number"),
    ({"params": {"atr_stop": "yes"}}, "true/false"),
    ({"params": {"regime_method": "magic"}}, "is not one of"),
    ({"params": {"sides": {"long": True, "sideways": True}}}, "unknown key"),
    ({"params": {"sessions": {"tokyo": {"start": "9am"}}}}, "HH:MM"),
    ({"params": {"vwma_lenght": 40}}, "unknown param"),
])
def test_invalid_deployment_is_rejected_with_reasons(client, over, expect):
    r = _post(client, **over)
    assert r.status_code == 400
    data = r.get_json()
    assert any(expect in p for p in data["problems"]), data
    assert expect in data["error"]
    assert live_alerts_config.load_rules() == []          # nothing saved


def test_patch_is_validated_but_pause_always_works(client):
    assert _post(client).status_code == 200
    bad = client.patch("/api/live/deployments/test-rule", json={"params": {"vwma_length": 9999}})
    assert bad.status_code == 400 and "above the maximum" in bad.get_json()["error"]

    # A stored rule that has since become invalid can still be paused.
    rules = live_alerts_config.load_rules()
    rules[0]["params"] = {"vwma_length": 9999}
    live_alerts_config.save_rules(rules)
    ok = client.patch("/api/live/deployments/test-rule", json={"status": "PAUSED"})
    assert ok.status_code == 200 and ok.get_json()["deployment"]["status"] == "PAUSED"


def test_legacy_put_validates_only_new_or_changed_enabled_rules(client):
    old_bad = make_rule(name="old", symbol="MEXC.SOLUSDT")      # predates validation
    live_alerts_config.save_rules([old_bad])
    good_new = make_rule(name="new")
    r = client.put("/api/live-alerts", json={"rules": [old_bad, good_new]})
    assert r.status_code == 200, r.get_json()                    # unchanged old rule doesn't block

    bad_new = make_rule(name="bad", timeframe="3m")
    r = client.put("/api/live-alerts", json={"rules": [old_bad, good_new, bad_new]})
    assert r.status_code == 400 and "bad:" in r.get_json()["error"]

    paused_bad = make_rule(name="paused", symbol="ES", enabled=False)
    r = client.put("/api/live-alerts", json={"rules": [old_bad, good_new, paused_bad]})
    assert r.status_code == 200                                   # disabled rules aren't run


def test_instruments_lists_deployable_usdt_pairs(client):
    data = client.get("/api/live/instruments").get_json()
    assert data["deploy_symbols"] == ["AVAXUSDT", "BTCUSDT", "ETHUSDT", "LTCUSDT", "SOLUSDT"]
    assert data["instruments"]                                    # chart list unchanged


# ---- payload preview shows the REAL secret (owner's call) ------------------------

def test_payload_preview_uses_stored_secret_for_an_existing_rule(client):
    live_alerts_config.save_rules([make_rule(secret="real-token-123")])
    r = client.post("/api/live/payload-preview", json={"name": "test-rule", "symbol": "LTCUSDT"})
    assert r.status_code == 200
    assert r.get_json()["payloads"]["BUY"]["secret"] == "real-token-123"


def test_payload_preview_prefers_a_typed_secret_then_a_reused_one(client):
    live_alerts_config.save_rules([make_rule(secret="donor-token")])
    typed = client.post("/api/live/payload-preview", json={"name": "test-rule", "secret": "typed-token"})
    assert typed.get_json()["payloads"]["SELL"]["secret"] == "typed-token"
    reused = client.post("/api/live/payload-preview", json={"secret": "***", "secret_source": "test-rule"})
    assert reused.get_json()["payloads"]["SELL"]["secret"] == "donor-token"
    none = client.post("/api/live/payload-preview", json={"name": "nope"})
    assert none.get_json()["payloads"]["BUY"]["secret"] == "<no secret set>"
