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
    strategy_id = (body.get("strategy_id") or "").strip()
    symbol = (body.get("symbol") or "").strip().upper()
    if not strategy_id or not symbol:
        return jsonify({"ok": False, "error": "strategy_id and symbol required"}), 400
    return jsonify(live_alerter.test_dispatch(strategy_id, symbol))
