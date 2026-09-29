"""
Weekday Swing — a day-of-week seasonal, ported from the Pine "NATGAS" script.

Plain-English rule set (all clock values in the chosen `timezone`):

  LONG   enter at  long_entry_day  @ long_entry_hour:long_entry_minute   if close > EMA
         exit  at  long_exit_day   @ long_exit_hour:long_exit_minute  (first bar at/after)
         hard stop long_stop_dollars / point_value below entry  (or long_stop_pct)
         force-close on any later weekday than long_exit_day (safety net)

  SHORT  mirror image on short_entry_day → short_exit_day, if close < EMA.

  Month filter: 12 checkboxes; unchecked months allow no NEW entries (open trades
  still exit normally). Pine defaults skip March and December.

Defaults reproduce the Pine: long Mon 01:00 → Wed 15:00, short Thu 01:00 → Fri 15:00,
EMA 100, stops $100 long / $10 short.

Weekdays are ISO: 1=Mon … 7=Sun (Pine uses 1=Sun … 7=Sat and offsets the input by +1;
here you type the ISO number directly). 6/7 are allowed because crypto trades weekends.

Fill model vs Pine (process_orders_on_close = false):
  - Entries fill at the NEXT bar's open (cond_long/cond_short on the signal bar).
  - Time/force exits fill at the next bar's open (Pine strategy.close) — exit_fill is
    left NaN so the engine uses next-open.
  - Stops fill AT the stop level, gap-protected (Pine strategy.exit stop=...).
  - The stop is active from the fill bar onward. Pine only places its stop order on
    the bar AFTER the fill (`if strategy.position_size > 0` runs at that bar's close),
    so the first bar of every Pine trade is unprotected. A real stop order placed with
    the entry protects immediately, so we model that — expect slightly more stop-outs
    than the TradingView report on the first bar.
  - `close_all` before an opposite entry = a flip: the engine closes the old side and
    opens the new one at the same next-bar open.

Stops: per side, `*_stop_dollars` > 0 → distance = dollars / point_value (Pine's
`stopLoss / syminfo.pointvalue`; point_value 1.0 on crypto, 10000 on NG, 50 on ES).
Else `*_stop_pct` > 0 → distance = entry × pct / 100. Else no stop. Same fallback
convention as lunar.py. On crypto with fractional sizing the "dollars" are really a
price distance per 1 unit of the asset — use the pct stop for small-price coins.

Warm-up: no entries until `ema_length` bars exist (Pine trades from bar 1 on a
half-formed EMA; the difference is a handful of bars at the start of the data).

Timeframe: the entry fires only on the bar whose local time is exactly HH:MM, so the
timeframe must have a bar starting then (1m/5m/15m/1h all do for :00). On 1h leave
the minute at 0. 4h and above never line up with 01:00 — don't use them.
"""
from __future__ import annotations

from typing import Optional, Union
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .base import Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec


_TZ_OPTIONS = [
    {"value": "UTC",              "label": "UTC"},
    {"value": "America/New_York", "label": "New York (ET)"},
    {"value": "America/Chicago",  "label": "Chicago (CT)"},
]

# (param name, label, Pine default) — Pine skips March and December.
_MONTHS = [
    ("jan", "January", True),  ("feb", "February", True), ("mar", "March", False),
    ("apr", "April", True),    ("may", "May", True),      ("jun", "June", True),
    ("jul", "July", True),     ("aug", "August", True),   ("sep", "September", True),
    ("oct", "October", True),  ("nov", "November", True), ("dec", "December", False),
]


def _clock(times_s, tz: str):
    """Epoch-seconds → (weekday 1=Mon..7=Sun, hour, minute, month) in `tz`. Vectorized."""
    idx = pd.to_datetime(np.asarray(times_s, dtype="int64"), unit="s", utc=True)
    idx = idx.tz_convert(ZoneInfo(tz))
    return (np.asarray(idx.dayofweek, dtype=np.int64) + 1,
            np.asarray(idx.hour,      dtype=np.int64),
            np.asarray(idx.minute,    dtype=np.int64),
            np.asarray(idx.month,     dtype=np.int64))


def _ema(close: np.ndarray, length: int) -> np.ndarray:
    return pd.Series(close).ewm(span=length, adjust=False).mean().to_numpy()


class WeekdaySwingStrategy(Strategy):
    PARAM_SCHEMA = [
        # ---- Long leg ----
        ParamSpec("long_entry_day",    ParamType.INT, 1,  min=1, max=7,  step=1, group="Long",
                  description="Weekday to open longs. 1=Mon … 5=Fri, 6=Sat, 7=Sun."),
        ParamSpec("long_entry_hour",   ParamType.INT, 1,  min=0, max=23, step=1, group="Long",
                  description="Hour (in `timezone`) of the bar that opens the long."),
        ParamSpec("long_entry_minute", ParamType.INT, 0,  min=0, max=59, step=1, group="Long",
                  description="Minute of the entry bar. Keep 0 on 1h data."),
        ParamSpec("long_exit_day",     ParamType.INT, 3,  min=1, max=7,  step=1, group="Long",
                  description="Weekday to close longs. Any later weekday force-closes."),
        ParamSpec("long_exit_hour",    ParamType.INT, 15, min=0, max=23, step=1, group="Long",
                  description="Close on the first bar at/after this hour on the exit day."),
        ParamSpec("long_exit_minute",  ParamType.INT, 0,  min=0, max=59, step=1, group="Long"),
        ParamSpec("long_stop_dollars", ParamType.FLOAT, 100.0, min=0.0, max=100000.0, step=1.0, group="Long",
                  description="Pine 'Long Stop Loss ($)'. Stop = entry − $ / point_value. 0 → use long_stop_pct."),
        ParamSpec("long_stop_pct",     ParamType.FLOAT, 0.0, min=0.0, max=20.0, step=0.05, group="Long",
                  description="Fallback stop as % of entry (used only when long_stop_dollars = 0). 0 = no stop."),

        # ---- Short leg ----
        ParamSpec("short_entry_day",    ParamType.INT, 4,  min=1, max=7,  step=1, group="Short",
                  description="Weekday to open shorts. 1=Mon … 5=Fri, 6=Sat, 7=Sun."),
        ParamSpec("short_entry_hour",   ParamType.INT, 1,  min=0, max=23, step=1, group="Short"),
        ParamSpec("short_entry_minute", ParamType.INT, 0,  min=0, max=59, step=1, group="Short"),
        ParamSpec("short_exit_day",     ParamType.INT, 5,  min=1, max=7,  step=1, group="Short",
                  description="Weekday to close shorts. Any later weekday force-closes."),
        ParamSpec("short_exit_hour",    ParamType.INT, 15, min=0, max=23, step=1, group="Short"),
        ParamSpec("short_exit_minute",  ParamType.INT, 0,  min=0, max=59, step=1, group="Short"),
        ParamSpec("short_stop_dollars", ParamType.FLOAT, 10.0, min=0.0, max=100000.0, step=1.0, group="Short",
                  description="Pine 'Short Stop Loss ($)' — note the Pine default is 1/10th of the long stop. "
                              "Stop = entry + $ / point_value. 0 → use short_stop_pct."),
        ParamSpec("short_stop_pct",     ParamType.FLOAT, 0.0, min=0.0, max=20.0, step=0.05, group="Short",
                  description="Fallback stop as % of entry (used only when short_stop_dollars = 0). 0 = no stop."),

        # ---- Filters ----
        ParamSpec("ema_length", ParamType.INT, 100, min=1, max=500, step=1, group="Filters",
                  description="Trend filter: longs need close > EMA, shorts need close < EMA."),
        ParamSpec("timezone", ParamType.SELECT, "UTC", group="Filters", options=_TZ_OPTIONS,
                  description="Clock for the weekday/hour rules. Pine's hour(time) uses the chart's "
                              "exchange timezone; Binance charts are UTC."),
        *[
            ParamSpec(key, ParamType.BOOL, default, group="Months",
                      description=f"Allow new entries in {label}.")
            for key, label, default in _MONTHS
        ],

        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction"),

        # ---- Risk ----
        ParamSpec("point_value", ParamType.FLOAT, 1.0, min=0.01, max=100000.0, step=1.0, group="Risk",
                  description="Dollar value of a 1.0 price move per unit (Pine syminfo.pointvalue). "
                              "Crypto 1, NG 10000, ES 50. Only used to turn $ stops into price."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Crypto/spot sizing: position as % of equity."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures sizing: contracts per trade (Pine default_qty_value = 1)."),
    ]

    META = StrategyMeta(
        id="weekday_swing",
        name="Weekday Swing",
        description=("Day-of-week seasonal: long the front half of the week, short the back "
                     "half, at fixed clock times, gated by an EMA and a month filter. "
                     "Dollar (or %) stop per side; force-close past the exit day."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("ema", "EMA", from_column="ema", color="#facc15", line_width=2),
    ]

    # ---- helpers ------------------------------------------------------
    def _stop_dist(self, side: str, entry_price: float) -> float:
        """Price distance from entry to the stop for `side`; 0 = no stop."""
        p = self.p
        dollars = float(p[f"{side}_stop_dollars"])
        pv      = float(p["point_value"])
        pct     = float(p[f"{side}_stop_pct"])
        if dollars > 0 and pv > 0:
            return dollars / pv
        if pct > 0:
            return entry_price * pct / 100.0
        return 0.0

    def _month_ok(self) -> np.ndarray:
        """Bool array indexed by month number (1..12); index 0 unused."""
        out = np.zeros(13, dtype=bool)
        for i, (key, _label, _d) in enumerate(_MONTHS, start=1):
            out[i] = bool(self.p[key])
        return out

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.p
        out = df.copy()
        n   = len(out)
        open_ = out["open"].astype(float).to_numpy()
        high  = out["high"].astype(float).to_numpy()
        low   = out["low"].astype(float).to_numpy()
        close = out["close"].astype(float).to_numpy()

        ema_len = int(p["ema_length"])
        ema     = _ema(close, ema_len)
        dow, hour, minute, month = _clock(out["time"].to_numpy(), str(p["timezone"]))
        tod     = hour * 60 + minute
        month_ok = self._month_ok()[month]
        sides   = p["sides"]
        warm    = np.arange(n) >= ema_len

        def _leg(side: str, cmp_ok: np.ndarray):
            ed, eh, em = int(p[f"{side}_entry_day"]), int(p[f"{side}_entry_hour"]), int(p[f"{side}_entry_minute"])
            xd, xh, xm = int(p[f"{side}_exit_day"]),  int(p[f"{side}_exit_hour"]),  int(p[f"{side}_exit_minute"])
            enabled  = bool(sides.get(side))
            entry    = enabled & warm & month_ok & (dow == ed) & (hour == eh) & (minute == em) & cmp_ok
            exit_win = (dow == xd) & (tod >= xh * 60 + xm)
            force    = dow > xd
            return entry, exit_win | force

        long_sig,  long_exit  = _leg("long",  close > ema)
        short_sig, short_exit = _leg("short", close < ema)

        cond_long       = np.zeros(n, dtype=bool)
        cond_short      = np.zeros(n, dtype=bool)
        bar_exit_long   = np.zeros(n, dtype=bool)
        bar_exit_short  = np.zeros(n, dtype=bool)
        exit_fill_long  = np.full(n, np.nan)
        exit_fill_short = np.full(n, np.nan)
        stop_price      = np.full(n, np.nan)

        pos = 0
        entry_price = np.nan
        stop_lvl = np.nan

        for t in range(n):
            # ---- exits for the open position (stop first, then the clock) ----
            if pos == 1:
                stop_price[t] = stop_lvl
                if np.isfinite(stop_lvl) and low[t] <= stop_lvl:
                    bar_exit_long[t]  = True
                    exit_fill_long[t] = min(stop_lvl, open_[t])   # gap-protected
                    pos = 0
                elif long_exit[t]:
                    bar_exit_long[t] = True                        # next-open fill
                    pos = 0
            elif pos == -1:
                stop_price[t] = stop_lvl
                if np.isfinite(stop_lvl) and high[t] >= stop_lvl:
                    bar_exit_short[t]  = True
                    exit_fill_short[t] = max(stop_lvl, open_[t])
                    pos = 0
                elif short_exit[t]:
                    bar_exit_short[t] = True
                    pos = 0

            # ---- entries (fill next bar open); opposite side is flipped ----
            if t + 1 >= n:
                continue
            if long_sig[t]:
                if pos == -1:                       # Pine close_all("Close All Before Long")
                    bar_exit_short[t] = True
                    pos = 0
                if pos == 0:
                    cond_long[t] = True
                    pos = 1
                    entry_price = open_[t + 1]
                    d = self._stop_dist("long", entry_price)
                    stop_lvl = entry_price - d if d > 0 else np.nan
            elif short_sig[t]:
                if pos == 1:                        # Pine close_all("Close All Before Short")
                    bar_exit_long[t] = True
                    pos = 0
                if pos == 0:
                    cond_short[t] = True
                    pos = -1
                    entry_price = open_[t + 1]
                    d = self._stop_dist("short", entry_price)
                    stop_lvl = entry_price + d if d > 0 else np.nan

        out["cond_long"]       = cond_long
        out["cond_short"]      = cond_short
        out["bar_exit_long"]   = bar_exit_long
        out["bar_exit_short"]  = bar_exit_short
        out["entry_long"]      = cond_long
        out["entry_short"]     = cond_short
        out["exit_long"]       = bar_exit_long
        out["exit_short"]      = bar_exit_short
        out["stop_price"]      = stop_price
        out["exit_fill_long"]  = exit_fill_long
        out["exit_fill_short"] = exit_fill_short
        out["ema"]             = ema
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Union[Signal, list[Signal], None]:
        if not bool(candle.get("isClosed", False)):
            return None
        p  = self.p
        ts = int(candle["time"])
        h  = float(candle["high"]); l = float(candle["low"]); c = float(candle["close"])

        # Incremental EMA (same recursion as pandas ewm(adjust=False), seeded on the first close).
        ema_len = int(p["ema_length"])
        alpha   = 2.0 / (ema_len + 1.0)
        prev    = state.get("ema")
        ema     = c if prev is None else alpha * c + (1.0 - alpha) * float(prev)
        state["ema"]  = ema
        state["bars"] = int(state.get("bars", 0)) + 1
        warm = state["bars"] >= ema_len

        dow_a, hour_a, min_a, mon_a = _clock([ts], str(p["timezone"]))
        dow, hour, minute, month = int(dow_a[0]), int(hour_a[0]), int(min_a[0]), int(mon_a[0])
        tod = hour * 60 + minute
        month_ok = bool(self._month_ok()[month])
        sides = p["sides"]

        def _entry_time(side: str) -> bool:
            return (dow == int(p[f"{side}_entry_day"]) and hour == int(p[f"{side}_entry_hour"])
                    and minute == int(p[f"{side}_entry_minute"]))

        def _exit_time(side: str) -> Optional[str]:
            xd = int(p[f"{side}_exit_day"])
            if dow == xd and tod >= int(p[f"{side}_exit_hour"]) * 60 + int(p[f"{side}_exit_minute"]):
                return "exit_window"
            if dow > xd:
                return "forced_exit"
            return None

        pos     = int(state.get("pos", 0))
        entry_p = float(state.get("entry_p", np.nan))
        signals: list[Signal] = []

        def _flat():
            state.update({"pos": 0, "entry_p": np.nan})

        # ---- exits for the open position ----
        if pos == 1 and np.isfinite(entry_p):
            d = self._stop_dist("long", entry_p)
            reason = "stop" if (d > 0 and l <= entry_p - d) else _exit_time("long")
            if reason:
                _flat(); pos = 0
                signals.append(Signal(side="long", kind="exit", price=c, time=ts, reason=reason))
        elif pos == -1 and np.isfinite(entry_p):
            d = self._stop_dist("short", entry_p)
            reason = "stop" if (d > 0 and h >= entry_p + d) else _exit_time("short")
            if reason:
                _flat(); pos = 0
                signals.append(Signal(side="short", kind="exit", price=c, time=ts, reason=reason))

        # ---- entries (flip if the other side is still open) ----
        if warm and month_ok:
            if sides.get("long") and _entry_time("long") and c > ema:
                if pos == -1:
                    signals.append(Signal(side="short", kind="exit", price=c, time=ts, reason="flip"))
                    pos = 0
                if pos == 0:
                    state.update({"pos": 1, "entry_p": c})
                    signals.append(Signal(side="long", kind="entry", price=c, time=ts, reason="weekday_open"))
            elif sides.get("short") and _entry_time("short") and c < ema:
                if pos == 1:
                    signals.append(Signal(side="long", kind="exit", price=c, time=ts, reason="flip"))
                    pos = 0
                if pos == 0:
                    state.update({"pos": -1, "entry_p": c})
                    signals.append(Signal(side="short", kind="entry", price=c, time=ts, reason="weekday_open"))

        if not signals:
            return None
        return signals[0] if len(signals) == 1 else signals
