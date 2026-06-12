"""
Lunar Tradestation Test — LITERAL port of the MultiCharts/TradeStation
"Bias - Multiday - Moon Cycle Engine QTLab" EasyLanguage strategy.

This is a deliberately FAITHFUL transcription of the original .txt
(docs/txt-strategies/BS MD MOON ES.txt), kept as a side-by-side TEST against the
production `lunar` strategy (services/strategies/lunar.py). Where `lunar`
reinterpreted the logic to be "robust" (session-based phase lags, dropped the
`Date+2`, percent breakeven), this file stays as close to the source as the
platform allows.

Original EasyLanguage (verbatim) ------------------------------------------------
  input: nCon(1);
  Var: AtrPeriod(11), stp(1750), tgt(3250), nBarExit(345);
  Var: Phase(0), atr(0);

  Phase = AbsValue(2 * (FracPortion(DateToJulian(Date+2)/29.53059 + .4137) -.5));

  if OpenS(0)<>OpenS(0)[1] and (HighS(0) <> LowS(0)) then begin
    If entriestoday(d) < 1 and Phase[1] < Phase[35] and Phase[35] > Phase[65]
        then Buy ("LE - Full Moon") nCon contracts next bar at market;
    if phase[1] > Phase[35] and Phase[35] < Phase[65]
        then Sell ("LX - Full Moon Exit") next bar at market;
    atr = avgtruerange(AtrPeriod) of data2;
    If entriestoday(d) < 1 and atr >1*atr[1] and Phase[1] > Phase[35] and Phase[35] < Phase[65]
        then Sellshort ("SE - New Moon") nCon contracts next bar at market;
    if Phase[1] < Phase[35] and Phase[35] > Phase[65]
        then Buytocover ("SX - New Moon Exit") next bar at market;
  end;

  If barssinceentry >= nBarExit then begin
    Sell ("LX-nBarX") next bar at market;
    Buytocover ("SX-nBarX") next bar at market;
  end;

  If marketposition = 1 then begin
    if maxpositionprofit >= (stp*nCon) then sell ("LX-Breakeven") next bar at entryprice+(10*minmove/pricescale) stop;
  end;
  If marketposition =-1 then begin
    if maxpositionprofit >= (stp*nCon) then buytocover ("SX-Breakeven") next bar at entryprice-(10*minmove/pricescale) stop;
  end;

  setstopcontract;
  setstoploss(stp);
  Setprofittarget(tgt);
--------------------------------------------------------------------------------

Faithful-port decisions (and where they differ from `lunar`):
  * PHASE uses `Date+2` (two calendar days added before DateToJulian), exactly as
    the source. `lunar` dropped the +2. Phase is a per-DAY step function.
  * LAGS are BAR offsets on the 60m primary chart — Phase[1], Phase[35], Phase[65]
    — NOT session offsets. Defaults 1 / 35 / 65 match the source. `lunar` recast
    these as 2/3/4 *sessions*.
  * BREAKEVEN is dollar-triggered: arm once maxpositionprofit >= stp ($1750), then
    stop moves to entry +/- 10 ticks (10*minmove/pricescale; ES tick=0.25 -> 2.5pts).
    `lunar` used a percent trigger/offset.
  * STOP/TARGET are dollar amounts (setstoploss 1750 / setprofittarget 3250),
    converted to price via point_value ($50/pt for ES).
  * ATR is `avgtruerange(11) of data2` — a daily/session ATR. To stay tradeable
    (no look-ahead) we compare the two most recently COMPLETED sessions, same as
    `lunar` (TS reads the closed data2 bar).

Exit mechanics (intra-bar stop/target/BE checks + Option-B exact fills) mirror
`lunar` because that is backtest_engine plumbing shared by both, not strategy logic.
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.session_utils import et_ordinal_days

_UNIX_EPOCH_JD    = 2440587.5
_LUNAR_PERIOD     = 29.53059
_TS_JULIAN_OFFSET = 2415018.5   # MultiCharts DateToJulian counts from Jan 1 1900
_PHASE_OFFSET     = 0.4137      # original TS offset (unfitted)
_DATE_PLUS        = 2           # TS `Date+2`


def _moon_phase(times_s) -> pd.Series:
    """Per-bar but date-based moon phase (one value per ET calendar day), with the
    source's `Date+2`. Triangle wave: 1.0 at cycle peak, 0.0 at trough.

    Date basis is US-Eastern (the CME session timezone, = TS `Date`), not UTC —
    see session_utils.et_ordinal_days. Unlike prod `lunar` (which samples phase at
    the session-open bar and is ~unaffected), this port reads phase at literal BAR
    offsets across the session, including the ~19% of evening bars whose UTC date
    is a day ahead of ET — so the ET rebase materially changes its phase series."""
    d_et      = et_ordinal_days(times_s)                    # ET calendar date (ordinal days)
    ts_julian = (d_et + _DATE_PLUS) + (_UNIX_EPOCH_JD - _TS_JULIAN_OFFSET)  # TS Date+2, ET-based
    raw       = ts_julian / _LUNAR_PERIOD + _PHASE_OFFSET
    frac      = raw - np.floor(raw)
    result    = np.abs(2.0 * (frac - 0.5))
    if isinstance(times_s, pd.Series):
        return pd.Series(result, index=times_s.index)
    return result


def _session_ids(times: np.ndarray) -> np.ndarray:
    """Monotonic session id per bar via time gaps > one 60m bar (DST-robust)."""
    ids = np.zeros(len(times), dtype=np.int32)
    for i in range(1, len(times)):
        ids[i] = ids[i - 1] + (1 if times[i] - times[i - 1] > 3600 else 0)
    return ids


def _session_atr_rising(df: pd.DataFrame, atr_period: int,
                        atr_rising_mult: float, use_hlc3: bool = False) -> np.ndarray:
    """`avgtruerange(N) of data2`, data2 = 1380m (one session/bar).

    Groups 60m bars into sessions, builds session OHLC, Wilder ATR, then per bar
    returns True when the last COMPLETED session's ATR > the prior one's * mult.
    Comparing s-1 vs s-2 (not the forming current session) avoids look-ahead and
    keeps live == backtest, matching TS reading the closed data2 bar.
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

    # HLC3 variant: feed True Range its typical price (H+L+C)/3 as the per-session
    # reference "close" instead of the raw close. use_hlc3=False -> original behavior.
    sess_ref = (sess_h + sess_l + sess_c) / 3.0 if use_hlc3 else sess_c

    alpha = 1.0 / atr_period
    sess_atr = np.full(m, np.nan)
    for i in range(m):
        h = sess_h[i]; l = sess_l[i]
        tr = (h - l) if i == 0 else max(h - l,
                                        abs(h - sess_ref[i - 1]),
                                        abs(l - sess_ref[i - 1]))
        sess_atr[i] = tr if (i == 0 or not np.isfinite(sess_atr[i - 1])) else \
                      sess_atr[i - 1] * (1 - alpha) + tr * alpha

    sid_to_idx = {sid: i for i, sid in enumerate(unique)}
    rising = np.zeros(n, dtype=bool)
    for j in range(n):
        i = sid_to_idx[sids[j]]
        if i < 2:
            continue
        curr = sess_atr[i - 1]; prev = sess_atr[i - 2]
        if np.isfinite(curr) and np.isfinite(prev) and prev > 0:
            rising[j] = curr > prev * atr_rising_mult
    return rising


class LunarTSTestStrategy(Strategy):
    # Price basis for the session-ATR filter; HLC3 subclass flips this to True.
    USE_HLC3 = False

    PARAM_SCHEMA = [
        # --- Phase lags: LITERAL bar offsets on the 60m chart (TS Phase[1/35/65]) ---
        ParamSpec("phase_lag_1", ParamType.INT, 1,  min=1,  max=20,  step=1, group="Phase",
                  description="Near lag in BARS (TS Phase[1]). Compared bar offset on the "
                              "60m chart, NOT sessions."),
        ParamSpec("phase_lag_2", ParamType.INT, 35, min=2,  max=120, step=1, group="Phase",
                  description="Mid lag in bars (TS Phase[35]) — the suspected phase extremum."),
        ParamSpec("phase_lag_3", ParamType.INT, 65, min=3,  max=240, step=1, group="Phase",
                  description="Far lag in bars (TS Phase[65]). Typically > mid."),

        # --- ATR filter (short side only): avgtruerange(11) of data2 ---
        ParamSpec("atr_period",      ParamType.INT,   11,  min=2,  max=60,  step=1,    group="ATR Filter",
                  description="ATR smoothing period (sessions). TS: 11 on data2 (1380m)."),
        ParamSpec("atr_rising_mult", ParamType.FLOAT, 1.0, min=0.5, max=3.0, step=0.05, group="ATR Filter",
                  description="Short requires session ATR > prior session ATR x this. TS: 1.0 (any increase)."),

        # --- Exits ---
        ParamSpec("n_bars_exit",    ParamType.INT,   345,    min=10,  max=2000,   step=1,    group="Exits",
                  description="Force-close after this many bars since entry (TS nBarExit=345)."),
        ParamSpec("stop_dollars",   ParamType.FLOAT, 1750.0, min=0.0, max=50000.0,  step=25.0, group="Exits",
                  description="Stop loss in dollars (TS setstoploss=1750)."),
        ParamSpec("target_dollars", ParamType.FLOAT, 3250.0, min=0.0, max=100000.0, step=25.0, group="Exits",
                  description="Profit target in dollars (TS setprofittarget=3250)."),
        ParamSpec("point_value",    ParamType.FLOAT, 50.0,   min=0.01, max=10000.0, step=1.0,  group="Exits",
                  description="Dollar value per 1-point move (ES: $50). Converts dollar stops to price levels."),
        ParamSpec("be_offset_points", ParamType.FLOAT, 2.5,  min=0.0, max=50.0,    step=0.25, group="Exits",
                  description="Breakeven stop offset in POINTS above/below entry "
                              "(TS 10*minmove/pricescale = 10 ticks; ES tick 0.25 -> 2.5pts). "
                              "Armed once max trade profit >= stop_dollars."),
        ParamSpec("phase_flip_exit", ParamType.BOOL, True, group="Exits",
                  description="Exit long on trough / short on peak at session open "
                              "(TS 'LX/SX - Full/New Moon Exit' inside the OpenS gate)."),

        # --- Entries ---
        ParamSpec("one_entry_per_day", ParamType.BOOL, True, group="Entries",
                  description="Cap to 1 entry per session (TS entriestoday(d) < 1)."),

        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction"),

        # --- Risk ---
        ParamSpec("risk_pct",  ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Only used if Contract sizing is OFF — position as % of equity."),
        ParamSpec("contracts", ParamType.INT,   1,   min=1,   max=100,   step=1,   group="Risk",
                  description="Number of contracts per trade (TS nCon). Contracts cancel in the "
                              "$-stop / breakeven math, so this only scales P&L."),
    ]

    META = StrategyMeta(
        id="lunar_ts_test",
        name="Lunar Tradestation Test Strategy",
        description=("Literal port of the TradeStation/MultiCharts Moon Cycle bias engine "
                     "(bar-based Phase[1/35/65] lags, Date+2 phase, $-breakeven). Side-by-side "
                     "TEST against the production 'lunar' strategy."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("moon_phase", "Moon Phase", from_column="phase",
                    color="rgba(255,210,140,0.55)", line_width=1),
    ]

    # Match the production lunar dashboard window so the two can be compared on
    # the same range TS actually traded. UI date picker overrides these.
    SYMBOL_BACKTEST_START = {"ES": "2018-01-01"}
    SYMBOL_BACKTEST_END   = {"ES": "2026-04-30"}

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p    = self.p
        out  = df.copy()
        high  = out["high"].astype(float)
        low   = out["low"].astype(float)
        open_ = out["open"].astype(float)
        time  = out["time"].astype(float)

        phase   = _moon_phase(time)          # date-based step function (Date+2)
        n       = len(out)
        time_a  = time.to_numpy()
        high_a  = high.to_numpy()
        low_a   = low.to_numpy()
        open_a  = open_.to_numpy()
        phase_a = phase.to_numpy()

        # Session structure: a gap > one 60m bar starts a new session (TS OpenS change).
        sids = _session_ids(time_a)
        is_sess = np.zeros(n, dtype=bool)
        if n:
            is_sess[0] = True
        for i in range(1, n):
            if time_a[i] - time_a[i - 1] > 3600:
                is_sess[i] = True

        # Bar-offset phase lags (TS Phase[lag1]/[lag2]/[lag3]).
        l1 = int(p["phase_lag_1"]); l2 = int(p["phase_lag_2"]); l3 = int(p["phase_lag_3"])
        lag_max = max(l1, l2, l3)
        peak_bar   = np.zeros(n, dtype=bool)   # Phase[l1] < Phase[l2] > Phase[l3]
        trough_bar = np.zeros(n, dtype=bool)   # Phase[l1] > Phase[l2] < Phase[l3]
        for i in range(lag_max, n):
            p1 = phase_a[i - l1]; p2 = phase_a[i - l2]; p3 = phase_a[i - l3]
            peak_bar[i]   = (p1 < p2) and (p2 > p3)
            trough_bar[i] = (p1 > p2) and (p2 < p3)

        # avgtruerange(11) of data2, mapped per bar (last two completed sessions).
        atr_rising = _session_atr_rising(out, int(p["atr_period"]),
                                         float(p["atr_rising_mult"]),
                                         use_hlc3=self.USE_HLC3)

        sides      = p["sides"]
        phase_flip = bool(p.get("phase_flip_exit", True))
        long_on    = bool(sides.get("long"))
        short_on   = bool(sides.get("short"))

        cond_long       = np.zeros(n, dtype=bool)
        cond_short      = np.zeros(n, dtype=bool)
        bar_exit_long   = np.zeros(n, dtype=bool)
        bar_exit_short  = np.zeros(n, dtype=bool)

        stop_dlr    = float(p.get("stop_dollars",   0.0))
        tgt_dlr     = float(p.get("target_dollars", 0.0))
        pv          = float(p.get("point_value",    50.0))
        be_off_pts  = float(p.get("be_offset_points", 0.0))
        max_bars    = int(p["n_bars_exit"])
        one_per_day = bool(p.get("one_entry_per_day", True))
        use_dlr     = stop_dlr > 0 and tgt_dlr > 0

        pos             = 0
        entry_price     = np.nan
        entry_idx       = -1
        mfe_price       = np.nan
        session_count   = 0
        last_entry_sess = -1

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
                    else:
                        stop_lvl = -np.inf
                        tgt_lvl  =  np.inf
                    be_armed = (mfe_price - entry_price) * pv >= stop_dlr if use_dlr else False
                    be_stop  = entry_price + be_off_pts
                    if   l <= stop_lvl:                          reason = "stop"
                    elif h >= tgt_lvl:                           reason = "target"
                    elif is_sess[t] and phase_flip and trough_bar[t]:  reason = "phase_flip"
                    elif (t - entry_idx) >= max_bars:            reason = "maxbars"
                    elif be_armed and l <= be_stop:             reason = "breakeven"
                else:
                    if use_dlr:
                        stop_lvl = entry_price + stop_dlr / pv
                        tgt_lvl  = entry_price - tgt_dlr  / pv
                    else:
                        stop_lvl =  np.inf
                        tgt_lvl  = -np.inf
                    be_armed = (entry_price - mfe_price) * pv >= stop_dlr if use_dlr else False
                    be_stop  = entry_price - be_off_pts
                    if   h >= stop_lvl:                          reason = "stop"
                    elif l <= tgt_lvl:                           reason = "target"
                    elif is_sess[t] and phase_flip and peak_bar[t]:    reason = "phase_flip"
                    elif (t - entry_idx) >= max_bars:            reason = "maxbars"
                    elif be_armed and h >= be_stop:             reason = "breakeven"

                if reason:
                    o = open_a[t]
                    if pos == 1:
                        bar_exit_long[t] = True
                        if   reason == "stop":      exit_fill_long_arr[t] = min(stop_lvl, o)
                        elif reason == "target":    exit_fill_long_arr[t] = max(tgt_lvl, o)
                        elif reason == "breakeven": exit_fill_long_arr[t] = min(be_stop, o)
                        # phase_flip / maxbars -> NaN -> engine fills next-bar open
                    else:
                        bar_exit_short[t] = True
                        if   reason == "stop":      exit_fill_short_arr[t] = max(stop_lvl, o)
                        elif reason == "target":    exit_fill_short_arr[t] = min(tgt_lvl, o)
                        elif reason == "breakeven": exit_fill_short_arr[t] = max(be_stop, o)
                    pos = 0; entry_price = np.nan; entry_idx = -1; mfe_price = np.nan

            # --- Entry: session-open only, at most once per session ---
            if pos == 0:
                if one_per_day and last_entry_sess == session_count:
                    continue
                if not is_sess[t]:
                    continue
                if h == l:                       # TS HighS(0) <> LowS(0) flat-bar guard
                    continue
                if t + 1 >= n:
                    continue
                next_open = float(open_a[t + 1])
                if long_on and peak_bar[t]:
                    cond_long[t] = True
                    pos = 1; entry_price = next_open; entry_idx = t + 1
                    mfe_price = next_open; last_entry_sess = session_count
                elif short_on and trough_bar[t] and atr_rising[t]:
                    cond_short[t] = True
                    pos = -1; entry_price = next_open; entry_idx = t + 1
                    mfe_price = next_open; last_entry_sess = session_count

        out["cond_long"]       = cond_long
        out["cond_short"]      = cond_short
        out["bar_exit_long"]   = bar_exit_long
        out["bar_exit_short"]  = bar_exit_short
        out["entry_long"]      = cond_long
        out["entry_short"]     = cond_short
        out["exit_long"]       = bar_exit_long
        out["exit_short"]      = bar_exit_short
        out["stop_price"]      = np.full(n, np.nan)
        out["exit_fill_long"]  = exit_fill_long_arr
        out["exit_fill_short"] = exit_fill_short_arr
        out["phase"]           = phase
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p

        l1 = int(p["phase_lag_1"]); l2 = int(p["phase_lag_2"]); l3 = int(p["phase_lag_3"])
        lag_max = max(l1, l2, l3)
        # Warm up enough bars to cover the far lag and let Wilder session-ATR
        # converge (~24 bars/session * 3x window).
        warmup = max(lag_max + 2, int(p["atr_period"]) * 3 * 24)

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
        if len(buf) <= lag_max:
            return None

        df      = pd.DataFrame(buf)
        phase_a = _moon_phase(df["time"].astype(float)).to_numpy()

        # Bar-offset lags relative to the latest bar (TS Phase[l] = l bars ago).
        p1 = phase_a[-1 - l1]; p2 = phase_a[-1 - l2]; p3 = phase_a[-1 - l3]
        peak_window   = (p1 < p2) and (p2 > p3)
        trough_window = (p1 > p2) and (p2 < p3)

        atr_rising_arr = _session_atr_rising(df, int(p["atr_period"]),
                                             float(p["atr_rising_mult"]),
                                             use_hlc3=self.USE_HLC3)
        atr_rising = bool(atr_rising_arr[-1])

        times_arr = df["time"].to_numpy().astype(float)
        c  = float(df["close"].iloc[-1])
        h  = float(df["high"].iloc[-1])
        l  = float(df["low"].iloc[-1])
        ts = int(df["time"].iloc[-1])
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

        stop_dlr   = float(p.get("stop_dollars",   0.0))
        tgt_dlr    = float(p.get("target_dollars", 0.0))
        pv         = float(p.get("point_value",    50.0))
        be_off_pts = float(p.get("be_offset_points", 0.0))
        max_bars   = int(p["n_bars_exit"])
        phase_flip = bool(p.get("phase_flip_exit", True))
        use_dlr    = stop_dlr > 0 and tgt_dlr > 0

        if pos == 1 and np.isfinite(entry_p):
            mfe = max(float(mfe) if np.isfinite(mfe) else h, h)
            state["mfe"] = mfe
            reason = None
            be_armed = use_dlr and (mfe - entry_p) * pv >= stop_dlr
            be_stop  = entry_p + be_off_pts
            if   use_dlr and l <= entry_p - stop_dlr / pv:           reason = "stop"
            elif use_dlr and h >= entry_p + tgt_dlr  / pv:           reason = "target"
            elif is_sess and phase_flip and trough_window:          reason = "phase_flip"
            elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                reason = "maxbars"
            elif be_armed and l <= be_stop:                         reason = "breakeven"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_bar": None, "mfe": np.nan})
                return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
            return None

        if pos == -1 and np.isfinite(entry_p):
            mfe = min(float(mfe) if np.isfinite(mfe) else l, l)
            state["mfe"] = mfe
            reason = None
            be_armed = use_dlr and (entry_p - mfe) * pv >= stop_dlr
            be_stop  = entry_p - be_off_pts
            if   use_dlr and h >= entry_p + stop_dlr / pv:          reason = "stop"
            elif use_dlr and l <= entry_p - tgt_dlr  / pv:          reason = "target"
            elif is_sess and phase_flip and peak_window:            reason = "phase_flip"
            elif entry_bar is not None and (bar_count - int(entry_bar)) >= max_bars:
                reason = "maxbars"
            elif be_armed and h >= be_stop:                         reason = "breakeven"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_bar": None, "mfe": np.nan})
                return Signal(side="short", kind="exit", price=c, time=ts, reason=reason)
            return None

        # Flat -> entries ONLY at session-open bar (TS OpenS gate)
        if bool(p.get("one_entry_per_day", True)) and last_sess == sess_cnt:
            return None
        if not is_sess:
            return None
        if h == l:                              # TS HighS(0) <> LowS(0)
            return None

        if sides.get("long") and peak_window:
            state.update({"pos": 1, "entry_p": c, "entry_bar": bar_count,
                          "mfe": c, "last_entry_sess": sess_cnt})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="full_moon")
        if sides.get("short") and trough_window and atr_rising:
            state.update({"pos": -1, "entry_p": c, "entry_bar": bar_count,
                          "mfe": c, "last_entry_sess": sess_cnt})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="new_moon")
        return None
