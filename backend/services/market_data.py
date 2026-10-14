"""
Historical OHLCV via CCXT + Parquet cache for backtest replay.

- fetch_ohlcv: small recent window for the chart's initial paint.
- ensure_parquet: idempotent bulk download (paginated). One file per
  (symbol, timeframe). Refresh if older than ~1 day.
- load_parquet: read cached file as DataFrame for the backtest stream.

All timestamps returned as integer SECONDS (Lightweight Charts convention).

Parquet files are namespaced by broker under `data/{broker}/`. Pre-Stage-1
installs stored them flat as `data/{symbol}_{tf}.parquet`; on first import
we transparently migrate to `data/binance/{symbol}_{tf}.parquet`. The
function signatures accept a `broker` argument that defaults to "binance"
so every existing caller keeps working unchanged.
"""
import os
import shutil
import time
import logging
from typing import List, Dict, Optional

import ccxt
import numpy as np
import pandas as pd

from config import (
    DATA_DIR,
    BACKTEST_LOOKBACK_DAYS,
    TIMEFRAME_SECONDS,
)
from services import assets

log = logging.getLogger(__name__)

# Current default broker. Future stages introduce capital.com / ig.com etc.
BROKER_DEFAULT = "binance"

# USDT-M perpetuals live in their own namespace (binance_perp, ...) and carry
# a ".P" suffix on the symbol (BTCUSDT.P — TradingView's convention). The
# suffix is what keeps a perp dataset from colliding with its spot twin: every
# research page loads by symbol only, and `find_parquet` prefers the spot
# folder, so a same-named perp file would silently be shadowed by spot.
PERP_SUFFIX = ".P"

# Other CCXT exchanges carry the exchange as a symbol PREFIX: BYBIT.LTCUSDT,
# MEXC.LTCUSDT.P (TradingView's BYBIT:LTCUSDT.P, with "." because Windows
# forbids ":" in file names). Same reason as ".P": `find_parquet` tries
# data/binance/ first, so a bare LTCUSDT from Bybit would be silently shadowed
# by the Binance file. A prefix (not a suffix) keeps ".P" last, so
# is_perp_symbol works unchanged. Keep in sync with utils/validators.py.
VENUE_PREFIXES = ("BYBIT", "MEXC")

# data/{broker}/ folders fed by CCXT -> (venue prefix, perp?).
CCXT_BROKERS = {
    "binance":      (None, False),
    "binance_perp": (None, True),
    "bybit":        ("BYBIT", False),
    "bybit_perp":   ("BYBIT", True),
    "mexc":         ("MEXC", False),
    "mexc_perp":    ("MEXC", True),
}
_BROKER_FOR = {key: broker for broker, key in CCXT_BROKERS.items()}


def is_perp_symbol(symbol: str) -> bool:
    return symbol.upper().endswith(PERP_SUFFIX)


def split_venue(symbol: str) -> tuple[Optional[str], str]:
    """'MEXC.LTCUSDT.P' -> ('MEXC', 'LTCUSDT.P'); 'LTCUSDT' -> (None, 'LTCUSDT')."""
    s = symbol.upper()
    head, dot, rest = s.partition(".")
    if dot and head in VENUE_PREFIXES:
        return head, rest
    return None, s


def ccxt_broker_for(symbol: str) -> str:
    """Which data/{broker}/ folder a CCXT-sourced symbol belongs in."""
    venue, _ = split_venue(symbol)
    return _BROKER_FOR[(venue, is_perp_symbol(symbol))]


def ccxt_symbol_for(symbol: str, broker: str) -> str:
    """The symbol as saved under `broker`: adds the venue prefix / ".P" the
    broker implies (LTCUSDT + mexc_perp -> MEXC.LTCUSDT.P). Markers already on
    the symbol are kept, so BTCUSDT.P + binance still means perp."""
    b_venue, b_perp = CCXT_BROKERS[broker]
    venue, rest = split_venue(symbol)
    if venue and venue != b_venue:
        raise ValueError(f"{symbol} is a {venue} symbol, not {broker}")
    perp = b_perp or is_perp_symbol(rest)
    bare = rest[: -len(PERP_SUFFIX)] if is_perp_symbol(rest) else rest
    prefix = f"{b_venue}." if b_venue else ""
    return f"{prefix}{bare}{PERP_SUFFIX if perp else ''}"

os.makedirs(DATA_DIR, exist_ok=True)


def _broker_dir(broker: str) -> str:
    return os.path.join(DATA_DIR, broker)


def _migrate_flat_layout_to_broker_namespace() -> None:
    """One-shot migration: move legacy `data/{symbol}_{tf}.parquet` files into
    `data/binance/{symbol}_{tf}.parquet`. Idempotent — if the broker subdir
    already exists, we still sweep the top level in case a partial run left
    files behind. Never overwrites a file that already exists in the new
    location.
    """
    if not os.path.isdir(DATA_DIR):
        return
    legacy = [
        f for f in os.listdir(DATA_DIR)
        if f.endswith(".parquet") and os.path.isfile(os.path.join(DATA_DIR, f))
    ]
    if not legacy:
        return
    target_dir = _broker_dir(BROKER_DEFAULT)
    os.makedirs(target_dir, exist_ok=True)
    for fname in legacy:
        src = os.path.join(DATA_DIR, fname)
        dst = os.path.join(target_dir, fname)
        if os.path.exists(dst):
            log.info("skipping migration of %s (target already exists)", fname)
            continue
        try:
            shutil.move(src, dst)
            log.info("migrated %s -> %s", src, dst)
        except OSError as e:
            log.warning("migration failed for %s: %s", fname, e)


_migrate_flat_layout_to_broker_namespace()

# Single shared CCXT client per market. enableRateLimit avoids hammering Binance.
# `binance` = spot (api.binance.com); `binanceusdm` = USDT-M perps (fapi.binance.com).
_exchange = ccxt.binance({"enableRateLimit": True, "timeout": 20000})
_exchange_perp = ccxt.binanceusdm({"enableRateLimit": True, "timeout": 20000})
# Bybit and MEXC: one client covers spot AND perps — the CCXT market name
# (LTC/USDT vs LTC/USDT:USDT) picks which.
_venue_clients = {
    "BYBIT": ccxt.bybit({"enableRateLimit": True, "timeout": 20000}),
    "MEXC": ccxt.mexc({"enableRateLimit": True, "timeout": 20000}),
}


def _client_for(symbol: str):
    venue, _ = split_venue(symbol)
    if venue:
        return _venue_clients[venue]
    return _exchange_perp if is_perp_symbol(symbol) else _exchange


_QUOTES = ("USDT", "USDC", "BUSD", "BTC", "ETH", "FDUSD", "TUSD", "EUR", "TRY", "BNB")

# pandas resample rules for the bespoke timeframes (lowercase 'min'/'h', 2.2+).
# Any other non-native timeframe (MEXC has no 3m/2h) falls back to "{N}min".
_TF_PANDAS_RULE = {
    "6m": "6min", "10m": "10min", "12m": "12min", "23m": "23min", "46m": "46min",
}


def _fetch_tf_for(client, timeframe: str) -> str:
    """The timeframe to fetch: `timeframe` itself if the exchange has it, else
    the largest one it has that divides it evenly (resampled up afterwards).
    Binance has no 6/10/12/23/46m; MEXC has no 3m or 2h — and 2h built from
    MEXC's 1h keeps years of history, where 1m would keep only ~30 days."""
    if timeframe in client.timeframes:
        return timeframe
    secs = TIMEFRAME_SECONDS[timeframe]
    fits = [tf for tf in client.timeframes
            if tf in TIMEFRAME_SECONDS and secs % TIMEFRAME_SECONDS[tf] == 0]
    return max(fits, key=TIMEFRAME_SECONDS.get)


def _require_market(client, pair: str, symbol: str) -> None:
    """Fail fast on a pair the exchange doesn't list. Inside the page loop a
    BadSymbol is an ExchangeError and would be retried forever."""
    client.load_markets()
    if pair not in client.markets:
        raise ValueError(f"{client.name} has no market {pair} (asked for {symbol})")


def _fetch_page(client, pair: str, timeframe: str, since: Optional[int] = None,
                limit: int = 1000) -> list:
    """client.fetch_ohlcv with volume in coins. CCXT passes perp volume through
    in the exchange's own unit: MEXC counts contracts of 0.01 LTC, so its raw
    number is 100x the coins traded. Binance and Bybit perps are 1 coin per
    contract, and spot has no contract size — both no-ops."""
    rows = client.fetch_ohlcv(pair, timeframe=timeframe, since=since, limit=limit)
    size = client.market(pair).get("contractSize") or 1.0
    if size != 1.0:
        rows = [[*r[:5], r[5] * size if r[5] is not None else None] for r in rows]
    return rows


def _seek_first_bar(client, pair: str, timeframe: str, since: int, end_ms: int) -> Optional[int]:
    """Earliest bar time >= `since`, or None if there's none up to `end_ms`.

    MEXC keeps only a rolling window of short timeframes (~30 days of 1m,
    ~1 year of 5m/15m) and answers an older `since` with an EMPTY page instead
    of its first bar — which the download loop would read as "nothing here".
    Binary search for where its data begins (~15 small requests)."""
    step = TIMEFRAME_SECONDS[timeframe] * 1000 * 100  # one 100-bar probe page
    hi = max(since, end_ms - step)
    if not _fetch_page(client, pair, timeframe, since=hi, limit=100):
        return None
    lo = since  # known empty
    while hi - lo > step:
        mid = (lo + hi) // 2
        if _fetch_page(client, pair, timeframe, since=mid, limit=100):
            hi = mid
        else:
            lo = mid
    return hi


def _resample_ohlcv_ms(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Resample a finer OHLCV frame (columns: ts_ms, open, high, low, close,
    volume) up to `timeframe`. Returns [time (int seconds), open, high, low,
    close, volume] — the standard parquet contract."""
    rule = _TF_PANDAS_RULE.get(timeframe) or f"{TIMEFRAME_SECONDS[timeframe] // 60}min"
    d = df.copy()
    d.index = pd.to_datetime(d["ts_ms"], unit="ms", utc=True)
    agg = (
        d.resample(rule, label="left", closed="left")
        .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
        .dropna(subset=["open", "high", "low", "close"])
        .reset_index(names="ts")
    )
    ts_naive = agg["ts"].dt.tz_convert("UTC").dt.tz_localize(None)
    agg["time"] = ts_naive.values.astype("datetime64[s]").astype("int64")
    return agg[["time", "open", "high", "low", "close", "volume"]].reset_index(drop=True)


def _to_ccxt_symbol(symbol: str) -> str:
    """BTCUSDT -> BTC/USDT (spot); BTCUSDT.P -> BTC/USDT:USDT (USDT-M perp).
    Splits on the longest known quote suffix. CCXT names a linear perp
    "BASE/QUOTE:SETTLE" — plain "BTC/USDT" is NOT a market on binanceusdm.
    A venue prefix is dropped: MEXC.LTCUSDT.P -> LTC/USDT:USDT."""
    _, s = split_venue(symbol)
    perp = is_perp_symbol(s)
    if perp:
        s = s[: -len(PERP_SUFFIX)]
    base, quote = None, None
    for q in sorted(_QUOTES, key=len, reverse=True):
        if s.endswith(q) and len(s) > len(q):
            base, quote = s[:-len(q)], q
            break
    if base is None:
        # Fallback: assume last 4 chars are the quote.
        base, quote = s[:-4], s[-4:]
    return f"{base}/{quote}:{quote}" if perp else f"{base}/{quote}"


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


_BINANCE_SYMBOLS: set | None = None

def is_binance_symbol(symbol: str) -> bool:
    """True if `symbol` is a known Binance trading pair (from assets/binance.json)."""
    global _BINANCE_SYMBOLS
    if _BINANCE_SYMBOLS is None:
        import json
        path = os.path.join(DATA_DIR, "assets", "binance.json")
        try:
            with open(path) as f:
                _BINANCE_SYMBOLS = set(json.load(f).keys())
        except Exception:
            _BINANCE_SYMBOLS = set()
    return symbol in _BINANCE_SYMBOLS


def fetch_ohlcv(symbol: str, timeframe: str, limit: int = 500) -> List[Dict]:
    """Recent N candles via CCXT REST. Used for initial chart paint."""
    pair = _to_ccxt_symbol(symbol)
    try:
        rows = _fetch_page(_client_for(symbol), pair, timeframe, limit=limit)
    except (ccxt.NetworkError, ccxt.ExchangeError) as e:
        log.error("fetch_ohlcv failed for %s %s: %s", symbol, timeframe, e)
        raise
    return _ohlcv_to_records(rows)


def fetch_ticker(symbol: str) -> Dict:
    """24h ticker snapshot via CCXT REST (Live Terminal price header).
    Returns {price, changePct, high, low, vol, ts} — the live tick between
    refreshes comes from the kline stream, this fills the 24h stats."""
    pair = _to_ccxt_symbol(symbol)
    try:
        t = _client_for(symbol).fetch_ticker(pair)
    except (ccxt.NetworkError, ccxt.ExchangeError) as e:
        log.error("fetch_ticker failed for %s: %s", symbol, e)
        raise
    return {
        "symbol": symbol,
        "price": float(t.get("last") or 0.0),
        "changePct": float(t.get("percentage") or 0.0),
        "high": float(t.get("high") or 0.0),
        "low": float(t.get("low") or 0.0),
        "vol": float(t.get("baseVolume") or 0.0),
        "quoteVol": float(t.get("quoteVolume") or 0.0),
        "ts": int((t.get("timestamp") or time.time() * 1000) // 1000),
    }


def parquet_path(symbol: str, timeframe: str, broker: str = BROKER_DEFAULT) -> str:
    bdir = _broker_dir(broker)
    os.makedirs(bdir, exist_ok=True)
    return os.path.join(bdir, f"{symbol}_{timeframe}.parquet")


def _is_fresh(path: str, max_age_seconds: int = 86400) -> bool:
    if not os.path.exists(path):
        return False
    return (time.time() - os.path.getmtime(path)) < max_age_seconds


def ensure_parquet(symbol: str, timeframe: str, force: bool = False) -> Dict:
    """
    Ensure a Parquet file with ~BACKTEST_LOOKBACK_DAYS of history exists.
    Returns metadata: {cached, rows, path}.
    """
    path = parquet_path(symbol, timeframe, ccxt_broker_for(symbol))
    if not force and _is_fresh(path):
        df = pd.read_parquet(path)
        return {"cached": True, "rows": len(df), "path": path}

    pair = _to_ccxt_symbol(symbol)
    client = _client_for(symbol)
    _require_market(client, pair, symbol)
    tf_seconds = TIMEFRAME_SECONDS[timeframe]
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - BACKTEST_LOOKBACK_DAYS * 86400 * 1000

    all_rows = []
    since = start_ms
    page_limit = 1000  # Binance max per fetch
    log.info("Downloading %s %s history (~%dd)...", symbol, timeframe, BACKTEST_LOOKBACK_DAYS)

    while since < end_ms:
        try:
            rows = _fetch_page(client, pair, timeframe, since=since, limit=page_limit)
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
    _invalidate_datasets_cache()
    log.info("Wrote %d rows to %s", len(df), path)
    return {"cached": False, "rows": len(df), "path": path}


def download_range(
    symbol: str,
    timeframe: str,
    start_ms: int,
    end_ms: int,
    progress_cb=None,
    cancel_check=None,
) -> Dict:
    """
    Download a custom date range and write/merge into the Parquet for
    (symbol, timeframe). If a file already exists, the new rows are merged
    in (deduped) so the cache grows incrementally.
    Returns {rows_added, rows_total, path, first_time, last_time}.

    `cancel_check`: optional callable returning True if the caller wants to
    abort. Checked between pages — the partial result still gets merged into
    the parquet so cancellation isn't a total loss.
    """
    if start_ms >= end_ms:
        raise ValueError("start must be before end")

    pair = _to_ccxt_symbol(symbol)
    client = _client_for(symbol)
    broker = ccxt_broker_for(symbol)
    _require_market(client, pair, symbol)
    # Odd intervals the exchange lacks are pulled finer and resampled.
    fetch_tf = _fetch_tf_for(client, timeframe)
    native = fetch_tf == timeframe
    tf_seconds = TIMEFRAME_SECONDS[fetch_tf]
    page_limit = 1000

    new_rows = []
    since = start_ms
    log.info("Downloading %s %s from %s to %s (fetch_tf=%s, broker=%s)", symbol, timeframe, start_ms, end_ms, fetch_tf, broker)

    while since < end_ms:
        if cancel_check is not None and cancel_check():
            log.info("download_range cancelled at since=%s", since)
            break
        try:
            rows = _fetch_page(client, pair, fetch_tf, since=since, limit=page_limit)
        except (ccxt.NetworkError, ccxt.ExchangeError) as e:
            log.warning("page failed since=%s: %s — retrying", since, e)
            time.sleep(2)
            continue

        if not rows:
            if new_rows:
                break  # ran past the newest bar
            # Nothing yet: `since` may predate a rolling-window exchange's history.
            first = _seek_first_bar(client, pair, fetch_tf, since, end_ms)
            if first is None or first <= since:
                break
            log.info("%s has no bars before %s — skipping ahead", client.name, first)
            since = first
            continue

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
        path = parquet_path(symbol, timeframe, broker)
        if os.path.exists(path):
            existing = pd.read_parquet(path)
            return {
                "rows_added": 0,
                "rows_total": int(len(existing)),
                "path": path,
                "first_time": int(existing["time"].min()) if len(existing) else None,
                "last_time": int(existing["time"].max()) if len(existing) else None,
            }
        raise RuntimeError(f"{client.name} returned no candles for that range")

    if native:
        new_df["time"] = (new_df["ts_ms"] // 1000).astype("int64")
        new_df = new_df[["time", "open", "high", "low", "close", "volume"]]
    else:
        # Trim to the requested window before resampling so partial edge bars
        # don't leak in, then aggregate fetch_tf -> target timeframe.
        new_df = new_df[new_df["ts_ms"] <= end_ms]
        new_df = _resample_ohlcv_ms(new_df, timeframe)

    path = parquet_path(symbol, timeframe, broker)
    rows_before = 0
    if os.path.exists(path):
        existing = pd.read_parquet(path)
        rows_before = len(existing)
        merged = pd.concat([existing, new_df], ignore_index=True)
    else:
        merged = new_df

    # keep="last": freshly fetched bars win, so a bar that was still forming at
    # the previous download's end gets replaced by its finished version.
    merged = merged.drop_duplicates(subset=["time"], keep="last").sort_values("time").reset_index(drop=True)
    merged.to_parquet(path, index=False)
    _invalidate_datasets_cache()

    return {
        "rows_added": int(len(merged) - rows_before),
        "rows_total": int(len(merged)),
        "path": path,
        "first_time": int(merged["time"].min()),
        "last_time": int(merged["time"].max()),
    }


_datasets_cache: dict | None = None
_datasets_cache_ts: float = 0.0
_DATASETS_CACHE_TTL = 30.0   # seconds


def _invalidate_datasets_cache() -> None:
    global _datasets_cache
    _datasets_cache = None


def list_datasets() -> List[Dict]:
    """Scan data/{broker}/ subdirs for *.parquet files and return metadata
    for each, enriched with asset_class / execution_model / etc. from
    services.assets.

    Skips empty/corrupt files so the dashboard never lists something the
    seed endpoint can't actually serve. Returned rows always include
    `broker` and `asset_class` keys (Stage 1 of the multi-asset roadmap)."""
    global _datasets_cache, _datasets_cache_ts
    now = time.time()
    if _datasets_cache is not None and (now - _datasets_cache_ts) < _DATASETS_CACHE_TTL:
        return list(_datasets_cache)

    out = []
    if not os.path.isdir(DATA_DIR):
        _datasets_cache = out
        _datasets_cache_ts = now
        return out
    # Each subdirectory of data/ that's not "assets" is treated as a broker.
    broker_dirs = []
    for entry in sorted(os.listdir(DATA_DIR)):
        full = os.path.join(DATA_DIR, entry)
        if not os.path.isdir(full):
            continue
        if entry == "assets":  # the metadata catalog dir, not a broker
            continue
        broker_dirs.append((entry, full))

    for broker, bdir in broker_dirs:
        for fname in sorted(os.listdir(bdir)):
            if not fname.endswith(".parquet"):
                continue
            stem = fname[: -len(".parquet")]
            if "_" not in stem:
                continue
            symbol, tf = stem.rsplit("_", 1)
            path = os.path.join(bdir, fname)
            try:
                if os.path.getsize(path) == 0:
                    log.warning("skipping empty parquet: %s", path)
                    continue
                df = pd.read_parquet(path, columns=["time"])
                if len(df) == 0:
                    log.warning("skipping rowless parquet: %s", path)
                    continue
                meta = assets.get(symbol, broker)
                out.append({
                    "symbol": symbol,
                    "timeframe": tf,
                    "broker": broker,
                    "asset_class": meta.asset_class,
                    "execution_model": meta.execution_model,
                    "rows": int(len(df)),
                    "first_time": int(df["time"].min()),
                    "last_time": int(df["time"].max()),
                    "size_bytes": os.path.getsize(path),
                })
            except Exception as e:
                log.warning("could not read %s: %s", path, e)

    _datasets_cache = out
    _datasets_cache_ts = time.time()
    return list(out)


def delete_dataset(symbol: str, timeframe: str, broker: str = BROKER_DEFAULT) -> bool:
    path = parquet_path(symbol, timeframe, broker)
    if os.path.exists(path):
        os.remove(path)
        _invalidate_datasets_cache()
        return True
    return False


def find_parquet(symbol: str, timeframe: str) -> Optional[str]:
    """Locate the parquet for (symbol, timeframe) across any broker namespace.
    Returns the absolute path, or None if not found.

    Used by callers that know the symbol but not which broker it came from
    (the backtest engine, walk-forward, streaming etc. pre-date the
    multi-broker abstraction and just take a symbol string). Default-broker
    path is tried first as a fast path; on miss, every broker subdir under
    DATA_DIR is scanned.
    """
    if not os.path.isdir(DATA_DIR):
        return None
    default_path = parquet_path(symbol, timeframe, BROKER_DEFAULT)
    if os.path.exists(default_path):
        return default_path
    for entry in sorted(os.listdir(DATA_DIR)):
        full = os.path.join(DATA_DIR, entry)
        if not os.path.isdir(full) or entry == "assets":
            continue
        candidate = os.path.join(full, f"{symbol}_{timeframe}.parquet")
        if os.path.exists(candidate):
            return candidate
    return None


def broker_for(symbol: str, timeframe: str) -> Optional[str]:
    """Return the broker namespace the (symbol, timeframe) parquet lives in
    (e.g. ES → 'tradestation', BTCUSDT → 'binance'), or None if not found.
    Used to look up asset metadata when only a symbol string is known."""
    path = find_parquet(symbol, timeframe)
    if path is None:
        return None
    return os.path.basename(os.path.dirname(path))


def load_parquet(symbol: str, timeframe: str, broker: Optional[str] = None) -> pd.DataFrame:
    """Load the cached parquet for (symbol, timeframe).

    If `broker` is given, load strictly from that broker's namespace.
    If `broker` is None, auto-discover: prefer the default broker's path,
    fall back to scanning every broker subdir. Cross-broker disambiguation
    is first-found wins — fine while no two brokers carry the same
    (symbol, timeframe). When that day comes, every caller will need to
    start passing `broker` explicitly.
    """
    if broker is not None:
        path = parquet_path(symbol, timeframe, broker)
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"No dataset for {symbol} {timeframe} on {broker}. "
                f"Download it from the Downloads page first."
            )
    else:
        path = find_parquet(symbol, timeframe)
        if path is None:
            raise FileNotFoundError(
                f"No dataset for {symbol} {timeframe}. "
                f"Download it from the Downloads page first."
            )
    return pd.read_parquet(path)


# ---------------------------------------------------------------------------
# Manual CSV import (TradeStation export format)
# ---------------------------------------------------------------------------

_CSV_TF_OFFSETS = {
    "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "4h": "4h", "1d": "D",
}


def import_csv_tradestation(
    file_bytes: bytes,
    symbol: str,
    timeframes: List[str],
    source_tz: str = "America/New_York",
) -> List[Dict]:
    """Parse a manually-exported TradeStation OHLCV CSV, resample to each
    requested timeframe, and merge-write to data/tradestation/.

    Handles the two most common TradeStation 1-minute export layouts:
      • With header:   Date, Time, Open, High, Low, Close, Up, Down
      • Without header: MM/DD/YYYY, HH:MM, O, H, L, C, [Volume | Up, Down]

    Timestamps in the CSV are assumed to be in `source_tz` (default Eastern
    Time — standard for CME futures in TradeStation) and are converted to UTC
    before writing to Parquet.

    Returns [{timeframe, rows_added, rows_total, first_time, last_time}, ...]
    """
    import io

    # UTF-8 with optional BOM
    content = file_bytes.decode("utf-8-sig", errors="replace")
    lines = [l for l in content.splitlines() if l.strip() and not l.startswith("#")]
    if not lines:
        raise ValueError("CSV file is empty")

    # Detect header: a date row starts with two digits (e.g. "01/...")
    first_field = lines[0].split(",")[0].strip().strip('"')
    has_header = not (len(first_field) >= 2 and first_field[:2].isdigit())

    df = pd.read_csv(
        io.StringIO("\n".join(lines)),
        header=0 if has_header else None,
        dtype=str,
    )

    # Normalize column names
    if has_header:
        df.columns = [c.strip().strip('"').lower().replace(" ", "_") for c in df.columns]
    else:
        ncols = len(df.columns)
        names = ["date", "time", "open", "high", "low", "close"]
        if ncols >= 8:
            names += ["up", "down"]
        elif ncols >= 7:
            names += ["volume"]
        df.columns = (names + [f"_x{i}" for i in range(ncols)])[:ncols]

    # Column aliases
    for src, dst in [("vol", "volume"), ("tot_vol", "volume"), ("total_volume", "volume"),
                     ("open_interest", "_oi")]:
        if src in df.columns and dst not in df.columns:
            df.rename(columns={src: dst}, inplace=True)

    # Build volume from Up/Down tick columns when no Volume column present
    if "volume" not in df.columns:
        def _get_col(names_to_try):
            for n in names_to_try:
                if n in df.columns:
                    return df[n]
            return pd.Series(["0"] * len(df))

        up_s = _get_col(["up", "up_volume"])
        dn_s = _get_col(["down", "down_volume"])
        df["volume"] = (
            pd.to_numeric(up_s.str.strip('"'), errors="coerce").fillna(0.0)
            + pd.to_numeric(dn_s.str.strip('"'), errors="coerce").fillna(0.0)
        )

    # Parse datetime
    date_s = df["date"].astype(str).str.strip().str.strip('"')
    time_s = df["time"].astype(str).str.strip().str.strip('"')

    dt = None
    # TradeStation numeric date format: pure integer like 1160524
    # Encoding: (year-1900)*10000 + month*100 + day
    # Time is also integer HHMM: 1900 = 19:00, 0 = 00:00
    first_date = date_s.iloc[0]
    if first_date.lstrip("-").isdigit() and "/" not in first_date and "-" not in first_date:
        try:
            date_int = date_s.astype(int)
            time_int = pd.to_numeric(time_s, errors="coerce").fillna(0).astype(int)
            dt = pd.to_datetime({
                "year":   date_int // 10000 + 1900,
                "month":  (date_int % 10000) // 100,
                "day":    date_int % 100,
                "hour":   time_int // 100,
                "minute": time_int % 100,
            })
        except Exception:
            pass

    if dt is None:
        combined = date_s + " " + time_s
        for fmt in ("%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                dt = pd.to_datetime(combined, format=fmt, errors="raise")
                break
            except Exception:
                continue
    if dt is None:
        combined = date_s + " " + time_s
        dt = pd.to_datetime(combined, errors="coerce")

    # Localize source timezone → UTC
    try:
        dt = dt.dt.tz_localize(source_tz, ambiguous="NaT", nonexistent="NaT").dt.tz_convert("UTC")
    except Exception:
        log.warning("import_csv: tz_localize failed for %s, treating as UTC", source_tz)
        dt = dt.dt.tz_localize("UTC", nonexistent="NaT")

    # OHLCV as float
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col].astype(str).str.strip('"'), errors="coerce")

    df["datetime"] = dt
    df = df.dropna(subset=["datetime", "open", "high", "low", "close"])
    df = df.sort_values("datetime").drop_duplicates(subset=["datetime"]).reset_index(drop=True)

    if df.empty:
        raise ValueError("No valid OHLCV rows found in CSV after parsing")

    log.info("import_csv: parsed %d rows for %s, resampling to %s", len(df), symbol, timeframes)

    results = []
    for tf in timeframes:
        offset = _CSV_TF_OFFSETS.get(tf)
        if offset is None:
            log.warning("import_csv: unsupported timeframe %s — skipped", tf)
            continue

        resampled = (
            df.set_index("datetime")[["open", "high", "low", "close", "volume"]]
            .resample(offset)
            .agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
            .dropna(subset=["open"])
        )

        if resampled.empty:
            continue

        out_df = resampled.copy()
        # Use timedelta arithmetic — resolution-independent across pandas versions
        # (pandas 2.x changed internal dtype from ns to µs, breaking // 1e9)
        out_df["time"] = (
            (resampled.index - pd.Timestamp("1970-01-01", tz="UTC"))
            .total_seconds()
            .astype("int64")
        )
        out_df = out_df.reset_index(drop=True)[["time", "open", "high", "low", "close", "volume"]]

        path = parquet_path(symbol, tf, broker="tradestation")
        rows_before = 0
        if os.path.exists(path):
            existing = pd.read_parquet(path)
            rows_before = len(existing)
            merged = pd.concat([existing, out_df], ignore_index=True)
        else:
            merged = out_df

        merged = merged.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)
        merged.to_parquet(path, index=False)
        _invalidate_datasets_cache()
        log.info("import_csv: wrote %s %s → %d rows (added %d)", symbol, tf, len(merged), len(merged) - rows_before)

        results.append({
            "timeframe": tf,
            "rows_added": int(len(merged) - rows_before),
            "rows_total": int(len(merged)),
            "first_time": int(merged["time"].min()),
            "last_time": int(merged["time"].max()),
        })

    return results

def tail_parquet(symbol: str, timeframe: str, limit: int, broker: Optional[str] = None) -> List[Dict]:
    """Last N rows from Parquet, ready for the chart's setData()."""
    df = load_parquet(symbol, timeframe, broker=broker).tail(limit)
    return df.to_dict(orient="records")


def time_to_index(symbol: str, timeframe: str, t: int, side: str = "left",
                  broker: Optional[str] = None) -> int:
    """Find the row index whose `time` is closest to t.
    side='left'  → first index with time >= t (replay start cursor)
    side='right' → last index with time <= t  (replay end cursor)
    """
    df = load_parquet(symbol, timeframe, broker=broker)
    if df.empty:
        return 0
    times = df["time"].to_numpy()
    if side == "left":
        idx = int(np.searchsorted(times, int(t), side="left"))
    else:
        idx = int(np.searchsorted(times, int(t), side="right")) - 1
    return max(0, min(idx, len(times) - 1))


def replay_start_index(symbol: str, timeframe: str, pct: float | None = None,
                       broker: Optional[str] = None) -> tuple[int, int]:
    """Deterministic replay starting position. Returns (total_rows, start_index).
    Used by BOTH the seed endpoint (for chart history) and BacktestStream
    (for the replay cursor) so timestamps line up perfectly."""
    from config import BACKTEST_REPLAY_START_PCT
    p = BACKTEST_REPLAY_START_PCT if pct is None else pct
    n = len(load_parquet(symbol, timeframe, broker=broker))
    if n == 0:
        return 0, 0
    return n, max(0, min(n - 1, int(n * p)))


def seed_slice(symbol: str, timeframe: str, end_index: int, limit: int,
               broker: Optional[str] = None) -> List[Dict]:
    """Rows [end_index - limit + 1 ... end_index] inclusive. The last bar
    in the returned slice is the one BacktestStream will re-emit first
    (as a forming tick) — so update() always appends going forward."""
    df = load_parquet(symbol, timeframe, broker=broker)
    n = len(df)
    if n == 0:
        return []
    end = max(0, min(end_index, n - 1))
    start = max(0, end - limit + 1)
    return df.iloc[start:end + 1].to_dict(orient="records")
