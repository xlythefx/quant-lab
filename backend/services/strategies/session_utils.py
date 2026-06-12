"""
Shared session-window utilities for VWMA strategies.

Vectorized replacement for the slow tod.apply(lambda t: _in_window(t, win)) path.
Eliminates ~280k Python function calls per backtest on a 15m dataset.
"""
from __future__ import annotations

import re
from datetime import time as dt_time
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

_HHMM_RE = re.compile(r"^(\d{1,2}):(\d{2})$")

# US equity-index futures trade on the CME Globex session, which is defined in
# US-Eastern wall-clock (default session 17:00–16:00 ET). TradeStation's `Date`
# reserved word is the ET session date, NOT a UTC date. Our parquet timestamps
# are epoch-UTC, so any date-based feature (e.g. the lunar moon phase) must be
# rebased to ET to line up with the platform the strategy was authored on.
_ET_ZONE = ZoneInfo("America/New_York")


def et_ordinal_days(times_s) -> np.ndarray:
    """Map epoch-seconds to the US-Eastern (America/New_York, DST-aware) CALENDAR
    date, expressed as an ordinal day count (days since 1970-01-01). Vectorized.

    Why ET, not UTC: ES sessions open 17:00 ET = 22:00/23:00 UTC and run across
    UTC midnight, so ~19% of bars (the 00:00–04:59 UTC evening bars) carry a UTC
    date one day ahead of their ET date. A per-bar date-based feature read off
    UTC therefore disagrees with TradeStation, whose `Date` is the ET date.
    Returns float64 so callers can fold it straight into JD arithmetic.
    """
    arr = np.asarray(times_s, dtype="int64")
    idx = pd.to_datetime(arr, unit="s", utc=True).tz_convert(_ET_ZONE)
    # Midnight of the ET wall-clock day, as whole days since the unix epoch.
    days = (idx.normalize().tz_localize(None) - pd.Timestamp("1970-01-01")).days
    return np.asarray(days, dtype="float64")


def parse_hhmm(s: str) -> dt_time:
    m = _HHMM_RE.match((s or "").strip())
    if not m:
        return dt_time(0, 0)
    return dt_time(min(23, int(m.group(1))), min(59, int(m.group(2))))


def in_window_live(t: dt_time, win: tuple[dt_time, dt_time]) -> bool:
    """Single-point check for the on_candle() live path."""
    s, e = win
    if s <= e:
        return s <= t < e
    return t >= s or t < e   # wraps midnight


def session_mask(times_utc: pd.Series, sessions: dict) -> pd.Series:
    """
    Vectorized session mask.

    times_utc: Series of pandas Timestamps (UTC, tz-aware)
    sessions:  {name: {enabled, start, end}} where start/end are 'HH:MM'

    Returns a bool Series aligned to times_utc.index.
    True = inside at least one enabled session window.
    """
    if not sessions:
        return pd.Series(False, index=times_utc.index)

    enabled_min = []
    for cfg in sessions.values():
        if not cfg or not cfg.get("enabled"):
            continue
        s = parse_hhmm(cfg.get("start", "00:00"))
        e = parse_hhmm(cfg.get("end",   "00:00"))
        enabled_min.append((s.hour * 60 + s.minute, e.hour * 60 + e.minute))

    if not enabled_min:
        return pd.Series(False, index=times_utc.index)

    tod_min = times_utc.dt.hour * 60 + times_utc.dt.minute
    mask = pd.Series(False, index=times_utc.index)
    for s_min, e_min in enabled_min:
        if s_min <= e_min:
            mask = mask | ((tod_min >= s_min) & (tod_min < e_min))
        else:
            # window wraps midnight (e.g. 22:00–02:00)
            mask = mask | ((tod_min >= s_min) | (tod_min < e_min))
    return mask
