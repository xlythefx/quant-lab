"""
Pivot R1 Breakout (Long) — daily pivot-point breakout, multiday, long-only.

Port of MultiCharts/TradeStation "Trend Following - Multiday - Pivot Points
Engine - Only long" (docs/txt-strategies/[TF-MD-PivotP-ES-001].txt). Original TS:

  data2 = daily session. Pivots are computed on the PREVIOUS completed session:
    pivot = (H1 + L1 + C1) / 3
    R1    = 2*pivot - L1                          (the breakout trigger)

  Filters (on completed daily sessions):
    FiltroY = L1 > L2                             (yesterday's low > 2-days-ago low)
    FiltroN = (range1 < range2) and (range2 < range3)   (3-session vol contraction)

  Entry (long only, once/day, flat, FiltroY true, FiltroN false, C < R1):
    buy next bar at (R1 - 2 ticks) STOP

  Exits:
    setstoploss($1200)                            (entry - stop$/pv)
    setprofittarget($1700)                        (entry + tgt$/pv, limit)
    maxpositionprofit >= $1200 -> breakeven       (stop -> entry + 2 ticks)
    barssinceentry >= ~9 days -> exit at close    (maxbars)

PORTING NOTE — entry timing
---------------------------
TS arms a *buy-stop* at `R1 - 2 ticks` and fills intrabar when price pierces it.
Our backtest engine fills entries at the NEXT BAR'S OPEN and exposes no entry-fill
override (only exits get exact fills via `exit_fill_*`). Honoring the stop level on
entry would require filling below the next open on non-gap breakouts, which biases
results optimistically. So we port the entry as a *close-confirmed breakout*: a
trade arms once price has traded below R1 this session (TS's `C < R1` guard, "don't
chase"), and signals the bar whose close first reaches the trigger; the engine then
fills realistically at the next bar's open. Slightly more conservative than the raw
stop, and free of look-ahead. Exits DO use exact gap-protected fills (Option-B),
same as rsi2_reversion / lunar.

Like those ports, `data2` (the daily bar) is reconstructed from the intraday feed
by grouping bars into sessions via time gaps; pivots/filters read the last COMPLETED
sessions (s-1, s-2, s-3). Runs on our existing 60m ES data; ES auto-sizes as $50/pt.
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)


def _session_ids(times: np.ndarray) -> np.ndarray:
    """Session id per bar — increments on a time gap > 1 bar (overnight/weekend)."""
    ids = np.zeros(len(times), dtype=np.int64)
    for i in range(1, len(times)):
        ids[i] = ids[i - 1] + (1 if times[i] - times[i - 1] > 3600 else 0)
    return ids


def _daily_from_sessions(time_a, open_a, high_a, low_a, close_a, sids):
    """Build per-session (daily) OHLC arrays + the index of each session's open bar."""
    nS = int(sids[-1]) + 1 if len(sids) else 0
    d_open  = np.empty(nS); d_high = np.empty(nS)
    d_low   = np.empty(nS); d_close = np.empty(nS)
    open_bar = np.zeros(nS, dtype=np.int64)
    start = 0
    for s in range(nS):
        end = start
        while end < len(sids) and sids[end] == s:
            end += 1
        seg = slice(start, end)
        d_open[s]  = open_a[start]
        d_high[s]  = high_a[seg].max()
        d_low[s]   = low_a[seg].min()
        d_close[s] = close_a[end - 1]
        open_bar[s] = start
        start = end
    return d_open, d_high, d_low, d_close, open_bar


def _pivots(d_high, d_low, d_close, s):
    """Pivot + R1 from the last COMPLETED session (s-1)."""
    h1, l1, c1 = d_high[s - 1], d_low[s - 1], d_close[s - 1]
    pivot = (h1 + l1 + c1) / 3.0
    r1 = 2.0 * pivot - l1
    return pivot, r1


def _filters_ok(d_high, d_low, s, use_pattern, use_vol):
    """FiltroY (pattern) true AND FiltroN (3-session vol contraction) false."""
    filtro_y = d_low[s - 1] > d_low[s - 2]
    rng1 = d_high[s - 1] - d_low[s - 1]
    rng2 = d_high[s - 2] - d_low[s - 2]
    rng3 = d_high[s - 3] - d_low[s - 3]
    filtro_n = (rng1 < rng2) and (rng2 < rng3)
    ok = True
    if use_pattern:
        ok = ok and filtro_y
    if use_vol:
        ok = ok and (not filtro_n)
    return ok


class PivotBreakoutStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("entry_offset_ticks", ParamType.FLOAT, 2.0, min=0.0, max=20.0, step=1.0, group="Entry",
                  description="Breakout trigger sits this many ticks below R1 (TS: 2). The bar "
                              "that closes at/above the trigger arms a next-bar-open entry."),
        ParamSpec("tick_size", ParamType.FLOAT, 0.25, min=0.0001, max=10.0, step=0.05, group="Entry",
                  description="Instrument tick size (ES: 0.25). Used for the entry offset and the "
                              "breakeven offset."),
        ParamSpec("pattern_filter", ParamType.BOOL, True, group="Filters",
                  description="FiltroY: require yesterday's low > 2-days-ago low (a neutral/rising "
                              "structure). TS had this ON. Turn off to take every R1 breakout."),
        ParamSpec("vol_contraction_filter", ParamType.BOOL, True, group="Filters",
                  description="FiltroN: inhibit entry when the daily range contracted across the "
                              "last 3 sessions (range1<range2<range3). TS had this ON."),

        ParamSpec("stop_dollars", ParamType.FLOAT, 1200.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Hard stop in dollars (TS setstoploss 1200). entry - stop$/point_value."),
        ParamSpec("target_dollars", ParamType.FLOAT, 1700.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Profit target in dollars (TS setprofittarget 1700), a limit fill at "
                              "entry + tgt$/point_value. 0 disables the target."),
        ParamSpec("breakeven_dollars", ParamType.FLOAT, 1200.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Once open MFE reaches this many dollars, move the stop to breakeven "
                              "+ offset (TS: maxpositionprofit >= stp). 0 disables."),
        ParamSpec("breakeven_offset_ticks", ParamType.FLOAT, 2.0, min=0.0, max=40.0, step=1.0, group="Exits",
                  description="Breakeven stop sits this many ticks above entry once armed (TS: 2)."),
        ParamSpec("max_days", ParamType.INT, 9, min=1, max=60, step=1, group="Exits",
                  description="Force-close after this many sessions in the trade (TS ~9 days)."),

        ParamSpec("point_value", ParamType.FLOAT, 50.0, min=0.01, max=10000.0, step=1.0, group="Risk",
                  description="$ per 1-point move (ES: $50). Converts dollar stop/target/BE to price."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures contracts per trade (TS nCon). ES sizes as contracts x $50/pt."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Only used if the instrument isn't contract-sized — % of equity per trade."),
    ]

    META = StrategyMeta(
        id="pivot_breakout",
        name="Pivot R1 Breakout (Long)",
        description=("Daily pivot-point breakout, long-only. Buys a close-confirmed break above "
                     "the R1 pivot (computed from the prior session) when structure is neutral/"
                     "rising and volatility hasn't been contracting; exits on a dollar target, a "
                     "stop with breakeven-lock, or after ~9 days."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("r1",    "R1 (trigger)", from_column="r1",    color="#22d3ee", line_width=2),
        OverlaySpec("pivot", "Pivot",        from_column="pivot", color="#a78bfa", line_width=1,
                    line_style="dashed"),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p     = self.p
        out   = df.copy()
        open_ = out["open"].astype(float).to_numpy()
        high  = out["high"].astype(float).to_numpy()
        low   = out["low"].astype(float).to_numpy()
        close = out["close"].astype(float).to_numpy()
        time  = out["time"].astype(float).to_numpy()
        n     = len(out)

        sids = _session_ids(time)
        nS   = int(sids[-1]) + 1 if n else 0
        d_open, d_high, d_low, d_close, open_bar = _daily_from_sessions(
            time, open_, high, low, close, sids)

        tick        = float(p["tick_size"])
        entry_off   = float(p["entry_offset_ticks"]) * tick
        use_pattern = bool(p.get("pattern_filter", True))
        use_vol     = bool(p.get("vol_contraction_filter", True))
        pv          = float(p["point_value"])
        stop_dlr    = float(p["stop_dollars"])
        tgt_dlr     = float(p["target_dollars"])
        be_dlr      = float(p["breakeven_dollars"])
        be_off      = float(p["breakeven_offset_ticks"]) * tick
        max_days    = int(p["max_days"])
        stop_pts    = stop_dlr / pv if pv > 0 else 0.0
        tgt_pts     = tgt_dlr  / pv if pv > 0 else 0.0
        be_pts      = be_dlr   / pv if pv > 0 else 0.0

        cond_long      = np.zeros(n, dtype=bool)
        bar_exit_long  = np.zeros(n, dtype=bool)
        exit_fill_long = np.full(n, np.nan)
        r1_overlay     = np.full(n, np.nan)
        pivot_overlay  = np.full(n, np.nan)

        pos = 0
        entry_price = np.nan
        entry_sess  = -1
        mfe = np.nan
        last_entry_sess = -1

        cur_s = -1
        seen_below = False     # has price traded below R1 this session (TS `C < R1` arm)

        for t in range(n):
            s = int(sids[t])
            warm = s >= 3      # need 3 completed sessions for pivots + filters
            if s != cur_s:     # new session opened on this bar
                cur_s = s
                seen_below = False

            pivot = r1 = np.nan
            filt_ok = False
            if warm:
                pivot, r1 = _pivots(d_high, d_low, d_close, s)
                r1_overlay[t]    = r1
                pivot_overlay[t] = pivot
                filt_ok = _filters_ok(d_high, d_low, s, use_pattern, use_vol)
                if close[t] < r1:
                    seen_below = True

            trigger = (r1 - entry_off) if warm else np.nan

            # ---- Exit processing (in a long position) ----
            if pos == 1 and np.isfinite(entry_price):
                if high[t] > mfe:
                    mfe = high[t]
                o = open_[t]
                base_stop = entry_price - stop_pts
                be_armed = be_pts > 0 and (mfe - entry_price) >= be_pts
                stop_lvl = (entry_price + be_off) if be_armed else base_stop
                reason = None
                if stop_pts > 0 and low[t] <= stop_lvl:
                    reason = "breakeven" if be_armed else "stop"
                    exit_fill_long[t] = min(stop_lvl, o)        # gap-protected
                elif tgt_pts > 0 and high[t] >= entry_price + tgt_pts:
                    reason = "target"
                    exit_fill_long[t] = max(entry_price + tgt_pts, o)  # limit, gap-up better
                elif (s - entry_sess) >= max_days:
                    reason = "maxdays"
                    exit_fill_long[t] = close[t]                # TS "this bar at close"
                if reason:
                    bar_exit_long[t] = True
                    pos = 0; entry_price = np.nan; entry_sess = -1; mfe = np.nan

            # ---- Entry (long only, once per session, close-confirmed breakout) ----
            if (pos == 0 and warm and last_entry_sess != s and t + 1 < n
                    and filt_ok and seen_below and close[t] >= trigger):
                nxt = open_[t + 1]
                cond_long[t] = True
                pos = 1; entry_price = nxt; entry_sess = s
                mfe = nxt; last_entry_sess = s

        out["cond_long"]       = cond_long
        out["cond_short"]      = np.zeros(n, dtype=bool)
        out["bar_exit_long"]   = bar_exit_long
        out["bar_exit_short"]  = np.zeros(n, dtype=bool)
        out["entry_long"]      = cond_long
        out["entry_short"]     = np.zeros(n, dtype=bool)
        out["exit_long"]       = bar_exit_long
        out["exit_short"]      = np.zeros(n, dtype=bool)
        out["stop_price"]      = np.full(n, np.nan)
        out["exit_fill_long"]  = exit_fill_long
        out["exit_fill_short"] = np.full(n, np.nan)
        out["r1"]              = r1_overlay
        out["pivot"]           = pivot_overlay
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        warmup = 8 * 24  # a handful of sessions worth of bars (~24 bars/session)

        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]), "open": float(candle["open"]),
            "high": float(candle["high"]), "low": float(candle["low"]),
            "close": float(candle["close"]),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        df = pd.DataFrame(buf)
        time = df["time"].to_numpy().astype(float)
        sids = _session_ids(time)
        nS = int(sids[-1]) + 1
        if nS < 4:           # need 3 completed sessions + the forming one
            return None

        open_ = df["open"].to_numpy(); high = df["high"].to_numpy()
        low = df["low"].to_numpy(); close = df["close"].to_numpy()
        d_open, d_high, d_low, d_close, open_bar = _daily_from_sessions(
            time, open_, high, low, close, sids)

        tick      = float(p["tick_size"])
        entry_off = float(p["entry_offset_ticks"]) * tick
        use_pattern = bool(p.get("pattern_filter", True))
        use_vol     = bool(p.get("vol_contraction_filter", True))
        pv        = float(p["point_value"])
        stop_pts  = float(p["stop_dollars"])  / pv if pv > 0 else 0.0
        tgt_pts   = float(p["target_dollars"]) / pv if pv > 0 else 0.0
        be_pts    = float(p["breakeven_dollars"]) / pv if pv > 0 else 0.0
        be_off    = float(p["breakeven_offset_ticks"]) * tick
        max_days  = int(p["max_days"])

        cur_s = int(sids[-1])
        pivot, r1 = _pivots(d_high, d_low, d_close, cur_s)
        trigger = r1 - entry_off
        filt_ok = _filters_ok(d_high, d_low, cur_s, use_pattern, use_vol)

        ts = int(df["time"].iloc[-1])
        c = float(close[-1]); h = float(high[-1]); l = float(low[-1])

        pos = int(state.get("pos", 0))
        entry_p = float(state.get("entry_p", np.nan))
        entry_sess = int(state.get("entry_sess", -1))
        mfe = float(state.get("mfe", np.nan))
        last_entry_sess = int(state.get("last_entry_sess", -1))

        # Track "price traded below R1 this session" (TS arm), reset on a new session.
        seen_below = bool(state.get("seen_below", False))
        if state.get("seen_below_sess", -1) != cur_s:
            seen_below = False
        if c < r1:
            seen_below = True
        state["seen_below"] = seen_below
        state["seen_below_sess"] = cur_s

        if pos == 1 and np.isfinite(entry_p):
            mfe = max(mfe if np.isfinite(mfe) else h, h)
            state["mfe"] = mfe
            base_stop = entry_p - stop_pts
            be_armed = be_pts > 0 and (mfe - entry_p) >= be_pts
            stop_lvl = (entry_p + be_off) if be_armed else base_stop
            reason = None
            if stop_pts > 0 and l <= stop_lvl:
                reason = "breakeven" if be_armed else "stop"
            elif tgt_pts > 0 and h >= entry_p + tgt_pts:
                reason = "target"
            elif (cur_s - entry_sess) >= max_days:
                reason = "maxdays"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_sess": -1, "mfe": np.nan})
                return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
            return None

        if pos == 0 and last_entry_sess != cur_s and filt_ok and seen_below and c >= trigger:
            state.update({"pos": 1, "entry_p": c, "entry_sess": cur_s,
                          "mfe": c, "last_entry_sess": cur_s})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="r1_breakout")
        return None
