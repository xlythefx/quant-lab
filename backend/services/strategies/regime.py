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
