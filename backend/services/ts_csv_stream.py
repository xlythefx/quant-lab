"""
TradeStation CSV file tailer for live candle data.

TradeStation appends one row per *closed* bar when BarStatus(1) = 2 fires
(i.e. at the OPEN of the next bar, confirming the previous bar).

Row format (Print to file):
    @ES,1250527,2300,5200.25,5210.50,5195.00,5205.75,12500
    symbol, date(YYYMMDD or YYMMDD), time(HHMM ET), o, h, l, c, vol

Date encoding:
    7-digit YYYMMDD  — TS 9+, years since 1900  (1250527 = 2025-05-27)
    6-digit YYMMDD   — older TS, years since 2000
"""
import os
import logging
from pathlib import Path
from datetime import datetime
from typing import Callable, Dict

import pytz

from services.stream_base import CandleStream

log = logging.getLogger(__name__)
_ET = pytz.timezone("America/New_York")

# Resolve relative to this file: backend/services/ → backend/ → quantlab/ → tradestation/
ROOT = Path(__file__).resolve().parents[2] / "tradestation"


def _csv_path(symbol: str, tf: str) -> Path:
    """Return expected CSV path for a given symbol and timeframe."""
    sym = symbol.lstrip("@")                          # @ES → ES
    tf_tag = tf.replace("m", "M").replace("h", "H")  # 1h → 1H, 15m → 15M
    return ROOT / sym / f"{sym}_{tf_tag}_live.csv"


def _parse_line(line: str, symbol: str, tf: str) -> Dict | None:
    """Parse one CSV row; return candle dict or None on error."""
    if not line:
        return None
    try:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            return None

        raw_date, raw_time = parts[1], parts[2]
        d = int(raw_date)
        if d > 999999:          # 7-digit YYYMMDD (TS 9+)
            year  = 1900 + d // 10000
            month = (d % 10000) // 100
            day   = d % 100
        else:                   # 6-digit YYMMDD (older TS)
            year  = 2000 + d // 10000
            month = (d % 10000) // 100
            day   = d % 100

        t      = int(raw_time)
        hour   = t // 100
        minute = t % 100

        dt_et = _ET.localize(datetime(year, month, day, hour, minute))
        ts = int(dt_et.timestamp())

        return {
            "time":      ts,
            "open":      float(parts[3]),
            "high":      float(parts[4]),
            "low":       float(parts[5]),
            "close":     float(parts[6]),
            "volume":    float(parts[7]),
            "isClosed":  True,
            "mode":      "live",
            "symbol":    symbol,
            "timeframe": tf,
        }
    except Exception as e:
        log.warning("TsCsvStream: bad line %r — %s", line, e)
        return None


class TsCsvStream(CandleStream):
    """
    Tails a TradeStation-exported CSV and emits each new closed bar as a
    candle dict — a drop-in replacement for BinanceKlineStream for non-Binance
    live symbols (e.g. ES futures).
    """

    def __init__(self, symbol: str, timeframe: str,
                 on_update: Callable[[Dict], None], csv_path: Path):
        super().__init__(symbol, timeframe, on_update)
        self._path = csv_path

    def _run(self):
        path = self._path
        # Start tailing from the current end of file so historical rows
        # already in the file are not replayed on startup.
        pos = path.stat().st_size if path.exists() else 0

        while not self._stop.is_set():
            try:
                if path.exists():
                    size = path.stat().st_size
                    if size > pos:
                        with open(path, "r") as f:
                            f.seek(pos)
                            new_data = f.read()
                            pos = f.tell()
                        for line in new_data.splitlines():
                            candle = _parse_line(line.strip(), self.symbol, self.timeframe)
                            if candle:
                                self.on_update(candle)
            except Exception as e:
                log.exception("TsCsvStream._run error: %s", e)

            self._stop.wait(1.0)
