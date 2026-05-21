"""
Monte Carlo simulation endpoint.

POST /api/montecarlo/run
  body: {
    strategies: [{strategy_id, symbol, timeframe, params?, priority?}, ...],
    method:      "trade_bootstrap" | "block_bootstrap" | "synthetic",
    n_sims?:     int, block_size?: int, seed?: int,
    start_time?: int, end_time?:   int
  }
  returns: full simulation result with `is_portfolio` flag + `strategies` echo
           (see services/monte_carlo.py).
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
    raw_specs = body.get("strategies") or []
    if not isinstance(raw_specs, list) or not raw_specs:
        return jsonify({"error": "strategies must be a non-empty array"}), 400

    try:
        strategies = []
        for i, raw in enumerate(raw_specs):
            if not isinstance(raw, dict):
                raise ValidationError(f"strategies[{i}] must be an object")
            sid = (raw.get("strategy_id") or "").strip()
            if not sid:
                raise ValidationError(f"strategies[{i}].strategy_id is required")
            strategies.append({
                "strategy_id": sid,
                "symbol":   validate_symbol(raw.get("symbol")),
                "timeframe": validate_timeframe(raw.get("timeframe")),
                "params":   raw.get("params") or {},
                "priority": int(raw.get("priority", i + 1)),
            })

        method = (body.get("method") or "trade_bootstrap").strip()
        n_sims = int(body.get("n_sims") or 1000)
        block_size = body.get("block_size")
        if block_size is not None:
            block_size = int(block_size)
        seed = int(body.get("seed") or 42)
        start_time = body.get("start_time")
        end_time = body.get("end_time")
        if start_time is not None: start_time = int(start_time)
        if end_time   is not None: end_time   = int(end_time)
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = monte_carlo.run(
            method=method, strategies=strategies,
            start_time=start_time, end_time=end_time,
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
