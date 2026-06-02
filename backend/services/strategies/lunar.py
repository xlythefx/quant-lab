"""
Lunar — Multiday moon-cycle bias engine.

Port of MultiCharts/TradeStation "Bias - Multiday - Moon Cycle Engine QTLab".

Original TS logic (verbatim):
  Phase = |2*(frac(DateToJulian(Date+2)/29.53059 + 0.4137) - 0.5)|

  if OpenS(0)<>OpenS(0)[1] and (HighS(0)<>LowS(0)) then begin
    -- LONG  entry: entriestoday<1 AND Phase[1]<Phase[35] AND Phase[35]>Phase[65]
    -- LONG  exit : Phase[1]>Phase[35] AND Phase[35]<Phase[65]   (trough window)
    -- SHORT entry: entriestoday<1 AND atr>atr[1] AND Phase[1]>Phase[35] AND Phase[35]<Phase[65]
    -- SHORT exit : Phase[1]<Phase[35] AND Phase[35]>Phase[65]   (peak  window)
  end
  if barssinceentry >= 345 then close;
  Breakeven: if maxpositionprofit >= stp then stop at entry ± tiny offset;
  setstoploss(1750); setprofittarget(3250);

`OpenS(0)<>OpenS(0)[1]` fires only on the FIRST bar of each new session AND
`HighS(0)<>LowS(0)` skips flat (no-range) session bars.
Both entries AND phase exits are session-gated.  Stop / target / breakeven /
maxbars fire on every bar.

Option-A fixes vs original broken port
---------------------------------------
1. ATR now uses true session-level (1380m) OHLCV — groups 60m bars into sessions,
   computes native session true-range and Wilder ATR, then maps back per bar.
   Previously used 60m ATR shifted by session_bars which gave different values.

2. Stop / target / breakeven now detected via intra-bar high/low (not close).
   Long  stop    : low  <= entry - stop$/pv
   Long  target  : high >= entry + tgt$/pv
   Short stop    : high >= entry + stop$/pv
   Short target  : low  <= entry - tgt$/pv
   Matches TS setstoploss / setprofittarget intra-bar semantics.

3. Flat-bar guard added: skips session-open bar if high == low (TS HighS<>LowS).

Fill price at engine level is still next-bar open (engine limitation; Option B
would fix this by supporting exact level fills).
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)

_UNIX_EPOCH_JD = 2440587.5
_LUNAR_PERIOD  = 29.53059
_PHASE_OFFSET  = 0.4137


def _moon_phase(times_s: pd.Series) -> pd.Series:
    julian = times_s / 86400.0 + _UNIX_EPOCH_JD + 2.0
    raw    = julian / _LUNAR_PERIOD + _PHASE_OFFSET
    frac   = raw - np.floor(raw)
    return (2.0 * (frac - 0.5)).abs()


def _session_ids(times: np.ndarray) -> np.ndarray:
    """Assign a monotonically increasing session ID per bar via time gaps > 1 bar."""
    ids = np.zeros(len(times), dtype=np.int32)
    for i in range(1, len(times)):
        ids[i] = ids[i - 1] + (1 if times[i] - times[i - 1] > 3600 else 0)
    return ids


def _session_atr_rising(df: pd.DataFrame, atr_period: int,
                        atr_rising_mult: float) -> np.ndarray:
    """
    True session-level ATR comparison matching TS `avgtruerange(N) of data2`
    where data2 is 1380m (one full session per bar).

    Groups 60m bars into sessions, builds session OHLCV, computes Wilder ATR,
    then returns a bool array: True when current-session ATR > prior ATR * mult.
    """
    times = df["time"].astype(float).to_numpy()
    high  = df["high"].astype(float).to_numpy()
    low   = df["low"].astype(float).to_numpy()
    close = df["close"].astype(float).to_numpy()
    n = len(times)

    sids = _session_ids(times)
    unique = np.unique(sids)
    m = len(unique)

    sess_h = np.empty(m); sess_l = np.empty(m); sess_c = np.empty(m)
    for i, sid in enumerate(unique):
        mask = sids == sid
        sess_h[i] = high[mask].max()
        sess_l[i] = low[mask].min()
        sess_c[i] = close[np.where(mask)[0][-1]]

    # Wilder ATR on session bars
    alpha = 1.0 / atr_period
    sess_atr = np.full(m, np.nan)
    for i in range(m):
        h = sess_h[i]; l = sess_l[i]
        tr = (h - l) if i == 0 else max(h - l,
                                        abs(h - sess_c[i - 1]),
                                        abs(l - sess_c[i - 1]))
        sess_atr[i] = tr if (i == 0 or not np.isfinite(sess_atr[i - 1])) else \
                      sess_atr[i - 1] * (1 - alpha) + tr * alpha

    # Map back: each bar gets its session's ATR comparison result
    sid_to_idx = {sid: i for i, sid in enumerate(unique)}
    rising = np.zeros(n, dtype=bool)
    for j in range(n):
        i = sid_to_idx[sids[j]]
        if i < 1:
            continue
        curr = sess_atr[i]; prev = sess_atr[i - 1]
        if np.isfinite(curr) and np.isfinite(prev) and prev > 0:
            rising[j] = curr > prev * atr_rising_mult
    return rising


class LunarStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("phase_lag_near", ParamType.INT, 1,  min=1,   max=100,  step=1,  group="Phase",
                  description="Near lag in bars."),
        ParamSpec("phase_lag_mid",  ParamType.INT, 35, min=5,   max=3000, step=1,  group="Phase",
                  description="Mid lag — the suspected phase extremum."),
        ParamSpec("phase_lag_far",  ParamType.INT, 65, min=10,  max=6000, step=1,  group="Phase",
                  description="Far lag."),

        ParamSpec("atr_period",      ParamType.INT,   11,  min=2,  max=60,  step=1,    group="ATR Filter",
                  description="ATR smoothing period (sessions). Original: 11 on data2 1380m."),
        ParamSpec("atr_rising_mult", ParamType.FLOAT, 1.0, min=0.5, max=3.0, step=0.05, group="ATR Filter",
                  description="Short requires session-ATR > prior session-ATR x this. "
                              "Original: 1.0 on data2 (any increase)."),

        ParamSpec("n_bars_exit", ParamType.INT,   345, min=10,  max=2000, step=1,   group="Exits",
                  description="Force-close after this many bars since entry (TS nBarExit)."),
        ParamSpec("stop_dollars",  ParamType.FLOAT, 1750.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Stop loss in dollars (exact TS setstoploss). "
                              "When > 0, overrides stop_pct. ES original: $1750. Set 0 to use stop_pct."),
        ParamSpec("target_dollars", ParamType.FLOAT, 3250.0, min=0.0, max=100000.0, step=25.0, group="Exits",
                  description="Profit target in dollars (exact TS setprofittarget). "
                              "When > 0, overrides target_pct. ES original: $3250. Set 0 to use target_pct."),
        ParamSpec("point_value",   ParamType.FLOAT, 50.0, min=0.01, max=10000.0, step=1.0, group="Exits",
                  description="Dollar value per 1-point move (ES: $50). Used to convert dollar stops to price levels."),
        ParamSpec("stop_pct",    ParamType.FLOAT, 0.7, min=0.05, max=10.0, step=0.05, group="Exits",
                  description="Stop loss % of entry (fallback when stop_dollars=0)."),
        ParamSpec("target_pct",  ParamType.FLOAT, 1.3, min=0.1,  max=20.0, step=0.05, group="Exits",
                  description="Profit target % of entry (fallback when target_dollars=0)."),
        ParamSpec("breakeven_trigger_pct", ParamType.FLOAT, 0.0, min=0.0, max=100.0, step=0.05, group="Exits",
                  description="Arm breakeven once MFE >= this % (fallback when stop_dollars=0). "
                              "0 = disabled in dollar-stop mode (trigger is stop_dollars instead)."),
        ParamSpec("breakeven_offset_pct",  ParamType.FLOAT, 0.04, min=0.0, max=2.0, step=0.01, group="Exits",
                  description="Breakeven stop offset above/below entry %. "
                              "Original: 10*minmove/pricescale ~2.5pts on ES ~0.04-0.1%."),

        ParamSpec("phase_flip_exit", ParamType.BOOL, True, group="Exits",
                  description="Exit long on trough / short on peak at session open. "
                              "ON by default — matches TS LX/SX inside the OpenS gate."),

        ParamSpec("one_entry_per_day", ParamType.BOOL, True, group="Entries",
                  description="Cap to 1 entry per session (TS: entriestoday() < 1)."),

        ParamSpec("session_bars", ParamType.INT, 23, min=1, max=48, step=1, group="Entries",
                  description="Hourly bars per trading session (ES: 23 = 17:00-16:00 ET). "
                              "Used for session-level ATR comparison (shift by this many bars)."),

        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": True},
                  group="Direction"),

        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade."),
    ]

    META = StrategyMeta(
        id="lunar",
        name="Lunar (Moon Cycle Bias)",
        description=("Multiday moon-cycle bias engine. Entries and phase exits fire only "
                     "at session open (TS OpenS gate). Hard exits: stop, target, "
                     "breakeven, maxbars on every bar."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("moon_phase", "Moon Phase", from_column="phase",
                    color="rgba(192,180,255,0.55)", line_width=1),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p    = self.p
        out  = df.copy()
        close = out["close"].astype(float)
        high  = out["high"].astype(float)
        low   = out["low"].astype(float)
        open_ = out["open"].astype(float)
        time  = out["time"].astype(float)

        phase = _moon_phase(time)

        ln = int(p["phase_lag_near"])
        lm = int(p["phase_lag_mid"])
        lf = int(p["phase_lag_far"])
        p_near = phase.shift(ln)
        p_mid  = phase.shift(lm)
        p_far  = phase.shift(lf)

        peak_window   = (p_near < p_mid) & (p_mid > p_far)
        trough_window = (p_near > p_mid) & (p_mid < p_far)

        # FIX 1: True session-level ATR matching TS data2 (1380m).
        atr_rising_arr = _session_atr_rising(out, int(p["atr_period"]),
                                             float(p["atr_rising_mult"]))
        atr_rising = pd.Series(atr_rising_arr, index=out.index)

        sides      = p["sides"]
        phase_flip = bool(p.get("phase_flip_exit", True))
        _false_s   = pd.Series(False, index=out.index)
        wle_arr = (peak_window if sides.get("long") else _false_s).fillna(False).to_numpy()
        wse_arr = ((trough_window & atr_rising) if sides.get("short") else _false_s).fillna(False).to_numpy()
        pel_arr = (trough_window if phase_flip else _false_s).fillna(False).to_numpy()
        pes_arr = (peak_window   if phase_flip else _false_s).fillna(False).to_numpy()

        n      = len(out)
        time_a = time.to_numpy()
        high_a = high.to_numpy()
        low_a  = low.to_numpy()
        open_a = open_.to_numpy()

        # Session-open detection via time gaps (robust to DST).
        is_sess = np.zeros(n, dtype=bool)
        is_sess[0] = True
        for i in range(1, n):
            if time_a[i] - time_a[i - 1] > 3600:
                is_sess[i] = True

        cond_long      = np.zeros(n, dtype=bool)
        cond_short     = np.zeros(n, dtype=bool)
        bar_exit_long  = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)

        stop_dlr    = float(p.get("stop_dollars",  0.0))
        tgt_dlr     = float(p.get("target_dollars", 0.0))
        pv          = float(p.get("point_value",   50.0))
        stop_pct    = float(p["stop_pct"])              / 100.0
        target_pct  = float(p["target_pct"])            / 100.0
        be_trig_pct = float(p["breakeven_trigger_pct"]) / 100.0
        be_off_pct  = float(p["breakeven_offset_pct"])  / 100.0
        max_bars    = int(p["n_bars_exit"])
        one_per_day = bool(p.get("one_entry_per_day", True))
        use_dlr     = stop_dlr > 0 and tgt_dlr > 0

        pos             = 0
        entry_price     = np.nan
        entry_idx       = -1
        mfe_price       = np.nan
        session_count   = 0
        last_entry_sess = -1

        # Option-B fill prices: NaN = engine fills at next-bar open (phase_flip / maxbars).
        # Finite = engine fills at this exact level with gap protection.
        exit_fill_long_arr  = np.full(n, np.nan)
        exit_fill_short_arr = np.full(n, np.nan)

        for t in range(n):
            h = high_a[t]
            l = low_a[t]

            if is_sess[t]:
                session_count += 1

            # --- Exit processing (every bar) ---
            if pos != 0 and np.isfinite(entry_price):
                if pos == 1:
                    if h > mfe_price: mfe_price = float(h)
                else:
                    if l < mfe_price: mfe_price = float(l)

                reason = None
                if pos == 1:
                    if use_dlr:
                        stop_lvl = entry_price - stop_dlr / pv
                        tgt_lvl  = entry_price + tgt_dlr  / pv
                        be_armed = (mfe_price - entry_price) * pv >= stop_dlr
                    else:
                        stop_lvl = entry_price * (1.0 - stop_pct)
                        tgt_lvl  = entry_price * (1.0 + target_pct)
                        be_armed = (mfe_price / entry_price - 1.0) >= be_trig_pct
                    be_stop = entry_price * (1.0 + be_off_pct)
                    # FIX 2: intra-bar check — use low for long stops, high for target
                    if   l <= stop_lvl:                          reason = "stop"
                    elif h >= tgt_lvl:                           reason = "target"
                    elif is_sess[t] and pel_arr[t]:              reason = "phase_flip"
                    elif (t - entry_idx) >= max_bars:            reason = "maxbars"
                    elif be_armed and l <= be_stop:              reason = "breakeven"
                else:
                    if use_dlr:
                        stop_lvl = entry_price + stop_dlr / pv
                        tgt_lvl  = entry_price - tgt_dlr  / pv
                        be_armed = (entry_price - mfe_price) * pv >= stop_dlr
                    else:
                        stop_lvl = entry_price * (1.0 + stop_pct)
                        tgt_lvl  = entry_price * (1.0 - target_pct)
                        be_armed = (1.0 - mfe_price / entry_price) >= be_trig_pct
                    be_stop = entry_price * (1.0 - be_off_pct)
                    # FIX 2: intra-bar check — use high for short stops, low for target
                    if   h >= stop_lvl:                          reason = "stop"
                    elif l <= tgt_lvl:                           reason = "target"
                    elif is_sess[t] and pes_arr[t]:              reason = "phase_flip"
                    elif (t - entry_idx) >= max_bars:            reason = "maxbars"
                    elif be_armed and h >= be_stop:              reason = "breakeven"

                if reason:
                    o = open_a[t]
                    if pos == 1:
                        bar_exit_long[t] = True
                        if reason == "stop":
                            exit_fill_long_arr[t] = min(stop_lvl, o)   # long stop: fill at level or gap-open
                        elif reason == "target":
                            exit_fill_long_arr[t] = max(tgt_lvl, o)    # long target: fill at level or gap-open
                        elif reason == "breakeven":
                            exit_fill_long_arr[t] = min(be_stop, o)    # long BE: same logic as stop
                        # phase_flip / maxbars → NaN → engine uses next-bar open
                    else:
                        bar_exit_short[t] = True
                        if reason == "stop":
                            exit_fill_short_arr[t] = max(stop_lvl, o)  # short stop: fill at level or gap-open
                        elif reason == "target":
                            exit_fill_short_arr[t] = min(tgt_lvl, o)   # short target: fill at level or gap-open
                        elif reason == "breakeven":
                            exit_fill_short_arr[t] = max(be_stop, o)   # short BE: same logic as stop
                    pos = 0; entry_price = np.nan; entry_idx = -1; mfe_price = np.nan

            # --- Entry: session-open only, at most once per session ---
            if pos == 0:
                if one_per_day and last_entry_sess == session_count:
                    continue
                if not is_sess[t]:
                    continue
                # FIX 3: flat-bar guard (TS: HighS(0)<>LowS(0))
                if h == l:
                    continue
                if t + 1 >= n:
                    continue
                next_open = float(open_a[t + 1])
                if wle_arr[t]:
                    cond_long[t] = True
                    pos = 1; entry_price = next_open; entry_idx = t + 1
                    mfe_price = next_open; last_entry_sess = session_count
                elif wse_arr[t]:
                    cond_short[t] = True
                    pos = -1; entry_price = next_open; entry_idx = t + 1
                    mfe_price = next_open; last_entry_sess = session_count

        out["cond_long"]        = cond_long
        out["cond_short"]       = cond_short
        out["bar_exit_long"]    = bar_exit_long
        out["bar_exit_short"]   = bar_exit_short
        out["entry_long"]       = cond_long
        out["entry_short"]      = cond_short
        out["exit_long"]        = bar_exit_long
        out["exit_short"]       = bar_exit_short
        out["stop_price"]       = np.full(n, np.nan)
        out["exit_fill_long"]   = exit_fill_long_arr   # Option-B: exact fill for stop/target/BE
        out["exit_fill_short"]  = exit_fill_short_arr
        out["phase"]            = phase
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p      = self.p
        warmup = max(int(p["phase_lag_far"]) + 10, int(p["atr_period"]) * 4)

        buf = state.setdefault("buf", [])
        buf.append({
            "time":   int(candle["time"]),
            "open":   float(candle["open"]),
            "high":   float(candle["high"]),
            "low":    float(candle["low"]),
            "close":  float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < warmup:
            return None

        df     = pd.DataFrame(buf)
        time_s = df["time"].astype(float)
        phase  = _moon_phase(time_s)

        ln = int(p["phase_lag_near"]); lm = int(p["phase_lag_mid"]); lf = int(p["phase_lag_far"])
        if len(phase) <= lf:
            return None
        p_near = float(phase.iloc[-1 - ln])
        p_mid  = float(phase.iloc[-1 - lm])
        p_far  = float(phase.iloc[-1 - lf])

        # FIX 1: true session-level ATR from buffer
        atr_rising_arr = _session_atr_rising(df, int(p["atr_period"]),
                                             float(p["atr_rising_mult"]))
        atr_rising = bool(atr_rising_arr[-1])

        peak_window   = (p_near < p_mid) and (p_mid > p_far)
        trough_window = (p_near > p_mid) and (p_mid < p_far)

        c  = float(df["close"].iloc[-1])
        h  = float(df["high"].iloc[-1])
        l  = float(df["low"].iloc[-1])
        ts = int(df["time"].iloc[-1])

        # Detect session-open from time gap in buffer
        times_arr = df["time"].to_numpy()
        is_sess = len(times_arr) < 2 or (times_arr[-1] - times_arr[-2] > 3600)

        state["bar_count"] = int(state.get("bar_count", 0)) + 1
        bar_count = state["bar_count"]
        if is_sess:
            state["session_count"] = int(state.get("session_count", 0)) + 1

        pos       = int(state.get("pos", 0))
        entry_p   = float(state.get("entry_p", np.nan))
        entry_bar = state.get("entry_bar", None)
        mfe       = state.get("mfe", np.nan)
        last_sess = state.get("last_entry_sess", -1)
        sess_cnt  = int(state.get("session_count", 0))
        sides     = p["sides"]

        stop_dlr   = float(p.get("stop_dollars",  0.0))
        tgt_dlr    = float(p.get("target_dollars", 0.0))
        pv         = float(p.get("point_value",   50.0))
        stop_pct   = float(p["stop_pct"])              / 100.0
        target_pct = float(p["target_pct"])            / 100.0
        be_trig    = float(p["breakeven_trigger_pct"]) / 100.0
        be_off     = float(p["breakeven_offset_pct"])  / 100.0
        max_bars   = int(p["n_bars_exit"])
        phase_flip = bool(p.get("phase_flip_exit", True))
        use_dlr    = stop_dlr > 0 and tgt_dlr > 0

        if pos == 1 and np.isfinite(entry_p):
            mfe = max(float(mfe) if np.isfinite(mfe) else h, h)
            state["mfe"] = mfe
            reason = None
            if use_dlr:
                be_stop = entry_p * (1.0 + be_off)
                be_armed = (mfe - entry_p) * pv >= stop_dlr
                # FIX 2: intra-bar high/low checks
                if   l <= entry_p - stop_dlr / pv:                      reason = "stop"
                elif h >= entry_p + tgt_dlr  / pv:                      reason = "target"
                elif is_sess and phase_flip and trough_window:           reason = "phase_flip"
                elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                    reason = "maxbars"
                elif be_armed and l <= be_stop:                          reason = "breakeven"
            else:
                be_stop = entry_p * (1.0 + be_off)
                be_armed = (mfe / entry_p - 1.0) >= be_trig
                if   l <= entry_p * (1.0 - stop_pct):                   reason = "stop"
                elif h >= entry_p * (1.0 + target_pct):                 reason = "target"
                elif is_sess and phase_flip and trough_window:           reason = "phase_flip"
                elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                    reason = "maxbars"
                elif be_armed and l <= be_stop:                          reason = "breakeven"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_bar": None, "mfe": np.nan})
                return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
            return None

        if pos == -1 and np.isfinite(entry_p):
            mfe = min(float(mfe) if np.isfinite(mfe) else l, l)
            state["mfe"] = mfe
            reason = None
            if use_dlr:
                be_stop = entry_p * (1.0 - be_off)
                be_armed = (entry_p - mfe) * pv >= stop_dlr
                # FIX 2: intra-bar high/low checks
                if   h >= entry_p + stop_dlr / pv:                      reason = "stop"
                elif l <= entry_p - tgt_dlr  / pv:                      reason = "target"
                elif is_sess and phase_flip and peak_window:             reason = "phase_flip"
                elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                    reason = "maxbars"
                elif be_armed and h >= be_stop:                          reason = "breakeven"
            else:
                be_stop = entry_p * (1.0 - be_off)
                be_armed = (1.0 - mfe / entry_p) >= be_trig
                if   h >= entry_p * (1.0 + stop_pct):                   reason = "stop"
                elif l <= entry_p * (1.0 - target_pct):                 reason = "target"
                elif is_sess and phase_flip and peak_window:             reason = "phase_flip"
                elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                    reason = "maxbars"
                elif be_armed and h >= be_stop:                          reason = "breakeven"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_bar": None, "mfe": np.nan})
                return Signal(side="short", kind="exit", price=c, time=ts, reason=reason)
            return None

        # Flat → entries ONLY at session-open bar (TS OpenS gate)
        if bool(p.get("one_entry_per_day", True)) and last_sess == sess_cnt:
            return None
        if not is_sess:
            return None
        # FIX 3: flat-bar guard
        if h == l:
            return None

        if sides.get("long") and peak_window:
            state.update({"pos": 1, "entry_p": c, "entry_bar": bar_count,
                          "mfe": c, "last_entry_sess": sess_cnt})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="moon_peak")
        if sides.get("short") and trough_window and atr_rising:
            state.update({"pos": -1, "entry_p": c, "entry_bar": bar_count,
                          "mfe": c, "last_entry_sess": sess_cnt})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="moon_trough")
        return None
