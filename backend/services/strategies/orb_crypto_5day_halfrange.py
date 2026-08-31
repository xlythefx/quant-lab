"""
ORB Crypto - 5DAY - HALFRANGE — a crypto port of the MultiCharts "BK-ID-ORB"
breakout (see docs/txt-strategies/[BK-ID-ORB-MNQ-001].txt).

THE IDEA IN PLAIN WORDS
  1. Yesterday moved a certain distance top-to-bottom. Call that yesterday's range.
  2. Take today's opening price. Draw a line HALF a range above it and half a range
     below it. Those two lines are the triggers.
  3. Only trade at all if the market has been coiled — over the last 5 days it has
     thrashed around but gone almost nowhere. The bet: compression precedes expansion.
  4. First trigger touched wins the day. One trade per day, then done.
  5. Out at a fixed loss, a fixed (4x bigger) gain, or the end of the day.

Despite "ORB" in the name this is NOT a classic opening-range breakout — it never
measures today's first N minutes. The level comes from YESTERDAY's range, anchored
to TODAY's open. Kept the original's name for traceability.

WHAT CHANGED FROM THE ORIGINAL (and why)
  - REMOVED: the breakeven ratchet ("trailing stop"). The original pulled the stop to
    entry+5 ticks once open profit reached 1R. Gone — exits are now stop / target /
    end-of-day only. This is the one behavioural change requested; everything else is
    either faithful or a forced consequence of the asset class.
  - Session -> UTC calendar day. Crypto is 24/7; there is no 17:00-16:00 CT session.
    "Yesterday" = previous UTC day, "today's open" = first bar of the current UTC day.
  - Dollar stop/target -> PERCENT of entry price. A "$90 stop" is meaningless without
    a contract multiplier. The original's $90/$360 on MNQ is 45/180 Nasdaq points,
    ~0.225%/0.9% at 20,000. Defaulted to 1%/2% here: the absolute size is raised
    because crypto is far more volatile than the Nasdaq (0.225% would be pure noise),
    and the reward-to-risk is cut from the original's 1:4 to 1:2 because a 1:4 target
    does not fit inside a single day on this asset -- see below.
  - REWARD-TO-RISK IS 1:2, NOT THE ORIGINAL'S 1:4. Measured on BTCUSDT 1h, only 9.9%
    of these trades ever travel +4% before the day ends, while ~32% reach +2%. On the
    Nasdaq day session a 1:4 target was reachable; on BTC it is not, so a 1:4 ratio and
    a same-day flatten are in direct conflict. 1:2 puts the target back inside the
    range a day actually delivers. The breakeven hit-rate for 1:2 is 33% before costs,
    so this is NOT free -- it still has to clear the gauntlet.
  - The original's "enter 5 ticks early" offset is exposed as `entry_offset_pct` and
    defaults to 0. On MNQ it is 0.006% — negligible as a percentage, and a repeated
    small magic number is usually an optimizer's residue. Test it, don't inherit it.
  - Every fitted constant (0.5 compression fraction, 0.5 half-range, 5-day lookback)
    is a parameter so it can be plateau-tested rather than trusted.

HONEST-EXECUTION NOTES (this engine is stricter than MultiCharts)
  - Orders are placed on bar t and live for bar t+1. A stop entry fills AT the trigger
    level, gap-protected against t+1's open (never better than the open).
  - Stop is checked BEFORE target within a bar. If one bar spans both, we assume the
    loss. Pessimistic on purpose — intrabar order is unknowable from OHLC.
  - When both a long and a short trigger are armed and t+1 hits both, the one NEARER
    t+1's open wins (price must travel there first). Exact ties go long.
  - The original exits end-of-day with "this bar at close", which assumes you transact
    at the close you just observed. Kept here (fill = that bar's close) so the port is
    comparable, but it is the one optimistic assumption in the file.

ENGINE CONTRACT
  cond_long / cond_short           entry conditions (order-placement bar)
  entry_fill_long / _short         Option-B exact entry fill (the stop level)
  bar_exit_long / _short           exit conditions
  exit_fill_long / _short          Option-B exact exit fill (stop / target / close)
The engine owns position state and sizing; this file owns the stop/target logic
because those are entry-relative and the engine has no native percent-stop hook.
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


class OrbCrypto5DayHalfRangeStrategy(Strategy):
    PARAM_SCHEMA = [
        # ---- The trigger level: a fraction of yesterday's range off today's open ----
        ParamSpec("range_frac", ParamType.FLOAT, 0.5, min=0.1, max=2.0, step=0.05,
                  group="Trigger Level",
                  description="Trigger distance = this fraction of YESTERDAY's high-low "
                              "range, measured up and down from TODAY's open. 0.5 = the "
                              "original's half-range."),
        # ---- Compression gate: the actual premise of the strategy ----
        ParamSpec("use_compression", ParamType.BOOL, True, group="Compression Filter",
                  description="Only trade when the market has been coiled — lots of "
                              "movement, little net progress."),
        ParamSpec("lookback_days", ParamType.INT, 5, min=2, max=30, step=1,
                  group="Compression Filter",
                  description="How many completed days the compression box is measured over."),
        ParamSpec("compression_frac", ParamType.FLOAT, 0.5, min=0.1, max=2.0, step=0.05,
                  group="Compression Filter",
                  description="Pass when |open N days ago - yesterday's close| is less than "
                              "this fraction of the N-day high-low box. Lower = stricter."),
        # ---- Directional day filters (faithful to the original's asymmetry) ----
        ParamSpec("use_inside_day_filter", ParamType.BOOL, True, group="Day Filters",
                  description="Block LONGS when yesterday sat entirely inside the day before "
                              "(a quiet coil-within-a-coil)."),
        ParamSpec("use_lower_low_filter", ParamType.BOOL, True, group="Day Filters",
                  description="Allow SHORTS only when yesterday made BOTH a lower high and a "
                              "lower low than the day before. Off = shorts always allowed."),
        # ---- Entry mechanics ----
        ParamSpec("entry_offset_pct", ParamType.FLOAT, 0.0, min=0.0, max=0.5, step=0.01,
                  group="Entry",
                  description="Trigger this %% EARLY (buy stop below the level, sell stop "
                              "above). The original used 5 MNQ ticks. 0 = trigger exactly "
                              "at the level."),
        ParamSpec("trade_all_day", ParamType.BOOL, True, group="Entry",
                  description="Crypto is 24/7 — take entries at any hour. Turn OFF to "
                              "restrict entries to the window below."),
        ParamSpec("entry_session", ParamType.SESSIONS,
                  {"entry": {"enabled": True, "start": "07:00", "end": "15:00"}},
                  group="Entry",
                  description="UTC window where an entry may open (used only when "
                              "'trade_all_day' is off). Default mirrors the original's "
                              "07:00-15:00."),
        # ---- Exits: fixed stop, fixed target, day-end flat. NO breakeven ratchet. ----
        ParamSpec("stop_pct", ParamType.FLOAT, 1.0, min=0.1, max=20.0, step=0.1,
                  group="Exits",
                  description="Stop-loss as %% of entry price. The original's $90 on MNQ."),
        ParamSpec("target_pct", ParamType.FLOAT, 2.0, min=0.1, max=50.0, step=0.1,
                  group="Exits",
                  description="Profit target as %% of entry price. Default is 2x the stop "
                              "(1:2). The original ran 1:4, but a 4%% target is reached by "
                              "under 10%% of these trades before the day ends on BTC."),
        ParamSpec("flat_at_day_end", ParamType.BOOL, True, group="Exits",
                  description="Close any open trade at the last bar of the UTC day. The "
                              "original never held overnight. Off = ride to stop/target."),
        # ---- Direction ----
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction"),
        # ---- Sizing ----
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Crypto/spot sizing: notional = equity x risk_pct / entry price."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures sizing: number of contracts (risk_pct is inert on futures)."),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=1, step=1, group="Risk",
                  description="Fixed at 1 — one trade per day, one at a time."),
    ]

    META = StrategyMeta(
        id="orb_crypto_5day_halfrange",
        name="ORB Crypto - 5DAY - HALFRANGE",
        description=("Crypto port of the MultiCharts BK-ID-ORB breakout. Triggers sit half "
                     "of YESTERDAY's range above and below TODAY's open, armed only when the "
                     "last 5 days show compression (movement without progress). One trade per "
                     "UTC day; exits on a fixed %% stop, a 2x %% target (1:2), or the day-end "
                     "flat. The original's breakeven ratchet is REMOVED."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("trig_long", "Long trigger", from_column="trig_long_disp",
                    color="#22c55e", line_width=2),
        OverlaySpec("trig_short", "Short trigger", from_column="trig_short_disp",
                    color="#ef4444", line_width=2),
        OverlaySpec("stop_line", "Stop", from_column="stop_price",
                    color="rgba(239,68,68,0.85)", line_width=1, line_style="dashed"),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        n = len(out)

        time_a = out["time"].to_numpy(dtype=np.int64)
        open_a = out["open"].astype(float).to_numpy()
        high_a = out["high"].astype(float).to_numpy()
        low_a = out["low"].astype(float).to_numpy()
        close_a = out["close"].astype(float).to_numpy()
        day_a = time_a // 86400  # UTC calendar day

        # Empty / degenerate input: emit the contract columns and bail.
        if n == 0:
            return self._empty(out, n)

        # ---- Daily OHLC from the intraday bars (UTC days) ----
        tmp = pd.DataFrame({"d": day_a, "open": open_a, "high": high_a,
                            "low": low_a, "close": close_a})
        g = tmp.groupby("d", sort=True)
        d_idx = g["open"].first().index.to_numpy()
        d_open = g["open"].first().to_numpy(dtype=float)
        d_high = g["high"].max().to_numpy(dtype=float)
        d_low = g["low"].min().to_numpy(dtype=float)
        d_close = g["close"].last().to_numpy(dtype=float)
        nd = len(d_idx)

        range_frac = float(p["range_frac"])
        comp_frac = float(p["compression_frac"])
        use_comp = bool(p["use_compression"])
        lb = int(p["lookback_days"])

        # ---- Per-day levels + filters. Every value for day k uses ONLY days < k,
        #      plus day k's own open (known from its first bar). Causal.
        trig_lvl_long = np.full(nd, np.nan)
        trig_lvl_short = np.full(nd, np.nan)
        comp_d = np.zeros(nd, dtype=bool)
        inside_d = np.zeros(nd, dtype=bool)    # yesterday inside the day before -> blocks longs
        lowlow_d = np.zeros(nd, dtype=bool)    # yesterday lower-high AND lower-low -> permits shorts

        need = max(lb, 2)
        for k in range(need, nd):
            prev_h = d_high[k - 1]
            prev_l = d_low[k - 1]
            rng = prev_h - prev_l
            if not (np.isfinite(rng) and rng > 0 and np.isfinite(d_open[k])):
                continue
            trig_lvl_long[k] = d_open[k] + range_frac * rng
            trig_lvl_short[k] = d_open[k] - range_frac * rng

            if use_comp:
                box_h = np.nanmax(d_high[k - lb:k])
                box_l = np.nanmin(d_low[k - lb:k])
                box = box_h - box_l
                net = abs(d_open[k - lb] - d_close[k - 1])
                comp_d[k] = bool(box > 0 and np.isfinite(net) and net < comp_frac * box)
            else:
                comp_d[k] = True

            inside_d[k] = bool(d_high[k - 2] > d_high[k - 1] and d_low[k - 2] < d_low[k - 1])
            lowlow_d[k] = bool(d_high[k - 1] < d_high[k - 2] and d_low[k - 1] < d_low[k - 2])

        # Map per-day values back onto every intraday bar.
        day_pos = np.searchsorted(d_idx, day_a)
        lvl_long_a = trig_lvl_long[day_pos]
        lvl_short_a = trig_lvl_short[day_pos]
        comp_a = comp_d[day_pos]
        inside_a = inside_d[day_pos]
        lowlow_a = lowlow_d[day_pos]

        # ---- Entry window ----
        if bool(p["trade_all_day"]):
            in_win = np.ones(n, dtype=bool)
        else:
            ts = pd.to_datetime(out["time"], unit="s", utc=True)
            ts.index = out.index
            in_win = session_mask(ts, p["entry_session"]).to_numpy()

        # ---- Day-end flatten bar = last in-window bar of each day ----
        eod_a = np.zeros(n, dtype=bool)
        if bool(p["flat_at_day_end"]):
            win_idx = np.nonzero(in_win)[0]
            if win_idx.size:
                dd = day_a[win_idx]
                is_last = np.empty(win_idx.size, dtype=bool)
                is_last[:-1] = dd[:-1] != dd[1:]
                is_last[-1] = True
                eod_a[win_idx[is_last]] = True

        # Next bar is usable for a fill only if it is the same day AND in-window.
        same_next = np.zeros(n, dtype=bool)
        if n > 1:
            same_next[:-1] = (day_a[:-1] == day_a[1:]) & in_win[1:]

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))
        use_inside = bool(p["use_inside_day_filter"])
        use_lowlow = bool(p["use_lower_low_filter"])
        off = float(p["entry_offset_pct"]) / 100.0
        stop_f = float(p["stop_pct"]) / 100.0
        tgt_f = float(p["target_pct"]) / 100.0

        cond_long = np.zeros(n, dtype=bool)
        cond_short = np.zeros(n, dtype=bool)
        bar_exit_long = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)
        entry_fill_long = np.full(n, np.nan)
        entry_fill_short = np.full(n, np.nan)
        exit_fill_long = np.full(n, np.nan)
        exit_fill_short = np.full(n, np.nan)
        stop_price = np.full(n, np.nan)

        pos = 0
        entry_price = np.nan
        last_entry_day = -1

        for t in range(n):
            o = open_a[t]; h = high_a[t]; l = low_a[t]; c = close_a[t]

            # ---- Exits first (stop -> target -> day end). No breakeven ratchet. ----
            if pos != 0 and np.isfinite(entry_price):
                if pos == 1:
                    stop_lvl = entry_price * (1.0 - stop_f)
                    tgt_lvl = entry_price * (1.0 + tgt_f)
                    stop_price[t] = stop_lvl
                    reason = None; fill = np.nan
                    if l <= stop_lvl:
                        reason = "stop"; fill = min(stop_lvl, o)      # gap-protected (worse)
                    elif h >= tgt_lvl:
                        reason = "target"; fill = max(tgt_lvl, o)     # gap-protected (better)
                    elif eod_a[t]:
                        reason = "eod"; fill = c
                    if reason:
                        bar_exit_long[t] = True
                        exit_fill_long[t] = fill
                        pos = 0; entry_price = np.nan
                else:
                    stop_lvl = entry_price * (1.0 + stop_f)
                    tgt_lvl = entry_price * (1.0 - tgt_f)
                    stop_price[t] = stop_lvl
                    reason = None; fill = np.nan
                    if h >= stop_lvl:
                        reason = "stop"; fill = max(stop_lvl, o)
                    elif l <= tgt_lvl:
                        reason = "target"; fill = min(tgt_lvl, o)
                    elif eod_a[t]:
                        reason = "eod"; fill = c
                    if reason:
                        bar_exit_short[t] = True
                        exit_fill_short[t] = fill
                        pos = 0; entry_price = np.nan

            # ---- Entries: arm order(s) on bar t, they live for bar t+1 ----
            d = int(day_a[t])
            if (pos == 0 and last_entry_day != d and t + 1 < n
                    and in_win[t] and same_next[t] and comp_a[t]
                    and np.isfinite(lvl_long_a[t]) and np.isfinite(lvl_short_a[t])):

                long_ok = long_on and not (use_inside and inside_a[t])
                short_ok = short_on and (lowlow_a[t] if use_lowlow else True)

                nxt_o = open_a[t + 1]; nxt_h = high_a[t + 1]; nxt_l = low_a[t + 1]
                # (side, fill, distance-from-open). Nearest to the open fills first.
                cands: list[tuple[str, float, float]] = []

                if long_ok:
                    if c < lvl_long_a[t]:
                        trig = lvl_long_a[t] * (1.0 - off)   # buy stop, optionally early
                        if nxt_h >= trig:
                            cands.append(("long", max(trig, nxt_o), max(0.0, trig - nxt_o)))
                    else:
                        # Already beyond the level -> the original chases at market.
                        cands.append(("long", nxt_o, 0.0))

                if short_ok:
                    if c > lvl_short_a[t]:
                        trig = lvl_short_a[t] * (1.0 + off)  # sell stop, optionally early
                        if nxt_l <= trig:
                            cands.append(("short", min(trig, nxt_o), max(0.0, nxt_o - trig)))
                    else:
                        cands.append(("short", nxt_o, 0.0))

                if cands:
                    cands.sort(key=lambda x: x[2])           # nearest the open wins; ties -> long
                    side, fill, _ = cands[0]
                    if side == "long":
                        cond_long[t] = True
                        entry_fill_long[t] = fill
                        pos = 1
                    else:
                        cond_short[t] = True
                        entry_fill_short[t] = fill
                        pos = -1
                    entry_price = fill
                    last_entry_day = d

        out["cond_long"] = cond_long
        out["cond_short"] = cond_short
        out["bar_exit_long"] = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        out["entry_long"] = cond_long
        out["entry_short"] = cond_short
        out["exit_long"] = bar_exit_long
        out["exit_short"] = bar_exit_short
        out["entry_fill_long"] = entry_fill_long
        out["entry_fill_short"] = entry_fill_short
        out["exit_fill_long"] = exit_fill_long
        out["exit_fill_short"] = exit_fill_short
        out["stop_price"] = stop_price
        # Overlays: the two trigger lines, painted across the day they belong to.
        out["trig_long_disp"] = np.where(comp_a, lvl_long_a, np.nan)
        out["trig_short_disp"] = np.where(comp_a, lvl_short_a, np.nan)
        return out

    @staticmethod
    def _empty(out: pd.DataFrame, n: int) -> pd.DataFrame:
        z = np.zeros(n, dtype=bool)
        nan = np.full(n, np.nan)
        for col in ("cond_long", "cond_short", "bar_exit_long", "bar_exit_short",
                    "entry_long", "entry_short", "exit_long", "exit_short"):
            out[col] = z
        for col in ("entry_fill_long", "entry_fill_short", "exit_fill_long",
                    "exit_fill_short", "stop_price", "trig_long_disp", "trig_short_disp"):
            out[col] = nan
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Live mirror. State keys:
          days        completed daily OHLC dicts (oldest first, trimmed)
          cur         the in-progress UTC day {d,o,h,l,c}
          done_day    UTC day whose single trade is already spent
          pos, entry_price

        Two known seams vs the backtest, both inherent to bar-by-bar live running:
          - the day-end flat fires on the FIRST bar of the new day (or the first bar
            outside the entry window), not on the last bar of the old one;
          - entries fill at this bar's close rather than at the exact trigger level.
        See CLAUDE.md live-vs-backtest parity note (single-position; pyramiding=1).
        """
        if not bool(candle.get("isClosed", False)):
            return None

        p = self.p
        ts = int(candle["time"])
        o = float(candle["open"]); h = float(candle["high"])
        l = float(candle["low"]); c = float(candle["close"])
        d = ts // 86400

        # ---- Roll the daily aggregation ----
        cur = state.get("cur")
        rolled = False
        if cur is None or cur["d"] != d:
            if cur is not None:
                days = state.setdefault("days", [])
                days.append(cur)
                lb = max(int(p["lookback_days"]), 2)
                if len(days) > lb * 4:
                    del days[: len(days) - lb * 4]
                rolled = True
            state["cur"] = {"d": d, "o": o, "h": h, "l": l, "c": c}
        else:
            cur["h"] = max(cur["h"], h)
            cur["l"] = min(cur["l"], l)
            cur["c"] = c

        tod = datetime.fromtimestamp(ts, tz=timezone.utc).time()
        if bool(p["trade_all_day"]):
            in_win = True
        else:
            in_win = False
            for cfg in (p["entry_session"] or {}).values():
                if cfg and cfg.get("enabled") and in_window_live(
                        tod, (parse_hhmm(cfg.get("start", "00:00")),
                              parse_hhmm(cfg.get("end", "00:00")))):
                    in_win = True
                    break

        stop_f = float(p["stop_pct"]) / 100.0
        tgt_f = float(p["target_pct"]) / 100.0
        pos = state.get("pos", 0)

        # ---- Manage an open position: stop -> target -> day-end flat ----
        if pos != 0:
            ep = state.get("entry_price", np.nan)
            if np.isfinite(ep):
                flat_eod = bool(p["flat_at_day_end"]) and (rolled or not in_win)
                if pos == 1:
                    if l <= ep * (1.0 - stop_f):
                        state["pos"] = 0
                        return Signal(side="long", kind="exit", price=c, time=ts, reason="stop")
                    if h >= ep * (1.0 + tgt_f):
                        state["pos"] = 0
                        return Signal(side="long", kind="exit", price=c, time=ts, reason="target")
                    if flat_eod:
                        state["pos"] = 0
                        return Signal(side="long", kind="exit", price=c, time=ts, reason="day_end")
                else:
                    if h >= ep * (1.0 + stop_f):
                        state["pos"] = 0
                        return Signal(side="short", kind="exit", price=c, time=ts, reason="stop")
                    if l <= ep * (1.0 - tgt_f):
                        state["pos"] = 0
                        return Signal(side="short", kind="exit", price=c, time=ts, reason="target")
                    if flat_eod:
                        state["pos"] = 0
                        return Signal(side="short", kind="exit", price=c, time=ts, reason="day_end")
            return None

        # ---- Flat: look for the day's single entry ----
        if state.get("done_day") == d or not in_win:
            return None

        days = state.get("days", [])
        lb = int(p["lookback_days"])
        if len(days) < max(lb, 2):
            return None

        prev = days[-1]
        prev_before = days[-2]
        rng = prev["h"] - prev["l"]
        today_open = state["cur"]["o"]
        if not (np.isfinite(rng) and rng > 0):
            return None

        range_frac = float(p["range_frac"])
        lvl_long = today_open + range_frac * rng
        lvl_short = today_open - range_frac * rng

        if bool(p["use_compression"]):
            win = days[-lb:]
            box = max(x["h"] for x in win) - min(x["l"] for x in win)
            net = abs(win[0]["o"] - prev["c"])
            if not (box > 0 and net < float(p["compression_frac"]) * box):
                return None

        inside = prev_before["h"] > prev["h"] and prev_before["l"] < prev["l"]
        lowlow = prev["h"] < prev_before["h"] and prev["l"] < prev_before["l"]

        sides = p["sides"]
        long_ok = bool(sides.get("long")) and not (bool(p["use_inside_day_filter"]) and inside)
        short_ok = bool(sides.get("short")) and (lowlow if bool(p["use_lower_low_filter"]) else True)
        off = float(p["entry_offset_pct"]) / 100.0

        # Live has no next-bar lookahead: trigger on THIS closed bar piercing the level.
        if long_ok and h >= lvl_long * (1.0 - off):
            state.update({"pos": 1, "entry_price": c, "done_day": d})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="halfrange_break")
        if short_ok and l <= lvl_short * (1.0 + off):
            state.update({"pos": -1, "entry_price": c, "done_day": d})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="halfrange_break")
        return None
