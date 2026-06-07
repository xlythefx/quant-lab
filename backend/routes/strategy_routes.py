"""
Strategy catalog + Hindsight backtest run endpoint.

The /strategies/run route is the legacy single-strategy endpoint. It now
internally calls the unified PortfolioRunner with one StrategySpec and
unwraps the response to the legacy shape — so frontend code that hasn't
migrated to /backtest/portfolio keeps working unchanged.
"""
import logging
from flask import Blueprint, jsonify, request

from services import strategy_registry, portfolio_runner
from services.portfolio_runner import StrategySpec
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
    """Hindsight backtest: returns the full result in one shot.

    Legacy single-strategy endpoint — wraps PortfolioRunner. New code should
    POST to /api/backtest/portfolio for multi-strategy support.
    """
    body = request.get_json(silent=True) or {}
    try:
        strategy_id = (body.get("strategy_id") or "").strip()
        if not strategy_id:
            raise ValidationError("strategy_id is required")
        symbol = validate_symbol(body.get("symbol"))
        tf = validate_timeframe(body.get("timeframe"))
        params = body.get("params") or {}
        broker = (body.get("broker") or None)
        start_time = body.get("start_time")
        end_time = body.get("end_time")
        if start_time is not None: start_time = int(start_time)
        if end_time   is not None: end_time   = int(end_time)
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        spec = StrategySpec(strategy_id=strategy_id, symbol=symbol,
                            timeframe=tf, params=params, priority=1, broker=broker)
        pres = portfolio_runner.run_portfolio(
            [spec], start_time=start_time, end_time=end_time,
        )
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("strategies/run failed")
        return jsonify({"error": str(e)}), 500

    # Unwrap to the legacy single-strategy shape so existing frontend code
    # (Dashboard, Analytics, Monte Carlo) keeps working without a migration.
    psd = pres["per_strategy"].get(strategy_id, {})
    legacy = {
        "strategy_id": strategy_id,
        "symbol": symbol,
        "timeframe": tf,
        "risk_config": pres["risk_config"],
        "params": psd.get("spec", {}).get("params", params),
        "candles":  psd.get("candles", []),
        "overlays": psd.get("overlays", []),
        "trades":   psd.get("trades", []),
        "equity":   psd.get("equity", []),
        "stats":    psd.get("stats", {}),
        "analytics": psd.get("analytics", {}),
    }
    return jsonify(legacy)
