"""
Overnight Run REST endpoints.

POST /api/overnight_run/start       -> start a batch, returns {job_id}
POST /api/overnight_run/cancel      -> cancel the current batch
GET  /api/overnight_run/status      -> live job state + progress
GET  /api/overnight_run/last_result -> last completed/checkpointed result
GET  /api/overnight_run/history     -> lightweight list of past runs
POST /api/overnight_run/estimate    -> {combos_per_asset, n_assets, ...}

Asset picker reuses the existing GET /api/datasets (cached datasets).
"""
import logging
from flask import Blueprint, jsonify, request

from services import overnight_run
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

overnight_run_bp = Blueprint("overnight_run", __name__, url_prefix="/api/overnight_run")


@overnight_run_bp.post("/start")
def start_job():
    body = request.get_json(silent=True) or {}
    try:
        symbols = [validate_symbol(s) for s in (body.get("symbols") or [])]
        spec = {
            "strategy_id": (body.get("strategy_id") or "").strip(),
            "timeframe":   validate_timeframe(body.get("timeframe")),
            "symbols":     symbols,
            "mode":        body.get("mode"),
            "grid_params": body.get("grid_params") or [],
            "search_space": body.get("search_space") or [],
            "base_params": body.get("base_params") or {},
            "metric":      body.get("metric"),
            "n_workers":   body.get("n_workers"),
            "wf_opts":     body.get("wf_opts") or {},
        }
        if not spec["strategy_id"]:
            raise ValidationError("strategy_id is required")
        if not symbols:
            raise ValidationError("select at least one asset")
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = overnight_run.start(spec)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("overnight_run start failed")
        return jsonify({"error": str(e)}), 500

    return jsonify({"job_id": job_id, "ok": True})


@overnight_run_bp.post("/cancel")
def cancel_job():
    return jsonify({"ok": overnight_run.cancel_current()})


@overnight_run_bp.get("/status")
def status():
    return jsonify(overnight_run.get_status())


@overnight_run_bp.get("/last_result")
def last_result():
    return jsonify({"result": overnight_run.get_last_result()})


@overnight_run_bp.get("/history")
def history():
    return jsonify({"runs": overnight_run.get_history()})


@overnight_run_bp.post("/estimate")
def estimate():
    body = request.get_json(silent=True) or {}
    return jsonify(overnight_run.estimate(body))
