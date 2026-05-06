"""
REST endpoints for the market data layer.

  GET  /api/health
  GET  /api/symbols
  GET  /api/ohlcv?symbol=BTCUSDT&timeframe=1m&limit=500&mode=backtest
  POST /api/backtest/prepare   body: {symbol, timeframe}
"""
import logging
from datetime import datetime, timezone
from flask import Blueprint, jsonify, request

from config import SUPPORTED_SYMBOLS, TIMEFRAMES, MODES, DEFAULT_MODE, TIMEFRAME_SECONDS
from services import market_data, event_bus
from utils.validators import (
    validate_symbol,
    validate_timeframe,
    validate_mode,
    validate_limit,
    ValidationError,
)


def _parse_date_to_ms(s: str, end_of_day: bool = False) -> int:
    """Accept 'YYYY-MM-DD' or ISO datetime. UTC."""
    if not s:
        raise ValidationError("date is required")
    try:
        if "T" in s or " " in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.strptime(s, "%Y-%m-%d")
            if end_of_day:
                dt = dt.replace(hour=23, minute=59, second=59)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError as e:
        raise ValidationError(f"invalid date '{s}': {e}")

log = logging.getLogger(__name__)
market_bp = Blueprint("market", __name__, url_prefix="/api")


@market_bp.get("/health")
def health():
    return jsonify({"status": "ok"})


@market_bp.get("/symbols")
def symbols():
    """Symbols are strictly what the user has downloaded. No fallbacks —
    the Downloads page is the single source of truth."""
    datasets = market_data.list_datasets()
    downloaded = sorted({d["symbol"] for d in datasets})
    return jsonify({
        "symbols": downloaded,
        "downloaded": downloaded,
        "timeframes": TIMEFRAMES,
        "modes": MODES,
        "default_mode": DEFAULT_MODE,
        "datasets": datasets,
    })


@market_bp.get("/datasets")
def datasets():
    return jsonify({"datasets": market_data.list_datasets()})


@market_bp.post("/datasets/download")
def datasets_download():
    body = request.get_json(silent=True) or {}
    try:
        symbol = validate_symbol(body.get("symbol"))
        tf = validate_timeframe(body.get("timeframe"))
        start_ms = _parse_date_to_ms(body.get("start"))
        end_ms = _parse_date_to_ms(body.get("end"), end_of_day=True)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    if end_ms <= start_ms:
        return jsonify({"error": "end must be after start"}), 400

    sid = body.get("sid")  # Socket.IO id of the requesting client (for progress)
    job_id = body.get("job_id") or f"{symbol}_{tf}_{start_ms}_{end_ms}"

    tf_ms = TIMEFRAME_SECONDS[tf] * 1000
    expected = max(1, (end_ms - start_ms) // tf_ms)

    # Initial event so the UI can render the bar at 0%.
    event_bus.emit(
        "download_progress",
        {
            "job_id": job_id,
            "symbol": symbol, "timeframe": tf,
            "fetched": 0, "expected": int(expected),
            "start_ms": start_ms, "end_ms": end_ms,
            "cursor_ms": start_ms,
            "status": "starting",
        },
        to=sid,
    )

    def progress_cb(p):
        event_bus.emit(
            "download_progress",
            {
                "job_id": job_id,
                "symbol": symbol, "timeframe": tf,
                "fetched": int(p.get("fetched", 0)),
                "expected": int(expected),
                "start_ms": start_ms, "end_ms": end_ms,
                "cursor_ms": int(p.get("last_ts") or start_ms),
                "status": "downloading",
            },
            to=sid,
        )

    try:
        meta = market_data.download_range(symbol, tf, start_ms, end_ms, progress_cb=progress_cb)
    except FileNotFoundError as e:
        event_bus.emit("download_progress", {"job_id": job_id, "status": "error", "error": str(e)}, to=sid)
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("download_range failed")
        event_bus.emit("download_progress", {"job_id": job_id, "status": "error", "error": str(e)}, to=sid)
        return jsonify({"error": str(e)}), 502

    event_bus.emit(
        "download_progress",
        {
            "job_id": job_id,
            "symbol": symbol, "timeframe": tf,
            "fetched": int(meta.get("rows_added", 0)),
            "expected": int(expected),
            "cursor_ms": end_ms,
            "status": "done",
        },
        to=sid,
    )

    return jsonify({"symbol": symbol, "timeframe": tf, "job_id": job_id, **meta})


@market_bp.delete("/datasets")
def datasets_delete():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
        tf = validate_timeframe(request.args.get("timeframe"))
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    removed = market_data.delete_dataset(symbol, tf)
    return jsonify({"removed": removed, "symbol": symbol, "timeframe": tf})


@market_bp.get("/ohlcv")
def ohlcv():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
        tf = validate_timeframe(request.args.get("timeframe"))
        limit = validate_limit(request.args.get("limit"))
        mode = validate_mode(request.args.get("mode"))
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        if mode == "backtest":
            data = market_data.tail_parquet(symbol, tf, limit)
        else:
            data = market_data.fetch_ohlcv(symbol, tf, limit)
    except Exception as e:
        log.exception("ohlcv failed")
        return jsonify({"error": str(e)}), 502

    return jsonify({"symbol": symbol, "timeframe": tf, "mode": mode, "candles": data})


@market_bp.get("/backtest/seed")
def backtest_seed():
    """History slice ending at the same cursor BacktestStream will replay
    from. The chart paints these candles, then live updates append cleanly."""
    try:
        symbol = validate_symbol(request.args.get("symbol"))
        tf = validate_timeframe(request.args.get("timeframe"))
        limit = validate_limit(request.args.get("limit"), default=1500, maximum=10000)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    try:
        total, idx = market_data.replay_start_index(symbol, tf)
        candles = market_data.seed_slice(symbol, tf, idx, limit)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("backtest_seed failed")
        return jsonify({"error": str(e)}), 502

    return jsonify({
        "symbol": symbol,
        "timeframe": tf,
        "total_rows": total,
        "start_index": idx,
        "start_time": candles[-1]["time"] if candles else None,
        "candles": candles,
    })


@market_bp.post("/backtest/prepare")
def backtest_prepare():
    """Just confirms a dataset is available — no implicit download.
    Use POST /api/datasets/download with a date range instead."""
    body = request.get_json(silent=True) or {}
    try:
        symbol = validate_symbol(body.get("symbol"))
        tf = validate_timeframe(body.get("timeframe"))
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    import os
    path = market_data.parquet_path(symbol, tf)
    if not os.path.exists(path):
        return jsonify({
            "error": f"No dataset for {symbol} {tf}. Open the Downloads page and pull a date range first.",
            "missing": True,
        }), 404

    import pandas as pd
    df = pd.read_parquet(path, columns=["time"])
    return jsonify({
        "symbol": symbol,
        "timeframe": tf,
        "cached": True,
        "rows": int(len(df)),
        "path": path,
    })
