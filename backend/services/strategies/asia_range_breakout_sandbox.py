"""
ICT Asia Range Breakout (Sandbox) — long-only failed-sweep fade of the Asia box.

THE RULE (range LOW 1000 / HIGH 2000, default sessions in PH time = UTC+8):

  BOX     08:00–12:00 PH (00:00–04:00 UTC). The high/low of these bars is the
          day's range box, frozen at noon PH.

  ENTRY   12:00–17:00 PH (04:00–09:00 UTC) only. A bar WICKS below 1000 (no close
          below required) and that SAME bar CLOSES back above 1000 — the wick
          took the liquidity, the close proves the grab failed. Buy at the next
          candle's open. If instead a bar CLOSES at/below 1000 the range did not
          hold, so longs are dead for the rest of the UTC day.
          One trade per day.

  TP      the other side of the box (2000), pinned to the box the trade ENTERED
          on. It never retargets to a later day's box.

  STOP    a bar CLOSES back outside the range (at/below 1000) → exit at the next
          open. This only arms from the Nth candle after entry (`stop_after_bars`,
          default 5): price sits near the low right after a sweep, so an instant
          "close below = out" would stop you on noise. N=1 arms it on the very
          next bar if you want immediate protection.

  CUTOFF  04:00 PH the next morning (20:00 UTC) — close at market whatever the
          P&L. Note 04:00 PH is 20:00 UTC on the SAME UTC day as the entry, so
          the whole cycle lives inside one UTC day. Max hold is 11–16 hours.

  THERE IS NO PRICE STOP BEFORE BAR N. By design, and worth restating: fading a
  sweep means buying a falling knife, and between entry and bar N nothing can
  close the position at any price. On the live acceptor at 25x a liquidation is
  an exit this simulator cannot even produce. Size accordingly.

No ATR anywhere: break_depth is a fraction of the BOX HEIGHT (the Asia range is
itself a volatility reading — a wide box means a wild day), and the stop is
structural. So there is no lookback, no volatility unit, and nothing to curve-fit
on either.

Engine contract — this file OWNS its position state, like vwma_reversion_v2:
  - cond_long                : entry signals, emitted only when flat
  - bar_exit_long            : TP, the N-bar structural stop, or the time cutoff
  - NO `atr` column, deliberately. Emitting it would give the engine a second,
    independent stop. One stop, one owner.
The engine still fills at the next bar's open, so realised P&L uses the true fill.

Day boundary = UTC calendar day (time // 86400). One action per bar: the strategy
never exits and re-enters on the same bar, because live on_candle returns one
signal per bar.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.session_utils import parse_hhmm, in_window_live, session_mask


class AsiaRangeBreakoutSandboxStrategy(Strategy):
    PARAM_SCHEMA = [
        # ---- Asia range: the box is the high/low of these bars each UTC day ----
        ParamSpec("asia_session", ParamType.SESSIONS,
                  {"asia": {"enabled": True, "start": "00:00", "end": "04:00"}},
                  group="Asia Range",
                  description="UTC window whose high/low form the day's range box. "
                              "Default 00:00-04:00 UTC = 08:00-12:00 PH."),
        # ---- Entry window ----
        ParamSpec("entry_session", ParamType.SESSIONS,
                  {"entry": {"enabled": True, "start": "04:00", "end": "09:00"}},
                  group="Entry Window",
                  description="UTC window where a sweep+reclaim may open a trade. "
                              "Default 04:00-09:00 UTC = 12:00-17:00 PH."),
        # ---- Sweep depth, measured against the box itself ----
        ParamSpec("break_depth", ParamType.FLOAT, 0.0, min=0.0, max=2.0, step=0.05,
                  group="Sweep",
                  description="How far below the box low the WICK must reach, as a fraction of the "
                              "box height. 0 = any poke past the line counts (the default). 0.25 = the "
                              "wick must travel a quarter of the range below the low."),
        # ---- The structural stop ----
        ParamSpec("stop_after_bars", ParamType.INT, 5, min=1, max=200, step=1, group="Stop",
                  description="Grace period in candles. From this many bars after entry, a bar CLOSING "
                              "back at/below the box low exits the trade. Before it, nothing can close "
                              "the position at any price. Set 1 to arm the stop on the very next bar."),
        # ---- Hard time cutoff ----
        ParamSpec("force_exit_hour_utc", ParamType.INT, 20, min=0, max=23, step=1, group="Stop",
                  description="Close any open position at market from this UTC hour. Default 20 = "
                              "04:00 PH the next morning. Resolved to the first occurrence strictly "
                              "after the entry bar, so it works whatever hour you pick."),
        # ---- Sizing (crypto uses risk_pct, futures use contracts; pyramiding fixed at 1) ----
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Crypto/spot sizing: notional = equity x risk_pct / entry price."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures sizing: number of contracts (risk_pct is inert on futures)."),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=1, step=1, group="Risk",
                  description="Fixed at 1 — this is a one-trade-at-a-time setup."),
    ]

    META = StrategyMeta(
        id="asia_range_breakout_sandbox",
        name="ICT Asia Range Breakout (Sandbox)",
        description=("Long-only failed-sweep fade of the Asia box: a wick must poke below the range "
                     "low and the SAME bar must close back inside. Targets the top of the box; exits "
                     "when a bar closes back outside the range after an N-candle grace period, or at "
                     "a hard time cutoff. One trade/day, no ATR."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("box_top", "Range top", from_column="box_top_disp",
                    color="#22c55e", line_width=2, line_style="solid"),
        OverlaySpec("box_bot", "Range bottom", from_column="box_bot_disp",
                    color="#ef4444", line_width=2, line_style="solid"),
        OverlaySpec("stop", "Structural stop", from_column="stop_price",
                    color="rgba(239,68,68,0.85)", line_width=1, line_style="dashed"),
    ]

    # ------------------------------------------------------------------ helper
    @staticmethod
    def _deadline(entry_ts: int, hour_utc: int) -> int:
        """First occurrence of `hour_utc`:00 UTC strictly after `entry_ts`.

        Resolved as an absolute timestamp at entry rather than compared as a
        time-of-day each bar, so the cutoff is correct even if it is set to an
        hour that falls before the entry window (it then lands the next day)."""
        day_start = (entry_ts // 86400) * 86400
        dl = day_start + hour_utc * 3600
        return dl if dl > entry_ts else dl + 86400

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        n = len(out)

        ts = pd.to_datetime(out["time"], unit="s", utc=True)
        ts.index = out.index
        asia_mask = session_mask(ts, p["asia_session"]).to_numpy()
        entry_mask = session_mask(ts, p["entry_session"]).to_numpy()

        time_a = out["time"].to_numpy(dtype=np.int64)
        high_a = out["high"].astype(float).to_numpy()
        low_a = out["low"].astype(float).to_numpy()
        close_a = out["close"].astype(float).to_numpy()
        day_a = time_a // 86400

        depth = float(p["break_depth"])
        stop_bars = max(1, int(p["stop_after_bars"]))
        cutoff_h = int(p["force_exit_hour_utc"])

        cond_long = np.zeros(n, dtype=bool)
        bar_exit_long = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)
        box_top_disp = np.full(n, np.nan)
        box_bot_disp = np.full(n, np.nan)

        # Pass 1 — freeze each UTC day's Asia box onto that day's post-Asia bars.
        for d in np.unique(day_a):
            day_idx = np.nonzero(day_a == d)[0]
            asia_idx = day_idx[asia_mask[day_idx]]
            if asia_idx.size == 0:
                continue
            bh = float(np.nanmax(high_a[asia_idx]))
            bl = float(np.nanmin(low_a[asia_idx]))
            if not (np.isfinite(bh) and np.isfinite(bl)) or bh <= bl:
                continue
            post = day_idx[day_idx > int(asia_idx.max())]
            box_top_disp[post] = bh
            box_bot_disp[post] = bl

        # Pass 2 — one sequential walk that mirrors on_candle exactly.
        cur_day = None
        long_dead = False
        done_today = False
        pos = 0
        bars_held = 0
        entry_box_high = entry_box_low = np.nan
        deadline = 0

        for t in range(n):
            if day_a[t] != cur_day:
                cur_day = day_a[t]
                long_dead = False
                done_today = False

            c = close_a[t]

            # ---- manage the open position (exits ignore the session windows) ----
            if pos != 0:
                bars_held += 1
                # The stop only exists once the grace period has elapsed; until
                # then the line is drawn faintly by leaving stop_price NaN.
                armed = bars_held >= stop_bars
                if armed:
                    stop_price[t] = entry_box_low
                if c >= entry_box_high:                       # take profit
                    bar_exit_long[t] = True
                    pos = 0
                elif armed and c <= entry_box_low:            # structural stop
                    bar_exit_long[t] = True
                    pos = 0
                elif time_a[t] >= deadline:                   # hard time cutoff
                    bar_exit_long[t] = True
                    pos = 0
                continue        # one action per bar, exactly like on_candle

            # ---- flat: hunt the day's sweep+reclaim ----
            bh = box_top_disp[t]
            bl = box_bot_disp[t]
            if (done_today or long_dead or not np.isfinite(bh) or not np.isfinite(bl)
                    or asia_mask[t] or not entry_mask[t]):
                continue

            sweep_low = bl - depth * (bh - bl)   # the wick must get strictly below this

            # The one-bar rule: wick out AND the SAME bar closes back inside.
            if low_a[t] < sweep_low and c > bl:
                cond_long[t] = True
                pos = 1
                bars_held = 0
                entry_box_high, entry_box_low = bh, bl
                deadline = self._deadline(int(time_a[t]), cutoff_h)
                done_today = True
            elif c <= bl:
                # A close back outside means the range did not hold — no fade today.
                long_dead = True

        out["cond_long"] = cond_long
        out["cond_short"] = np.zeros(n, dtype=bool)
        out["bar_exit_long"] = bar_exit_long
        out["bar_exit_short"] = np.zeros(n, dtype=bool)
        # Base Strategy contract (also what the chart markers read).
        out["entry_long"] = cond_long
        out["entry_short"] = np.zeros(n, dtype=bool)
        out["exit_long"] = bar_exit_long
        out["exit_short"] = np.zeros(n, dtype=bool)
        out["stop_price"] = stop_price
        out["box_top_disp"] = box_top_disp
        out["box_bot_disp"] = box_bot_disp
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Live, stateful mirror of the backtest.

        State: cur_day, box_high/low, long_dead, done_today, pos, bars_held,
        entry_box_high/low, deadline.

        Known seam (shared with every live path here): the backtest fills at the
        NEXT bar's open, while live can only transact at the close of the bar that
        confirmed. No indicator buffer is needed — this strategy has no lookback.
        """
        if not bool(candle.get("isClosed", False)):
            return None

        p = self.p
        ts = int(candle["time"])
        c = float(candle["close"])
        hi = float(candle["high"])
        lo = float(candle["low"])
        day = ts // 86400

        # New UTC day → reset the box and the invalidation flag.
        if state.get("cur_day") != day:
            state["cur_day"] = day
            state["box_high"] = None
            state["box_low"] = None
            state["long_dead"] = False
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

        in_asia = _in(p["asia_session"])
        in_entry = _in(p["entry_session"])

        # Extend the Asia box while inside the Asia window.
        if in_asia:
            bh0 = state.get("box_high")
            bl0 = state.get("box_low")
            state["box_high"] = hi if bh0 is None else max(bh0, hi)
            state["box_low"] = lo if bl0 is None else min(bl0, lo)

        stop_bars = max(1, int(p["stop_after_bars"]))
        pos = int(state.get("pos", 0))

        # ---- Manage the open position (exits ignore the session windows) ----
        if pos != 0:
            held = int(state.get("bars_held", 0)) + 1
            state["bars_held"] = held
            ebh = state.get("entry_box_high", np.nan)
            ebl = state.get("entry_box_low", np.nan)
            armed = held >= stop_bars
            reason = None
            if c >= ebh:
                reason = "box_tp"
            elif armed and c <= ebl:
                reason = "range_lost"
            elif ts >= int(state.get("deadline", 0)):
                reason = "time_cutoff"
            if reason:
                state["pos"] = 0
                return Signal(side="long", kind="exit", price=c, time=ts, reason=reason)
            return None

        # ---- Flat: hunt the day's sweep+reclaim ----
        if state.get("done_today") or state.get("long_dead"):
            return None
        box_high = state.get("box_high")
        box_low = state.get("box_low")
        if box_high is None or box_low is None or box_high <= box_low:
            return None
        if in_asia or not in_entry:
            return None

        sweep_low = box_low - float(p["break_depth"]) * (box_high - box_low)

        if lo < sweep_low and c > box_low:
            state.update({"pos": 1, "bars_held": 0,
                          "entry_box_high": box_high, "entry_box_low": box_low,
                          "deadline": self._deadline(ts, int(p["force_exit_hour_utc"])),
                          "done_today": True})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="sweep_reclaim")
        if c <= box_low:
            state["long_dead"] = True
        return None
