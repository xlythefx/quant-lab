"""
Monte Carlo simulation endpoint.

POST /api/montecarlo/run
  body: {strategy_id, symbol, timeframe, params?, start_time?, end_time?,
         method: "trade_bootstrap" | "block_bootstrap" | "synthetic",
         n_sims?, block_size?, seed?}
  returns: full simulation result (see services/monte_carlo.py)
"""
import logging
from flask import Blueprint, jsonify, request

from services import monte_carlo
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

monte_carlo_bp = Blueprint("monte_carlo", __name__, url_prefix="/api/montecarlo")


@monte_carlo_bp.post("/run")
def run_mc():
    body = request.get_json(silent=True) or {}
    try:
        strategy_id = (body.get("strategy_id") or "").strip()
        if not strategy_id:
            raise ValidationError("strategy_id is required")
        symbol = validate_symbol(body.get("symbol"))
        tf = validate_timeframe(body.get("timeframe"))
        method = (body.get("method") or "trade_bootstrap").strip()
        n_sims = int(body.get("n_sims") or 1000)
        block_size = body.get("block_size")
        seed = int(body.get("seed") or 42)
        params = body.get("params") or {}
        start_time = body.get("start_time")
        end_time = body.get("end_time")
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = monte_carlo.run(
            method=method,
            strategy_id=strategy_id, symbol=symbol, timeframe=tf,
            params=params, start_time=start_time, end_time=end_time,
            n_sims=n_sims, block_size=block_size, seed=seed,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("montecarlo/run failed")
        return jsonify({"error": str(e)}), 500

    return jsonify(result)
