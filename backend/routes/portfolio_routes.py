"""
Portfolio backtest route — accepts 1..N strategies and runs them through
the shared-cash-pool PortfolioRunner. Single-strategy callers can still use
/api/strategies/run (which now also wraps PortfolioRunner under the hood).
"""
import logging
from flask import Blueprint, jsonify, request

from services import portfolio_runner
from services.portfolio_runner import StrategySpec
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

portfolio_bp = Blueprint("portfolio", __name__, url_prefix="/api")


@portfolio_bp.post("/backtest/portfolio")
def run_backtest_portfolio():
    """Run a portfolio backtest across 1..N strategies sharing one cash pool.

    Request body:
        {
          "strategies": [
            { "strategy_id": "vwma_momentum",
              "symbol": "BTCUSDT", "timeframe": "1h",
              "params": { "risk_pct": 2.0, ... },
              "priority": 1 },
            ...
          ],
          "start_time": <epoch_seconds_or_null>,
          "end_time":   <epoch_seconds_or_null>
        }

    Response: see services.portfolio_runner.run_portfolio for the full shape.
    """
    body = request.get_json(silent=True) or {}
    raw_specs = body.get("strategies") or []
    if not isinstance(raw_specs, list) or not raw_specs:
        return jsonify({"error": "strategies must be a non-empty array"}), 400

    try:
        specs = []
        for i, raw in enumerate(raw_specs):
            if not isinstance(raw, dict):
                raise ValidationError(f"strategies[{i}] must be an object")
            sid = (raw.get("strategy_id") or "").strip()
            if not sid:
                raise ValidationError(f"strategies[{i}].strategy_id is required")
            symbol = validate_symbol(raw.get("symbol"))
            tf     = validate_timeframe(raw.get("timeframe"))
            params = raw.get("params") or {}
            broker = (raw.get("broker") or None)
            try:
                priority = int(raw.get("priority", 100))
            except (TypeError, ValueError):
                raise ValidationError(f"strategies[{i}].priority must be an integer")
            specs.append(StrategySpec(strategy_id=sid, symbol=symbol,
                                      timeframe=tf, params=params,
                                      priority=priority, broker=broker))
        start_time = body.get("start_time")
        end_time   = body.get("end_time")
        if start_time is not None: start_time = int(start_time)
        if end_time   is not None: end_time   = int(end_time)
        # Optional per-run cost overrides (does NOT touch the saved Risk Settings).
        # Used by the equity-curve compare (e.g. a zero-cost variant). Only known
        # numeric cost keys are honored — everything else is ignored.
        risk_overrides = None
        raw_ov = body.get("risk_overrides")
        if isinstance(raw_ov, dict):
            allowed = ("fee_pct", "fee_flat", "slippage_bps", "futures_commission")
            risk_overrides = {}
            for k in allowed:
                if k in raw_ov and raw_ov[k] is not None:
                    risk_overrides[k] = float(raw_ov[k])
            risk_overrides = risk_overrides or None
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"invalid request: {e}"}), 400

    # Socket id of the requesting client (optional) — lets the runner stream live
    # progress (stage + HMM refit %) back to just this client while the run blocks.
    client_sid = body.get("sid") or None

    try:
        result = portfolio_runner.run_portfolio(specs, start_time=start_time,
                                                end_time=end_time, sid=client_sid,
                                                risk_overrides=risk_overrides)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("backtest/portfolio failed")
        return jsonify({"error": str(e)}), 500

    return jsonify(result)
