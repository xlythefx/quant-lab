"""
Strategy catalog + Hindsight backtest run endpoint.
"""
import logging
from flask import Blueprint, jsonify, request

from services import strategy_registry, backtest_engine
from utils.validators import (
    validate_symbol, validate_timeframe, ValidationError,
)

log = logging.getLogger(__name__)

strategy_bp = Blueprint("strategy", __name__, url_prefix="/api")


@strategy_bp.get("/strategies")
def list_strategies():
    return jsonify({"strategies": strategy_registry.list_strategies()})


@strategy_bp.post("/strategies/run")
def run_strategy():
    """Hindsight backtest: returns the full result in one shot."""
    body = request.get_json(silent=True) or {}
    try:
        strategy_id = (body.get("strategy_id") or "").strip()
        if not strategy_id:
            raise ValidationError("strategy_id is required")
        symbol = validate_symbol(body.get("symbol"))
        tf = validate_timeframe(body.get("timeframe"))
        params = body.get("params") or {}
        start_time = body.get("start_time")
        end_time = body.get("end_time")
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = backtest_engine.run(strategy_id, symbol, tf, params,
                                     start_time=start_time, end_time=end_time)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("strategies/run failed")
        return jsonify({"error": str(e)}), 500

    return jsonify(result)
