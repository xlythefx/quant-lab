"""
ICT Asia Range Breakout — liquidity-sweep reversal around the Asia-session box.

The idea, in plain words:
  1. During the ASIA session, record the session high and low. That box (top =
     green line, bottom = red line) is frozen for the rest of the day.
  2. During the ENTRY session, watch for price to poke OUT of the box far enough
     to look like a real liquidity grab — the poke depth must exceed
     break_depth × (ATR or rolling σ). A tiny wick past the line is ignored.
  3. We FADE that sweep (bet it reverses):
       - break BELOW the box first  → BUY,  target = TOP of the box.
       - break ABOVE the box first  → SELL, target = BOTTOM of the box.
     Entry is the "reclaim": we wait for a bar to CLOSE back inside the box.
  4. Take-profit = the opposite side of the box. Stop-loss = entry ∓ atr_mult×ATR.
     One trade per day; whichever side is swept+reclaimed first wins; the trade is
     held until TP or stop (not force-closed at session end).

Direction is togglable (long-only / short-only / both). With long-only we only
arm on below-sweeps, and vice-versa.

Engine contract (matches vwma_reversion.py so BOTH sim loops behave the same):
  - cond_long / cond_short   : per-bar entry conditions (fired on the reclaim bar).
  - bar_exit_long / bar_exit_short : per-bar take-profit (close reached the box side).
  - atr + atr_mult           : the engine's native fixed-ATR stop.
The engine owns position state; this file only emits stateless per-bar conditions
(plus display-only entry/exit markers and the box/stop overlays).

Day boundary = UTC calendar day (time // 86400), consistent with the UTC session
windows below. This assumes the Asia window sits earlier in the same UTC day than
the entry window — true for real Asia→London/NY sessions. A trade still open when
the NEXT day's Asia box forms will retarget to the new box (rare; documented, not
engineered around).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.session_utils import (
    parse_hhmm, in_window_live, session_mask,
)


# ---------------------------------------------------------------------------
# Self-contained indicators
# ---------------------------------------------------------------------------

def _atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / length, adjust=False).mean()


def _rolling_std(close: pd.Series, length: int) -> pd.Series:
    # Population std (ddof=0) — the z-score alternative to ATR for the sweep-depth
    # unit. Same convention as vwma_reversion's band std.
    return close.rolling(length).std(ddof=0)


class AsiaRangeBreakoutStrategy(Strategy):
    PARAM_SCHEMA = [
        # ---- Asia range: the box is the high/low of these bars each UTC day ----
        ParamSpec("asia_session", ParamType.SESSIONS,
                  {"asia": {"enabled": True, "start": "00:00", "end": "08:00"}},
                  group="Asia Range",
                  description="UTC window whose high/low form the day's range box. "
                              "Keep one window; add more only if your 'Asia' spans a gap."),
        # ---- Entry window: sweeps are only faded while inside this window ----
        ParamSpec("entry_session", ParamType.SESSIONS,
                  {"entry": {"enabled": True, "start": "08:00", "end": "16:00"}},
                  group="Entry Window",
                  description="UTC window where a sweep+reclaim may open a trade. "
                              "Should start at/after the Asia window ends."),
        # ---- Sweep depth: how far past the box counts as a real liquidity grab ----
        ParamSpec("depth_measure", ParamType.SELECT, "atr", group="Sweep",
                  options=[
                      {"value": "atr",    "label": "ATR (avg true range)"},
                      {"value": "zscore", "label": "Z-score (rolling σ)"},
                  ],
                  description="Volatility unit for the sweep-depth test below."),
        ParamSpec("vol_length", ParamType.INT, 14, min=5, max=100, step=1, group="Sweep",
                  description="Lookback for the ATR / rolling-σ used to size the sweep."),
        ParamSpec("break_depth", ParamType.FLOAT, 0.5, min=0.0, max=5.0, step=0.1, group="Sweep",
                  description="Price must poke at least this many ATR (or σ) BEYOND the "
                              "box edge to count as a sweep. 0 = any poke past the line."),
        # ---- Stop: fixed ATR distance (engine-native). TP is always the opposite box side.
        ParamSpec("atr_mult", ParamType.FLOAT, 5.0, min=0.5, max=10.0, step=0.5, group="Stop",
                  description="Stop-loss distance = entry ∓ this × ATR at entry. "
                              "Take-profit is the opposite side of the box."),
        # ---- Direction toggle (defaults to long-only) ----
        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": False},
                  group="Direction"),
        # ---- Sizing (crypto uses risk_pct, futures use contracts; pyramiding fixed at 1) ----
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Crypto/spot sizing: notional = equity × risk_pct ÷ entry price."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures sizing: number of contracts (risk_pct is inert on futures)."),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=1, step=1, group="Risk",
                  description="Fixed at 1 — this is a one-trade-at-a-time setup."),
    ]

    META = StrategyMeta(
        id="asia_range_breakout",
        name="ICT Asia Range Breakout",
        description=("Fade a liquidity sweep of the Asia-session box: break below → buy, "
                     "break above → sell, target the opposite side. Sweep depth gated by "
                     "ATR/σ; fixed-ATR stop; one trade/day; configurable sessions + sides."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("box_top", "Range top", from_column="box_top_disp",
                    color="#22c55e", line_width=2, line_style="solid"),
        OverlaySpec("box_bot", "Range bottom", from_column="box_bot_disp",
                    color="#ef4444", line_width=2, line_style="solid"),
        OverlaySpec("atr_stop", "ATR stop", from_column="stop_price",
                    color="rgba(239,68,68,0.85)", line_width=1, line_style="dashed"),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        n = len(out)
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        close = out["close"].astype(float)

        # Volatility unit for the sweep-depth test (ATR or rolling σ).
        atr = _atr(high, low, close, p["vol_length"])
        if p.get("depth_measure") == "zscore":
            vol_unit = _rolling_std(close, p["vol_length"])
        else:
            vol_unit = atr

        # Session masks (UTC, vectorized). Both params are {name: {enabled,start,end}}.
        ts = pd.to_datetime(out["time"], unit="s", utc=True)
        ts.index = out.index
        asia_mask = session_mask(ts, p["asia_session"]).to_numpy()
        entry_mask = session_mask(ts, p["entry_session"]).to_numpy()

        time_a = out["time"].to_numpy(dtype=np.int64)
        high_a = high.to_numpy()
        low_a = low.to_numpy()
        close_a = close.to_numpy()
        vol_a = vol_unit.to_numpy()
        day_a = time_a // 86400  # UTC calendar day

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))
        depth = float(p["break_depth"])

        # Outputs.
        cond_long = np.zeros(n, dtype=bool)
        cond_short = np.zeros(n, dtype=bool)
        box_top_disp = np.full(n, np.nan)   # per-day box for the chart overlay
        box_bot_disp = np.full(n, np.nan)
        box_top_exit = np.full(n, np.nan)   # carry-forward box that drives TP exits
        box_bot_exit = np.full(n, np.nan)

        # Walk day-by-day: build the box from the Asia bars, then scan the entry
        # bars for the first sweep+reclaim.
        for d in np.unique(day_a):
            day_idx = np.nonzero(day_a == d)[0]
            asia_idx = day_idx[asia_mask[day_idx]]
            if asia_idx.size == 0:
                continue
            box_high = float(np.nanmax(high_a[asia_idx]))
            box_low = float(np.nanmin(low_a[asia_idx]))
            if not (np.isfinite(box_high) and np.isfinite(box_low)) or box_high <= box_low:
                continue
            asia_last = int(asia_idx.max())

            # Paint the box for this day's bars AFTER the box is frozen (overlay).
            post = day_idx[day_idx > asia_last]
            box_top_disp[post] = box_high
            box_bot_disp[post] = box_low
            # Seed the carry-forward exit box at the freeze bar (ffill'd below).
            box_top_exit[asia_last] = box_high
            box_bot_exit[asia_last] = box_low

            # Entry candidates: entry-session bars that come after the Asia box froze.
            entry_idx = post[entry_mask[post]]
            locked = None            # 'long' | 'short' — first enabled sweep locks the day
            swept_below = swept_above = False
            for i in entry_idx:
                a = vol_a[i]
                if not np.isfinite(a):
                    continue
                thr = depth * a
                if low_a[i] < box_low and (box_low - low_a[i]) >= thr:
                    swept_below = True
                if high_a[i] > box_high and (high_a[i] - box_high) >= thr:
                    swept_above = True
                # Lock the day's bias on the first sweep of an ENABLED side.
                if locked is None:
                    if swept_below and long_on:
                        locked = "long"
                    elif swept_above and short_on:
                        locked = "short"
                # Reclaim = close back inside the box → arm the entry, done for the day.
                if locked == "long" and close_a[i] > box_low:
                    cond_long[i] = True
                    break
                if locked == "short" and close_a[i] < box_high:
                    cond_short[i] = True
                    break

        # Carry the box forward so a trade opened on day d can still target day d's
        # box into the next morning (until the next day's box overwrites it).
        box_top_exit = pd.Series(box_top_exit).ffill().to_numpy()
        box_bot_exit = pd.Series(box_bot_exit).ffill().to_numpy()

        # Take-profit conditions for the engine (close reached the opposite side).
        finite_exit = np.isfinite(box_top_exit) & np.isfinite(box_bot_exit)
        bar_exit_long = finite_exit & (close_a >= box_top_exit)
        bar_exit_short = finite_exit & (close_a <= box_bot_exit)

        # ---- Display-only sim: entry/exit markers + the live stop line. Mirrors the
        # engine's precedence (act on bar t-1's signal, fill at bar t's open, exit on
        # TP or fixed-ATR stop). Single-position, for the chart only — the real P&L
        # comes from the engine reading cond_/bar_exit_/atr above.
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)
        atr_mult = float(p["atr_mult"])
        atr_a = atr.to_numpy()

        pos = 0
        entry_p = np.nan
        atr_at_entry = np.nan
        cur_stop = np.nan
        for t in range(1, n):
            if pos == 1:
                stop_hit = (np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                            and close_a[t - 1] <= entry_p - atr_mult * atr_at_entry)
                if bar_exit_long[t - 1] or stop_hit:
                    exit_long[t] = True
                    pos = 0
                    entry_p = atr_at_entry = cur_stop = np.nan
                elif np.isfinite(cur_stop):
                    stop_price[t] = cur_stop
            elif pos == -1:
                stop_hit = (np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                            and close_a[t - 1] >= entry_p + atr_mult * atr_at_entry)
                if bar_exit_short[t - 1] or stop_hit:
                    exit_short[t] = True
                    pos = 0
                    entry_p = atr_at_entry = cur_stop = np.nan
                elif np.isfinite(cur_stop):
                    stop_price[t] = cur_stop

            if pos == 0:
                if cond_long[t - 1]:
                    pos = 1
                    entry_p = float(close_a[t])   # marker/stop reference ≈ fill
                    atr_at_entry = atr_a[t - 1] if np.isfinite(atr_a[t - 1]) else np.nan
                    entry_long[t] = True
                    if np.isfinite(atr_at_entry):
                        cur_stop = entry_p - atr_mult * atr_at_entry
                        stop_price[t] = cur_stop
                elif cond_short[t - 1]:
                    pos = -1
                    entry_p = float(close_a[t])
                    atr_at_entry = atr_a[t - 1] if np.isfinite(atr_a[t - 1]) else np.nan
                    entry_short[t] = True
                    if np.isfinite(atr_at_entry):
                        cur_stop = entry_p + atr_mult * atr_at_entry
                        stop_price[t] = cur_stop

        out["entry_long"] = entry_long
        out["entry_short"] = entry_short
        out["exit_long"] = exit_long
        out["exit_short"] = exit_short
        out["stop_price"] = stop_price
        # Raw bar-level conditions the engines consume (position-independent).
        out["cond_long"] = cond_long
        out["cond_short"] = cond_short
        out["bar_exit_long"] = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        out["atr"] = atr   # enables the engine's fixed-ATR stop (with atr_mult)
        # Overlay columns.
        out["box_top_disp"] = box_top_disp
        out["box_bot_disp"] = box_bot_disp
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """
        Live, stateful mirror of the backtest. State keys:
          buf            recent bars for ATR/σ
          cur_day        UTC day the box belongs to
          box_high/low   frozen Asia box for cur_day (None until Asia bars seen)
          locked         'long'|'short'|None — first enabled sweep locks the day
          swept_below/above, done_today
          pos, entry_p, atr_at_entry, box_high_at_entry, box_low_at_entry

        Single-position (like every live path here). Exits target the box active
        at the time (matches the engine's carry-forward), so a same-day trade uses
        its entry box. See CLAUDE.md live-vs-backtest note for the pyramiding caveat.
        """
        if not bool(candle.get("isClosed", False)):
            return None

        p = self.p
        warmup = int(p["vol_length"]) * 4
        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low": float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]

        ts = int(candle["time"])
        c = float(candle["close"])
        hi = float(candle["high"])
        lo = float(candle["low"])
        day = ts // 86400

        # New UTC day → reset the daily box/sweep state (keep any open position).
        if state.get("cur_day") != day:
            state["cur_day"] = day
            state["box_high"] = None
            state["box_low"] = None
            state["locked"] = None
            state["swept_below"] = False
            state["swept_above"] = False
            state["done_today"] = False

        # UTC time-of-day for the session checks.
        tod = datetime.fromtimestamp(ts, tz=timezone.utc).time()

        def _in(sessions_cfg) -> bool:
            for cfg in (sessions_cfg or {}).values():
                if not cfg or not cfg.get("enabled"):
                    continue
                win = (parse_hhmm(cfg.get("start", "00:00")), parse_hhmm(cfg.get("end", "00:00")))
                if in_window_live(tod, win):
                    return True
            return False

        in_asia = _in(p["asia_session"])
        in_entry = _in(p["entry_session"])

        # Extend the Asia box while inside the Asia window.
        if in_asia:
            bh = state.get("box_high")
            bl = state.get("box_low")
            state["box_high"] = hi if bh is None else max(bh, hi)
            state["box_low"] = lo if bl is None else min(bl, lo)

        # Volatility unit (ATR or σ) from the buffer.
        if len(buf) < int(p["vol_length"]) + 1:
            a = np.nan
        else:
            dfb = pd.DataFrame(buf)
            if p.get("depth_measure") == "zscore":
                a = float(_rolling_std(dfb["close"], p["vol_length"]).iloc[-1])
            else:
                a = float(_atr(dfb["high"], dfb["low"], dfb["close"], p["vol_length"]).iloc[-1])

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))
        atr_mult = float(p["atr_mult"])
        pos = state.get("pos", 0)

        # ---- Manage an open position first (exits fire regardless of session) ----
        if pos == 1:
            entry_p = state.get("entry_p", np.nan)
            aae = state.get("atr_at_entry", np.nan)
            tp = state.get("box_high_at_entry", np.nan)
            stop_hit = (np.isfinite(aae) and np.isfinite(entry_p)
                        and c <= entry_p - atr_mult * aae)
            tp_hit = np.isfinite(tp) and c >= tp
            if tp_hit or stop_hit:
                state["pos"] = 0
                return Signal(side="long", kind="exit", price=c, time=ts,
                              reason="atr_stop" if stop_hit else "box_tp")
            return None
        if pos == -1:
            entry_p = state.get("entry_p", np.nan)
            aae = state.get("atr_at_entry", np.nan)
            tp = state.get("box_low_at_entry", np.nan)
            stop_hit = (np.isfinite(aae) and np.isfinite(entry_p)
                        and c >= entry_p + atr_mult * aae)
            tp_hit = np.isfinite(tp) and c <= tp
            if tp_hit or stop_hit:
                state["pos"] = 0
                return Signal(side="short", kind="exit", price=c, time=ts,
                              reason="atr_stop" if stop_hit else "box_tp")
            return None

        # ---- Flat: look for the day's first sweep+reclaim inside the entry window ----
        if state.get("done_today"):
            return None
        box_high = state.get("box_high")
        box_low = state.get("box_low")
        if box_high is None or box_low is None or box_high <= box_low:
            return None
        # Only arm once the Asia window is over (we're in the entry window) and we
        # have a valid volatility reading.
        if in_asia or not in_entry or not np.isfinite(a):
            return None

        thr = float(p["break_depth"]) * a
        if lo < box_low and (box_low - lo) >= thr:
            state["swept_below"] = True
        if hi > box_high and (hi - box_high) >= thr:
            state["swept_above"] = True
        if state.get("locked") is None:
            if state.get("swept_below") and long_on:
                state["locked"] = "long"
            elif state.get("swept_above") and short_on:
                state["locked"] = "short"

        locked = state.get("locked")
        if locked == "long" and c > box_low:
            state.update({"pos": 1, "entry_p": c, "atr_at_entry": a,
                          "box_high_at_entry": box_high, "box_low_at_entry": box_low,
                          "done_today": True})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="sweep_reclaim")
        if locked == "short" and c < box_high:
            state.update({"pos": -1, "entry_p": c, "atr_at_entry": a,
                          "box_high_at_entry": box_high, "box_low_at_entry": box_low,
                          "done_today": True})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="sweep_reclaim")
        return None
