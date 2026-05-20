"""
Walk-Forward Optimization REST endpoints.

POST /api/walkforward/start    -> start a job, returns {job_id}
POST /api/walkforward/cancel   -> cancel current job
GET  /api/walkforward/status   -> live job state + progress
GET  /api/walkforward/last_result -> last completed result
"""
import logging
from flask import Blueprint, jsonify, request

from services import walkforward
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

walkforward_bp = Blueprint("walkforward", __name__, url_prefix="/api/walkforward")


@walkforward_bp.post("/start")
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
            "search_space": body.get("search_space") or [],
            "is_bars":     body.get("is_bars"),
            "oos_bars":    body.get("oos_bars"),
            "n_trials":    body.get("n_trials"),
            "n_workers":   body.get("n_workers"),
            "metric":      body.get("metric"),
            "embargo_bars": body.get("embargo_bars"),
            "purge_radius": body.get("purge_radius"),
        }
        if not spec["strategy_id"]:
            raise ValidationError("strategy_id is required")
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = walkforward.start(spec)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("walkforward start failed")
        return jsonify({"error": str(e)}), 500

    return jsonify({"job_id": job_id, "ok": True})


@walkforward_bp.post("/cancel")
def cancel_job():
    ok = walkforward.cancel_current()
    return jsonify({"ok": ok})


@walkforward_bp.get("/status")
def status():
    return jsonify(walkforward.get_status())


@walkforward_bp.get("/last_result")
def last_result():
    r = walkforward.get_last_result()
    if r is None:
        return jsonify({"result": None})
    return jsonify({"result": r})
