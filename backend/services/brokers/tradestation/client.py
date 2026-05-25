"""
TradeStation historical bar fetcher.

fetch_bars() — native TS interface, returns list of dicts.
download()   — mirrors yahoo.py / dukascopy.py signature so the existing
               parquet pipeline accepts TradeStation as a drop-in data source.

Usage (smoke test once credentials are in .env):
    python -m backend.services.brokers.tradestation.client @NQ 60m 100
"""
from __future__ import annotations

import logging
import os
import urllib.parse
from datetime import datetime, timezone
from typing import Callable, Optional

import httpx
import pandas as pd
from dotenv import load_dotenv, find_dotenv

load_dotenv(find_dotenv(), override=False)

from .auth import get_access_token, refresh as refresh_token

log = logging.getLogger(__name__)

_BASE_URL = os.getenv("TRADESTATION_BASE_URL", "https://api.tradestation.com")

# Project timeframe string → (TS interval number, TS unit string)
_TF_TS: dict[str, tuple[int, str]] = {
    "1m":  (1,  "Minute"),
    "5m":  (5,  "Minute"),
    "15m": (15, "Minute"),
    "30m": (30, "Minute"),
    "60m": (60, "Minute"),
    "1h":  (60, "Minute"),
    "1d":  (1,  "Daily"),
    "1wk": (1,  "Weekly"),
    "1mo": (1,  "Monthly"),
}


def fetch_bars(
    symbol: str,
    timeframe: str = "60m",
    barsback: int = 100,
    session_template: str = "Default",
    first_date: Optional[datetime] = None,
    last_date: Optional[datetime] = None,
) -> list[dict]:
    """Fetch historical OHLCV bars from TradeStation.

    Returns a list of dicts: {ts_utc, open, high, low, close, volume}
    where ts_utc is unix-seconds UTC at bar OPEN time.

    Args:
        symbol:           TS symbol, e.g. "@NQ", "@ES", "AAPL"
        timeframe:        one of the _TF_TS keys above
        barsback:         how many bars to fetch (ignored if first_date set)
        session_template: "Default" (24h) | "USEQPreAndPost" | "USEQ" | etc.
        first_date:       range start (UTC) — use with last_date
        last_date:        range end (UTC) — use with first_date
    """
    if timeframe not in _TF_TS:
        raise ValueError(
            f"Unsupported timeframe {timeframe!r} for TradeStation; "
            f"allowed: {sorted(_TF_TS)}"
        )

    interval, unit = _TF_TS[timeframe]
    encoded = urllib.parse.quote(symbol, safe="")
    url = f"{_BASE_URL}/v3/marketdata/barcharts/{encoded}"

    params: dict = {
        "interval":        interval,
        "unit":            unit,
        "sessiontemplate": session_template,
    }

    if first_date is not None and last_date is not None:
        params["firstdate"] = _fmt_dt(first_date)
        params["lastdate"]  = _fmt_dt(last_date)
    else:
        params["barsback"] = barsback

    log.info("fetch_bars %s %s params=%s", symbol, timeframe, params)

    resp = _get(url, params)
    if resp is None:
        return []

    data = resp.json()
    bars_raw = data.get("Bars") or data.get("bars") or []

    bars = []
    for b in bars_raw:
        ts = _parse_ts(b.get("TimeStamp") or b.get("timestamp", ""))
        if ts is None:
            continue
        bars.append({
            "ts_utc": ts,
            "open":   float(b.get("Open")        or b.get("open",        0)),
            "high":   float(b.get("High")        or b.get("high",        0)),
            "low":    float(b.get("Low")         or b.get("low",         0)),
            "close":  float(b.get("Close")       or b.get("close",       0)),
            "volume": float(b.get("TotalVolume") or b.get("volume",      0)),
        })

    log.info("fetch_bars %s %s → %d bars", symbol, timeframe, len(bars))
    return bars


def download(
    symbol: str,
    start: datetime,
    end: datetime,
    timeframe: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> pd.DataFrame:
    """Drop-in replacement for yahoo.download() and dukascopy.download().

    Returns a DataFrame with columns [time, open, high, low, close, volume]
    where `time` is unix-seconds int — identical schema to all other brokers.
    The existing parquet pipeline (market_data.py) accepts this unchanged.
    """
    if progress_cb:
        progress_cb(0, 1)

    if cancel_check and cancel_check():
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    bars = fetch_bars(
        symbol=symbol,
        timeframe=timeframe,
        first_date=start,
        last_date=end,
    )

    if progress_cb:
        progress_cb(1, 1)

    if not bars:
        log.warning("TradeStation returned no bars for %s %s %s..%s", symbol, timeframe, start, end)
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    df = pd.DataFrame([{
        "time":   b["ts_utc"],
        "open":   b["open"],
        "high":   b["high"],
        "low":    b["low"],
        "close":  b["close"],
        "volume": b["volume"],
    } for b in bars])

    return df.sort_values("time").reset_index(drop=True)


# ── helpers ──────────────────────────────────────────────────────────────────

def _get(url: str, params: dict) -> Optional[httpx.Response]:
    """GET with one automatic token-refresh retry on 401."""
    headers = {"Authorization": f"Bearer {get_access_token()}"}
    resp = httpx.get(url, params=params, headers=headers, timeout=30.0)

    if resp.status_code == 401:
        log.warning("401 on GET %s — refreshing token and retrying", url)
        refresh_token()
        headers = {"Authorization": f"Bearer {get_access_token()}"}
        resp = httpx.get(url, params=params, headers=headers, timeout=30.0)

    resp.raise_for_status()
    return resp


def _parse_ts(ts_str: str) -> Optional[int]:
    """Parse TS ISO 8601 timestamp → unix-seconds UTC."""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return int(dt.astimezone(timezone.utc).timestamp())
    except Exception:
        log.warning("could not parse timestamp %r", ts_str)
        return None


def _fmt_dt(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    symbol    = sys.argv[1] if len(sys.argv) > 1 else "@NQ"
    timeframe = sys.argv[2] if len(sys.argv) > 2 else "60m"
    barsback  = int(sys.argv[3]) if len(sys.argv) > 3 else 10

    bars = fetch_bars(symbol, timeframe, barsback)
    print(f"\nGot {len(bars)} bars for {symbol} {timeframe}")
    for b in bars[-5:]:
        from datetime import datetime
        dt = datetime.utcfromtimestamp(b["ts_utc"]).strftime("%Y-%m-%d %H:%M")
        print(f"  {dt}  O={b['open']}  H={b['high']}  L={b['low']}  C={b['close']}  V={b['volume']}")
