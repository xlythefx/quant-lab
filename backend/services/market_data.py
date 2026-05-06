"""
Historical OHLCV via CCXT + Parquet cache for backtest replay.

- fetch_ohlcv: small recent window for the chart's initial paint.
- ensure_parquet: idempotent bulk download (paginated). One file per
  (symbol, timeframe). Refresh if older than ~1 day.
- load_parquet: read cached file as DataFrame for the backtest stream.

All timestamps returned as integer SECONDS (Lightweight Charts convention).
"""
import os
import time
import logging
from typing import List, Dict

import ccxt
import numpy as np
import pandas as pd

from config import (
    DATA_DIR,
    BACKTEST_LOOKBACK_DAYS,
    TIMEFRAME_SECONDS,
)

log = logging.getLogger(__name__)

os.makedirs(DATA_DIR, exist_ok=True)

# Single shared CCXT client. enableRateLimit avoids hammering Binance.
_exchange = ccxt.binance({"enableRateLimit": True, "timeout": 20000})


_QUOTES = ("USDT", "USDC", "BUSD", "BTC", "ETH", "FDUSD", "TUSD", "EUR", "TRY", "BNB")


def _to_ccxt_symbol(symbol: str) -> str:
    """BTCUSDT -> BTC/USDT. Splits on the longest known quote suffix."""
    s = symbol.upper()
    for q in sorted(_QUOTES, key=len, reverse=True):
        if s.endswith(q) and len(s) > len(q):
            return f"{s[:-len(q)]}/{q}"
    # Fallback: assume last 4 chars are the quote.
    return s[:-4] + "/" + s[-4:]


def _ohlcv_to_records(rows) -> List[Dict]:
    """CCXT returns [ms, o, h, l, c, v]. Convert to dicts with seconds."""
    return [
        {
            "time": int(r[0] // 1000),
            "open": float(r[1]),
            "high": float(r[2]),
            "low": float(r[3]),
            "close": float(r[4]),
            "volume": float(r[5]),
        }
        for r in rows
    ]


def fetch_ohlcv(symbol: str, timeframe: str, limit: int = 500) -> List[Dict]:
    """Recent N candles via CCXT REST. Used for initial chart paint."""
    pair = _to_ccxt_symbol(symbol)
    try:
        rows = _exchange.fetch_ohlcv(pair, timeframe=timeframe, limit=limit)
    except (ccxt.NetworkError, ccxt.ExchangeError) as e:
        log.error("fetch_ohlcv failed for %s %s: %s", symbol, timeframe, e)
        raise
    return _ohlcv_to_records(rows)


def parquet_path(symbol: str, timeframe: str) -> str:
    return os.path.join(DATA_DIR, f"{symbol}_{timeframe}.parquet")


def _is_fresh(path: str, max_age_seconds: int = 86400) -> bool:
    if not os.path.exists(path):
        return False
    return (time.time() - os.path.getmtime(path)) < max_age_seconds


def ensure_parquet(symbol: str, timeframe: str, force: bool = False) -> Dict:
    """
    Ensure a Parquet file with ~BACKTEST_LOOKBACK_DAYS of history exists.
    Returns metadata: {cached, rows, path}.
    """
    path = parquet_path(symbol, timeframe)
    if not force and _is_fresh(path):
        df = pd.read_parquet(path)
        return {"cached": True, "rows": len(df), "path": path}

    pair = _to_ccxt_symbol(symbol)
    tf_seconds = TIMEFRAME_SECONDS[timeframe]
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - BACKTEST_LOOKBACK_DAYS * 86400 * 1000

    all_rows = []
    since = start_ms
    page_limit = 1000  # Binance max per fetch
    log.info("Downloading %s %s history (~%dd)...", symbol, timeframe, BACKTEST_LOOKBACK_DAYS)

    while since < end_ms:
        try:
            rows = _exchange.fetch_ohlcv(
                pair, timeframe=timeframe, since=since, limit=page_limit
            )
        except (ccxt.NetworkError, ccxt.ExchangeError) as e:
            log.error("Pagination failed at since=%s: %s", since, e)
            time.sleep(2)
            continue

        if not rows:
            break

        all_rows.extend(rows)
        last_ts = rows[-1][0]
        next_since = last_ts + tf_seconds * 1000
        if next_since <= since:
            break
        since = next_since
        # CCXT enableRateLimit already throttles; tiny sleep adds safety.
        time.sleep(0.05)

    # Dedup & sort (paginated boundaries can overlap by 1 row).
    df = pd.DataFrame(all_rows, columns=["ts_ms", "open", "high", "low", "close", "volume"])
    df = df.drop_duplicates(subset=["ts_ms"]).sort_values("ts_ms").reset_index(drop=True)
    df["time"] = (df["ts_ms"] // 1000).astype("int64")
    df = df[["time", "open", "high", "low", "close", "volume"]]

    df.to_parquet(path, index=False)
    log.info("Wrote %d rows to %s", len(df), path)
    return {"cached": False, "rows": len(df), "path": path}


def download_range(
    symbol: str,
    timeframe: str,
    start_ms: int,
    end_ms: int,
    progress_cb=None,
) -> Dict:
    """
    Download a custom date range and write/merge into the Parquet for
    (symbol, timeframe). If a file already exists, the new rows are merged
    in (deduped) so the cache grows incrementally.
    Returns {rows_added, rows_total, path, first_time, last_time}.
    """
    if start_ms >= end_ms:
        raise ValueError("start must be before end")

    pair = _to_ccxt_symbol(symbol)
    tf_seconds = TIMEFRAME_SECONDS[timeframe]
    page_limit = 1000

    new_rows = []
    since = start_ms
    log.info("Downloading %s %s from %s to %s", symbol, timeframe, start_ms, end_ms)

    while since < end_ms:
        try:
            rows = _exchange.fetch_ohlcv(pair, timeframe=timeframe, since=since, limit=page_limit)
        except (ccxt.NetworkError, ccxt.ExchangeError) as e:
            log.warning("page failed since=%s: %s — retrying", since, e)
            time.sleep(2)
            continue

        if not rows:
            break

        # Trim rows that exceed end_ms.
        rows = [r for r in rows if r[0] <= end_ms]
        if not rows:
            break

        new_rows.extend(rows)
        last_ts = rows[-1][0]

        if progress_cb:
            try:
                progress_cb({"fetched": len(new_rows), "last_ts": last_ts})
            except Exception:
                pass

        next_since = last_ts + tf_seconds * 1000
        if next_since <= since:
            break
        since = next_since
        time.sleep(0.05)

    new_df = pd.DataFrame(new_rows, columns=["ts_ms", "open", "high", "low", "close", "volume"])
    if new_df.empty:
        # Nothing fetched — but file may still exist.
        path = parquet_path(symbol, timeframe)
        if os.path.exists(path):
            existing = pd.read_parquet(path)
            return {
                "rows_added": 0,
                "rows_total": int(len(existing)),
                "path": path,
                "first_time": int(existing["time"].min()) if len(existing) else None,
                "last_time": int(existing["time"].max()) if len(existing) else None,
            }
        raise RuntimeError("Binance returned no candles for that range")

    new_df["time"] = (new_df["ts_ms"] // 1000).astype("int64")
    new_df = new_df[["time", "open", "high", "low", "close", "volume"]]

    path = parquet_path(symbol, timeframe)
    rows_before = 0
    if os.path.exists(path):
        existing = pd.read_parquet(path)
        rows_before = len(existing)
        merged = pd.concat([existing, new_df], ignore_index=True)
    else:
        merged = new_df

    merged = merged.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)
    merged.to_parquet(path, index=False)

    return {
        "rows_added": int(len(merged) - rows_before),
        "rows_total": int(len(merged)),
        "path": path,
        "first_time": int(merged["time"].min()),
        "last_time": int(merged["time"].max()),
    }


def list_datasets() -> List[Dict]:
    """Scan data/ for *.parquet files and return metadata for each.
    Skips empty/corrupt files so the dashboard never lists something
    the seed endpoint can't actually serve."""
    out = []
    if not os.path.isdir(DATA_DIR):
        return out
    for fname in sorted(os.listdir(DATA_DIR)):
        if not fname.endswith(".parquet"):
            continue
        stem = fname[:-len(".parquet")]
        if "_" not in stem:
            continue
        symbol, tf = stem.rsplit("_", 1)
        path = os.path.join(DATA_DIR, fname)
        try:
            if os.path.getsize(path) == 0:
                log.warning("skipping empty parquet: %s", path)
                continue
            df = pd.read_parquet(path, columns=["time"])
            if len(df) == 0:
                log.warning("skipping rowless parquet: %s", path)
                continue
            out.append({
                "symbol": symbol,
                "timeframe": tf,
                "rows": int(len(df)),
                "first_time": int(df["time"].min()),
                "last_time": int(df["time"].max()),
                "size_bytes": os.path.getsize(path),
            })
        except Exception as e:
            log.warning("could not read %s: %s", path, e)
    return out


def delete_dataset(symbol: str, timeframe: str) -> bool:
    path = parquet_path(symbol, timeframe)
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def load_parquet(symbol: str, timeframe: str) -> pd.DataFrame:
    path = parquet_path(symbol, timeframe)
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"No dataset for {symbol} {timeframe}. Download it from the Downloads page first."
        )
    return pd.read_parquet(path)


def tail_parquet(symbol: str, timeframe: str, limit: int) -> List[Dict]:
    """Last N rows from Parquet, ready for the chart's setData()."""
    df = load_parquet(symbol, timeframe).tail(limit)
    return df.to_dict(orient="records")


def time_to_index(symbol: str, timeframe: str, t: int, side: str = "left") -> int:
    """Find the row index whose `time` is closest to t.
    side='left'  → first index with time >= t (replay start cursor)
    side='right' → last index with time <= t  (replay end cursor)
    """
    df = load_parquet(symbol, timeframe)
    if df.empty:
        return 0
    times = df["time"].to_numpy()
    if side == "left":
        idx = int(np.searchsorted(times, int(t), side="left"))
    else:
        idx = int(np.searchsorted(times, int(t), side="right")) - 1
    return max(0, min(idx, len(times) - 1))


def replay_start_index(symbol: str, timeframe: str, pct: float | None = None) -> tuple[int, int]:
    """Deterministic replay starting position. Returns (total_rows, start_index).
    Used by BOTH the seed endpoint (for chart history) and BacktestStream
    (for the replay cursor) so timestamps line up perfectly."""
    from config import BACKTEST_REPLAY_START_PCT
    p = BACKTEST_REPLAY_START_PCT if pct is None else pct
    n = len(load_parquet(symbol, timeframe))
    if n == 0:
        return 0, 0
    return n, max(0, min(n - 1, int(n * p)))


def seed_slice(symbol: str, timeframe: str, end_index: int, limit: int) -> List[Dict]:
    """Rows [end_index - limit + 1 ... end_index] inclusive. The last bar
    in the returned slice is the one BacktestStream will re-emit first
    (as a forming tick) — so update() always appends going forward."""
    df = load_parquet(symbol, timeframe)
    n = len(df)
    if n == 0:
        return []
    end = max(0, min(end_index, n - 1))
    start = max(0, end - limit + 1)
    return df.iloc[start:end + 1].to_dict(orient="records")
