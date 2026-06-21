"""
Donchian Breakout (Intraday) — long/short 60m Donchian channel breakout with
daily/weekly context filters, a dual trailing/ATR stop, an end-of-day flatten,
breakeven lock, and a dollar stop + target.

Port of MultiCharts/TradeStation "Donchian Breakout - Intraday - QTLab Engine"
(docs/txt-strategies/[BK-ID-Donk-CL-001].txt), authored on @CL (WTI crude) on a
60min + 1380min (daily) dual-data chart. Original TS logic:

  data1 = 60min, data2 = daily session (1380m). p1=36, p3=6, N=5, mult=0.75.

  Filters (on the daily / weekly bar):
    MovingUp    = average(C of data2,100) > average(...)[1]   (100-day SMA rising)
    CloseStrong = C > H - (H-L)/N    of data2                 (daily close in top 20%)
    CloseWeak   = C < L + (H-L)/N    of data2                 (daily close in bottom 20%)
    vf2 (computed each Friday, then held all week):
        weekly body |OpenW-CloseW| <= mult * weekly range (HighW-LowW)
        i.e. the week did NOT close near its extremes (a non-trending week)

  Entry (flat, HighS<>LowS, entriestoday<1, 0200 < t < 1700):
    LONG  : CloseStrong=false AND MovingUp AND vf2 -> buy  next bar at highest(H,p1)-1tick STOP
    SHORT : vf2 (CloseWeak filter commented out)   -> sell next bar at lowest(L,p1)+1tick  STOP

  Exits:
    trailing (when t<>1700):
        long  -> sell        next bar at minlist(lowest(H,p3), h - AvgTrueRange(23)) STOP
        short -> buytocover  next bar at maxlist(highest(L,p3), l + AvgTrueRange(23)) STOP
    end-of-session (t>=1700): flatten next bar at close (limit)
    breakeven: once maxpositionprofit >= stp, stop -> entry +/- 10 ticks
    setstopcontract; setstoploss(stp=$1200); setprofittarget(tgt=$2400)   (per contract)

PORTING NOTES
-------------
1. ENTRY TIMING — true stop fills (Option-B entry side). TS arms buy/sell *stops*
   at the channel edge (highest(H,p1)/lowest(L,p1), current bar INCLUDED) and fills
   intrabar the moment price pierces them. The engine now supports this via the
   `entry_fill_long`/`entry_fill_short` columns (the entry-side twin of the existing
   exact-fill exits): at the order-placement bar `t` we read the channel through `t`,
   and if the NEXT bar pierces the level we fill there — gap-protected against the
   next bar's open (max(level, open) for a buy-stop, min for a sell-stop). This is an
   achievable live fill, NOT look-ahead (the level is committed before the fill bar).
   Earlier this was ported as a conservative close-confirmed next-open entry, which
   systematically entered a bar late and understated a breakout system; the
   "Look-Ahead vs Reality" exhibit was dominated by that artifact. Strategies that
   don't emit entry_fill columns are unaffected and still fill at next-bar open.

2. data2 (daily) is reconstructed from the 60m feed by grouping bars into sessions
   via time gaps (a gap > one bar = overnight/weekend/maintenance break). The daily
   CloseStrong/CloseWeak read the FORMING session's *running* high/low/close (causal,
   matching `... of data2[0]` intraday); MovingUp compares the 100-day SMA of the last
   two COMPLETED sessions (no look-ahead, near-constant intraday).

3. WEEKLY vf2 is replayed exactly as TS: a per-bar state recomputed on every Friday
   bar from that week's running OHLC and held until the next Friday (init True). Weeks
   are ET-calendar, Sunday-start (so the Sunday-evening Globex open and Mon-Fri group
   together, matching a futures weekly bar).

4. TIME-OF-DAY. TS `Time` is the bar-CLOSE in exchange (ET) time; our parquet stamps
   the bar-OPEN. So TS `t>0200 and t<1700` -> our ET open-hour in [2,15] (entries) and
   TS `t>=1700` -> our ET open-hour >= 16 (the session's last bar -> EoD flatten). The
   trailing stop is active on every non-EoD bar (TS `t<>1700`). Hours are configurable.

5. STOPS. The binding long exit-stop on any bar = the HIGHEST of {dollar stop, armed
   breakeven, active trailing} (the one closest below price fills first as price falls);
   shorts mirror it. Within a bar the adverse stop is taken before the favorable target
   (conservative, no Look-Inside-Bar). Exits use Option-B exact fills (the stop/target/
   BE level, gap-protected against the bar open; EoD fills at the bar close) — same
   mechanism as rsi2_reversion / lunar / pivot_breakout.

Runs on our 60m CME futures data. CL auto-sizes as $1000/pt × contracts (contract_size
1000 in data/assets/databento.json); `point_value`/`tick_size` default to CL and have
per-symbol overrides in SYMBOL_DEFAULTS for the other catalog futures.
"""
from __future__ import annotations

from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.session_utils import et_ordinal_days

_ET_ZONE = ZoneInfo("America/New_York")


# ---------------------------------------------------------------------------
# Session / daily reconstruction (shared shape with rsi2 / pivot / lunar)
# ---------------------------------------------------------------------------

def _session_ids(times: np.ndarray) -> np.ndarray:
    """Session id per bar — increments on a time gap > 1 bar (overnight / weekend
    / the daily maintenance break, all > 3600s on a 60m feed)."""
    ids = np.zeros(len(times), dtype=np.int64)
    for i in range(1, len(times)):
        ids[i] = ids[i - 1] + (1 if times[i] - times[i - 1] > 3600 else 0)
    return ids


def _daily_from_sessions(time_a, open_a, high_a, low_a, close_a, sids):
    """Per-session (daily) OHLC arrays + the index of each session's open bar."""
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


def _et_fields(time_a):
    """(ET open-hour, ET weekday Mon=0, ET Sunday-start week id) per bar.

    weekday/week are derived from the ET *calendar date* (so the 18:00-ET Globex
    open carries that evening's date); 1970-01-01 is ordinal 0 = Thursday, and
    1970-01-04 (ordinal 3) is a Sunday, hence the +3 / -3 constants."""
    arr = np.asarray(time_a, dtype="int64")
    et_hour = np.asarray(pd.to_datetime(arr, unit="s", utc=True)
                         .tz_convert(_ET_ZONE).hour, dtype=np.int64)
    ordinal = et_ordinal_days(arr).astype(np.int64)
    weekday = (ordinal + 3) % 7                 # Mon=0 .. Sun=6
    week_id = np.floor_divide(ordinal - 3, 7)   # Sunday-start trading week
    return et_hour, weekday, week_id


# ---------------------------------------------------------------------------
# Per-bar features (pure functions of the price series — no position state).
# Computed once over the full df (vectorized) or over the live buffer (on_candle)
# so the indicator math lives in exactly one place.
# ---------------------------------------------------------------------------

class _Features:
    __slots__ = ("n", "sids", "chan_high", "chan_low", "trig_long", "trig_short",
                 "trail_long", "trail_short", "moving_up", "close_strong",
                 "close_weak", "vf2", "in_window", "is_eod", "flat_guard", "same_next")


def _features(time_a, open_a, high_a, low_a, close_a, p) -> _Features:
    n = len(time_a)
    f = _Features()
    f.n = n
    if n == 0:
        empty_b = np.zeros(0, dtype=bool); empty_f = np.zeros(0)
        f.sids = np.zeros(0, dtype=np.int64)
        f.chan_high = f.chan_low = f.trig_long = f.trig_short = empty_f
        f.trail_long = f.trail_short = empty_f
        f.moving_up = f.close_strong = f.close_weak = f.vf2 = empty_b
        f.in_window = f.is_eod = f.flat_guard = f.same_next = empty_b
        return f

    p1       = int(p["donchian_length"])
    p3       = int(p["trail_length"])
    n_div    = float(p["close_strength_div"])
    atr_len  = int(p["atr_length"])
    sma_len  = int(p["sma_daily_length"])
    mult     = float(p["weekly_body_mult"])
    tick     = float(p["tick_size"])
    entry_off = float(p["entry_offset_ticks"]) * tick   # MultiCharts "1 point" = 1 tick (MinMove/PriceScale)
    h_start  = int(p["entry_start_hour"])
    h_end    = int(p["entry_end_hour"])
    h_eod    = int(p["eod_hour"])

    high = pd.Series(high_a); low = pd.Series(low_a); close = pd.Series(close_a)

    # --- Donchian channel (TS highest(H,p1)/lowest(L,p1) — INCLUDES the current
    #     bar). Read at the order-placement bar t, it is the standing buy-/sell-stop
    #     level for bar t+1. `trig_*` fold in the 1-tick anticipation (TS '-1/+1');
    #     `chan_*` are the raw channel for the chart overlay.
    chan_high = high.rolling(p1).max()
    chan_low  = low.rolling(p1).min()
    f.chan_high  = chan_high.to_numpy()
    f.chan_low   = chan_low.to_numpy()
    f.trig_long  = (chan_high - entry_off).to_numpy()   # buy-stop level for next bar
    f.trig_short = (chan_low + entry_off).to_numpy()     # sell-stop level for next bar

    # --- AvgTrueRange(atr_len): EL AvgTrueRange = SIMPLE average of TrueRange.
    prev_close = close.shift(1)
    tr = pd.concat([(high - low).abs(),
                    (high - prev_close).abs(),
                    (low - prev_close).abs()], axis=1).max(axis=1)
    tr.iloc[0] = high.iloc[0] - low.iloc[0]
    atr = tr.rolling(atr_len).mean()

    # --- Trailing-stop levels for bar t, computed from data <= t-1 (TS places the
    #     stop at bar t-1's close for bar t): min/max of the p3 highs/lows and the
    #     prior bar's high/low -/+ ATR.
    lh_p3 = high.rolling(p3).min().shift(1)
    hl_p3 = low.rolling(p3).max().shift(1)
    f.trail_long  = np.minimum(lh_p3, high.shift(1) - atr.shift(1)).to_numpy()
    f.trail_short = np.maximum(hl_p3, low.shift(1) + atr.shift(1)).to_numpy()

    # --- Session structure + daily reconstruction
    sids = _session_ids(np.asarray(time_a, dtype="float64"))
    f.sids = sids
    nS = int(sids[-1]) + 1
    d_open, d_high, d_low, d_close, open_bar = _daily_from_sessions(
        time_a, open_a, high_a, low_a, close_a, sids)

    # --- MovingUp: 100-day SMA rising, from the last two COMPLETED sessions.
    #     moving_up_sess[s] compares SMA(closes ending s-1) vs SMA(ending s-2);
    #     uses only sessions < s (causal). Default True (TS var init MovingUp=true).
    prefix = np.concatenate([[0.0], np.cumsum(d_close)]) if nS else np.array([0.0])
    moving_up_sess = np.ones(nS, dtype=bool)
    for s in range(sma_len + 1, nS):
        cur = (prefix[s]     - prefix[s - sma_len])     / sma_len
        prv = (prefix[s - 1] - prefix[s - 1 - sma_len]) / sma_len
        moving_up_sess[s] = cur > prv
    f.moving_up = moving_up_sess[sids]

    # --- Forward pass: running session OHLC (for CloseStrong/Weak + flat guard)
    #     and the weekly vf2 replay.
    et_hour, weekday, week_id = _et_fields(time_a)

    sess_high_run = np.empty(n); sess_low_run = np.empty(n)
    cur_s = -1; sh = -np.inf; sl = np.inf
    cur_w = -2; w_open = np.nan; w_high = -np.inf; w_low = np.inf
    vf2_arr = np.empty(n, dtype=bool)
    vf2_state = True   # TS: var vf2(true)
    for t in range(n):
        s = sids[t]
        if s != cur_s:
            cur_s = s; sh = high_a[t]; sl = low_a[t]
        else:
            if high_a[t] > sh: sh = high_a[t]
            if low_a[t]  < sl: sl = low_a[t]
        sess_high_run[t] = sh; sess_low_run[t] = sl

        wk = week_id[t]
        if wk != cur_w:
            cur_w = wk; w_open = open_a[t]; w_high = high_a[t]; w_low = low_a[t]
        else:
            if high_a[t] > w_high: w_high = high_a[t]
            if low_a[t]  < w_low:  w_low  = low_a[t]
        if weekday[t] == 4:   # Friday -> recompute vf2 from the forming week
            rng = max(w_high - w_low, 1e-4)
            bdy = abs(w_open - close_a[t])
            vf2_state = bool(bdy <= mult * rng)
        vf2_arr[t] = vf2_state

    rngS = sess_high_run - sess_low_run
    f.close_strong = close_a > (sess_high_run - rngS / n_div)
    f.close_weak   = close_a < (sess_low_run + rngS / n_div)
    f.vf2 = vf2_arr
    f.in_window = (et_hour >= h_start) & (et_hour <= h_end)
    # "Last bar of a session" = the next bar starts a new session (or is the final
    # bar). Used to block entries whose next-bar fill would land in the NEXT session
    # (a cross-gap, non-intraday fill).
    same_next = np.zeros(n, dtype=bool)
    if n > 1:
        same_next[:-1] = sids[1:] == sids[:-1]
    f.same_next = same_next
    # EoD flatten fires ONLY at the ET `eod_hour`, exactly like TS `If T>=1700`.
    # We deliberately do NOT also flatten on a session's last bar: TS has no such
    # backstop, so on early-close/holiday days the position rides to the next
    # session's stops/EoD just as it does in TradeStation.
    f.is_eod = (et_hour >= h_eod)
    f.flat_guard = sess_high_run != sess_low_run
    return f


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class DonchianBreakoutStrategy(Strategy):
    # When True, shorts are blocked while the daily trend is up (MovingUp) — i.e.
    # only short when the 100-day SMA is falling. False = faithful TS port (shorts
    # fire regardless of trend). The trend-filtered variant subclass flips this on.
    SHORT_TREND_FILTER = False

    # When True, every protective / profit-taking exit is disabled (dollar stop,
    # dollar target, ATR-channel trailing stop, breakeven lock) and the position
    # rides to the end-of-day flatten — a "naked breakout, flat by the close"
    # variant. Default False preserves the full TS exit stack. The Naked-EoD
    # subclass (donchian_breakout_eod.py) flips this on; the Exits-group params
    # are then inert. An EoD-only exit samples just the session close (where the
    # roll/back-adjust offset cancels against the entry), so its P&L is largely
    # data-feed-independent — the point of the variant.
    EXITS_EOD_ONLY = False

    PARAM_SCHEMA = [
        # --- Donchian channel / entry
        ParamSpec("donchian_length", ParamType.INT, 36, min=5, max=200, step=1, group="Donchian",
                  description="Breakout channel: highest-high / lowest-low of the prior N 60m bars "
                              "(current bar excluded). TS p1=36."),
        ParamSpec("entry_offset_ticks", ParamType.FLOAT, 1.0, min=0.0, max=20.0, step=1.0, group="Donchian",
                  description="Anticipate the breakout by this many ticks. MultiCharts '-1/+1 point' = one "
                              "minimum tick (its `Point` = MinMove/PriceScale = 0.01 on CL), so this is 1 "
                              "tick: long buy-stop at channel_high - offset, short sell-stop at channel_low + offset."),

        # --- Daily / weekly filters
        ParamSpec("use_moving_up_filter", ParamType.BOOL, True, group="Filters",
                  description="LONG only: require the daily SMA to be rising (MovingUp)."),
        ParamSpec("sma_daily_length", ParamType.INT, 100, min=10, max=300, step=5, group="Filters",
                  description="Daily-SMA length for the MovingUp trend filter (TS 100, on data2)."),
        ParamSpec("use_close_strong_filter", ParamType.BOOL, True, group="Filters",
                  description="LONG only: block when the daily close is in the top 1/N of its range "
                              "(CloseStrong) — don't chase an already-extended day."),
        ParamSpec("use_close_weak_filter", ParamType.BOOL, False, group="Filters",
                  description="SHORT only: block when the daily close is in the bottom 1/N of its "
                              "range (CloseWeak). OFF to match TS (this filter was commented out)."),
        ParamSpec("close_strength_div", ParamType.FLOAT, 5.0, min=2.0, max=20.0, step=1.0, group="Filters",
                  description="Range divisor N for CloseStrong/CloseWeak (TS N=5 -> top/bottom 20%)."),
        ParamSpec("use_weekly_filter", ParamType.BOOL, True, group="Filters",
                  description="Both sides: require vf2 — last/this week's body <= mult x its range "
                              "(a non-trending week). Recomputed each Friday, held all week."),
        ParamSpec("weekly_body_mult", ParamType.FLOAT, 0.75, min=0.1, max=2.0, step=0.05, group="Filters",
                  description="vf2 threshold: weekly |open-close| <= this x weekly (high-low). TS 0.75."),

        # --- Time-of-day (ET, bar-OPEN basis; see module docstring)
        ParamSpec("entry_start_hour", ParamType.INT, 2, min=0, max=23, step=1, group="Session",
                  description="Earliest ET open-hour for new entries (TS t>0200 -> 2)."),
        ParamSpec("entry_end_hour", ParamType.INT, 15, min=0, max=23, step=1, group="Session",
                  description="Latest ET open-hour for new entries, inclusive (TS t<1700 -> 15)."),
        ParamSpec("eod_hour", ParamType.INT, 16, min=0, max=23, step=1, group="Session",
                  description="ET open-hour of the session's last bar; flatten at its close and "
                              "disable the trailing stop on it (TS t>=1700 -> 16)."),

        # --- Exits
        ParamSpec("trail_length", ParamType.INT, 6, min=1, max=60, step=1, group="Exits",
                  description="Trailing-stop channel: lowest-high / highest-low of the last N bars "
                              "(TS p3=6), floored/capped by high-/low +/- ATR."),
        ParamSpec("atr_length", ParamType.INT, 23, min=2, max=100, step=1, group="Exits",
                  description="AvgTrueRange length (simple) for the trailing stop (TS 23, on 60m)."),
        ParamSpec("stop_dollars", ParamType.FLOAT, 1200.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Per-contract dollar stop (TS setstoploss 1200). entry -/+ stop$/point_value. 0 disables."),
        ParamSpec("target_dollars", ParamType.FLOAT, 2400.0, min=0.0, max=100000.0, step=25.0, group="Exits",
                  description="Per-contract dollar target (TS setprofittarget 2400). 0 disables."),
        ParamSpec("breakeven_trigger_dollars", ParamType.FLOAT, 1200.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Once open MFE reaches this many $/contract, lock the stop to breakeven "
                              "+ offset (TS: maxpositionprofit >= stp). 0 disables breakeven."),
        ParamSpec("breakeven_offset_ticks", ParamType.FLOAT, 10.0, min=0.0, max=100.0, step=1.0, group="Exits",
                  description="Breakeven stop sits this many ticks beyond entry once armed (TS 10)."),

        # --- Instrument / risk
        ParamSpec("tick_size", ParamType.FLOAT, 0.01, min=0.0001, max=10.0, step=0.01, group="Risk",
                  description="Instrument tick size (CL 0.01). Used for the entry & breakeven offsets."),
        ParamSpec("point_value", ParamType.FLOAT, 1000.0, min=0.01, max=10000.0, step=1.0, group="Risk",
                  description="$ per 1.0 price move per contract (CL $1000). Converts the dollar "
                              "stop/target/BE to price levels."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures contracts per trade (TS nCon). Futures size as contracts x point_value."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Only used if the instrument isn't contract-sized — % of equity per trade."),

        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction"),

        ParamSpec("look_ahead", ParamType.BOOL, False, group="Execution",
                  description="⚠ LOOK-AHEAD (fictitious, NOT tradeable; default OFF): fills entries at the bar's "
                              "most favorable extreme (the low for longs, the high for shorts) — a "
                              "perfect-foresight ceiling, not an achievable live fill. Turn OFF for "
                              "the realistic, tradeable result. The engine flags every such run "
                              "look_ahead=True so the UI badges it."),
    ]

    META = StrategyMeta(
        id="donchian_breakout",
        name="Donchian Breakout (Intraday) - CL 1H",
        description=("Intraday 60m Donchian channel breakout (long & short) gated by a rising-daily-SMA "
                     "trend filter, a daily close-strength filter, and a weekly non-trending (vf2) filter. "
                     "Exits on a trailing/ATR stop, an end-of-day flatten, a breakeven lock, or a dollar "
                     "stop/target. Ported from the @CL TS QTLab engine."),
        schema=PARAM_SCHEMA,
    )

    # Per-symbol point_value / tick_size for the catalog futures. Defaults above
    # are CL; Reset Defaults applies these when another symbol is active.
    SYMBOL_DEFAULTS = {
        "CL":  {"point_value": 1000.0, "tick_size": 0.01},
        "GC":  {"point_value": 100.0,  "tick_size": 0.10},
        "ES":  {"point_value": 50.0,   "tick_size": 0.25},
        "NQ":  {"point_value": 20.0,   "tick_size": 0.25},
        "MES": {"point_value": 5.0,    "tick_size": 0.25},
        "MNQ": {"point_value": 2.0,    "tick_size": 0.25},
    }

    OVERLAYS = [
        OverlaySpec("donch_high", "Donchian High", from_column="donch_high",
                    color="rgba(34,211,238,0.6)", line_width=1),
        OverlaySpec("donch_low",  "Donchian Low",  from_column="donch_low",
                    color="rgba(248,113,113,0.6)", line_width=1),
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

        f = _features(time, open_, high, low, close, p)

        pv        = float(p["point_value"])
        tick      = float(p["tick_size"])
        stop_pts  = float(p["stop_dollars"])   / pv if pv > 0 else 0.0
        tgt_pts   = float(p["target_dollars"]) / pv if pv > 0 else 0.0
        be_trig   = float(p["breakeven_trigger_dollars"])
        be_off    = float(p["breakeven_offset_ticks"]) * tick
        sides     = p["sides"]
        long_on   = bool(sides.get("long"))
        short_on  = bool(sides.get("short"))
        use_mu    = bool(p["use_moving_up_filter"])
        use_cs    = bool(p["use_close_strong_filter"])
        use_cw    = bool(p["use_close_weak_filter"])
        use_vf2   = bool(p["use_weekly_filter"])

        cond_long       = np.zeros(n, dtype=bool)
        cond_short      = np.zeros(n, dtype=bool)
        bar_exit_long   = np.zeros(n, dtype=bool)
        bar_exit_short  = np.zeros(n, dtype=bool)
        exit_fill_long  = np.full(n, np.nan)
        exit_fill_short = np.full(n, np.nan)
        entry_fill_long  = np.full(n, np.nan)
        entry_fill_short = np.full(n, np.nan)

        sids = f.sids
        pos = 0; entry_price = np.nan; mfe = np.nan
        last_entry_sess = -1

        for t in range(n):
            o = open_[t]; h = high[t]; l = low[t]; c = close[t]
            s = int(sids[t])

            # ---- Exit processing (in a position) ----
            if pos != 0 and np.isfinite(entry_price):
                is_eod = bool(f.is_eod[t])
                reason = None; fill = np.nan
                if pos == 1:
                    if h > mfe: mfe = h
                    eff_stop = entry_price - stop_pts if stop_pts > 0 else -np.inf
                    if be_trig > 0 and (mfe - entry_price) * pv >= be_trig:
                        eff_stop = max(eff_stop, entry_price + be_off)
                    if (not is_eod) and np.isfinite(f.trail_long[t]):
                        eff_stop = max(eff_stop, f.trail_long[t])
                    if self.EXITS_EOD_ONLY:          # naked variant: ride to the EoD flatten
                        eff_stop = -np.inf
                    tgt = entry_price + tgt_pts
                    if eff_stop > -np.inf and l <= eff_stop:
                        reason = "stop"; fill = min(eff_stop, o)
                    elif tgt_pts > 0 and not self.EXITS_EOD_ONLY and h >= tgt:
                        reason = "target"; fill = max(tgt, o)
                    elif is_eod:
                        reason = "eod"; fill = c
                    if reason:
                        bar_exit_long[t] = True; exit_fill_long[t] = fill
                        pos = 0; entry_price = np.nan; mfe = np.nan
                else:  # pos == -1
                    if l < mfe: mfe = l
                    eff_stop = entry_price + stop_pts if stop_pts > 0 else np.inf
                    if be_trig > 0 and (entry_price - mfe) * pv >= be_trig:
                        eff_stop = min(eff_stop, entry_price - be_off)
                    if (not is_eod) and np.isfinite(f.trail_short[t]):
                        eff_stop = min(eff_stop, f.trail_short[t])
                    if self.EXITS_EOD_ONLY:          # naked variant: ride to the EoD flatten
                        eff_stop = np.inf
                    tgt = entry_price - tgt_pts
                    if eff_stop < np.inf and h >= eff_stop:
                        reason = "stop"; fill = max(eff_stop, o)
                    elif tgt_pts > 0 and not self.EXITS_EOD_ONLY and l <= tgt:
                        reason = "target"; fill = min(tgt, o)
                    elif is_eod:
                        reason = "eod"; fill = c
                    if reason:
                        bar_exit_short[t] = True; exit_fill_short[t] = fill
                        pos = 0; entry_price = np.nan; mfe = np.nan

            # ---- Entry: STOP orders (TS faithful). Filters/window are checked on
            #      the order-placement bar t; the buy-/sell-stop is live for bar t+1
            #      and fills if t+1 pierces the channel level, at that level
            #      gap-protected against t+1's open. cond_*[t] + entry_fill_*[t] tell
            #      the engine to fill at bar t+1 at that exact price.
            if (pos == 0 and last_entry_sess != s and t + 1 < n
                    and bool(f.in_window[t]) and bool(f.flat_guard[t])
                    and bool(f.same_next[t])):
                vf2_ok = (not use_vf2) or bool(f.vf2[t])
                long_ok = (vf2_ok
                           and (not use_mu or bool(f.moving_up[t]))
                           and (not use_cs or not bool(f.close_strong[t])))
                short_ok = (vf2_ok
                            and (not use_cw or not bool(f.close_weak[t]))
                            and (not self.SHORT_TREND_FILTER or not bool(f.moving_up[t])))
                nxt_o = open_[t + 1]; nxt_h = high[t + 1]; nxt_l = low[t + 1]
                took = False
                if (long_on and long_ok and np.isfinite(f.trig_long[t])
                        and nxt_h >= f.trig_long[t]):
                    fill = max(f.trig_long[t], nxt_o)   # buy-stop, gap-protected
                    cond_long[t] = True; entry_fill_long[t] = fill
                    pos = 1; entry_price = fill; mfe = fill; last_entry_sess = s
                    took = True
                if (not took and short_on and short_ok and np.isfinite(f.trig_short[t])
                        and nxt_l <= f.trig_short[t]):
                    fill = min(f.trig_short[t], nxt_o)  # sell-stop, gap-protected
                    cond_short[t] = True; entry_fill_short[t] = fill
                    pos = -1; entry_price = fill; mfe = fill; last_entry_sess = s

        out["cond_long"]       = cond_long
        out["cond_short"]      = cond_short
        out["bar_exit_long"]   = bar_exit_long
        out["bar_exit_short"]  = bar_exit_short
        out["entry_long"]      = cond_long
        out["entry_short"]     = cond_short
        out["exit_long"]       = bar_exit_long
        out["exit_short"]      = bar_exit_short
        out["stop_price"]      = np.full(n, np.nan)
        out["exit_fill_long"]  = exit_fill_long
        out["exit_fill_short"] = exit_fill_short
        out["entry_fill_long"]  = entry_fill_long   # Option-B entry fills (stop levels)
        out["entry_fill_short"] = entry_fill_short
        out["donch_high"] = f.chan_high   # raw channel for the chart overlay
        out["donch_low"]  = f.chan_low
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        # Warm up enough sessions for the 100-day SMA + a few weeks for vf2.
        warmup = (int(p["sma_daily_length"]) + 6) * 24

        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]), "open": float(candle["open"]),
            "high": float(candle["high"]), "low": float(candle["low"]),
            "close": float(candle["close"]),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        df = pd.DataFrame(buf)
        time  = df["time"].to_numpy().astype(float)
        open_ = df["open"].to_numpy(); high = df["high"].to_numpy()
        low   = df["low"].to_numpy();  close = df["close"].to_numpy()
        n = len(df)
        if n < max(int(p["donchian_length"]), int(p["atr_length"])) + 2:
            return None

        f = _features(time, open_, high, low, close, p)
        i = n - 1   # the just-closed bar
        if int(f.sids[i]) < 2:
            return None

        pv      = float(p["point_value"]); tick = float(p["tick_size"])
        stop_pts = float(p["stop_dollars"])   / pv if pv > 0 else 0.0
        tgt_pts  = float(p["target_dollars"]) / pv if pv > 0 else 0.0
        be_trig  = float(p["breakeven_trigger_dollars"])
        be_off   = float(p["breakeven_offset_ticks"]) * tick
        sides    = p["sides"]
        use_mu   = bool(p["use_moving_up_filter"]); use_cs = bool(p["use_close_strong_filter"])
        use_cw   = bool(p["use_close_weak_filter"]); use_vf2 = bool(p["use_weekly_filter"])

        o = float(open_[i]); h = float(high[i]); l = float(low[i]); c = float(close[i])
        ts = int(time[i]); sids = f.sids; s = int(sids[i])

        pos      = int(state.get("pos", 0))
        entry_p  = float(state.get("entry_p", np.nan))
        mfe      = float(state.get("mfe", np.nan))

        # ---- Exit ----
        if pos != 0 and np.isfinite(entry_p):
            is_eod = bool(f.is_eod[i])
            reason = None
            if pos == 1:
                mfe = max(mfe if np.isfinite(mfe) else h, h)
                eff_stop = entry_p - stop_pts if stop_pts > 0 else -np.inf
                if be_trig > 0 and (mfe - entry_p) * pv >= be_trig:
                    eff_stop = max(eff_stop, entry_p + be_off)
                if (not is_eod) and np.isfinite(f.trail_long[i]):
                    eff_stop = max(eff_stop, float(f.trail_long[i]))
                if self.EXITS_EOD_ONLY:                       # naked variant: ride to the EoD flatten
                    eff_stop = -np.inf
                if eff_stop > -np.inf and l <= eff_stop:      reason = "stop"
                elif tgt_pts > 0 and not self.EXITS_EOD_ONLY and h >= entry_p + tgt_pts:  reason = "target"
                elif is_eod:                                  reason = "eod"
                state["mfe"] = mfe
                if reason:
                    state.update({"pos": 0, "entry_p": np.nan, "mfe": np.nan})
                    return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
                return None
            else:  # pos == -1
                mfe = min(mfe if np.isfinite(mfe) else l, l)
                eff_stop = entry_p + stop_pts if stop_pts > 0 else np.inf
                if be_trig > 0 and (entry_p - mfe) * pv >= be_trig:
                    eff_stop = min(eff_stop, entry_p - be_off)
                if (not is_eod) and np.isfinite(f.trail_short[i]):
                    eff_stop = min(eff_stop, float(f.trail_short[i]))
                if self.EXITS_EOD_ONLY:                       # naked variant: ride to the EoD flatten
                    eff_stop = np.inf
                if eff_stop < np.inf and h >= eff_stop:       reason = "stop"
                elif tgt_pts > 0 and not self.EXITS_EOD_ONLY and l <= entry_p - tgt_pts:  reason = "target"
                elif is_eod:                                  reason = "eod"
                state["mfe"] = mfe
                if reason:
                    state.update({"pos": 0, "entry_p": np.nan, "mfe": np.nan})
                    return Signal(side="short", kind="exit", price=c, time=ts, reason=reason)
                return None

        # ---- Entry: STOP orders. The standing buy-/sell-stop for THIS bar (i) was
        #      placed at the prior bar's close (i-1) from the channel through i-1, and
        #      fills if bar i pierced it — at that level, gap-protected against bar i's
        #      open. Mirrors the vectorized stop model (placement bar i-1, fill bar i).
        if i < 1 or sids[i - 1] != s:
            return None   # need a prior in-session bar that placed the order
        # One-entry-per-session, keyed by the session-open timestamp (stable across
        # buffer rebuilds, unlike the buffer-relative session id).
        j = i
        while j > 0 and sids[j - 1] == s:
            j -= 1
        sess_open_ts = int(time[j])
        if int(state.get("last_entry_sess_ts", -1)) == sess_open_ts:
            return None
        k = i - 1   # order-placement bar
        if not (bool(f.in_window[k]) and bool(f.flat_guard[k])):
            return None
        vf2_ok = (not use_vf2) or bool(f.vf2[k])
        long_ok = (vf2_ok and (not use_mu or bool(f.moving_up[k]))
                   and (not use_cs or not bool(f.close_strong[k])))
        short_ok = (vf2_ok and (not use_cw or not bool(f.close_weak[k]))
                    and (not self.SHORT_TREND_FILTER or not bool(f.moving_up[k])))

        if (sides.get("long") and long_ok and np.isfinite(f.trig_long[k]) and h >= float(f.trig_long[k])):
            fill = max(float(f.trig_long[k]), o)   # buy-stop, gap-protected
            state.update({"pos": 1, "entry_p": fill, "mfe": fill, "last_entry_sess_ts": sess_open_ts})
            return Signal(side="long", kind="entry", price=fill, time=ts, reason="donchian_breakout")
        if (sides.get("short") and short_ok and np.isfinite(f.trig_short[k]) and l <= float(f.trig_short[k])):
            fill = min(float(f.trig_short[k]), o)  # sell-stop, gap-protected
            state.update({"pos": -1, "entry_p": fill, "mfe": fill, "last_entry_sess_ts": sess_open_ts})
            return Signal(side="short", kind="entry", price=fill, time=ts, reason="donchian_breakdown")
        return None
