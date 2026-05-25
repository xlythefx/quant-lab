"""
VWMA Reversion — z-score mean reversion around the volume-weighted moving
average, gated by RSI bands and UTC session windows. ATR stop-loss.

Self-contained: all indicator math (VWMA, RSI, ATR, z-score, sessions)
implemented with numpy/pandas in this file. No shared feature library.
"""
from __future__ import annotations

from datetime import time as dt_time, datetime, timezone
import re
from typing import Optional

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


# ---------------------------------------------------------------------------
# Self-contained indicators
# ---------------------------------------------------------------------------

def _vwma(close: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    pv = (close * volume).rolling(length).sum()
    vsum = volume.rolling(length).sum().replace(0, np.nan)
    return pv / vsum


def _rsi(close: pd.Series, length: int) -> pd.Series:
    diff = close.diff()
    up = diff.clip(lower=0)
    down = -diff.clip(upper=0)
    # Wilder's smoothing
    avg_up = up.ewm(alpha=1 / length, adjust=False).mean()
    avg_down = down.ewm(alpha=1 / length, adjust=False).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / length, adjust=False).mean()


def _in_window(t: dt_time, win: tuple[dt_time, dt_time]) -> bool:
    s, e = win
    if s <= e:
        return s <= t < e
    # wraps midnight
    return t >= s or t < e


def _session_mask(times_utc: pd.Series, sessions: dict) -> pd.Series:
    """times_utc is a Series of pandas Timestamps (UTC). Returns bool mask.
    sessions value: {name: {enabled, start, end}} where start/end are 'HH:MM'."""
    if not sessions:
        return pd.Series(False, index=times_utc.index)
    enabled = []
    for name, cfg in sessions.items():
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
# Strategy
# ---------------------------------------------------------------------------

class VwmaReversionStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("vwma_length",  ParamType.INT,   30,  min=5,  max=200, step=1, group="VWMA"),
        ParamSpec("z_threshold",  ParamType.FLOAT, 1.5, min=0.5, max=4.0, step=0.1, group="VWMA"),
        ParamSpec("rsi_length",   ParamType.INT,   25,  min=5,  max=50,  step=1, group="RSI"),
        ParamSpec("rsi_long_max", ParamType.INT,   35,  min=25, max=40,  step=1, group="RSI"),
        ParamSpec("rsi_short_min",ParamType.INT,   65,  min=60, max=75,  step=1, group="RSI"),
        ParamSpec("atr_stop",     ParamType.BOOL,  True, group="Stop",
                  description="Use ATR-based stop loss. Turn off to exit only on mean reversion."),
        ParamSpec("atr_length",   ParamType.INT,   10,  min=5,  max=50,  step=1, group="Stop"),
        ParamSpec("atr_mult",     ParamType.FLOAT, 6.0, min=1,  max=20,  step=0.5, group="Stop"),
        ParamSpec("trade_24_7", ParamType.BOOL, False, group="Sessions",
                  description="Trade any time of day; the session windows below are ignored."),
        ParamSpec("sessions", ParamType.SESSIONS,
                  {
                    "tokyo":  {"enabled": True,  "start": "00:00", "end": "04:00"},
                    "london": {"enabled": True,  "start": "05:00", "end": "12:30"},
                    "ny_am":  {"enabled": True,  "start": "12:30", "end": "16:00"},
                    "ny_pm":  {"enabled": False, "start": "17:00", "end": "20:00"},
                  },
                  group="Sessions",
                  description="UTC session windows where new entries are allowed. "
                              "Edit start/end per session as needed."),
        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": True},
                  group="Direction"),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=20, step=1, group="Risk",
                  description="Max concurrent positions per side. Each tranche is sized at the strategy's Risk%. Set to 1 to disable stacking."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade. Notional = equity × risk_pct ÷ entry_price."),
    ]

    META = StrategyMeta(
        id="vwma_reversion",
        name="VWMA Reversion",
        description=("Z-score mean reversion around VWMA, RSI filter, ATR stop-loss, "
                     "UTC session gating. Long when oversold near band, short when overbought."),
        schema=PARAM_SCHEMA,
    )

    SYMBOL_DEFAULTS = {
        "LTCUSDT": {
            "vwma_length": 23,
            "rsi_length":  15,
            "sides":       {"long": True, "short": False},
            "sessions":    {"ny_pm": {"enabled": False}},
        },
    }

    OVERLAYS = [
        OverlaySpec("vwma",  "VWMA",  from_column="vwma",       color="#fbbf24", line_width=2),
        OverlaySpec("upper", "+z·σ",  from_column="upper_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
        OverlaySpec("lower", "-z·σ",  from_column="lower_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        vol = out["volume"].astype(float) if "volume" in out.columns else pd.Series(1.0, index=out.index)

        mean = _vwma(close, vol, p["vwma_length"])
        # ddof=0 (population) — matches TradingView's ta.stdev() and is the
        # right formula when the rolling window IS the distribution, not a
        # sample of one.
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        ts_for_mask = pd.to_datetime(out["time"], unit="s", utc=True)
        ts_for_mask.index = out.index
        if bool(p.get("trade_24_7")):
            in_session = pd.Series(True, index=out.index)
        else:
            in_session = _session_mask(ts_for_mask, p["sessions"])

        sides = p["sides"]
        if sides.get("long"):
            long_cond = in_session & (zscore < -p["z_threshold"]) & (rsi < p["rsi_long_max"])
        else:
            long_cond = pd.Series(False, index=out.index)
        if sides.get("short"):
            short_cond = in_session & (zscore > p["z_threshold"]) & (rsi > p["rsi_short_min"])
        else:
            short_cond = pd.Series(False, index=out.index)

        # Walk forward to compute entries / exits respecting position state.
        n = len(out)
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)

        mean_a = mean.to_numpy()
        close_a = close.to_numpy()
        atr_a = atr.to_numpy()
        ins = in_session.to_numpy()
        lc = long_cond.to_numpy()
        sc = short_cond.to_numpy()

        pos = 0           # 0 flat, 1 long, -1 short
        entry_p = np.nan
        atr_at_entry = np.nan

        for t in range(n):
            m = mean_a[t]
            c = close_a[t]
            if not np.isfinite(m):
                continue

            if pos == 0:
                if ins[t]:
                    if lc[t]:
                        pos = 1
                        entry_p = c
                        atr_at_entry = atr_a[t] if np.isfinite(atr_a[t]) else np.nan
                        entry_long[t] = True
                        if np.isfinite(atr_at_entry):
                            stop_price[t] = entry_p - p["atr_mult"] * atr_at_entry
                    elif sc[t]:
                        pos = -1
                        entry_p = c
                        atr_at_entry = atr_a[t] if np.isfinite(atr_a[t]) else np.nan
                        entry_short[t] = True
                        if np.isfinite(atr_at_entry):
                            stop_price[t] = entry_p + p["atr_mult"] * atr_at_entry
            elif pos == 1:
                stop_hit = (np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                            and c <= entry_p - p["atr_mult"] * atr_at_entry)
                if c >= m or stop_hit:
                    exit_long[t] = True
                    pos = 0
                    entry_p = np.nan
                    atr_at_entry = np.nan
            else:  # pos == -1
                stop_hit = (np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                            and c >= entry_p + p["atr_mult"] * atr_at_entry)
                if c <= m or stop_hit:
                    exit_short[t] = True
                    pos = 0
                    entry_p = np.nan
                    atr_at_entry = np.nan

        out["entry_long"] = entry_long
        out["entry_short"] = entry_short
        out["exit_long"] = exit_long
        out["exit_short"] = exit_short
        out["stop_price"] = stop_price
        # Raw per-bar conditions for the engine's pyramiding/MTM path.
        # cond_*: bar-level entry condition independent of position state.
        # bar_exit_*: bar-level mean-revert exit (price crossed back through VWMA).
        # atr: per-bar ATR for per-tranche stop calculation in the engine.
        out["cond_long"]      = long_cond.fillna(False).astype(bool)
        out["cond_short"]     = short_cond.fillna(False).astype(bool)
        out["bar_exit_long"]  = (close >= mean).fillna(False).astype(bool)
        out["bar_exit_short"] = (close <= mean).fillna(False).astype(bool)
        # Emit atr only when the stop is enabled. The engine gates ATR-stop
        # logic on "atr" column presence, so omitting it cleanly disables it.
        if bool(p.get("atr_stop", True)):
            out["atr"] = atr
        # Overlay columns referenced by OVERLAYS:
        out["vwma"] = mean
        out["upper_band"] = mean + std * p["z_threshold"]
        out["lower_band"] = mean - std * p["z_threshold"]
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """
        State keys we maintain:
          buf:        list of recent {time,o,h,l,c,v} dicts (len <= warmup)
          pos:        0 / 1 / -1
          entry_p:    float
          atr_at_entry: float

        NOTE: Single-position only. The backtest engine supports pyramiding
        (see backtest_engine.py — tranches list), but this live path holds
        at most one position at a time. If you trade live with pyramiding>1
        in risk_config, live behavior will NOT match the backtest equity
        curve. Extend `state` to a tranches list to align them.
        """
        if not bool(candle.get("isClosed", False)):
            return None  # only act on closed bars

        p = self.p
        warmup = max(p["vwma_length"], p["rsi_length"], p["atr_length"]) * 4
        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low": float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        # keep only what we need
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < warmup:
            return None  # not enough data yet

        df = pd.DataFrame(buf)
        close = df["close"]
        high = df["high"]
        low = df["low"]
        vol = df["volume"]

        mean = _vwma(close, vol, p["vwma_length"])
        # ddof=0 (population) — matches TradingView's ta.stdev() and is the
        # right formula when the rolling window IS the distribution, not a
        # sample of one.
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        m = float(mean.iloc[-1]) if np.isfinite(mean.iloc[-1]) else np.nan
        if not np.isfinite(m):
            return None
        c = float(close.iloc[-1])
        z = float(zscore.iloc[-1])
        r = float(rsi.iloc[-1])
        a = float(atr.iloc[-1]) if np.isfinite(atr.iloc[-1]) else np.nan
        ts = int(df["time"].iloc[-1])

        # session gate
        if bool(p.get("trade_24_7")):
            in_sess = True
        else:
            utc = datetime.fromtimestamp(ts, tz=timezone.utc).time()
            in_sess = False
            for cfg in (p["sessions"] or {}).values():
                if not cfg or not cfg.get("enabled"):
                    continue
                win = (_parse_hhmm(cfg.get("start", "00:00")), _parse_hhmm(cfg.get("end", "00:00")))
                if _in_window(utc, win):
                    in_sess = True
                    break

        pos = state.get("pos", 0)
        entry_p = state.get("entry_p", np.nan)
        atr_at_entry = state.get("atr_at_entry", np.nan)
        sides = p["sides"]

        if pos == 0:
            if not in_sess:
                return None
            if sides.get("long") and z < -p["z_threshold"] and r < p["rsi_long_max"]:
                state["pos"] = 1
                state["entry_p"] = c
                state["atr_at_entry"] = a
                return Signal(side="long", kind="entry", price=c, time=ts, reason="z_long")
            if sides.get("short") and z > p["z_threshold"] and r > p["rsi_short_min"]:
                state["pos"] = -1
                state["entry_p"] = c
                state["atr_at_entry"] = a
                return Signal(side="short", kind="entry", price=c, time=ts, reason="z_short")
            return None

        atr_on = bool(p.get("atr_stop", True))
        if pos == 1:
            stop_hit = (atr_on and np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                        and c <= entry_p - p["atr_mult"] * atr_at_entry)
            if c >= m or stop_hit:
                state["pos"] = 0
                state["entry_p"] = np.nan
                state["atr_at_entry"] = np.nan
                return Signal(side="long", kind="exit", price=c, time=ts,
                              reason="atr_stop" if stop_hit else "z_revert")
            return None

        # pos == -1
        stop_hit = (atr_on and np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                    and c >= entry_p + p["atr_mult"] * atr_at_entry)
        if c <= m or stop_hit:
            state["pos"] = 0
            state["entry_p"] = np.nan
            state["atr_at_entry"] = np.nan
            return Signal(side="short", kind="exit", price=c, time=ts,
                          reason="atr_stop" if stop_hit else "z_revert")
        return None
