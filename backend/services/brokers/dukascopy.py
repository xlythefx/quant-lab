"""
Dukascopy historical data downloader.

Dukascopy publishes free tick data on a public CDN. Each URL is one hour of
ticks for one symbol, LZMA-compressed binary. We download the range hour-by-
hour (in parallel), decompress, parse the tick records, then resample to OHLC
bars at the requested timeframe.

URL pattern (note the 0-indexed month — Jan = 00, Dec = 11):
  https://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YYYY}/{MM}/{DD}/{HH}h_ticks.bi5

Tick record (20 bytes each):
  uint32 ms_offset      milliseconds since the hour start
  uint32 ask_int        ask × 10^digits
  uint32 bid_int        bid × 10^digits
  float32 ask_volume    volume in millions of base currency
  float32 bid_volume

Pricing decimals per instrument:
  XAUUSD: 3 decimals (digits=3, divisor=1000)
  EURUSD: 5 decimals
  USDJPY: 3 decimals
  ...

Weekends + market-closed hours return HTTP 404 (or empty payload), so we
skip those silently. Mid-week empty files are also occasional — handled the
same way.
"""
from __future__ import annotations

import logging
import lzma
import os
import struct
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import pandas as pd
import requests

log = logging.getLogger(__name__)

_BASE = "https://datafeed.dukascopy.com/datafeed"

# Pricing decimals per instrument. Add more as needed.
_DIGITS = {
    "XAUUSD": 3,
    "XAGUSD": 3,
    "EURUSD": 5,
    "GBPUSD": 5,
    "USDJPY": 3,
    "AUDUSD": 5,
    "USDCAD": 5,
    "USDCHF": 5,
}

# Pandas resample aliases. Use lowercase 'h' / 'min' to avoid the deprecation
# warning pandas 2.2+ raises on 'H' and 'T'.
_TF_PANDAS = {
    "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
    "1d": "1D",
}


def _digits_for(symbol: str) -> int:
    return _DIGITS.get(symbol.upper(), 5)


def _hour_url(symbol: str, hour_utc: datetime) -> str:
    return (
        f"{_BASE}/{symbol.upper()}/"
        f"{hour_utc.year:04d}/{hour_utc.month - 1:02d}/{hour_utc.day:02d}/"
        f"{hour_utc.hour:02d}h_ticks.bi5"
    )


def _fetch_hour(symbol: str, hour_utc: datetime,
                session: requests.Session,
                divisor: float, retries: int = 2) -> list[tuple]:
    """Fetch + parse one hour of ticks. Returns a list of
    (ts_ms, bid, ask, bid_vol, ask_vol). Empty list if no data."""
    url = _hour_url(symbol, hour_utc)
    for attempt in range(retries + 1):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 404:
                return []  # Market closed (weekend, holiday)
            r.raise_for_status()
            payload = r.content
            break
        except requests.RequestException as e:
            if attempt == retries:
                log.warning("dukas fetch failed %s: %s", url, e)
                return []
            time.sleep(0.5 * (attempt + 1))
    if not payload:
        return []
    try:
        raw = lzma.decompress(payload)
    except lzma.LZMAError:
        return []  # Occasionally returns garbage; skip.
    if not raw or len(raw) % 20 != 0:
        return []

    n_ticks = len(raw) // 20
    base_ms = int(hour_utc.replace(tzinfo=timezone.utc).timestamp() * 1000)
    out = []
    # Tick fields per Dukascopy: ms (uint32), ask_int (uint32), bid_int (uint32),
    # ask_vol (float32), bid_vol (float32) — all big-endian.
    fmt = ">IIIff"
    for i in range(n_ticks):
        ms, ask_i, bid_i, ask_v, bid_v = struct.unpack(fmt, raw[i * 20:(i + 1) * 20])
        ts_ms = base_ms + ms
        ask = ask_i / divisor
        bid = bid_i / divisor
        out.append((ts_ms, bid, ask, float(bid_v), float(ask_v)))
    return out


def download(
    symbol: str,
    start: datetime,
    end: datetime,
    timeframe: str = "15m",
    *,
    workers: int = 6,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> pd.DataFrame:
    """Download Dukascopy ticks for `symbol` from `start` (UTC) to `end` (UTC,
    exclusive) and aggregate to OHLC bars at `timeframe`.

    Returns a DataFrame with columns: time (int seconds), open, high, low,
    close, volume. Same shape Quantlab's parquet cache uses everywhere else.

    `cancel_check`: optional callable returning True if the caller wants to
    stop. Checked between completed hour-fetches. Pending futures are
    cancelled and the partial tick set is aggregated and returned.
    """
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if start >= end:
        raise ValueError("start must be before end")
    if timeframe not in _TF_PANDAS:
        raise ValueError(f"unsupported timeframe {timeframe!r}")

    # Align to the hour.
    cur = start.replace(minute=0, second=0, microsecond=0)
    end_aligned = end.replace(minute=0, second=0, microsecond=0)
    if end_aligned < end:
        end_aligned += timedelta(hours=1)

    hours: list[datetime] = []
    h = cur
    while h < end_aligned:
        hours.append(h)
        h += timedelta(hours=1)

    divisor = float(10 ** _digits_for(symbol))
    log.info("dukas downloading %s: %d hours from %s to %s",
             symbol, len(hours), start.isoformat(), end.isoformat())

    all_ticks: list[tuple] = []
    completed = 0
    cancelled = False
    session = requests.Session()
    # Modest concurrency. Dukas tolerates this but heavy hitting can briefly
    # rate-limit your IP. 6 workers + bounded retries is reliable.
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = {pool.submit(_fetch_hour, symbol, hr, session, divisor): hr for hr in hours}
        for fut in as_completed(futures):
            if cancel_check is not None and cancel_check():
                cancelled = True
                # cancel_futures=True asks Python (3.9+) to drop pending
                # submitted-but-not-started tasks. In-flight ones still
                # complete; their results just don't get harvested.
                pool.shutdown(wait=False, cancel_futures=True)
                break
            ticks = fut.result()
            if ticks:
                all_ticks.extend(ticks)
            completed += 1
            if progress_cb and completed % 50 == 0:
                progress_cb(completed, len(hours))
    finally:
        if not cancelled:
            pool.shutdown(wait=True)
    if progress_cb:
        progress_cb(completed if cancelled else len(hours), len(hours))

    if not all_ticks:
        # Returns empty-but-typed DataFrame so callers don't have to special-case.
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    # Build the tick frame, then resample mid-price OHLC and sum bid+ask volume.
    df = pd.DataFrame(all_ticks, columns=["ts_ms", "bid", "ask", "bid_vol", "ask_vol"])
    df = df.sort_values("ts_ms").drop_duplicates(subset=["ts_ms"]).reset_index(drop=True)
    df["mid"] = (df["bid"] + df["ask"]) / 2.0
    df["vol"] = df["bid_vol"] + df["ask_vol"]
    df["ts"] = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
    df = df.set_index("ts")

    rule = _TF_PANDAS[timeframe]
    ohlc = df["mid"].resample(rule, label="left", closed="left").ohlc()
    vol = df["vol"].resample(rule, label="left", closed="left").sum()

    bars = ohlc.join(vol.rename("volume")).dropna(subset=["open", "high", "low", "close"])
    bars = bars.reset_index()
    # pandas 2.x preserves the resolution of pd.to_datetime(unit="ms"), so the
    # ts column may be datetime64[ms] (or [us]) rather than [ns]. Cast through
    # tz-naive datetime64[s] via numpy to get seconds-since-epoch reliably,
    # regardless of input resolution.
    ts_naive = bars["ts"].dt.tz_convert("UTC").dt.tz_localize(None).values
    bars["time"] = ts_naive.astype("datetime64[s]").astype("int64")
    bars = bars[["time", "open", "high", "low", "close", "volume"]].copy()
    bars["volume"] = bars["volume"].fillna(0.0).astype(float)
    bars = bars.reset_index(drop=True)
    return bars


def download_to_parquet(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    out_dir: str,
    *,
    workers: int = 6,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Convenience wrapper: download() + write to parquet. Returns metadata
    about the written file."""
    os.makedirs(out_dir, exist_ok=True)
    bars = download(symbol, start, end, timeframe, workers=workers, progress_cb=progress_cb)
    if bars.empty:
        raise RuntimeError(f"Dukascopy returned no ticks for {symbol} {start.date()} -> {end.date()}")
    out_path = os.path.join(out_dir, f"{symbol.upper()}_{timeframe}.parquet")
    bars.to_parquet(out_path, index=False)
    return {
        "path": out_path,
        "rows": int(len(bars)),
        "first_time": int(bars["time"].iloc[0]),
        "last_time": int(bars["time"].iloc[-1]),
        "symbol": symbol.upper(),
        "timeframe": timeframe,
    }
