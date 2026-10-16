"""
Live-alert rule CRUD + test-fire endpoint.
"""
from flask import Blueprint, jsonify, request

from services import live_alerts_config, live_alerter, alerts_daemon
from services.live.rule_validation import validate_rule

live_alerts_bp = Blueprint("live_alerts", __name__, url_prefix="/api")

def _behaviour(r: dict) -> tuple:
    """The fields that change what a rule RUNS. Only rules whose behaviour changed
    are re-validated on save, so an old rule can't block editing the others."""
    return (str(r.get("strategy_id") or "").strip(), str(r.get("symbol") or "").strip().upper(),
            str(r.get("timeframe") or "").strip(), r.get("params") or {}, bool(r.get("enabled", True)))


def _problems_for_save(incoming, current_by_name: dict) -> list[str]:
    """Validate every ENABLED rule that is new or whose behaviour changed."""
    problems = []
    for r in incoming if isinstance(incoming, list) else []:
        if not isinstance(r, dict) or not r.get("enabled", True):
            continue   # disabling must always be possible
        name = str(r.get("name") or "").strip()
        old = current_by_name.get(name)
        if old is not None and _behaviour(old) == _behaviour(r):
            continue
        problems += [f"{name or 'new rule'}: {p}" for p in validate_rule(r)]
    return problems


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
    current = {r["name"]: r for r in live_alerts_config.load_rules()}
    problems = _problems_for_save(rules or [], current)
    if problems:
        return jsonify({"error": "rules rejected: " + "; ".join(problems), "problems": problems}), 400
    saved = live_alerts_config.save_rules(rules or [])
    alerts_daemon.refresh()
    for gone in set(current) - {r["name"] for r in saved}:
        alerts_daemon.forget_state(gone)
    # Return masked rules (same as GET) so the save round-trip never echoes
    # plaintext secrets back to the browser.
    return jsonify({"rules": live_alerts_config.masked_rules()})


@live_alerts_bp.post("/live-alerts/test")
def test_live_alert():
    body = request.get_json(silent=True) or {}
    rule_name = (body.get("rule_name") or "").strip()
    action = (body.get("action") or "BUY").strip().upper()
    # SAFE DEFAULT: dry-run unless the caller explicitly asks for a real POST.
    dry_run = bool(body.get("dry_run", True))
    if not rule_name:
        return jsonify({"ok": False, "error": "rule_name required"}), 400
    return jsonify(live_alerter.test_dispatch(rule_name, action, dry_run=dry_run))
