"""
Cost Sensitivity Sweep REST endpoints.

POST /api/cost_sweep/start       -> start a job, returns {job_id}
POST /api/cost_sweep/cancel      -> cancel current job
GET  /api/cost_sweep/status      -> live job state + progress
GET  /api/cost_sweep/last_result -> last completed result
"""
import logging
from flask import Blueprint, jsonify, request

from services import cost_sweep
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

cost_sweep_bp = Blueprint("cost_sweep", __name__, url_prefix="/api/cost_sweep")


@cost_sweep_bp.post("/start")
def start_job():
    body = request.get_json(silent=True) or {}
    try:
        spec = {
            "strategy_id":  (body.get("strategy_id") or "").strip(),
            "symbol":       validate_symbol(body.get("symbol")),
            "timeframe":    validate_timeframe(body.get("timeframe")),
            "start_time":   body.get("start_time"),
            "end_time":     body.get("end_time"),
            "params":       body.get("params") or {},
            "sweep_dim":    body.get("sweep_dim"),
            "sweep_values": body.get("sweep_values") or [],
            "metric":       body.get("metric"),
        }
        if not spec["strategy_id"]:
            raise ValidationError("strategy_id is required")
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = cost_sweep.start(spec)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("cost_sweep start failed")
        return jsonify({"error": str(e)}), 500

    return jsonify({"job_id": job_id, "ok": True})


@cost_sweep_bp.post("/cancel")
def cancel_job():
    ok = cost_sweep.cancel_current()
    return jsonify({"ok": ok})


@cost_sweep_bp.get("/status")
def status():
    return jsonify(cost_sweep.get_status())


@cost_sweep_bp.get("/last_result")
def last_result():
    r = cost_sweep.get_last_result()
    if r is None:
        return jsonify({"result": None})
    return jsonify({"result": r})
