"""
Market Lab — read-only structural analysis endpoints.

All three are synchronous POSTs (fast vectorized passes over one DataFrame — no
jobs/threads/sockets). See services/market_lab.py for the math.

POST /api/marketlab/regime      — regime classification + forward-return / transition stats
POST /api/marketlab/volatility  — realized vol, clustering, EWMA/persistence forecast + skill
POST /api/marketlab/statistics  — day/hour (UTC) returns, autocorrelation, distribution, streaks
POST /api/marketlab/weekday-windows — 7×7 entry-day → exit-day grid (Weekday Swing V2 fills), IS/OOS
POST /api/marketlab/pair-check — rolling cointegration of two coins + a gap-trade sim vs a fake pair
     (body: symbol_y, symbol_x instead of symbol — see services/pair_check.py)
POST /api/marketlab/drift-check — does a coin's drift away from an anchor (BTC) keep going? research
     data only; /drift-check/universe lists the coins, /drift-check/open-holdout opens the sealed
     months once (see services/drift_check.py)

  body (all three): {
    symbol, timeframe,
    start_time?: int, end_time?: int,
    params?: { ...module-specific overrides... }
  }
"""
import logging
from flask import Blueprint, jsonify, request

from services import market_lab
from services import pair_check as pair_check_svc
from services import drift_check as drift_svc
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

market_lab_bp = Blueprint("market_lab", __name__, url_prefix="/api/marketlab")


def _parse_common(body):
    """Validate + coerce the shared request fields. Raises ValidationError/ValueError."""
    symbol = validate_symbol(body.get("symbol"))
    timeframe = validate_timeframe(body.get("timeframe"))
    start_time = body.get("start_time")
    end_time = body.get("end_time")
    if start_time is not None:
        start_time = int(start_time)
    if end_time is not None:
        end_time = int(end_time)
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise ValidationError("params must be an object")
    return symbol, timeframe, start_time, end_time, params


def _run(fn, name):
    body = request.get_json(silent=True) or {}
    try:
        symbol, timeframe, start_time, end_time, params = _parse_common(body)
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = fn(symbol, timeframe, start_time, end_time, params)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("marketlab/%s failed", name)
        return jsonify({"error": str(e)}), 500

    return jsonify(result)


@market_lab_bp.post("/regime")
def regime():
    return _run(market_lab.classify_regimes, "regime")


@market_lab_bp.post("/regime-hmm")
def regime_hmm():
    return _run(market_lab.classify_regimes_hmm, "regime_hmm")


@market_lab_bp.post("/volatility")
def volatility():
    return _run(market_lab.forecast_volatility, "volatility")


@market_lab_bp.post("/statistics")
def statistics():
    return _run(market_lab.explore_statistics, "statistics")


@market_lab_bp.post("/weekday-windows")
def weekday_windows():
    return _run(market_lab.weekday_windows, "weekday_windows")


@market_lab_bp.post("/scan")
def scan():
    return _run(market_lab.scan_mean_reversion, "scan")


@market_lab_bp.post("/fade-safety")
def fade_safety():
    return _run(market_lab.fade_safety_scan, "fade_safety")


@market_lab_bp.post("/feature-importance")
def feature_importance():
    return _run(market_lab.feature_importance, "feature_importance")


@market_lab_bp.post("/patterns")
def patterns():
    return _run(market_lab.cluster_patterns, "patterns")


@market_lab_bp.post("/similarity")
def similarity():
    return _run(market_lab.similarity_search, "similarity")


@market_lab_bp.post("/pair-check")
def pair_check():
    """body: {symbol_y, symbol_x, timeframe, start_time?, end_time?, params?}"""
    body = request.get_json(silent=True) or {}
    try:
        symbol_y = validate_symbol(body.get("symbol_y"))
        symbol_x = validate_symbol(body.get("symbol_x"))
        timeframe = validate_timeframe(body.get("timeframe"))
        start_time = int(body["start_time"]) if body.get("start_time") is not None else None
        end_time = int(body["end_time"]) if body.get("end_time") is not None else None
        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise ValidationError("params must be an object")
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = pair_check_svc.pair_check(symbol_y, symbol_x, timeframe, start_time, end_time, params)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("marketlab/pair-check failed")
        return jsonify({"error": str(e)}), 500
    return jsonify(result)


def _drift_body():
    body = request.get_json(silent=True) or {}
    anchor = validate_symbol(body.get("anchor") or "BTCUSDT")
    timeframe = validate_timeframe(body.get("timeframe"))
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise ValidationError("params must be an object")
    return body, anchor, timeframe, params


def _drift_call(fn, name):
    try:
        return jsonify(fn())
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("marketlab/%s failed", name)
        return jsonify({"error": str(e)}), 500


@market_lab_bp.post("/drift-check")
def drift_check():
    """body: {anchor, timeframe, params?} — research data only (see services/drift_check.py)."""
    def run():
        _, anchor, timeframe, params = _drift_body()
        return drift_svc.drift_check(anchor, timeframe, params)
    return _drift_call(run, "drift-check")


@market_lab_bp.post("/drift-check/universe")
def drift_universe():
    """body: {anchor, timeframe} → the coins a run would use + the holdout's seal state."""
    def run():
        _, anchor, timeframe, _ = _drift_body()
        return {"coins": drift_svc.universe(anchor, timeframe),
                "holdout": drift_svc.holdout_status(anchor, timeframe)}
    return _drift_call(run, "drift-check/universe")


@market_lab_bp.post("/drift-check/open-holdout")
def drift_open_holdout():
    """body: {anchor, timeframe, params, confirm: "OPEN"} — one time per anchor + timeframe."""
    def run():
        body, anchor, timeframe, params = _drift_body()
        if body.get("confirm") != "OPEN":
            raise ValidationError('Type OPEN to confirm. The holdout opens once and cannot be re-run.')
        return drift_svc.open_holdout(anchor, timeframe, params)
    return _drift_call(run, "drift-check/open-holdout")


@market_lab_bp.post("/scan-batch")
def scan_batch():
    body = request.get_json(silent=True) or {}
    raw = body.get("symbols") or []
    if not isinstance(raw, list) or not raw:
        return jsonify({"error": "symbols must be a non-empty array"}), 400
    try:
        symbols = [validate_symbol(s) for s in raw]
        timeframe = validate_timeframe(body.get("timeframe"))
        start_time = body.get("start_time")
        end_time = body.get("end_time")
        if start_time is not None:
            start_time = int(start_time)
        if end_time is not None:
            end_time = int(end_time)
        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise ValidationError("params must be an object")
    except (ValidationError, TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = market_lab.scan_batch(symbols, timeframe, start_time, end_time, params)
    except Exception as e:
        log.exception("marketlab/scan-batch failed")
        return jsonify({"error": str(e)}), 500
    return jsonify(result)
