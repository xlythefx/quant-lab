"""
Yahoo Finance historical bar downloader (yfinance wrapper).

Yahoo's free OHLCV endpoint is the simplest way to land equity-index futures
(ES=F, NQ=F), index ETFs, and FX into the same parquet pipeline as Binance
and Dukascopy. Two real limitations:

  1. Intraday history is capped per-interval — 730 days for >=30m bars,
     60 days for 5m-15m, 7 days for 1m. We validate this BEFORE issuing the
     request so the user sees a loud error instead of an empty DataFrame.

  2. Yahoo's tickers are not quant-friendly: futures use a "=F" suffix,
     FX uses "=X", crypto uses "-USD". Rather than hardcoding a translation
     table here, we read backend/data/assets/yahoo.json and use the optional
     `yahoo_ticker` field per symbol. If absent, the symbol is passed through
     unchanged (so SPY → SPY works without any config).

Output schema matches dukascopy.download() exactly: a DataFrame with
[time, open, high, low, close, volume] where `time` is unix-seconds (int).
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import pandas as pd
import yfinance as yf

log = logging.getLogger(__name__)

# Project timeframe → yfinance interval string.
_TF_YF = {
    "1m":  "1m",
    "2m":  "2m",
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "60m",   # yfinance uses "60m" not "1h"
    "60m": "60m",
    "90m": "90m",
    "1d":  "1d",
    "5d":  "5d",
    "1wk": "1wk",
    "1mo": "1mo",
}

# Yahoo's hard ceilings on how far back each interval can reach.
# These are the documented yfinance limits (Yahoo enforces them server-side).
_MAX_LOOKBACK_DAYS = {
    "1m":  7,
    "2m":  60,
    "5m":  60,
    "15m": 60,
    "30m": 60,
    "60m": 730,
    "90m": 60,
    "1d":  100 * 365,    # effectively unlimited
    "5d":  100 * 365,
    "1wk": 100 * 365,
    "1mo": 100 * 365,
}

_ASSETS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "assets", "yahoo.json",
)


def _yahoo_ticker(symbol: str) -> str:
    """Look up the Yahoo ticker for a project symbol.

    backend/data/assets/yahoo.json can contain:
        { "ES": { "yahoo_ticker": "ES=F", ... }, ... }
    Returns the mapped ticker, or the symbol unchanged if no override exists.
    Reading the JSON directly (rather than going through services.assets) keeps
    the broker module self-contained and avoids adding a `yahoo_ticker` field
    to the shared AssetMetadata dataclass.
    """
    if not os.path.exists(_ASSETS_PATH):
        return symbol
    try:
        with open(_ASSETS_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        log.warning("failed to read yahoo.json (%s); using symbol as-is", e)
        return symbol
    entry = raw.get(symbol)
    if isinstance(entry, dict):
        ticker = entry.get("yahoo_ticker")
        if isinstance(ticker, str) and ticker.strip():
            return ticker.strip()
    return symbol


def download(
    symbol: str,
    start: datetime,
    end: datetime,
    timeframe: str,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> pd.DataFrame:
    """Download OHLCV bars from Yahoo Finance.

    Returns a DataFrame with columns [time, open, high, low, close, volume],
    where `time` is unix-seconds (int). Empty DataFrame if Yahoo returns no
    rows in the requested range.

    Raises ValueError if:
      - timeframe is not one of _TF_YF keys
      - the requested range exceeds Yahoo's per-interval lookback ceiling
    """
    if timeframe not in _TF_YF:
        raise ValueError(
            f"unsupported timeframe {timeframe!r} for Yahoo; "
            f"allowed: {sorted(_TF_YF)}"
        )
    yf_interval = _TF_YF[timeframe]

    # Normalise to UTC.
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if end <= start:
        raise ValueError(f"end {end} must be after start {start}")

    # Validate range against Yahoo's per-interval ceiling.
    max_days = _MAX_LOOKBACK_DAYS[yf_interval]
    earliest_allowed = datetime.now(timezone.utc) - timedelta(days=max_days)
    if start < earliest_allowed:
        # Loud error so the UI can surface it instead of silently returning empty.
        raise ValueError(
            f"Yahoo allows at most {max_days} days of {timeframe} history; "
            f"you requested back to {start.date()} but the earliest available "
            f"is {earliest_allowed.date()}. Narrow the start date or pick a "
            f"larger timeframe."
        )

    ticker = _yahoo_ticker(symbol)
    log.info("yfinance download %s (yahoo=%s) %s %s → %s",
             symbol, ticker, timeframe, start.date(), end.date())

    if progress_cb is not None:
        progress_cb(0, 1)
    if cancel_check is not None and cancel_check():
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    # auto_adjust=False so OHLC matches what TradeStation/MultiCharts charts
    # show by default (no dividend/split adjustment for futures).
    # progress=False suppresses yfinance's own stdout bar.
    raw = yf.download(
        ticker,
        start=start,
        end=end,
        interval=yf_interval,
        progress=False,
        auto_adjust=False,
        actions=False,
        threads=False,
    )

    if progress_cb is not None:
        progress_cb(1, 1)

    if raw is None or raw.empty:
        log.warning("yfinance returned no rows for %s %s %s..%s",
                    ticker, timeframe, start, end)
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    # yfinance returns a MultiIndex when threads/multi-symbol; flatten if needed.
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)

    # Index is a DatetimeIndex. Convert to unix-seconds int via UTC.
    idx = raw.index
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    else:
        idx = idx.tz_convert("UTC")

    # DatetimeIndex → unix-seconds int64. We can't astype tz-aware → naive
    # directly (pandas raises), and we can't blindly divide by 1e9 because
    # yfinance returns datetime64[s, UTC] in newer versions (where astype
    # int64 already yields seconds) and datetime64[ns, UTC] in older ones
    # (where it yields nanoseconds). Stripping tz then forcing seconds
    # precision makes the int64 conversion unambiguous either way.
    naive_utc = idx.tz_convert("UTC").tz_localize(None)
    time_unix_s = naive_utc.astype("datetime64[s]").astype("int64").to_numpy(dtype="int64")

    out = pd.DataFrame({
        "time":   time_unix_s,
        "open":   raw["Open"].astype("float64").to_numpy(),
        "high":   raw["High"].astype("float64").to_numpy(),
        "low":    raw["Low"].astype("float64").to_numpy(),
        "close":  raw["Close"].astype("float64").to_numpy(),
        "volume": raw["Volume"].astype("float64").to_numpy(),
    })
    # Drop rows where Yahoo returned NaN for OHLC (occasionally happens
    # around session boundaries or holidays).
    out = out.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
    return out
