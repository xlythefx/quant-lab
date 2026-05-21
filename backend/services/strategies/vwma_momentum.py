"""
VWMA Momentum — trend-following with optional volume / RSI / session gates.

Long when close > VWMA AND slope > 0 AND filters pass.
Short when close < VWMA AND slope < 0 AND filters pass.
Exits when momentum stalls (close crosses VWMA against the direction with
slope flipping). Optional flip-into-opposite if the other-side condition
also fires on the exit bar.

Self-contained: VWMA, RSI, session math all inline.
"""
from __future__ import annotations

from datetime import time as dt_time, datetime, timezone
from typing import Optional
import re

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)

_HHMM_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


def _parse_hhmm(s: str) -> dt_time:
    m = _HHMM_RE.match((s or "").strip())
    if not m:
        return dt_time(0, 0)
    return dt_time(min(23, int(m.group(1))), min(59, int(m.group(2))))


def _in_window(t: dt_time, win: tuple[dt_time, dt_time]) -> bool:
    s, e = win
    if s <= e:
        return s <= t < e
    return t >= s or t < e   # wraps midnight


def _session_mask(times_utc: pd.Series, sessions: dict) -> pd.Series:
    if not sessions:
        return pd.Series(False, index=times_utc.index)
    enabled = []
    for cfg in sessions.values():
        if not cfg or not cfg.get("enabled"):
            continue
        enabled.append((_parse_hhmm(cfg.get("start", "00:00")),
                        _parse_hhmm(cfg.get("end",   "00:00"))))
    if not enabled:
        return pd.Series(False, index=times_utc.index)
    tod = times_utc.dt.time
    mask = pd.Series(False, index=times_utc.index)
    for win in enabled:
        mask = mask | tod.apply(lambda t: _in_window(t, win))
    return mask


# ---------------------------------------------------------------------------
# Indicators (self-contained)
# ---------------------------------------------------------------------------

def _vwma(close: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    pv = (close * volume).rolling(length).sum()
    vsum = volume.rolling(length).sum().replace(0, np.nan)
    return pv / vsum


def _rsi(close: pd.Series, length: int) -> pd.Series:
    diff = close.diff()
    up = diff.clip(lower=0)
    down = -diff.clip(upper=0)
    avg_up = up.ewm(alpha=1 / length, adjust=False).mean()
    avg_down = down.ewm(alpha=1 / length, adjust=False).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class VwmaMomentumStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("vwma_length",        ParamType.INT,   75,   min=10, max=300, step=1, group="VWMA"),
        ParamSpec("use_rsi_filter",     ParamType.BOOL,  True,                          group="RSI"),
        ParamSpec("rsi_length",         ParamType.INT,   14,   min=5,  max=50,  step=1, group="RSI"),
        ParamSpec("rsi_long_min",       ParamType.INT,   40,   min=10, max=80,  step=1, group="RSI",
                  description="Long requires RSI above this floor."),
        ParamSpec("rsi_short_max",      ParamType.INT,   60,   min=20, max=90,  step=1, group="RSI",
                  description="Short requires RSI below this ceiling."),
        ParamSpec("use_volume_filter",  ParamType.BOOL,  True,                          group="Volume"),
        ParamSpec("vol_length",         ParamType.INT,   45,   min=5,  max=200, step=1, group="Volume"),
        ParamSpec("vol_mult",           ParamType.FLOAT, 1.05, min=0.5, max=5.0, step=0.05, group="Volume",
                  description="Bar volume must exceed avg × this multiplier."),
        ParamSpec("trade_24_7", ParamType.BOOL, False, group="Sessions",
                  description="Trade any time of day; the session windows below are ignored."),
        ParamSpec("sessions", ParamType.SESSIONS,
                  {
                    "tokyo":  {"enabled": True,  "start": "00:00", "end": "04:00"},
                    "london": {"enabled": True,  "start": "05:00", "end": "09:00"},
                    "ny_am":  {"enabled": True,  "start": "12:30", "end": "16:00"},
                    "ny_pm":  {"enabled": False, "start": "17:00", "end": "20:00"},
                  },
                  group="Sessions",
                  description="UTC session windows where new entries are allowed."),
        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": True},
                  group="Direction"),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=20, step=1, group="Risk",
                  description="Max concurrent positions per side. Each tranche is sized at the strategy's Risk%. Set to 1 to disable stacking."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade. Notional = equity × risk_pct ÷ entry_price."),
    ]

    META = StrategyMeta(
        id="vwma_momentum",
        name="VWMA Momentum",
        description=("Trend-follow VWMA with optional volume confirmation and RSI gate. "
                     "Exits when momentum stalls (close crosses VWMA with opposite slope)."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("vwma", "VWMA", from_column="vwma", color="#fbbf24", line_width=2),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        vol = out["volume"].astype(float) if "volume" in out.columns else pd.Series(1.0, index=out.index)

        vwma = _vwma(close, vol, int(p["vwma_length"]))
        slope = vwma - vwma.shift(1)
        rsi = _rsi(close, int(p["rsi_length"]))
        vol_avg = vol.rolling(int(p["vol_length"])).mean()

        ts_for_mask = pd.to_datetime(out["time"], unit="s", utc=True)
        ts_for_mask.index = out.index
        if bool(p.get("trade_24_7")):
            in_session = pd.Series(True, index=out.index)
        else:
            in_session = _session_mask(ts_for_mask, p["sessions"])

        if bool(p["use_rsi_filter"]):
            rsi_long_ok  = rsi > float(p["rsi_long_min"])
            rsi_short_ok = rsi < float(p["rsi_short_max"])
        else:
            rsi_long_ok  = pd.Series(True, index=out.index)
            rsi_short_ok = pd.Series(True, index=out.index)

        if bool(p["use_volume_filter"]):
            vol_ok = vol > vol_avg * float(p["vol_mult"])
        else:
            vol_ok = pd.Series(True, index=out.index)

        trend_up   = (close > vwma) & (slope > 0)
        trend_down = (close < vwma) & (slope < 0)

        sides = p["sides"]
        long_cond  = (in_session & trend_up   & rsi_long_ok  & vol_ok) if sides.get("long")  else pd.Series(False, index=out.index)
        short_cond = (in_session & trend_down & rsi_short_ok & vol_ok) if sides.get("short") else pd.Series(False, index=out.index)

        # Walk-forward: exits when momentum flips against position.
        n = len(out)
        entry_long  = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long   = np.zeros(n, dtype=bool)
        exit_short  = np.zeros(n, dtype=bool)
        stop_price  = np.full(n, np.nan)

        close_a = close.to_numpy()
        vwma_a  = vwma.to_numpy()
        slope_a = slope.to_numpy()
        lc      = long_cond.to_numpy()
        sc      = short_cond.to_numpy()

        pos = 0
        for t in range(n):
            c = close_a[t]; vw = vwma_a[t]; sl = slope_a[t]
            if not (np.isfinite(c) and np.isfinite(vw) and np.isfinite(sl)):
                continue
            if pos == 0:
                if lc[t]:
                    pos = 1
                    entry_long[t] = True
                elif sc[t]:
                    pos = -1
                    entry_short[t] = True
            elif pos == 1:
                # exit long when close < vwma and slope < 0
                if c < vw and sl < 0:
                    exit_long[t] = True
                    pos = 0
                    # opportunity to flip on same bar
                    if sc[t]:
                        pos = -1
                        entry_short[t] = True
            else:  # pos == -1
                if c > vw and sl > 0:
                    exit_short[t] = True
                    pos = 0
                    if lc[t]:
                        pos = 1
                        entry_long[t] = True

        out["entry_long"]  = entry_long
        out["entry_short"] = entry_short
        out["exit_long"]   = exit_long
        out["exit_short"]  = exit_short
        out["stop_price"]  = stop_price
        out["vwma"]        = vwma

        # Raw per-bar conditions used by the pyramiding-capable backtest
        # engine. The state-machine columns above stay for one-shot consumers
        # and any callers still relying on edge-triggered semantics.
        # bar_exit_* mirror the in-loop FSM exit checks but are stateless,
        # which is what the tranche-based engine needs.
        exit_long_cond  = (close < vwma) & (slope < 0)
        exit_short_cond = (close > vwma) & (slope > 0)
        out["cond_long"]      = long_cond.fillna(False).astype(bool)
        out["cond_short"]     = short_cond.fillna(False).astype(bool)
        out["bar_exit_long"]  = exit_long_cond.fillna(False).astype(bool)
        out["bar_exit_short"] = exit_short_cond.fillna(False).astype(bool)
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        warmup = max(int(p["vwma_length"]), int(p["rsi_length"]), int(p["vol_length"])) * 4
        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low":  float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < warmup:
            return None

        df = pd.DataFrame(buf)
        close = df["close"]; high = df["high"]; low = df["low"]; vol = df["volume"]
        vwma = _vwma(close, vol, int(p["vwma_length"]))
        slope = vwma - vwma.shift(1)
        rsi = _rsi(close, int(p["rsi_length"]))
        vol_avg = vol.rolling(int(p["vol_length"])).mean()

        c = float(close.iloc[-1]); vw = float(vwma.iloc[-1]); sl = float(slope.iloc[-1])
        if not (np.isfinite(c) and np.isfinite(vw) and np.isfinite(sl)):
            return None
        ts = int(df["time"].iloc[-1])

        if bool(p.get("trade_24_7")):
            in_sess = True
        else:
            utc = datetime.fromtimestamp(ts, tz=timezone.utc).time()
            in_sess = False
            for cfg in (p["sessions"] or {}).values():
                if not cfg or not cfg.get("enabled"):
                    continue
                if _in_window(utc, (_parse_hhmm(cfg.get("start", "00:00")), _parse_hhmm(cfg.get("end", "00:00")))):
                    in_sess = True
                    break

        rsi_v = float(rsi.iloc[-1])
        v = float(vol.iloc[-1]); va = float(vol_avg.iloc[-1]) if np.isfinite(vol_avg.iloc[-1]) else 0.0

        rsi_long_ok  = (not bool(p["use_rsi_filter"])) or (rsi_v > float(p["rsi_long_min"]))
        rsi_short_ok = (not bool(p["use_rsi_filter"])) or (rsi_v < float(p["rsi_short_max"]))
        vol_ok = (not bool(p["use_volume_filter"])) or (v > va * float(p["vol_mult"]))

        sides = p["sides"]
        pos = state.get("pos", 0)
        if pos == 0 and in_sess:
            if sides.get("long") and c > vw and sl > 0 and rsi_long_ok and vol_ok:
                state["pos"] = 1
                return Signal(side="long", kind="entry", price=c, time=ts, reason="vwma_up")
            if sides.get("short") and c < vw and sl < 0 and rsi_short_ok and vol_ok:
                state["pos"] = -1
                return Signal(side="short", kind="entry", price=c, time=ts, reason="vwma_down")
            return None
        if pos == 1 and c < vw and sl < 0:
            state["pos"] = 0
            return Signal(side="long", kind="exit", price=c, time=ts, reason="vwma_flip")
        if pos == -1 and c > vw and sl > 0:
            state["pos"] = 0
            return Signal(side="short", kind="exit", price=c, time=ts, reason="vwma_flip")
        return None
