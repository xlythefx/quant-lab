"""
Live-alert rule CRUD + test-fire endpoint.
"""
from flask import Blueprint, jsonify, request

from services import live_alerts_config, live_alerter, alerts_daemon

live_alerts_bp = Blueprint("live_alerts", __name__, url_prefix="/api")


@live_alerts_bp.get("/live-alerts")
def get_live_alerts():
    # Never ship plaintext secrets to the browser. save_rules() restores the real
    # secret from the stored rule of the same name, so these masked values can be
    # edited and resubmitted safely (edit / enabled-toggle / delete all round-trip).
    return jsonify({"rules": live_alerts_config.masked_rules()})


@live_alerts_bp.put("/live-alerts")
def put_live_alerts():
    body = request.get_json(silent=True) or {}
    rules = body.get("rules") if isinstance(body, dict) else body
    live_alerts_config.save_rules(rules or [])
    alerts_daemon.refresh()
    # Return masked rules (same as GET) so the save round-trip never echoes
    # plaintext secrets back to the browser.
    return jsonify({"rules": live_alerts_config.masked_rules()})


@live_alerts_bp.post("/live-alerts/test")
def test_live_alert():
    body = request.get_json(silent=True) or {}
    rule_name = (body.get("rule_name") or "").strip()
    action = (body.get("action") or "BUY").strip().upper()
    dry_run = bool(body.get("dry_run", False))  # old page: real POST (unchanged)
    if not rule_name:
        return jsonify({"ok": False, "error": "rule_name required"}), 400
    return jsonify(live_alerter.test_dispatch(rule_name, action, dry_run=dry_run))
