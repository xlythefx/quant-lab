"""
RSI-2 Reversion (Long) — daily RSI(2) mean reversion in an uptrend.

Port of MultiCharts/TradeStation "Mean Reverting - Multiday - RSI Engine - Long Only"
(docs/txt-strategies/[MR-MD-RSI-ES-001].txt). Original TS logic:

  DailySMA200 = AverageFC(c, 200) of data2          (200-bar SMA on the DAILY bar)
  DailyRSI    = RSI(c, 2) of data2                  (Wilder RSI-2 on the daily close)

  Entry (long only, once/day, HighS<>LowS flat-bar guard):
    today daily range > yesterday daily range       (volatility-expansion filter)
    AND daily close > DailySMA200                    (uptrend filter)
    AND DailyRSI < 20                                (oversold)
      -> Buy next bar at open

  Exits:
    barssinceentry >= ~10 days     -> exit at close   (maxbars)
    DailyRSI > 80                  -> exit next bar at open (overbought)
    setstoploss(1750-ish 1400)     -> hard $ stop (entry - stop$/pv)
    maxpositionprofit >= stop$     -> stop tightens to entry - stop$/pv * 0.5
                                       (profit-protect: cap loss to half the stop)

Like Lunar, `data2` (the daily bar) is reconstructed from the intraday feed by
grouping bars into sessions via time gaps, and the daily indicators are evaluated
on the FORMING session (today's running bar) on every intraday bar — matching
`... of data2[0]`. Runs on our existing 60m ES data; ES auto-sizes as $50/pt.
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
        # contiguous run of session s
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


def _wilder_rsi_components(dc: np.ndarray, period: int):
    """Wilder avg-gain / avg-loss arrays (one per completed daily close)."""
    n = len(dc)
    ag = np.zeros(n); al = np.zeros(n)
    if n == 0:
        return ag, al
    a = 1.0 / period
    for s in range(1, n):
        diff = dc[s] - dc[s - 1]
        gain = diff if diff > 0 else 0.0
        loss = -diff if diff < 0 else 0.0
        ag[s] = ag[s - 1] * (1 - a) + gain * a
        al[s] = al[s - 1] * (1 - a) + loss * a
    return ag, al


def _rsi_from(ag: float, al: float) -> float:
    if al <= 1e-12:
        return 100.0 if ag > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + ag / al)


class Rsi2ReversionStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("rsi_period",     ParamType.INT, 2,  min=2, max=30, step=1, group="RSI",
                  description="Wilder RSI period on the daily close (TS: 2)."),
        ParamSpec("rsi_oversold",   ParamType.INT, 10, min=5,  max=50, step=1, group="RSI",
                  description="Enter long when daily RSI < this (oversold). TS used 20; 10 is "
                              "more selective and tested better on our ES data (higher PF, lower DD)."),
        ParamSpec("rsi_overbought", ParamType.INT, 80, min=50, max=95, step=1, group="RSI",
                  description="Exit when daily RSI > this (overbought)."),

        ParamSpec("sma_period", ParamType.INT, 200, min=10, max=400, step=5, group="Trend",
                  description="Daily SMA length; only buy when daily close is above it."),
        ParamSpec("range_filter", ParamType.BOOL, False, group="Trend",
                  description="Require today's daily range > yesterday's (volatility expansion). "
                              "TS had this ON; it overfit to 2008-2018 and drags on 2016-2026, so "
                              "default OFF. Turn on to match the original."),

        ParamSpec("stop_dollars", ParamType.FLOAT, 1400.0, min=0.0, max=50000.0, step=25.0, group="Exits",
                  description="Hard stop in dollars (TS setstoploss). entry - stop$/point_value."),
        ParamSpec("point_value", ParamType.FLOAT, 50.0, min=0.01, max=10000.0, step=1.0, group="Exits",
                  description="$ per 1-point move (ES: $50). Converts the dollar stop to a price level."),
        ParamSpec("profit_lock_frac", ParamType.FLOAT, 0.5, min=0.0, max=1.0, step=0.05, group="Exits",
                  description="Once MFE >= stop$, tighten the stop to entry - stop$/pv x this "
                              "(TS: 0.5 -> caps the loss to half the stop after a full-stop profit)."),
        ParamSpec("max_days", ParamType.INT, 10, min=1, max=60, step=1, group="Exits",
                  description="Force-close after this many sessions in the trade (TS nBarExit ~10d)."),

        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures contracts per trade (TS nCon). ES sizes as contracts x $50/pt."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Only used if the instrument isn't contract-sized — % of equity per trade."),
    ]

    META = StrategyMeta(
        id="rsi2_reversion",
        name="RSI-2 Reversion (Long)",
        description=("Daily RSI(2) mean reversion, long-only. Buys oversold (RSI<20) dips in an "
                     "uptrend (price > 200-day SMA) on volatility-expansion days; exits on "
                     "RSI>80, a dollar stop with profit-protect, or after ~10 days."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("sma", "Daily SMA", from_column="sma", color="#fbbf24", line_width=2),
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

        rsi_p    = int(p["rsi_period"])
        sma_p    = int(p["sma_period"])
        oversold = float(p["rsi_oversold"])
        overb    = float(p["rsi_overbought"])
        use_range = bool(p.get("range_filter", True))
        stop_dlr = float(p["stop_dollars"])
        pv       = float(p["point_value"])
        lock_f   = float(p["profit_lock_frac"])
        max_days = int(p["max_days"])
        stop_pts = stop_dlr / pv if pv > 0 else 0.0

        # Wilder RSI components on completed daily closes + SMA prefix sums.
        ag, al = _wilder_rsi_components(d_close, rsi_p)
        prefix = np.concatenate([[0.0], np.cumsum(d_close)]) if nS else np.array([0.0])  # prefix[k]=sum(d_close[:k])
        d_range = d_high - d_low

        cond_long      = np.zeros(n, dtype=bool)
        bar_exit_long  = np.zeros(n, dtype=bool)
        exit_fill_long = np.full(n, np.nan)
        sma_overlay    = np.full(n, np.nan)

        a = 1.0 / rsi_p
        pos = 0
        entry_price = np.nan
        entry_idx = -1
        entry_sess = -1
        mfe = np.nan
        last_entry_sess = -1

        # forming-session running OHLC
        f_high = -np.inf
        f_low  = np.inf
        cur_s  = -1

        for t in range(n):
            s = int(sids[t])
            if s != cur_s:               # new session opened on this bar
                cur_s = s
                f_high = high[t]
                f_low  = low[t]
            else:
                if high[t] > f_high: f_high = high[t]
                if low[t]  < f_low:  f_low  = low[t]

            f_close = close[t]
            warm = s >= sma_p and s >= 2  # need SMA window + a prior session

            # Forming daily RSI(2) / SMA(200) using the last completed session (s-1).
            rsi_prov = np.nan
            sma_prov = np.nan
            range_ok = False
            if warm:
                pc = d_close[s - 1]
                diff = f_close - pc
                gp = ag[s - 1] * (1 - a) + (diff if diff > 0 else 0.0) * a
                lp = al[s - 1] * (1 - a) + (-diff if diff < 0 else 0.0) * a
                rsi_prov = _rsi_from(gp, lp)
                # SMA over last (sma_p-1) completed closes + the forming close.
                csum = prefix[s] - prefix[s - (sma_p - 1)]   # d_close[s-(sma_p-1) .. s-1]
                sma_prov = (csum + f_close) / sma_p
                sma_overlay[t] = sma_prov
                range_ok = (not use_range) or ((f_high - f_low) > d_range[s - 1])

            # ---- Exit processing (in a long position) ----
            if pos == 1 and np.isfinite(entry_price):
                if f_high > mfe:
                    mfe = f_high
                o = open_[t]
                reason = None
                stop_lvl = entry_price - stop_pts
                if (mfe - entry_price) >= stop_pts and stop_pts > 0:
                    stop_lvl = entry_price - stop_pts * lock_f   # profit-protect (tighter)
                if low[t] <= stop_lvl:
                    reason = "stop"
                elif warm and np.isfinite(rsi_prov) and rsi_prov > overb:
                    reason = "rsi_overbought"
                elif (s - entry_sess) >= max_days:
                    reason = "maxdays"
                if reason:
                    bar_exit_long[t] = True
                    if reason == "stop":
                        exit_fill_long[t] = min(stop_lvl, o)   # stop level, gap-protected
                    elif reason == "maxdays":
                        exit_fill_long[t] = f_close            # TS "this bar at close"
                    # rsi_overbought -> NaN -> engine fills at next-bar open
                    pos = 0; entry_price = np.nan; entry_idx = -1; entry_sess = -1; mfe = np.nan

            # ---- Entry (long only, once per session) ----
            if pos == 0 and warm and last_entry_sess != s and t + 1 < n:
                if (f_close > sma_prov) and (rsi_prov < oversold) and range_ok:
                    nxt = open_[t + 1]
                    cond_long[t] = True
                    pos = 1; entry_price = nxt; entry_idx = t + 1; entry_sess = s
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
        out["sma"]             = sma_overlay
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        sma_p = int(p["sma_period"])
        rsi_p = int(p["rsi_period"])
        warmup = (sma_p + 5) * 24  # sessions worth of bars (~24 bars/session)

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
        if nS < sma_p + 2:
            return None

        open_ = df["open"].to_numpy(); high = df["high"].to_numpy()
        low = df["low"].to_numpy(); close = df["close"].to_numpy()
        d_open, d_high, d_low, d_close, open_bar = _daily_from_sessions(
            time, open_, high, low, close, sids)
        ag, al = _wilder_rsi_components(d_close, rsi_p)

        # current (forming) session = last id; recompute its running OHLC
        cur_s = int(sids[-1])
        mask = sids == cur_s
        f_high = float(high[mask].max()); f_low = float(low[mask].min())
        f_close = float(close[-1])

        a = 1.0 / rsi_p
        pc = d_close[cur_s - 1]
        diff = f_close - pc
        gp = ag[cur_s - 1] * (1 - a) + (diff if diff > 0 else 0.0) * a
        lp = al[cur_s - 1] * (1 - a) + (-diff if diff < 0 else 0.0) * a
        rsi_prov = _rsi_from(gp, lp)
        sma_prov = float(d_close[cur_s - sma_p: cur_s].sum() + f_close) / sma_p \
            if cur_s >= sma_p else np.nan
        range_ok = (not bool(p.get("range_filter", True))) or ((f_high - f_low) > (d_high[cur_s - 1] - d_low[cur_s - 1]))

        ts = int(df["time"].iloc[-1])
        c  = f_close; h = f_high; l = f_low
        pv = float(p["point_value"]); stop_dlr = float(p["stop_dollars"])
        stop_pts = stop_dlr / pv if pv > 0 else 0.0
        lock_f = float(p["profit_lock_frac"]); max_days = int(p["max_days"])
        overb = float(p["rsi_overbought"]); oversold = float(p["rsi_oversold"])

        pos = int(state.get("pos", 0))
        entry_p = float(state.get("entry_p", np.nan))
        entry_sess = int(state.get("entry_sess", -1))
        mfe = float(state.get("mfe", np.nan))
        last_entry_sess = int(state.get("last_entry_sess", -1))

        if pos == 1 and np.isfinite(entry_p):
            mfe = max(mfe if np.isfinite(mfe) else h, h)
            state["mfe"] = mfe
            stop_lvl = entry_p - stop_pts
            if (mfe - entry_p) >= stop_pts and stop_pts > 0:
                stop_lvl = entry_p - stop_pts * lock_f
            reason = None
            if l <= stop_lvl:                              reason = "stop"
            elif np.isfinite(rsi_prov) and rsi_prov > overb: reason = "rsi_overbought"
            elif (cur_s - entry_sess) >= max_days:          reason = "maxdays"
            if reason:
                state.update({"pos": 0, "entry_p": np.nan, "entry_sess": -1, "mfe": np.nan})
                return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
            return None

        if pos == 0 and np.isfinite(sma_prov) and last_entry_sess != cur_s:
            if (c > sma_prov) and (rsi_prov < oversold) and range_ok:
                state.update({"pos": 1, "entry_p": c, "entry_sess": cur_s,
                              "mfe": c, "last_entry_sess": cur_s})
                return Signal(side="long", kind="entry", price=c, time=ts, reason="rsi_oversold")
        return None
