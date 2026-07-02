"""
Walk-Forward Optimization REST endpoints.

POST /api/walkforward/start    -> start a job, returns {job_id}
POST /api/walkforward/cancel   -> cancel current job
GET  /api/walkforward/status   -> live job state + progress
GET  /api/walkforward/last_result -> last completed result
"""
import logging
from flask import Blueprint, jsonify, request

from services import walkforward, walkforward_robustness
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
            "sessions_cfg": body.get("sessions_cfg"),
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


# ---------------------------------------------------------------------------
# Multi-seed robustness — run the same config across N optimizer seeds.
# ---------------------------------------------------------------------------

@walkforward_bp.post("/robustness/start")
def robustness_start():
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
            "sessions_cfg": body.get("sessions_cfg"),
        }
        if not spec["strategy_id"]:
            raise ValidationError("strategy_id is required")
        if not spec["search_space"]:
            raise ValidationError("a search space is required for a robustness run")
        # Seeds: accept an explicit list, or derive N seeds from n_seeds.
        seeds = body.get("seeds")
        if not seeds:
            n_seeds = max(2, min(50, int(body.get("n_seeds") or 5)))
            seeds = list(range(1, n_seeds + 1))
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = walkforward_robustness.start(spec, seeds)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.exception("robustness start failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"job_id": job_id, "seeds": seeds, "ok": True})


@walkforward_bp.post("/robustness/cancel")
def robustness_cancel():
    return jsonify({"ok": walkforward_robustness.cancel_current()})


@walkforward_bp.get("/robustness/status")
def robustness_status():
    return jsonify(walkforward_robustness.get_status())


@walkforward_bp.get("/robustness/last_result")
def robustness_last_result():
    return jsonify({"result": walkforward_robustness.get_last_result()})
