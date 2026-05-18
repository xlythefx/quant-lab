"""
AI insights endpoints — Claude-powered analysis of MC / WF results,
plus AI-suggested WFA config.

Endpoints (POST, all on /api/ai):
  /insights/monte-carlo  body: {mc_result}                 -> {text, model, usage}
  /insights/walkforward  body: {wf_result}                 -> {text, model, usage}
  /suggest/walkforward   body: {strategy_id, symbol, ...}  -> {suggestion, model, usage}

The Anthropic API key lives in backend/.env — never exposed to the frontend.
"""
import logging
from flask import Blueprint, jsonify, request

from services import ai_insights

log = logging.getLogger(__name__)

ai_bp = Blueprint("ai", __name__, url_prefix="/api/ai")


def _handle(fn, body):
    try:
        return jsonify(fn(body))
    except ai_insights.AIDisabledError as e:
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        log.exception("AI call failed")
        return jsonify({"error": str(e)}), 500


@ai_bp.post("/insights/monte-carlo")
def mc_insights():
    body = request.get_json(silent=True) or {}
    mc = body.get("mc_result")
    if not isinstance(mc, dict):
        return jsonify({"error": "mc_result (object) is required"}), 400
    return _handle(ai_insights.analyze_monte_carlo, mc)


@ai_bp.post("/insights/walkforward")
def wf_insights():
    body = request.get_json(silent=True) or {}
    wf = body.get("wf_result")
    if not isinstance(wf, dict):
        return jsonify({"error": "wf_result (object) is required"}), 400
    return _handle(ai_insights.analyze_walkforward, wf)


@ai_bp.post("/insights/backtest-section")
def backtest_section_insights():
    body = request.get_json(silent=True) or {}
    result = body.get("result")
    section = body.get("section")
    if not isinstance(result, dict) or not isinstance(section, str):
        return jsonify({"error": "result (object) and section (string) are required"}), 400
    return _handle(ai_insights.analyze_backtest_section, {"result": result, "section": section})


@ai_bp.post("/suggest/walkforward")
def wf_suggest():
    body = request.get_json(silent=True) or {}
    # Strip nothing — pass the full meta blob through. The service has its own
    # heuristics for what to weight.
    return _handle(ai_insights.suggest_walkforward, body)
