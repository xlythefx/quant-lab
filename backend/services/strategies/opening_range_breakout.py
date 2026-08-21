"""
Opening Range Breakout (ORB) — ride the break of the session's opening range.

The idea, in plain words:
  1. During the OPENING-RANGE session (e.g. the first 30 min after the open),
     record the high and low. That box (top = green, bottom = red) is frozen
     for the rest of the day.
  2. During the ENTRY session (the rest of the day), watch for the FIRST bar to
     CLOSE decisively beyond the box — optionally by break_buffer × ATR so a
     marginal poke doesn't count.
  3. We trade WITH the break (continuation — the opposite of a fade):
       - close ABOVE the box → BUY
       - close BELOW the box → SELL
  4. Stop-loss = entry ∓ atr_mult × ATR (engine-native fixed-ATR stop). There is
     no fixed profit target: the winner is ridden until the ATR stop OR the
     SESSION-CLOSE flatten (we go flat at the end of the entry window). One trade
     per day; whichever side breaks first locks the day.

This is the mirror image of asia_range_breakout.py (which FADES the sweep). Same
box/session scaffolding + engine contract; opposite directional bet. ORB tends to
pay on trending days and bleed on choppy ones — validate per-instrument.

Engine contract (matches vwma_reversion.py / asia_range_breakout.py so BOTH sim
loops behave the same):
  - cond_long / cond_short         : per-bar entry conditions (the break bar).
  - bar_exit_long / bar_exit_short : per-bar forced flat (last entry-session bar).
  - atr + atr_mult                 : the engine's native fixed-ATR stop.
The engine owns position state; this file emits stateless per-bar conditions (plus
display-only entry/exit markers and the box/stop overlays).

Day boundary = UTC calendar day (time // 86400), consistent with the UTC session
windows. Assumes the opening-range window sits earlier in the same UTC day than
the entry window (set them that way). Sessions are fixed UTC — no DST shift — so
pick the window that matches your instrument's open (e.g. GC gold ~13:30 UTC).
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


class OpeningRangeBreakoutStrategy(Strategy):
    PARAM_SCHEMA = [
        # ---- Opening range: the box is the high/low of these bars each UTC day ----
        ParamSpec("or_session", ParamType.SESSIONS,
                  {"open": {"enabled": True, "start": "13:30", "end": "14:00"}},
                  group="Opening Range",
                  description="UTC window whose high/low form the day's box (the "
                              "'opening range'). Keep it SHORT — e.g. the first 15-30 "
                              "min after your instrument's open. Default ~US open."),
        # ---- Entry window: breaks are only taken while inside this window ----
        ParamSpec("entry_session", ParamType.SESSIONS,
                  {"entry": {"enabled": True, "start": "14:00", "end": "20:00"}},
                  group="Entry Window",
                  description="UTC window where a break may open a trade. Should start "
                              "at/after the opening-range window ends. The trade is "
                              "flattened at the END of this window (session-close exit)."),
        # ---- Break buffer: how far past the box a close must be to count ----
        ParamSpec("break_buffer", ParamType.FLOAT, 0.0, min=0.0, max=3.0, step=0.1, group="Break",
                  description="A bar must CLOSE at least this many ATR beyond the box "
                              "edge to count as a break. 0 = any close beyond the line."),
        ParamSpec("vol_length", ParamType.INT, 14, min=5, max=100, step=1, group="Break",
                  description="Lookback for the ATR used by the break buffer and the stop."),
        # ---- Stop: fixed ATR distance (engine-native). No fixed target — ride to close.
        ParamSpec("atr_mult", ParamType.FLOAT, 2.0, min=0.5, max=10.0, step=0.5, group="Stop",
                  description="Stop-loss distance = entry ∓ this × ATR at entry. No profit "
                              "target: the trade rides until the stop or the session-close flat."),
        # ---- Direction toggle (defaults to both) ----
        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": True},
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
        id="opening_range_breakout",
        name="Opening Range Breakout (ORB)",
        description=("Ride the break of the opening-range box: close above → buy, close "
                     "below → sell. Break gated by ATR buffer; fixed-ATR stop; flatten at "
                     "session close; one trade/day; configurable sessions + sides."),
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

        atr = _atr(high, low, close, p["vol_length"])

        # Session masks (UTC, vectorized). Both params are {name: {enabled,start,end}}.
        ts = pd.to_datetime(out["time"], unit="s", utc=True)
        ts.index = out.index
        or_mask = session_mask(ts, p["or_session"]).to_numpy()
        entry_mask = session_mask(ts, p["entry_session"]).to_numpy()

        time_a = out["time"].to_numpy(dtype=np.int64)
        high_a = high.to_numpy()
        low_a = low.to_numpy()
        close_a = close.to_numpy()
        atr_a = atr.to_numpy()
        day_a = time_a // 86400  # UTC calendar day

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))
        buf = float(p["break_buffer"])

        # Outputs.
        cond_long = np.zeros(n, dtype=bool)
        cond_short = np.zeros(n, dtype=bool)
        bar_exit_long = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)
        box_top_disp = np.full(n, np.nan)   # per-day box for the chart overlay
        box_bot_disp = np.full(n, np.nan)

        # Walk day-by-day: build the box from the opening-range bars, then scan the
        # entry bars for the FIRST break beyond the box.
        for d in np.unique(day_a):
            day_idx = np.nonzero(day_a == d)[0]
            or_idx = day_idx[or_mask[day_idx]]
            if or_idx.size == 0:
                continue
            box_high = float(np.nanmax(high_a[or_idx]))
            box_low = float(np.nanmin(low_a[or_idx]))
            if not (np.isfinite(box_high) and np.isfinite(box_low)) or box_high <= box_low:
                continue
            or_last = int(or_idx.max())

            # Paint the box for this day's bars AFTER it froze (overlay only).
            post = day_idx[day_idx > or_last]
            box_top_disp[post] = box_high
            box_bot_disp[post] = box_low

            # Entry candidates: entry-session bars that come after the box froze.
            entry_idx = post[entry_mask[post]]
            if entry_idx.size == 0:
                continue

            # Session-close flatten: force flat at the LAST entry-session bar of the
            # day (fires regardless of which side, if any, is open).
            last_entry = int(entry_idx.max())
            bar_exit_long[last_entry] = True
            bar_exit_short[last_entry] = True

            # First decisive close beyond the box locks the day (one trade/day).
            for i in entry_idx:
                a = atr_a[i]
                thr = 0.0 if buf == 0.0 else (buf * a if np.isfinite(a) else np.inf)
                broke_up = close_a[i] > box_high + thr
                broke_dn = close_a[i] < box_low - thr
                if broke_up and long_on:
                    cond_long[i] = True
                    break
                if broke_dn and short_on:
                    cond_short[i] = True
                    break

        # ---- Display-only sim: entry/exit markers + the live stop line. Mirrors the
        # engine's precedence (act on bar t-1's signal, fill at bar t's open, exit on
        # the forced flat or the fixed-ATR stop). Single-position, for the chart only —
        # the real P&L comes from the engine reading cond_/bar_exit_/atr above.
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)
        atr_mult = float(p["atr_mult"])

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
          buf              recent bars for ATR
          cur_day          UTC day the box belongs to
          box_high/low     frozen opening-range box for cur_day (None until OR bars seen)
          or_done          True once we've left the OR window (box is frozen)
          locked           'long'|'short'|None — first break locks the day
          done_today       True once the day's single trade has opened
          pos, entry_p, atr_at_entry

        Single-position (like every live path here). Flattens at the last entry-
        session bar. See CLAUDE.md live-vs-backtest note for the pyramiding caveat.
        """
        if not bool(candle.get("isClosed", False)):
            return None

        p = self.p
        warmup = int(p["vol_length"]) * 4
        buf_bars = state.setdefault("buf", [])
        buf_bars.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low": float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        if len(buf_bars) > warmup * 2:
            del buf_bars[: len(buf_bars) - warmup * 2]

        ts = int(candle["time"])
        c = float(candle["close"])
        hi = float(candle["high"])
        lo = float(candle["low"])
        day = ts // 86400

        # New UTC day → reset the daily box/break state (keep any open position).
        if state.get("cur_day") != day:
            state["cur_day"] = day
            state["box_high"] = None
            state["box_low"] = None
            state["locked"] = None
            state["done_today"] = False

        tod = datetime.fromtimestamp(ts, tz=timezone.utc).time()

        def _in(sessions_cfg) -> bool:
            for cfg in (sessions_cfg or {}).values():
                if not cfg or not cfg.get("enabled"):
                    continue
                win = (parse_hhmm(cfg.get("start", "00:00")), parse_hhmm(cfg.get("end", "00:00")))
                if in_window_live(tod, win):
                    return True
            return False

        in_or = _in(p["or_session"])
        in_entry = _in(p["entry_session"])

        # Extend the opening-range box while inside the OR window.
        if in_or:
            bh = state.get("box_high")
            bl = state.get("box_low")
            state["box_high"] = hi if bh is None else max(bh, hi)
            state["box_low"] = lo if bl is None else min(bl, lo)

        # ATR from the buffer.
        if len(buf_bars) < int(p["vol_length"]) + 1:
            a = np.nan
        else:
            dfb = pd.DataFrame(buf_bars)
            a = float(_atr(dfb["high"], dfb["low"], dfb["close"], p["vol_length"]).iloc[-1])

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))
        atr_mult = float(p["atr_mult"])
        pos = state.get("pos", 0)

        # ---- Manage an open position first (stop any time; flat at entry-session end) ----
        if pos == 1:
            entry_p = state.get("entry_p", np.nan)
            aae = state.get("atr_at_entry", np.nan)
            stop_hit = (np.isfinite(aae) and np.isfinite(entry_p)
                        and c <= entry_p - atr_mult * aae)
            # Session-close flatten: once we're past the entry window, go flat.
            if stop_hit or not in_entry:
                state["pos"] = 0
                return Signal(side="long", kind="exit", price=c, time=ts,
                              reason="atr_stop" if stop_hit else "session_close")
            return None
        if pos == -1:
            entry_p = state.get("entry_p", np.nan)
            aae = state.get("atr_at_entry", np.nan)
            stop_hit = (np.isfinite(aae) and np.isfinite(entry_p)
                        and c >= entry_p + atr_mult * aae)
            if stop_hit or not in_entry:
                state["pos"] = 0
                return Signal(side="short", kind="exit", price=c, time=ts,
                              reason="atr_stop" if stop_hit else "session_close")
            return None

        # ---- Flat: look for the day's first break inside the entry window ----
        if state.get("done_today"):
            return None
        box_high = state.get("box_high")
        box_low = state.get("box_low")
        if box_high is None or box_low is None or box_high <= box_low:
            return None
        # Only arm once the OR window is over (we're in the entry window).
        if in_or or not in_entry:
            return None

        buf = float(p["break_buffer"])
        thr = 0.0 if buf == 0.0 else (buf * a if np.isfinite(a) else np.inf)
        broke_up = c > box_high + thr
        broke_dn = c < box_low - thr

        if state.get("locked") is None:
            if broke_up and long_on:
                state["locked"] = "long"
            elif broke_dn and short_on:
                state["locked"] = "short"

        locked = state.get("locked")
        if locked == "long":
            state.update({"pos": 1, "entry_p": c, "atr_at_entry": a, "done_today": True})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="or_break")
        if locked == "short":
            state.update({"pos": -1, "entry_p": c, "atr_at_entry": a, "done_today": True})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="or_break")
        return None
