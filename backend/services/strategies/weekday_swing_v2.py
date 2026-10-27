"""
Weekday Swing V2 — a crypto-only, simplified day-of-week swing.

Plain-English rule set (all clock values in UTC — Binance charts are UTC):

  LONG   enter at  long_entry_day  @ long_entry_hour:00   if the trend filter allows
         exit  at  long_exit_day   @ long_exit_hour:00    (first bar at/after)
  SHORT  mirror image on short_entry_day → short_exit_day. Off by default.

  Trend filter: close above the MA for longs, below it for shorts. MA = EMA or VWMA
  (`trend_filter`, length `ma_length`), or "off" for no filter.

No stop loss, no trailing, no month filter — a trade only ever ends at its exit time.

What changed vs V1 (weekday_swing.py, the natural-gas Pine port):
  - Trades that cross the weekend now work. V1 force-closed whenever today's weekday
    number was later than the exit day, so Fri → Mon closed one bar after entry.
    V2 turns entry → exit into a hold length (e.g. Mon 01:00 → Wed 15:00 = 62 hours)
    and exits once the trade has been open that long, so the week wraps naturally.
  - Only enters when flat; no "flip" (V1's close-all before the opposite entry).
  - Removed: months, minutes, timezone, dollar / % stops, point_value, contracts.

Fill model (QuantLab honest mode = Pine process_orders_on_close = false):
  entries and exits are flagged on the signal bar and fill at the NEXT bar's open.

Timeframe: entries fire on the bar that starts exactly at HH:00 UTC, so use 1h or
lower (15m / 5m / 1m). 4h and above skip most hours — don't use them.

Same entry and exit time = a full 7-day hold; the next entry on that same bar is
skipped (the old trade is still closing), so it trades every other week.
"""
from __future__ import annotations

from typing import Union

import numpy as np
import pandas as pd

from .base import Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec


_DAYS = [
    {"value": "1", "label": "Monday"},   {"value": "2", "label": "Tuesday"},
    {"value": "3", "label": "Wednesday"}, {"value": "4", "label": "Thursday"},
    {"value": "5", "label": "Friday"},   {"value": "6", "label": "Saturday"},
    {"value": "7", "label": "Sunday"},
]

_FILTERS = [
    {"value": "ema",  "label": "EMA"},
    {"value": "vwma", "label": "VWMA"},
    {"value": "off",  "label": "Off"},
]

_WEEK_MIN = 7 * 24 * 60


def _clock(times_s):
    """Epoch-seconds → (weekday 1=Mon..7=Sun, hour, minute) in UTC. Vectorized."""
    idx = pd.to_datetime(np.asarray(times_s, dtype="int64"), unit="s", utc=True)
    return (np.asarray(idx.dayofweek, dtype=np.int64) + 1,
            np.asarray(idx.hour,      dtype=np.int64),
            np.asarray(idx.minute,    dtype=np.int64))


def _ema(close: np.ndarray, length: int) -> np.ndarray:
    return pd.Series(close).ewm(span=length, adjust=False).mean().to_numpy()


def _vwma(close: np.ndarray, volume: np.ndarray, length: int) -> np.ndarray:
    """ta.vwma: sum(close·volume, n) / sum(volume, n). NaN when the window has no volume."""
    c, v = pd.Series(close), pd.Series(volume)
    return ((c * v).rolling(length).sum() / v.rolling(length).sum().replace(0, np.nan)).to_numpy()


class WeekdaySwingV2Strategy(Strategy):
    PARAM_SCHEMA = [
        # ---- Long leg ----
        ParamSpec("long_entry_day",  ParamType.SELECT, "1", group="Long", options=_DAYS,
                  description="Day to open the long (UTC)."),
        ParamSpec("long_entry_hour", ParamType.INT, 1,  min=0, max=23, step=1, group="Long",
                  description="Hour (UTC, 0-23) of the bar that opens the long."),
        ParamSpec("long_exit_day",   ParamType.SELECT, "3", group="Long", options=_DAYS,
                  description="Day to close the long (UTC). May be in the next week, e.g. Fri → Mon."),
        ParamSpec("long_exit_hour",  ParamType.INT, 15, min=0, max=23, step=1, group="Long",
                  description="Hour (UTC, 0-23): close on the first bar at/after this time."),

        # ---- Short leg ----
        ParamSpec("short_entry_day",  ParamType.SELECT, "4", group="Short", options=_DAYS,
                  description="Day to open the short (UTC)."),
        ParamSpec("short_entry_hour", ParamType.INT, 1,  min=0, max=23, step=1, group="Short",
                  description="Hour (UTC, 0-23) of the bar that opens the short."),
        ParamSpec("short_exit_day",   ParamType.SELECT, "5", group="Short", options=_DAYS,
                  description="Day to close the short (UTC)."),
        ParamSpec("short_exit_hour",  ParamType.INT, 15, min=0, max=23, step=1, group="Short",
                  description="Hour (UTC, 0-23): close on the first bar at/after this time."),

        # ---- Trend filter ----
        ParamSpec("trend_filter", ParamType.SELECT, "ema", group="Trend", options=_FILTERS,
                  description="Longs need close above this average, shorts below. Off = no filter."),
        ParamSpec("ma_length", ParamType.INT, 100, min=2, max=500, step=1, group="Trend",
                  description="Length of the EMA / VWMA in BARS — 100 is ~4 days on 1h, ~25 hours on 15m."),

        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": False}, group="Direction",
                  description="Which legs may trade: tick Long and/or Short. Long only by default."),

        # ---- Risk ----
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of equity."),
    ]

    META = StrategyMeta(
        id="weekday_swing_v2",
        name="Weekday Swing V2",
        description=("Crypto day-of-week swing: open at a fixed UTC day/hour, close at a fixed "
                     "day/hour (can cross the weekend). Optional EMA or VWMA trend filter. "
                     "No stop loss. Long only by default."),
        schema=PARAM_SCHEMA,
        guide=(
            "A simpler crypto version of Weekday Swing: open at a fixed UTC day and hour, close at "
            "another, every week.\n\n"
            "- Buys (long) when: it is Monday 01:00 UTC and the close is above the 100-bar EMA (an "
            "average that weights recent prices more). Entry at the next bar's open.\n"
            "- Sells short when: off by default; when on, Thursday 01:00 UTC below the EMA, out "
            "Friday 15:00.\n"
            "- Closes the trade when: it has been open Monday 01:00 to Wednesday 15:00 UTC (62 "
            "hours).\n"
            "- Stop loss: none.\n\n"
            "Good to know: unlike V1, a trade can cross the weekend (e.g. Friday to Monday). No "
            "month filter, no flipping. The trend filter can be EMA, VWMA (a volume-weighted "
            "average) or off. Use 1h or smaller bars."
        ),
    )

    OVERLAYS = [
        OverlaySpec("trend_ma", "Trend MA", from_column="trend_ma", color="#facc15", line_width=2),
    ]

    # ---- helpers ------------------------------------------------------
    def _hold_sec(self, side: str) -> int:
        """Entry day/hour → exit day/hour as a hold length; wraps past Sunday."""
        p = self.p
        ed, eh = int(p[f"{side}_entry_day"]), int(p[f"{side}_entry_hour"])
        xd, xh = int(p[f"{side}_exit_day"]),  int(p[f"{side}_exit_hour"])
        mins = ((xd - ed) * 1440 + (xh - eh) * 60) % _WEEK_MIN
        return (mins or _WEEK_MIN) * 60

    def _is_entry_bar(self, side: str, dow, hour, minute):
        p = self.p
        return (dow == int(p[f"{side}_entry_day"])) & (hour == int(p[f"{side}_entry_hour"])) & (minute == 0)

    def warmup_bars(self) -> int:
        return max(500, int(self.p["ma_length"]) * 5)

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p   = self.p
        out = df.copy()
        n   = len(out)
        time  = out["time"].to_numpy(dtype="int64")
        close = out["close"].astype(float).to_numpy()

        flt = str(p["trend_filter"])
        ma_len = int(p["ma_length"])
        if flt == "ema":
            ma = _ema(close, ma_len)
        elif flt == "vwma":
            ma = _vwma(close, out["volume"].astype(float).to_numpy(), ma_len)
        else:
            ma = np.full(n, np.nan)

        dow, hour, minute = _clock(time)
        sides = p["sides"]
        if flt == "off":
            long_ok = short_ok = np.ones(n, dtype=bool)
        else:
            warm = np.arange(n) >= ma_len
            long_ok, short_ok = warm & (close > ma), warm & (close < ma)
        long_sig  = bool(sides.get("long"))  & long_ok  & self._is_entry_bar("long",  dow, hour, minute)
        short_sig = bool(sides.get("short")) & short_ok & self._is_entry_bar("short", dow, hour, minute)
        hold = {1: self._hold_sec("long"), -1: self._hold_sec("short")}

        cond_long      = np.zeros(n, dtype=bool)
        cond_short     = np.zeros(n, dtype=bool)
        bar_exit_long  = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)

        pos, sig_time = 0, 0
        for t in range(n):
            # ---- exit once the trade has been open for its hold length ----
            exited = 0
            if pos != 0 and time[t] - sig_time >= hold[pos]:
                (bar_exit_long if pos == 1 else bar_exit_short)[t] = True
                exited, pos = pos, 0

            # ---- entries (fill next bar open); only when flat ----
            if pos != 0 or t + 1 >= n:
                continue
            if long_sig[t] and exited != 1:
                cond_long[t] = True
                pos, sig_time = 1, time[t]
            elif short_sig[t] and exited != -1:
                cond_short[t] = True
                pos, sig_time = -1, time[t]

        out["cond_long"]      = cond_long
        out["cond_short"]     = cond_short
        out["bar_exit_long"]  = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        out["entry_long"]     = cond_long
        out["entry_short"]    = cond_short
        out["exit_long"]      = bar_exit_long
        out["exit_short"]     = bar_exit_short
        out["trend_ma"]       = ma
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Union[Signal, list[Signal], None]:
        if not bool(candle.get("isClosed", False)):
            return None
        p  = self.p
        ts = int(candle["time"])
        c  = float(candle["close"])

        # ---- trend MA, same math as vectorized() ----
        flt = str(p["trend_filter"])
        ma_len = int(p["ma_length"])
        state["bars"] = int(state.get("bars", 0)) + 1
        warm = state["bars"] > ma_len                      # = index >= ma_len in the backtest
        ma = None
        if flt == "ema":
            # Same recursion as pandas ewm(adjust=False), seeded on the first close.
            alpha = 2.0 / (ma_len + 1.0)
            prev  = state.get("ema")
            ma = c if prev is None else alpha * c + (1.0 - alpha) * float(prev)
            state["ema"] = ma
        elif flt == "vwma":
            win = state.setdefault("win", [])
            win.append([c, float(candle.get("volume", 0.0))])
            del win[:-ma_len]
            vsum = sum(v for _c, v in win)
            if len(win) == ma_len and vsum > 0:
                ma = sum(cc * v for cc, v in win) / vsum

        if flt == "off":
            long_ok = short_ok = True
        else:
            long_ok  = warm and ma is not None and c > ma
            short_ok = warm and ma is not None and c < ma

        dow_a, hour_a, min_a = _clock([ts])
        dow, hour, minute = int(dow_a[0]), int(hour_a[0]), int(min_a[0])
        sides = p["sides"]
        pos = int(state.get("pos", 0))
        signals: list[Signal] = []

        # ---- exit once the trade has been open for its hold length ----
        exited = 0
        if pos != 0 and ts - int(state.get("sig_time", ts)) >= self._hold_sec("long" if pos == 1 else "short"):
            side = "long" if pos == 1 else "short"
            signals.append(Signal(side=side, kind="exit", price=c, time=ts, reason="exit_time"))
            exited, pos = pos, 0
            state["pos"] = 0

        # ---- entries; only when flat ----
        if pos == 0:
            if sides.get("long") and long_ok and exited != 1 and self._is_entry_bar("long", dow, hour, minute):
                state.update({"pos": 1, "sig_time": ts})
                signals.append(Signal(side="long", kind="entry", price=c, time=ts, reason="weekday_open"))
            elif sides.get("short") and short_ok and exited != -1 and self._is_entry_bar("short", dow, hour, minute):
                state.update({"pos": -1, "sig_time": ts})
                signals.append(Signal(side="short", kind="entry", price=c, time=ts, reason="weekday_open"))

        if not signals:
            return None
        return signals[0] if len(signals) == 1 else signals
