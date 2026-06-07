"""
Databento historical data downloader (CME futures via GLBX.MDP3).

Databento serves survivorship-bias-free CME / CBOT / NYMEX / COMEX data through a
single Historical client. We request OHLCV bars for a continuous front-month
contract (e.g. ES.c.0), decode to a DataFrame, and normalize to Quantlab's parquet
contract: columns [time (int seconds), open, high, low, close, volume] — the same
shape every other broker adapter returns (see brokers/dukascopy.py).

Symbology (mirrors docs/databento/reference.md §5):
  - Bare root (ES, NQ, CL, GC) -> continuous **volume-rolled** front month
    "<ROOT>.v.0" with stype_in="continuous". Volume roll (.v) follows the
    most-actively-traded contract, which is what a backtestable continuous
    series needs. Calendar roll (.c, nearest expiry) is wrong for products
    whose front-by-expiry month is illiquid — notably gold (GC), where .c.0
    returns near-empty bars while .v.0 tracks the liquid active month.
  - Explicit contract code (ESH4, CLZ24) -> stype_in="raw_symbol".
  - Already-dotted symbol (ES.v.0, ES.c.0, ES.FUT) -> passed through
    (parent for *.FUT, continuous otherwise).

Timeframes:
  - Databento has native ohlcv-1m / ohlcv-1h / ohlcv-1d. There is no native
    5m / 15m / 30m / 2h / 4h, so for those we request 1m bars and resample —
    the same strategy the Dukascopy adapter uses for non-native TFs.

The API key is read from DATABENTO_API_KEY (already in backend/.env, loaded by
python-dotenv at app boot). `databento` is imported lazily inside download() so
this module — and download_jobs that imports it — load fine even if the package
isn't installed yet. See docs/databento/ for the full integration notes.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Callable, Optional

import pandas as pd

log = logging.getLogger(__name__)

_DATASET = "GLBX.MDP3"

# Quantlab timeframe -> native Databento OHLCV schema (no resample needed).
_NATIVE = {"1m": "ohlcv-1m", "1h": "ohlcv-1h", "1d": "ohlcv-1d"}

# Non-native TFs: fetch ohlcv-1m and resample with this pandas rule.
# Lowercase 'h' / 'min' aliases (pandas 2.2+), matching dukascopy.py.
_RESAMPLE = {
    "5m": "5min", "15m": "15min", "30m": "30min",
    "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
}

# Explicit contract month code at the end of a root, e.g. ESH4 / ESM24 / CLZ2025.
# CME month letters: F G H J K M N Q U V X Z.
_CONTRACT_RE = re.compile(r"[FGHJKMNQUVXZ]\d{1,4}$")


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])


def _extract_available_end(msg: str):
    """Parse the usable end timestamp out of a Databento range error. Handles
    both 'data available up to '<ts>'' and 'end time before <ts>' phrasings.
    Returns a tz-aware UTC datetime, or None if nothing parseable is found."""
    for pat in (
        r"available up to '?\"?([0-9][0-9 T:\.\+\-]*Z?)",
        r"end time before '?\"?([0-9][0-9 T:\.\+\-]*Z?)",
    ):
        m = re.search(pat, msg)
        if m:
            try:
                return pd.to_datetime(m.group(1).strip(), utc=True).to_pydatetime()
            except Exception:  # noqa: BLE001
                continue
    return None


def _resolve_symbol(symbol: str) -> tuple[str, str]:
    """Map a Quantlab symbol to (databento_symbols, stype_in).

    Examples:
      "ES"     -> ("ES.v.0", "continuous")   # volume-rolled front month
      "ESH4"   -> ("ESH4",   "raw_symbol")
      "ES.c.0" -> ("ES.c.0", "continuous")   # explicit roll rule respected
      "ES.FUT" -> ("ES.FUT", "parent")
    """
    s = symbol.strip()
    up = s.upper()
    if "." in s:
        if up.endswith(".FUT") or up.endswith(".OPT"):
            return s, "parent"
        return s, "continuous"
    if _CONTRACT_RE.search(up):
        return up, "raw_symbol"
    return f"{up}.v.0", "continuous"


def _schema_for(timeframe: str) -> tuple[str, Optional[str]]:
    """Return (databento_schema, resample_rule). resample_rule is None for
    natively-supported timeframes."""
    if timeframe in _NATIVE:
        return _NATIVE[timeframe], None
    if timeframe in _RESAMPLE:
        return "ohlcv-1m", _RESAMPLE[timeframe]
    raise ValueError(f"unsupported timeframe {timeframe!r}")


def _normalize(df: pd.DataFrame, resample_rule: Optional[str]) -> pd.DataFrame:
    """Decode a Databento OHLCV DataFrame (from DBNStore.to_df()) into the
    Quantlab parquet contract: [time (int seconds), open, high, low, close,
    volume]. to_df() already gives a tz-aware UTC datetime index and float
    prices, so we never re-scale (see reference.md §4)."""
    if df is None or df.empty:
        return _empty()

    df = df.copy()

    # to_df() indexes by ts_event (tz-aware UTC). Be defensive if it doesn't.
    if not isinstance(df.index, pd.DatetimeIndex):
        if "ts_event" in df.columns:
            df = df.set_index(pd.to_datetime(df["ts_event"], utc=True))
        else:
            raise ValueError("databento frame has no datetime index or ts_event column")
    idx = df.index
    idx = idx.tz_localize("UTC") if idx.tz is None else idx.tz_convert("UTC")
    df.index = idx

    cols = ["open", "high", "low", "close", "volume"]
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(f"databento frame missing columns: {missing}")
    df = df[cols].sort_index()
    # Collapse any duplicate timestamps (can occur across instrument changes).
    df = df[~df.index.duplicated(keep="last")]

    if resample_rule:
        ohlc = (
            df[["open", "high", "low", "close"]]
            .resample(resample_rule, label="left", closed="left")
            .agg({"open": "first", "high": "max", "low": "min", "close": "last"})
        )
        vol = df["volume"].resample(resample_rule, label="left", closed="left").sum()
        df = ohlc.join(vol.rename("volume")).dropna(subset=["open", "high", "low", "close"])

    out = df.reset_index()
    ts_col = out.columns[0]  # the former datetime index
    ts_naive = pd.to_datetime(out[ts_col], utc=True).dt.tz_convert("UTC").dt.tz_localize(None)
    out["time"] = ts_naive.values.astype("datetime64[s]").astype("int64")
    out = out[["time", "open", "high", "low", "close", "volume"]].copy()
    for c in ("open", "high", "low", "close"):
        out[c] = out[c].astype(float)
    out["volume"] = out["volume"].fillna(0.0).astype(float)
    return out.sort_values("time").drop_duplicates(subset=["time"]).reset_index(drop=True)


def download(
    symbol: str,
    start: datetime,
    end: datetime,
    timeframe: str = "1h",
    *,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> pd.DataFrame:
    """Download Databento OHLCV bars for `symbol` from `start` (UTC) to `end`
    (UTC, exclusive) at `timeframe`.

    Returns a DataFrame with columns: time (int seconds), open, high, low,
    close, volume — the same shape Quantlab's parquet cache uses everywhere.

    Databento returns the whole range in one request, so progress is coarse
    (0% -> 100%), like the Yahoo adapter. `cancel_check` is honored before and
    after the request; mid-request cancel isn't possible (single HTTP call).
    """
    try:
        import databento as db
    except ImportError as e:  # pragma: no cover - depends on install
        raise RuntimeError(
            "the 'databento' package is not installed; run `pip install databento`"
        ) from e

    key = os.environ.get("DATABENTO_API_KEY")
    if not key:
        raise RuntimeError(
            "DATABENTO_API_KEY is not set — add it to backend/.env (loaded by python-dotenv)"
        )

    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if start >= end:
        raise ValueError("start must be before end")

    db_symbols, stype_in = _resolve_symbol(symbol)
    schema, resample_rule = _schema_for(timeframe)

    if cancel_check is not None and cancel_check():
        return _empty()
    if progress_cb is not None:
        try:
            progress_cb(0, 1)
        except Exception:
            pass

    log.info(
        "databento fetching %s (stype_in=%s) schema=%s %s -> %s",
        db_symbols, stype_in, schema, start.isoformat(), end.isoformat(),
    )
    client = db.Historical(key)

    def _get(end_):
        return client.timeseries.get_range(
            dataset=_DATASET,
            symbols=db_symbols,
            schema=schema,
            stype_in=stype_in,
            start=start,
            end=end_,
        )

    # The requested end can exceed two distinct boundaries: the dataset's
    # physically-available end (`data_end_after_available_end`) and the end your
    # license/subscription covers (`dataset_unavailable_range` — the most recent
    # ~24h of CME data needs a live subscription). Both errors name the new end
    # to use, so clamp and retry until the request is within bounds.
    data = None
    for _ in range(3):
        try:
            data = _get(end)
            break
        except Exception as e:  # noqa: BLE001 - inspect message for recoverable cases
            new_end = _extract_available_end(str(e))
            if new_end is None or new_end >= end:
                raise
            log.warning("databento end %s out of bounds; clamping to %s",
                        end.isoformat(), new_end.isoformat())
            end = new_end
            if start >= end:
                return _empty()
    if data is None:
        return _empty()
    df = data.to_df()

    if cancel_check is not None and cancel_check():
        return _empty()

    bars = _normalize(df, resample_rule)

    if progress_cb is not None:
        try:
            progress_cb(1, 1)
        except Exception:
            pass
    return bars


def download_to_parquet(
    symbol: str,
    timeframe: str,
    start: datetime,
    end: datetime,
    out_dir: str,
    *,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Convenience wrapper: download() + write to parquet. Returns metadata
    about the written file. (download_jobs handles the incremental merge; this
    is here for parity with dukascopy.py and ad-hoc/CLI use.)"""
    os.makedirs(out_dir, exist_ok=True)
    bars = download(symbol, start, end, timeframe, progress_cb=progress_cb)
    if bars.empty:
        raise RuntimeError(f"Databento returned no bars for {symbol} {start.date()} -> {end.date()}")
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
