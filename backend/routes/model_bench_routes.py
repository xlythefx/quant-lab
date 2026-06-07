"""
Model Bench REST endpoints (async LSTM training job).

POST /api/modelbench/start       -> start a job, returns {job_id}
POST /api/modelbench/cancel      -> cancel current job
GET  /api/modelbench/status      -> live job state + progress
GET  /api/modelbench/last_result -> last completed result
"""
import logging
from flask import Blueprint, jsonify, request

from services import model_bench
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

model_bench_bp = Blueprint("model_bench", __name__, url_prefix="/api/modelbench")


@model_bench_bp.post("/start")
def start_job():
    body = request.get_json(silent=True) or {}
    try:
        spec = {
            "symbol": validate_symbol(body.get("symbol")),
            "timeframe": validate_timeframe(body.get("timeframe")),
            "start_time": body.get("start_time"),
            "end_time": body.get("end_time"),
            "seq_len": body.get("seq_len"),
            "fwd_horizon": body.get("fwd_horizon"),
            "hidden": body.get("hidden"),
            "epochs": body.get("epochs"),
            "max_samples": body.get("max_samples"),
        }
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    try:
        job_id = model_bench.start(spec)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.exception("modelbench start failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"job_id": job_id, "ok": True})


@model_bench_bp.post("/cancel")
def cancel_job():
    return jsonify({"ok": model_bench.cancel_current()})


@model_bench_bp.get("/status")
def status():
    return jsonify(model_bench.get_status())


@model_bench_bp.get("/last_result")
def last_result():
    return jsonify({"result": model_bench.get_last_result()})
