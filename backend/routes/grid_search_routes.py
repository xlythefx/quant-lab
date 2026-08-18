"""
Grid Search REST endpoints.

POST /api/grid_search/start       -> start a job, returns {job_id}
POST /api/grid_search/cancel      -> cancel current job
GET  /api/grid_search/status      -> live job state + progress
GET  /api/grid_search/last_result -> last completed result
POST /api/grid_search/estimate    -> {combos, projected_seconds, warn, refuse}
"""
import logging
from flask import Blueprint, jsonify, request

from services import grid_search
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

grid_search_bp = Blueprint("grid_search", __name__, url_prefix="/api/grid_search")


@grid_search_bp.post("/start")
def start_job():
    body = request.get_json(silent=True) or {}
    try:
        spec = {
            "strategy_id": (body.get("strategy_id") or "").strip(),
            "symbol":      validate_symbol(body.get("symbol")),
            "timeframe":   validate_timeframe(body.get("timeframe")),
            "start_time":  body.get("start_time"),
            "end_time":    body.get("end_time"),
            "base_params": body.get("base_params") or {},
            "grid_params": body.get("grid_params") or [],
            "metric":      body.get("metric"),
            "target_trades":     body.get("target_trades"),
            "target_trades_tol": body.get("target_trades_tol"),
            "n_workers":   body.get("n_workers"),
        }
        if not spec["strategy_id"]:
            raise ValidationError("strategy_id is required")
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = grid_search.start(spec)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("grid_search start failed")
        return jsonify({"error": str(e)}), 500

    return jsonify({"job_id": job_id, "ok": True})


@grid_search_bp.post("/cancel")
def cancel_job():
    ok = grid_search.cancel_current()
    return jsonify({"ok": ok})


@grid_search_bp.get("/status")
def status():
    return jsonify(grid_search.get_status())


@grid_search_bp.get("/last_result")
def last_result():
    r = grid_search.get_last_result()
    if r is None:
        return jsonify({"result": None})
    return jsonify({"result": r})


@grid_search_bp.post("/estimate")
def estimate():
    body = request.get_json(silent=True) or {}
    return jsonify(grid_search.estimate(body))
