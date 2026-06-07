"""
Standalone ADX-based regime detector.

ADX < threshold  → ranging  → True  → safe for mean reversion entries
ADX >= threshold → trending → False → skip mean reversion entries

Import and use in any strategy:
    from services.strategies.regime import RegimeDetector
    rd = RegimeDetector(period=14, threshold=25.0)
    ranging = rd.detect(df)          # vectorized: pd.Series[bool]
    adx_now = rd.last_adx(df)        # live: float for latest bar
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _calc_adx(df: pd.DataFrame, period: int) -> pd.Series:
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)

    prev_high = high.shift(1)
    prev_low = low.shift(1)
    prev_close = close.shift(1)

    # True Range
    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)

    # Directional Movement — zero when the other direction dominates
    up_move = high - prev_high
    down_move = prev_low - low

    plus_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0), up_move, 0.0),
        index=df.index,
    )
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0.0),
        index=df.index,
    )

    # Wilder's smoothing — same EWM formula used by _rsi() and _atr()
    alpha = 1.0 / period
    tr_s = tr.ewm(alpha=alpha, adjust=False).mean().replace(0, np.nan)
    plus_s = plus_dm.ewm(alpha=alpha, adjust=False).mean()
    minus_s = minus_dm.ewm(alpha=alpha, adjust=False).mean()

    plus_di = 100.0 * plus_s / tr_s
    minus_di = 100.0 * minus_s / tr_s

    denom = (plus_di + minus_di).replace(0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / denom

    adx = dx.ewm(alpha=alpha, adjust=False).mean()
    return adx


class RegimeDetector:
    def __init__(self, period: int = 14, threshold: float = 25.0):
        self.period = period
        self.threshold = threshold

    def detect(self, df: pd.DataFrame) -> pd.Series:
        """Vectorized — returns bool Series aligned to df.index.
        True = ranging (safe to enter mean reversion trades)."""
        adx = _calc_adx(df, self.period)
        # NaN = insufficient warmup bars → fill with 0 so comparisons produce True
        # (numpy NaN < threshold returns False, not NaN, so fillna on the bool
        # result is too late — fill on adx itself before comparing).
        return adx.fillna(0.0) < self.threshold

    def last_adx(self, df: pd.DataFrame) -> float:
        """Return the ADX value for the most recent bar in df."""
        val = _calc_adx(df, self.period).iloc[-1]
        return float(val) if np.isfinite(val) else 0.0


# --------------------------------------------------------------------------- #
# Five-regime classifier (shared by Market Lab analysis AND tradeable strategies)
#
# Lives here (not in services/market_lab.py) so strategies can import it without
# a circular dependency: this module imports nothing app-level; market_lab.py and
# strategies both import from here.
#
# Causal: every feature at bar i uses only bars <= i. The volatility percentile is
# ranked within a TRAILING lookback window, so a bar's label does not depend on the
# display range and no future data leaks in — making the labels safe to use as a
# live trade filter that matches the backtest.
# --------------------------------------------------------------------------- #
REGIME_LABELS = [
    "Trending Up",
    "Trending Down",
    "High-Volatility",
    "Quiet",
    "Choppy-Range",
]


def _p(params: dict, key: str, default):
    """Read an optional numeric param with a fallback default (type-coerced)."""
    if not params or params.get(key) is None:
        return default
    try:
        return type(default)(params[key])
    except (TypeError, ValueError):
        return default


def _regime_params(params: dict) -> dict:
    params = params or {}
    return {
        "adx_period": _p(params, "adx_period", 14),
        "adx_trend_thresh": _p(params, "adx_trend_thresh", 25.0),
        "vol_window": _p(params, "vol_window", 20),
        "trend_window": _p(params, "trend_window", 20),
        "vol_lookback": _p(params, "vol_lookback", 500),
        "vol_hi_pct": _p(params, "vol_hi_pct", 0.80),
        "vol_lo_pct": _p(params, "vol_lo_pct", 0.20),
        "smooth_bars": _p(params, "smooth_bars", 0),
    }


def _smooth_labels(labels: np.ndarray, min_len: int) -> np.ndarray:
    """Merge regime runs shorter than min_len into their longer neighbor.
    Reduces ribbon flicker. Iterates until stable (or a few passes)."""
    labels = labels.copy()
    for _ in range(8):
        runs, s = [], 0
        for i in range(1, len(labels) + 1):
            if i == len(labels) or labels[i] != labels[s]:
                runs.append((s, i, labels[s]))
                s = i
        if len(runs) <= 1:
            break
        changed = False
        for ri, (a, b, _lab) in enumerate(runs):
            if b - a >= min_len:
                continue
            prev_len = (runs[ri - 1][1] - runs[ri - 1][0]) if ri > 0 else -1
            next_len = (runs[ri + 1][1] - runs[ri + 1][0]) if ri < len(runs) - 1 else -1
            if prev_len < 0 and next_len < 0:
                continue
            target = runs[ri - 1][2] if prev_len >= next_len else runs[ri + 1][2]
            labels[a:b] = target
            changed = True
        if not changed:
            break
    return labels


def _regime_labels(df: pd.DataFrame, rp: dict) -> np.ndarray:
    """Causal per-bar regime label array (one of REGIME_LABELS)."""
    close = df["close"].astype(float)
    n = len(df)
    c = close.to_numpy()

    adx = _calc_adx(df, rp["adx_period"]).fillna(0.0).to_numpy()

    # rolling linreg slope of close, normalized to %/bar (causal)
    tw = rp["trend_window"]
    x = np.arange(tw, dtype=float)
    x_dev = x - x.mean()
    x_ss = float(np.dot(x_dev, x_dev))
    slope_pct = np.zeros(n)
    for i in range(tw - 1, n):
        win = c[i - tw + 1 : i + 1]
        beta = float(np.dot(x_dev, win - win.mean())) / x_ss if x_ss > 0 else 0.0
        slope_pct[i] = (beta / win[-1]) if win[-1] > 0 else 0.0

    # Volatility, ranked within a TRAILING lookback (causal + range-independent).
    rv = close.pct_change().rolling(rp["vol_window"]).std()
    lb = max(2, int(rp["vol_lookback"]))
    vol_pct = rv.rolling(lb, min_periods=min(lb, 20)).rank(pct=True).to_numpy()

    labels = np.empty(n, dtype=object)
    at = rp["adx_trend_thresh"]
    for i in range(n):
        a, sl = adx[i], slope_pct[i]
        vp = vol_pct[i] if np.isfinite(vol_pct[i]) else 0.5
        if a >= at and sl > 0:
            labels[i] = "Trending Up"
        elif a >= at and sl < 0:
            labels[i] = "Trending Down"
        elif vp >= rp["vol_hi_pct"]:
            labels[i] = "High-Volatility"
        elif vp <= rp["vol_lo_pct"] and a < at:
            labels[i] = "Quiet"
        else:
            labels[i] = "Choppy-Range"

    sb = int(rp.get("smooth_bars") or 0)
    if sb > 1:
        labels = _smooth_labels(labels, sb)
    return labels
