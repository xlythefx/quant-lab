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
from services import market_data, event_bus, assets, download_jobs
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
    the Downloads page is the single source of truth.

    As of Stage 1 of the multi-asset roadmap, each dataset row carries
    `broker` + `asset_class` + `execution_model` fields. The top-level
    `brokers` and `asset_classes` fields enumerate everything the catalog
    knows about, so the frontend can render filters even before downloads
    exist for some categories."""
    datasets = market_data.list_datasets()
    downloaded = sorted({d["symbol"] for d in datasets})
    return jsonify({
        "symbols": downloaded,
        "downloaded": downloaded,
        "timeframes": TIMEFRAMES,
        "modes": MODES,
        "default_mode": DEFAULT_MODE,
        "datasets": datasets,
        "brokers": assets.list_brokers(),
        "asset_classes": list(assets.ASSET_CLASSES),
    })


@market_bp.get("/datasets")
def datasets():
    return jsonify({"datasets": market_data.list_datasets()})


_BROKERS = ("binance", "dukascopy", "yahoo", "tradestation")


@market_bp.post("/datasets/download")
def datasets_download():
    """Start a background download job. Returns immediately with the job_id;
    the actual fetch runs in a daemon thread and streams progress via the
    `download_progress` / `download_complete` / `download_error` /
    `download_cancelled` socket events."""
    body = request.get_json(silent=True) or {}
    broker = (body.get("broker") or "binance").strip().lower()
    if broker not in _BROKERS:
        return jsonify({"error": f"unknown broker {broker!r}; allowed: {_BROKERS}"}), 400

    try:
        symbol = validate_symbol(body.get("symbol"))
        tf = validate_timeframe(body.get("timeframe"))
        start_ms = _parse_date_to_ms(body.get("start"))
        end_ms = _parse_date_to_ms(body.get("end"), end_of_day=True)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    if end_ms <= start_ms:
        return jsonify({"error": "end must be after start"}), 400

    tf_ms = TIMEFRAME_SECONDS[tf] * 1000
    expected = max(1, (end_ms - start_ms) // tf_ms)

    spec = {
        "broker": broker,
        "symbol": symbol,
        "timeframe": tf,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "expected": int(expected),
        "sid": body.get("sid"),
        "job_id": body.get("job_id") or f"{broker}_{symbol}_{tf}_{start_ms}_{end_ms}",
    }

    try:
        job_id = download_jobs.start(spec)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.exception("download_jobs.start failed (broker=%s)", broker)
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "ok": True,
        "job_id": job_id,
        "broker": broker,
        "symbol": symbol,
        "timeframe": tf,
        "expected": int(expected),
    })


@market_bp.post("/datasets/download/cancel")
def datasets_download_cancel():
    ok = download_jobs.cancel_current()
    return jsonify({"ok": ok})


@market_bp.get("/datasets/download/status")
def datasets_download_status():
    return jsonify(download_jobs.get_status())


_IMPORT_TFS = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}


@market_bp.post("/datasets/import")
def datasets_import():
    """Import a manually-exported TradeStation CSV file.

    Multipart form fields:
      file       — the .csv upload
      symbol     — ticker symbol (e.g. ES)
      timeframes — one or more target timeframes (may be repeated or comma-separated)
      source_tz  — optional IANA timezone of the CSV timestamps (default America/New_York)
    """
    if "file" not in request.files:
        return jsonify({"error": "no file provided"}), 400
    f = request.files["file"]
    if not f.filename.lower().endswith(".csv"):
        return jsonify({"error": "only .csv files are supported"}), 400

    raw_symbol = (request.form.get("symbol") or "").strip().upper()
    if not raw_symbol:
        return jsonify({"error": "symbol is required"}), 400
    try:
        symbol = validate_symbol(raw_symbol)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400

    # Accept repeated field or comma-separated string
    tfs_raw = request.form.getlist("timeframes")
    if not tfs_raw:
        tfs_raw = (request.form.get("timeframes") or "15m,1h").split(",")
    timeframes = [t.strip() for t in tfs_raw if t.strip()]
    invalid = [t for t in timeframes if t not in _IMPORT_TFS]
    if invalid:
        return jsonify({"error": f"invalid timeframe(s): {invalid}; allowed: {sorted(_IMPORT_TFS)}"}), 400

    source_tz = (request.form.get("source_tz") or "America/New_York").strip()

    try:
        file_bytes = f.read()
        results = market_data.import_csv_tradestation(file_bytes, symbol, timeframes, source_tz)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        log.exception("CSV import failed (symbol=%s)", symbol)
        return jsonify({"error": str(e)}), 500

    return jsonify({"ok": True, "symbol": symbol, "results": results})


@market_bp.delete("/datasets")
def datasets_delete():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
        tf = validate_timeframe(request.args.get("timeframe"))
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    broker = (request.args.get("broker") or "binance").strip().lower()
    if broker not in _BROKERS:
        return jsonify({"error": f"unknown broker {broker!r}"}), 400
    removed = market_data.delete_dataset(symbol, tf, broker=broker)
    return jsonify({"removed": removed, "symbol": symbol, "timeframe": tf, "broker": broker})


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

    # Look up the parquet across all broker namespaces (Stage 1 multi-broker).
    path = market_data.find_parquet(symbol, tf)
    if path is None:
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
