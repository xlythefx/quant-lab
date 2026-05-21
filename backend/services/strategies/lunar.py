"""
Lunar — Multiday moon-cycle bias engine.

Port of a MultiCharts/TradeStation strategy ("Bias - Multiday - Moon
Cycle Engine QTLab") that uses the synodic lunar phase as the directional
bias. Long entries fire on local Phase-peak windows (full/new moon at the
mid-lag bar), short entries fire on Phase-trough windows gated by rising
ATR. Exits: regular phase-flip (LX / SX in the original), max-bars-since-
entry timer, percent stop loss, percent profit target, and a breakeven
stop after a favorable move.

The original used $-based stops sized for ES futures ($50/pt: $1750 SL,
$3250 TP). This port replaces them with percent-based stops so the same
logic works on any symbol. One entry per UTC day is enforced to match
the original's `entriestoday(d) < 1` gate.

The Phase formula and the offset 0.4137 are preserved verbatim:
  Phase = |2 * (frac(julian(date+2)/29.53059 + 0.4137) - 0.5)|
Phase peaks at full AND new moons (~1) and troughs at quarter moons (~0).
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)

# Unix epoch (1970-01-01 00:00 UTC) expressed as a Julian Day.
_UNIX_EPOCH_JD = 2440587.5
# Synodic month length in days (the original used this exact constant).
_LUNAR_PERIOD = 29.53059
# Calibration offset from the original script — aligns Phase=1 at full/new
# moons and Phase=0 at quarter moons. Don't tweak unless rebasing the cycle.
_PHASE_OFFSET = 0.4137


def _moon_phase(times_s: pd.Series) -> pd.Series:
    """Synodic moon-phase in [0, 1]. Peaks (~1) at full AND new moons,
    troughs (~0) at quarter moons. The +2 day lookahead matches the
    original `DateToJulian(Date+2)`."""
    julian = times_s / 86400.0 + _UNIX_EPOCH_JD + 2.0
    raw = julian / _LUNAR_PERIOD + _PHASE_OFFSET
    frac = raw - np.floor(raw)
    return (2.0 * (frac - 0.5)).abs()


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    prev = close.shift(1)
    tr = pd.concat([
        (high - low).abs(),
        (high - prev).abs(),
        (low - prev).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / length, adjust=False).mean()


class LunarStrategy(Strategy):
    PARAM_SCHEMA = [
        # Phase windowing — defaults mirror the TradeStation [1] / [35] / [65]
        # triplet. The mid-lag bar is the "extremum" we look for; near and far
        # lags bracket it to form a local peak / trough test.
        ParamSpec("phase_lag_near", ParamType.INT, 1,  min=1,  max=30,  step=1, group="Phase",
                  description="Near lag in bars (TS default 1 — prior bar)."),
        ParamSpec("phase_lag_mid",  ParamType.INT, 35, min=5,  max=120, step=1, group="Phase",
                  description="Mid lag in bars — the suspected extremum (TS default 35)."),
        ParamSpec("phase_lag_far",  ParamType.INT, 65, min=10, max=240, step=1, group="Phase",
                  description="Far lag in bars (TS default 65)."),

        # Short-side volatility filter: ATR must be rising.
        ParamSpec("atr_period",      ParamType.INT,   11,  min=2,   max=60,  step=1,    group="ATR Filter",
                  description="ATR window for the short-entry rising-vol filter."),
        ParamSpec("atr_rising_mult", ParamType.FLOAT, 1.0, min=0.5, max=3.0, step=0.05, group="ATR Filter",
                  description="Short requires ATR > prior ATR × this multiplier (TS used 1.0)."),

        # Exits — percent-based ports of the original $1750 / $3250 / BE / maxbars.
        ParamSpec("n_bars_exit", ParamType.INT,   345, min=10,  max=2000, step=1,   group="Exits",
                  description="Force-close after this many bars since entry (TS maxbars)."),
        ParamSpec("stop_pct",    ParamType.FLOAT, 0.7, min=0.05, max=10.0, step=0.05, group="Exits",
                  description="Stop loss as % of entry price. Original $1750 on ES≈0.7%."),
        ParamSpec("target_pct",  ParamType.FLOAT, 1.3, min=0.1,  max=20.0, step=0.05, group="Exits",
                  description="Profit target as % of entry price. Original $3250 on ES≈1.3%."),
        ParamSpec("breakeven_trigger_pct", ParamType.FLOAT, 0.7, min=0.05, max=10.0, step=0.05, group="Exits",
                  description="Arm breakeven after favorable excursion ≥ this % of entry price."),
        ParamSpec("breakeven_offset_pct",  ParamType.FLOAT, 0.04, min=0.0, max=2.0,  step=0.01, group="Exits",
                  description="Offset above (long) / below (short) entry for the breakeven stop."),

        ParamSpec("one_entry_per_day", ParamType.BOOL, True, group="Entries",
                  description="Cap entries to 1 per UTC day, matching TS `entriestoday(d) < 1`."),

        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": True},
                  group="Direction"),

        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade. Notional = equity × risk_pct ÷ entry_price."),
    ]

    META = StrategyMeta(
        id="lunar",
        name="Lunar (Moon Cycle Bias)",
        description=("Multiday moon-cycle bias engine. Long on Phase-peak windows "
                     "(full/new moon at the mid-lag bar), short on Phase-trough "
                     "windows with rising-ATR confirmation. Exits: phase-flip, "
                     "max-bars timer, percent stop/target, and breakeven."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        # Phase oscillates 0..1 — it won't visually align with price, but it's
        # useful as a diagnostic line on a secondary panel / scaled view.
        OverlaySpec("moon_phase", "Moon Phase", from_column="phase",
                    color="rgba(192,180,255,0.55)", line_width=1),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        high  = out["high"].astype(float)
        low   = out["low"].astype(float)
        open_ = out["open"].astype(float)
        time  = out["time"].astype(float)

        phase = _moon_phase(time)
        atr   = _atr(high, low, close, int(p["atr_period"]))

        ln = int(p["phase_lag_near"])
        lm = int(p["phase_lag_mid"])
        lf = int(p["phase_lag_far"])
        p_near = phase.shift(ln)
        p_mid  = phase.shift(lm)
        p_far  = phase.shift(lf)

        peak_window   = (p_near < p_mid) & (p_mid > p_far)  # LE / SX trigger
        trough_window = (p_near > p_mid) & (p_mid < p_far)  # SE / LX trigger
        atr_rising = atr > atr.shift(1) * float(p["atr_rising_mult"])

        sides = p["sides"]
        wle_arr  = (peak_window  if sides.get("long")  else pd.Series(False, index=out.index)).fillna(False).to_numpy()
        wse_arr  = ((trough_window & atr_rising) if sides.get("short") else pd.Series(False, index=out.index)).fillna(False).to_numpy()
        pel_arr  = trough_window.fillna(False).to_numpy()   # long  exit on phase trough
        pes_arr  = peak_window.fillna(False).to_numpy()     # short exit on phase peak

        n = len(out)
        cond_long      = np.zeros(n, dtype=bool)
        cond_short     = np.zeros(n, dtype=bool)
        bar_exit_long  = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)

        close_a = close.to_numpy()
        high_a  = high.to_numpy()
        low_a   = low.to_numpy()
        open_a  = open_.to_numpy()
        time_a  = time.to_numpy()

        stop_pct    = float(p["stop_pct"])              / 100.0
        target_pct  = float(p["target_pct"])            / 100.0
        be_trig_pct = float(p["breakeven_trigger_pct"]) / 100.0
        be_off_pct  = float(p["breakeven_offset_pct"])  / 100.0
        max_bars    = int(p["n_bars_exit"])
        one_per_day = bool(p.get("one_entry_per_day", True))

        # Internal single-position walk-forward — the engine sizes/tracks
        # tranches; this just emits entry/exit timing. The simulated
        # entry_price uses the NEXT bar's open (which is the engine's actual
        # fill bar) so percent stops/targets line up with the engine's fills.
        pos = 0
        entry_price = np.nan
        entry_idx   = -1     # bar index of the engine's fill bar
        mfe_price   = np.nan
        last_entry_day: Optional[int] = None

        for t in range(n):
            ts  = int(time_a[t])
            c   = close_a[t]
            h   = high_a[t]
            l   = low_a[t]
            day = ts // 86400

            if pos != 0 and np.isfinite(entry_price):
                # update MFE using the current bar's range
                if pos == 1:
                    if h > mfe_price:
                        mfe_price = float(h)
                else:
                    if l < mfe_price:
                        mfe_price = float(l)

                exit_now = False
                if pos == 1:
                    stop_lvl = entry_price * (1.0 - stop_pct)
                    tgt_lvl  = entry_price * (1.0 + target_pct)
                    if   c <= stop_lvl:                  exit_now = True
                    elif c >= tgt_lvl:                   exit_now = True
                    elif pel_arr[t]:                     exit_now = True
                    elif (t - entry_idx) >= max_bars:    exit_now = True
                    elif (mfe_price / entry_price - 1.0) >= be_trig_pct:
                        be_lvl = entry_price * (1.0 + be_off_pct)
                        if c <= be_lvl:                  exit_now = True
                    if exit_now:
                        bar_exit_long[t] = True
                        pos = 0
                        entry_price = np.nan
                        entry_idx   = -1
                        mfe_price   = np.nan
                else:  # pos == -1
                    stop_lvl = entry_price * (1.0 + stop_pct)
                    tgt_lvl  = entry_price * (1.0 - target_pct)
                    if   c >= stop_lvl:                  exit_now = True
                    elif c <= tgt_lvl:                   exit_now = True
                    elif pes_arr[t]:                     exit_now = True
                    elif (t - entry_idx) >= max_bars:    exit_now = True
                    elif (1.0 - mfe_price / entry_price) >= be_trig_pct:
                        be_lvl = entry_price * (1.0 - be_off_pct)
                        if c >= be_lvl:                  exit_now = True
                    if exit_now:
                        bar_exit_short[t] = True
                        pos = 0
                        entry_price = np.nan
                        entry_idx   = -1
                        mfe_price   = np.nan

            # Entries — only when flat, only once per UTC day (if gated).
            if pos == 0:
                if one_per_day and last_entry_day == day:
                    continue
                # Need next bar to model the engine's actual fill price.
                if t + 1 >= n:
                    continue
                next_open = float(open_a[t + 1])
                if wle_arr[t]:
                    cond_long[t] = True
                    pos = 1
                    entry_price = next_open
                    entry_idx   = t + 1
                    mfe_price   = next_open
                    last_entry_day = day
                elif wse_arr[t]:
                    cond_short[t] = True
                    pos = -1
                    entry_price = next_open
                    entry_idx   = t + 1
                    mfe_price   = next_open
                    last_entry_day = day

        # Provide both the new (cond_*/bar_exit_*) and legacy (entry_*/exit_*)
        # column names so the engine picks them up regardless of which path
        # it takes.
        out["cond_long"]      = cond_long
        out["cond_short"]     = cond_short
        out["bar_exit_long"]  = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        out["entry_long"]     = cond_long
        out["entry_short"]    = cond_short
        out["exit_long"]      = bar_exit_long
        out["exit_short"]     = bar_exit_short
        out["stop_price"]     = np.full(n, np.nan)
        out["phase"]          = phase
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        warmup = max(int(p["phase_lag_far"]) + 10, int(p["atr_period"]) * 4)

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
        close = df["close"]; high = df["high"]; low = df["low"]
        time_s = df["time"].astype(float)
        phase = _moon_phase(time_s)
        atr   = _atr(high, low, close, int(p["atr_period"]))

        ln = int(p["phase_lag_near"]); lm = int(p["phase_lag_mid"]); lf = int(p["phase_lag_far"])
        if len(phase) <= lf:
            return None
        p_near = float(phase.iloc[-1 - ln])
        p_mid  = float(phase.iloc[-1 - lm])
        p_far  = float(phase.iloc[-1 - lf])
        a_now  = float(atr.iloc[-1]) if np.isfinite(atr.iloc[-1]) else np.nan
        a_prev = float(atr.iloc[-2]) if len(atr) >= 2 and np.isfinite(atr.iloc[-2]) else np.nan

        peak_window   = (p_near < p_mid) and (p_mid > p_far)
        trough_window = (p_near > p_mid) and (p_mid < p_far)
        atr_rising = (np.isfinite(a_now) and np.isfinite(a_prev)
                      and a_now > a_prev * float(p["atr_rising_mult"]))

        c  = float(close.iloc[-1])
        h  = float(high.iloc[-1])
        l  = float(low.iloc[-1])
        ts = int(df["time"].iloc[-1])
        day = ts // 86400

        # bar-count for max-bars exit; live so we have to count manually.
        state["bar_count"] = int(state.get("bar_count", 0)) + 1
        bar_count = state["bar_count"]

        pos       = int(state.get("pos", 0))
        entry_p   = float(state.get("entry_p", np.nan))
        entry_bar = state.get("entry_bar", None)
        mfe       = state.get("mfe", np.nan)
        last_day  = state.get("last_entry_day", None)
        sides = p["sides"]

        stop_pct   = float(p["stop_pct"])              / 100.0
        target_pct = float(p["target_pct"])            / 100.0
        be_trig    = float(p["breakeven_trigger_pct"]) / 100.0
        be_off     = float(p["breakeven_offset_pct"])  / 100.0
        max_bars   = int(p["n_bars_exit"])

        # Position management first.
        if pos == 1 and np.isfinite(entry_p):
            mfe = max(float(mfe) if np.isfinite(mfe) else h, h)
            state["mfe"] = mfe
            reason = None
            if   c <= entry_p * (1 - stop_pct):   reason = "stop"
            elif c >= entry_p * (1 + target_pct): reason = "target"
            elif trough_window:                   reason = "phase_flip"
            elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                reason = "maxbars"
            elif (mfe / entry_p - 1.0) >= be_trig and c <= entry_p * (1 + be_off):
                reason = "breakeven"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_bar": None, "mfe": np.nan})
                return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
            return None

        if pos == -1 and np.isfinite(entry_p):
            mfe = min(float(mfe) if np.isfinite(mfe) else l, l)
            state["mfe"] = mfe
            reason = None
            if   c >= entry_p * (1 + stop_pct):   reason = "stop"
            elif c <= entry_p * (1 - target_pct): reason = "target"
            elif peak_window:                     reason = "phase_flip"
            elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                reason = "maxbars"
            elif (1.0 - mfe / entry_p) >= be_trig and c >= entry_p * (1 - be_off):
                reason = "breakeven"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_bar": None, "mfe": np.nan})
                return Signal(side="short", kind="exit", price=c, time=ts, reason=reason)
            return None

        # Flat → consider entries.
        if bool(p.get("one_entry_per_day", True)) and last_day == day:
            return None
        if sides.get("long") and peak_window:
            state.update({"pos": 1, "entry_p": c, "entry_bar": bar_count,
                          "mfe": c, "last_entry_day": day})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="moon_peak")
        if sides.get("short") and trough_window and atr_rising:
            state.update({"pos": -1, "entry_p": c, "entry_bar": bar_count,
                          "mfe": c, "last_entry_day": day})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="moon_trough")
        return None
