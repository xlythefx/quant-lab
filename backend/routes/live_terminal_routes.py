"""
Live Terminal REST endpoints (/api/live/*).

Snapshot endpoints for initial paint; live updates ride the existing
Socket.IO rooms (candle stream) + global events (gateway, live_signal,
live_alert_dispatched). This blueprint grows with the phases:
  03: instruments / candles / ticker / markets
"""
from __future__ import annotations

import logging
import time
from threading import Lock

from flask import Blueprint, jsonify, request

from services import market_data
from utils.validators import validate_symbol, validate_timeframe, validate_limit, ValidationError

log = logging.getLogger(__name__)
live_bp = Blueprint("live_terminal", __name__, url_prefix="/api/live")

# First instruments (per plan 01): BTCUSDT + LTCUSDT on Binance spot.
INSTRUMENTS = [
    {"symbol": "BTCUSDT", "venue": "BINANCE", "cls": "crypto", "label": "Bitcoin / USDT",  "priceDecimals": 2},
    {"symbol": "LTCUSDT", "venue": "BINANCE", "cls": "crypto", "label": "Litecoin / USDT", "priceDecimals": 2},
]
_INSTRUMENT_SYMBOLS = {i["symbol"] for i in INSTRUMENTS}

# Timeframes offered by the terminal's chart (subset of config.TIMEFRAMES).
LIVE_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]


@live_bp.get("/instruments")
def instruments():
    return jsonify({"instruments": INSTRUMENTS, "timeframes": LIVE_TIMEFRAMES})


@live_bp.get("/candles")
def candles():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
        tf = validate_timeframe(request.args.get("timeframe"))
        limit = validate_limit(request.args.get("limit"), default=300, maximum=1000)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    try:
        data = market_data.fetch_ohlcv(symbol, tf, limit)
    except Exception as e:
        log.exception("live candles failed")
        return jsonify({"error": str(e)}), 502
    return jsonify({"symbol": symbol, "timeframe": tf, "candles": data})


@live_bp.get("/ticker")
def ticker():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    try:
        return jsonify(market_data.fetch_ticker(symbol))
    except Exception as e:
        log.exception("live ticker failed")
        return jsonify({"error": str(e)}), 502


# ---- Markets table (cached ~10s so the UI can poll politely) --------------
_markets_cache: dict = {"ts": 0.0, "rows": None}
_markets_lock = Lock()


def _build_markets_rows() -> list[dict]:
    rows = []
    for inst in INSTRUMENTS:
        sym = inst["symbol"]
        row = {"symbol": sym, "venue": inst["venue"], "last": None, "chg24h": None,
               "volume": None, "funding": None, "spark": []}
        try:
            t = market_data.fetch_ticker(sym)
            row.update({"last": t["price"], "chg24h": t["changePct"], "volume": t["quoteVol"]})
        except Exception:
            log.warning("markets: ticker failed for %s", sym)
        try:
            candles_1h = market_data.fetch_ohlcv(sym, "1h", 30)
            row["spark"] = [c["close"] for c in candles_1h]
        except Exception:
            log.warning("markets: spark failed for %s", sym)
        rows.append(row)
    return rows


@live_bp.get("/markets")
def markets():
    with _markets_lock:
        if _markets_cache["rows"] is None or time.time() - _markets_cache["ts"] > 10.0:
            _markets_cache["rows"] = _build_markets_rows()
            _markets_cache["ts"] = time.time()
        return jsonify({"rows": _markets_cache["rows"]})
