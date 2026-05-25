"""
Live-alert rule CRUD + test-fire endpoint.
"""
from flask import Blueprint, jsonify, request

from services import live_alerts_config, live_alerter

live_alerts_bp = Blueprint("live_alerts", __name__, url_prefix="/api")


@live_alerts_bp.get("/live-alerts")
def get_live_alerts():
    return jsonify({"rules": live_alerts_config.load_rules()})


@live_alerts_bp.put("/live-alerts")
def put_live_alerts():
    body = request.get_json(silent=True) or {}
    rules = body.get("rules") if isinstance(body, dict) else body
    saved = live_alerts_config.save_rules(rules or [])
    return jsonify({"rules": saved})


@live_alerts_bp.post("/live-alerts/test")
def test_live_alert():
    body = request.get_json(silent=True) or {}
    rule_name = (body.get("rule_name") or "").strip()
    action = (body.get("action") or "BUY").strip().upper()
    if not rule_name:
        return jsonify({"ok": False, "error": "rule_name required"}), 400
    return jsonify(live_alerter.test_dispatch(rule_name, action))
