"""
Nexa Strategy — converted from the "Elias Strategy" Pine script.

Five filters must all agree before an entry:
  1. Cloud   — price above BOTH cloud lines (long) / below both (short).
               NOTE: the source calls this Ichimoku, but it is built from simple
               moving averages of hl2 and is NOT displaced forward like real
               Ichimoku. Ported as written — which also makes it causal (every
               value at bar i uses only bars <= i).
  2. VWMA    — price on the right side of a slow volume-weighted average.
  3. MACD    — MACD line above its signal (long) / below (short).
  4. RSI     — a "don't chase" gate: long only below rsi_long_max, short only
               above rsi_short_min. This BLOCKS stretched entries; it is not a
               momentum filter.
  5. Volume  — bar volume above its rolling average x vol_mult.

Exit: opposite-signal only. A long is closed when the short condition fires and
vice versa — there is no stop or target in the source script, so a single trade
has open-ended downside. Deliberately left as-is; adding a stop is a separate
change that has to earn its place out-of-sample.

Self-contained: SMA / EMA / VWMA / RSI / MACD all inline.
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)


# ---------------------------------------------------------------------------
# Indicators (self-contained)
# ---------------------------------------------------------------------------

def _vwma(close: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    pv = (close * volume).rolling(length).sum()
    vsum = volume.rolling(length).sum().replace(0, np.nan)
    return pv / vsum


def _ema(s: pd.Series, length: int) -> pd.Series:
    return s.ewm(span=length, adjust=False).mean()


def _rsi(close: pd.Series, length: int) -> pd.Series:
    diff = close.diff()
    up = diff.clip(lower=0)
    down = -diff.clip(upper=0)
    avg_up = up.ewm(alpha=1 / length, adjust=False).mean()
    avg_down = down.ewm(alpha=1 / length, adjust=False).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd(close: pd.Series, fast: int, slow: int, signal: int):
    line = _ema(close, fast) - _ema(close, slow)
    sig = _ema(line, signal)
    return line, sig


def _cloud(high: pd.Series, low: pd.Series, tenkan_len: int, kijun_len: int, span_b_len: int):
    """Span A / Span B from SMAs of hl2, undisplaced (matches the Pine source)."""
    hl2 = (high + low) / 2.0
    tenkan = hl2.rolling(tenkan_len).mean()
    kijun = hl2.rolling(kijun_len).mean()
    span_a = (tenkan + kijun) / 2.0
    span_b = hl2.rolling(span_b_len).mean()
    return span_a, span_b


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class NexaStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("tenkan_length",  ParamType.INT, 9,  min=2,  max=100, step=1, group="Cloud",
                  description="Fast SMA of (high+low)/2."),
        ParamSpec("kijun_length",   ParamType.INT, 26, min=5,  max=200, step=1, group="Cloud",
                  description="Slow SMA of (high+low)/2. Averaged with Tenkan to form Span A."),
        ParamSpec("span_b_length",  ParamType.INT, 52, min=10, max=400, step=1, group="Cloud",
                  description="Span B: the slowest cloud line. Price must clear BOTH lines."),

        ParamSpec("vwma_length",    ParamType.INT, 168, min=10, max=600, step=1, group="VWMA",
                  description="Volume-weighted average; price must be on the right side of it."),

        ParamSpec("macd_fast",      ParamType.INT, 12, min=2,  max=100, step=1, group="MACD"),
        ParamSpec("macd_slow",      ParamType.INT, 26, min=5,  max=200, step=1, group="MACD"),
        ParamSpec("macd_signal",    ParamType.INT, 9,  min=2,  max=50,  step=1, group="MACD"),

        ParamSpec("use_rsi_filter", ParamType.BOOL, True, group="RSI"),
        ParamSpec("rsi_length",     ParamType.INT, 14, min=2,  max=50,  step=1, group="RSI"),
        ParamSpec("rsi_long_max",   ParamType.INT, 70, min=20, max=95,  step=1, group="RSI",
                  description="Long requires RSI BELOW this — blocks chasing an overbought bar."),
        ParamSpec("rsi_short_min",  ParamType.INT, 30, min=5,  max=80,  step=1, group="RSI",
                  description="Short requires RSI ABOVE this — blocks chasing an oversold bar."),

        ParamSpec("use_volume_filter", ParamType.BOOL, True, group="Volume"),
        ParamSpec("vol_length",     ParamType.INT, 50, min=5, max=300, step=1, group="Volume"),
        ParamSpec("vol_mult",       ParamType.FLOAT, 1.2, min=0.5, max=5.0, step=0.05, group="Volume",
                  description="Bar volume must exceed avg x this multiplier."),

        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": False}, group="Direction",
                  description="Source script ships long-only (Enable Short = false)."),

        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=20, step=1, group="Risk",
                  description="Max concurrent positions per side. The source Pine used 10; kept at 1 "
                              "here so backtest matches live (live is single-position)."),
        ParamSpec("risk_pct", ParamType.FLOAT, 20.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade (Pine: 20% of equity)."),
    ]

    META = StrategyMeta(
        id="nexa",
        name="Nexa Strategy",
        description=("Cloud + VWMA + MACD + RSI + volume confluence, converted from the Elias "
                     "Pine script. All five filters must agree to enter; exits are opposite-signal "
                     "only (no stop or target in the source)."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("vwma",   "VWMA",   from_column="vwma",   color="#fbbf24", line_width=2),
        OverlaySpec("span_a", "Span A", from_column="span_a", color="#34d399", line_width=1),
        OverlaySpec("span_b", "Span B", from_column="span_b", color="#f87171", line_width=1),
    ]

    # ---- shared condition math ----------------------------------------
    def _conditions(self, df: pd.DataFrame):
        """Returns (raw_long, raw_short, vwma, span_a, span_b) — sides NOT applied.

        Raw (ungated) conditions are what the exits key off: the Pine closes a
        long on shortCondition even when Enable Short is false.
        """
        p = self.p
        close = df["close"].astype(float)
        high = df["high"].astype(float)
        low = df["low"].astype(float)
        vol = df["volume"].astype(float) if "volume" in df.columns else pd.Series(1.0, index=df.index)

        span_a, span_b = _cloud(high, low, int(p["tenkan_length"]),
                                int(p["kijun_length"]), int(p["span_b_length"]))
        kumo_high = pd.concat([span_a, span_b], axis=1).max(axis=1)
        kumo_low = pd.concat([span_a, span_b], axis=1).min(axis=1)

        vwma = _vwma(close, vol, int(p["vwma_length"]))
        macd_line, macd_sig = _macd(close, int(p["macd_fast"]), int(p["macd_slow"]), int(p["macd_signal"]))
        rsi = _rsi(close, int(p["rsi_length"]))
        vol_avg = vol.rolling(int(p["vol_length"])).mean()

        if bool(p["use_rsi_filter"]):
            rsi_long_ok = rsi < float(p["rsi_long_max"])
            rsi_short_ok = rsi > float(p["rsi_short_min"])
        else:
            rsi_long_ok = pd.Series(True, index=df.index)
            rsi_short_ok = pd.Series(True, index=df.index)

        if bool(p["use_volume_filter"]):
            vol_ok = vol > vol_avg * float(p["vol_mult"])
        else:
            vol_ok = pd.Series(True, index=df.index)

        # Only act once every input is warmed up, so a NaN never reads as False
        # and quietly changes the signal.
        valid = (span_a.notna() & span_b.notna() & vwma.notna() & macd_sig.notna()
                 & rsi.notna() & vol_avg.notna())

        raw_long = (valid & (close > kumo_high) & (close > vwma)
                    & (macd_line > macd_sig) & rsi_long_ok & vol_ok)
        raw_short = (valid & (close < kumo_low) & (close < vwma)
                     & (macd_line < macd_sig) & rsi_short_ok & vol_ok)

        raw_long = raw_long.fillna(False).astype(bool)
        raw_short = raw_short.fillna(False).astype(bool)
        return raw_long, raw_short, vwma, span_a, span_b

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        raw_long, raw_short, vwma, span_a, span_b = self._conditions(out)

        sides = self.p["sides"]
        cond_long = raw_long if sides.get("long") else pd.Series(False, index=out.index)
        cond_short = raw_short if sides.get("short") else pd.Series(False, index=out.index)

        n = len(out)
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)

        lc = cond_long.to_numpy()
        sc = cond_short.to_numpy()
        rl = raw_long.to_numpy()
        rs = raw_short.to_numpy()

        pos = 0
        for t in range(n):
            if pos == 0:
                if lc[t]:
                    pos = 1
                    entry_long[t] = True
                elif sc[t]:
                    pos = -1
                    entry_short[t] = True
            elif pos == 1:
                if rs[t]:
                    exit_long[t] = True
                    pos = 0
                    if sc[t]:            # flip on the same bar
                        pos = -1
                        entry_short[t] = True
            else:  # pos == -1
                if rl[t]:
                    exit_short[t] = True
                    pos = 0
                    if lc[t]:
                        pos = 1
                        entry_long[t] = True

        out["entry_long"] = entry_long
        out["entry_short"] = entry_short
        out["exit_long"] = exit_long
        out["exit_short"] = exit_short
        out["stop_price"] = np.full(n, np.nan)
        out["vwma"] = vwma
        out["span_a"] = span_a
        out["span_b"] = span_b

        # Raw per-bar conditions for the pyramiding-capable engines. Exits are
        # the ungated opposite condition, matching the Pine.
        out["cond_long"] = cond_long.fillna(False).astype(bool)
        out["cond_short"] = cond_short.fillna(False).astype(bool)
        out["bar_exit_long"] = raw_short
        out["bar_exit_short"] = raw_long
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        warmup = max(int(p["span_b_length"]), int(p["vwma_length"]), int(p["vol_length"]),
                     int(p["macd_slow"]) + int(p["macd_signal"]), int(p["rsi_length"])) * 4

        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low": float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < warmup:
            return None

        df = pd.DataFrame(buf)
        raw_long, raw_short, _, _, _ = self._conditions(df)
        rl = bool(raw_long.iloc[-1])
        rs = bool(raw_short.iloc[-1])

        c = float(df["close"].iloc[-1])
        ts = int(df["time"].iloc[-1])
        sides = p["sides"]
        pos = state.get("pos", 0)

        if pos == 1 and rs:
            state["pos"] = 0
            return Signal(side="long", kind="exit", price=c, time=ts, reason="opposite_signal")
        if pos == -1 and rl:
            state["pos"] = 0
            return Signal(side="short", kind="exit", price=c, time=ts, reason="opposite_signal")
        if pos == 0:
            if sides.get("long") and rl:
                state["pos"] = 1
                return Signal(side="long", kind="entry", price=c, time=ts, reason="confluence_long")
            if sides.get("short") and rs:
                state["pos"] = -1
                return Signal(side="short", kind="entry", price=c, time=ts, reason="confluence_short")
        return None
