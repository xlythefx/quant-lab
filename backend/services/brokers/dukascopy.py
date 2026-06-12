"""
Dukascopy historical data downloader.

Dukascopy publishes free tick data on a public CDN. Each URL is one hour of
ticks for one symbol, LZMA-compressed binary. We fetch the relevant hours in
parallel over a small thread pool of HTTP/1.1 connections (which Dukascopy
serves much more reliably than aggressive HTTP/2 multiplexing), parse each
hour's ticks in one numpy.frombuffer call, aggregate to 1-minute bars inside
the worker, then do a single final resample 1m → target TF.

URL pattern (note 0-indexed month — Jan = 00, Dec = 11):
  https://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YYYY}/{MM}/{DD}/{HH}h_ticks.bi5

Tick record (20 bytes each, big-endian):
  uint32  ms_offset      milliseconds since the hour start
  uint32  ask_int        ask × 10^digits
  uint32  bid_int        bid × 10^digits
  float32 ask_volume     volume in millions of base currency
  float32 bid_volume

Pricing decimals per instrument:
  XAUUSD: 3 decimals (digits=3, divisor=1000)
  EURUSD: 5 decimals
  USDJPY: 3 decimals

Weekends + market-closed hours return HTTP 404 (or empty payload), so they
are skipped silently. Mid-week empty files are also occasional — same.
503/429 throttle responses are retried with exponential backoff.

Performance characteristics (typical on a residential connection):
  - 1 week of 15m bars (168 hour-files): ~3-5 seconds
  - 1 year of 15m bars (~6,000 hour-files): ~1-2 minutes
  - 10 years of 15m bars (~87,000 hour-files): ~15-30 minutes
"""
from __future__ import annotations

import logging
import lzma
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import numpy as np
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
    "NZDUSD": 5,
    "EURJPY": 3,
    "GBPJPY": 3,
}

# Pandas resample aliases. Use lowercase 'h' / 'min' (pandas 2.2+).
# Includes the bespoke minutes used by the imported MultiCharts strategies
# (6/10/12/23/46m).
_TF_PANDAS = {
    "1m": "1min", "3m": "3min", "5m": "5min", "6m": "6min", "10m": "10min",
    "12m": "12min", "15m": "15min", "23m": "23min", "30m": "30min", "46m": "46min",
    "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
    "1d": "1D",
}

# numpy structured dtype matching one Dukascopy tick. Big-endian.
_TICK_DTYPE = np.dtype([
    ("ms",      ">u4"),
    ("ask",     ">u4"),
    ("bid",     ">u4"),
    ("ask_vol", ">f4"),
    ("bid_vol", ">f4"),
])


def _digits_for(symbol: str) -> int:
    return _DIGITS.get(symbol.upper(), 5)


def _hour_url(symbol: str, hour_utc: datetime) -> str:
    return (
        f"{_BASE}/{symbol.upper()}/"
        f"{hour_utc.year:04d}/{hour_utc.month - 1:02d}/{hour_utc.day:02d}/"
        f"{hour_utc.hour:02d}h_ticks.bi5"
    )


# ---------------------------------------------------------------------------
# Per-worker fetch + parse — returns raw numpy arrays (no pandas overhead here)
# ---------------------------------------------------------------------------

def _fetch_hour_arrays(
    symbol: str,
    hour_utc: datetime,
    session: requests.Session,
    divisor: float,
    cancel_check: Optional[Callable[[], bool]],
    retries: int = 4,
) -> Optional[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Download + decompress + parse one hour. Returns (ts_ms, mid, vol)
    numpy arrays, or None if the hour was empty / market closed.

    Per-hour aggregation happens in the main thread on the concatenated
    arrays — pandas DataFrame construction inside each worker turned out
    to be slower than the parallel I/O saved.
    """
    if cancel_check is not None and cancel_check():
        return None
    url = _hour_url(symbol, hour_utc)
    payload: Optional[bytes] = None
    for attempt in range(retries + 1):
        try:
            r = session.get(url, timeout=30)
        except requests.RequestException:
            if attempt < retries:
                time.sleep(0.5 * (attempt + 1))
                continue
            return None
        if r.status_code == 404 or not r.content:
            return None  # market closed
        if r.status_code in (429, 503):
            time.sleep(0.6 * (2 ** attempt))
            continue
        if r.status_code >= 500:
            time.sleep(0.5 * (attempt + 1))
            continue
        if r.status_code != 200:
            return None
        payload = r.content
        break

    if payload is None:
        return None
    try:
        raw = lzma.decompress(payload)
    except lzma.LZMAError:
        return None
    if not raw or len(raw) % 20 != 0:
        return None
    ticks = np.frombuffer(raw, dtype=_TICK_DTYPE)
    if ticks.size == 0:
        return None
    hour_ms = int(hour_utc.replace(tzinfo=timezone.utc).timestamp() * 1000)
    ts_ms = ticks["ms"].astype(np.int64) + hour_ms
    bid = ticks["bid"].astype(np.float64) / divisor
    ask = ticks["ask"].astype(np.float64) / divisor
    mid = (bid + ask) * 0.5
    vol = ticks["bid_vol"].astype(np.float64) + ticks["ask_vol"].astype(np.float64)
    return ts_ms, mid, vol


# ---------------------------------------------------------------------------
# Public sync API
# ---------------------------------------------------------------------------

def download(
    symbol: str,
    start: datetime,
    end: datetime,
    timeframe: str = "15m",
    *,
    workers: int = 16,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> pd.DataFrame:
    """Download Dukascopy bars for `symbol` from `start` (UTC) to `end` (UTC,
    exclusive) and aggregate to OHLC bars at `timeframe`.

    Returns a DataFrame with columns: time (int seconds), open, high, low,
    close, volume. Same shape Quantlab's parquet cache uses everywhere else.

    `cancel_check`: optional callable returning True if the caller wants to
    stop. Checked before each per-hour fetch and between batches; pending
    futures are cancelled and the partial bars collected so far are returned.
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

    log.info("dukas downloading %s: %d hours from %s to %s (workers=%d)",
             symbol, len(hours), start.isoformat(), end.isoformat(), workers)

    divisor = float(10 ** _digits_for(symbol))
    ts_chunks: list[np.ndarray] = []
    mid_chunks: list[np.ndarray] = []
    vol_chunks: list[np.ndarray] = []
    completed = 0
    cancelled = False
    total = len(hours)
    session = requests.Session()
    # Default urllib3 pool size is 10. With `workers` > 10 the extras get
    # discarded and rebuilt (TLS handshake each time) — major perf hit.
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=max(10, workers),
        pool_maxsize=max(10, workers),
        max_retries=0,  # we handle retries ourselves inside _fetch_hour_arrays
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = {
            pool.submit(_fetch_hour_arrays, symbol, hr, session, divisor, cancel_check): hr
            for hr in hours
        }
        for fut in as_completed(futures):
            if cancel_check is not None and cancel_check():
                cancelled = True
                pool.shutdown(wait=False, cancel_futures=True)
                break
            try:
                result = fut.result()
            except Exception:
                result = None
            if result is not None:
                ts_arr, mid_arr, vol_arr = result
                ts_chunks.append(ts_arr)
                mid_chunks.append(mid_arr)
                vol_chunks.append(vol_arr)
            completed += 1
            if progress_cb is not None and (completed % 100 == 0 or completed == total):
                try:
                    progress_cb(completed, total)
                except Exception:
                    pass
    finally:
        if not cancelled:
            pool.shutdown(wait=True)

    if progress_cb is not None:
        try:
            progress_cb(completed, total)
        except Exception:
            pass

    if not ts_chunks:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    # Single concat + single resample. With numpy this is fast even for 10y.
    ts_all = np.concatenate(ts_chunks)
    mid_all = np.concatenate(mid_chunks)
    vol_all = np.concatenate(vol_chunks)
    # Sort by timestamp (Dukascopy futures arrive in arbitrary order).
    order = np.argsort(ts_all, kind="mergesort")
    ts_all = ts_all[order]
    mid_all = mid_all[order]
    vol_all = vol_all[order]
    # Deduplicate identical timestamps (rare, but the original feed can have ties).
    keep = np.ones(len(ts_all), dtype=bool)
    if len(ts_all) > 1:
        keep[1:] = ts_all[1:] != ts_all[:-1]
    ts_all = ts_all[keep]
    mid_all = mid_all[keep]
    vol_all = vol_all[keep]

    df = pd.DataFrame({
        "ts": pd.to_datetime(ts_all, unit="ms", utc=True),
        "mid": mid_all,
        "vol": vol_all,
    }).set_index("ts")

    rule = _TF_PANDAS[timeframe]
    ohlc = df["mid"].resample(rule, label="left", closed="left").ohlc()
    vol = df["vol"].resample(rule, label="left", closed="left").sum()
    bars = ohlc.join(vol.rename("volume")).dropna(subset=["open", "high", "low", "close"])
    bars = bars.reset_index()
    ts_naive = bars["ts"].dt.tz_convert("UTC").dt.tz_localize(None).values
    bars["time"] = ts_naive.astype("datetime64[s]").astype("int64")
    bars = bars[["time", "open", "high", "low", "close", "volume"]].copy()
    bars["volume"] = bars["volume"].fillna(0.0).astype(float)
    return bars.reset_index(drop=True)


def download_to_parquet(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    out_dir: str,
    *,
    workers: int = 16,
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
