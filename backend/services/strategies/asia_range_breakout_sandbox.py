"""
ICT Asia Range Breakout (Sandbox) — failed-sweep fade of the Asia box (long by default).

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

  WEEKEND Saturday/Sunday (UTC day) are off by default (`skip_weekends`): no box,
          no entries. The setup feeds on London/NY liquidity, which is absent
          at the weekend. Friday's trade is already flat by the 20:00 UTC cutoff.

  SHORT   (`sides`, default long only) the exact mirror: a bar WICKS above the box
          high and the SAME bar CLOSES back below it → sell at the next open. TP =
          the box low; structural stop = a close back at/above the box high after
          the grace period; a close at/above the high kills shorts for the day.
          With both sides on it is still one trade per day — whichever side
          triggers first. A single bar that sweeps BOTH sides and closes inside is
          skipped: that is a wild bar, not a signal.

  REGIME  (`use_regime`, default off) entries only while the regime allows them —
          ADX (ranging: ADX below the threshold) or the 5-regime labels you tick,
          the same engines and params as vwma_reversion. Measured on THIS chart's
          bars, so on 15m ADX(20) reads the last ~5 hours: "is it choppy right
          now", not "is crypto in a bear market". Exits ignore it. HMM is left
          out on purpose — it is backtest-only and would break live parity.

  BOX STOP (`use_box_stop`, default off) an emergency stop `box_stop_mult` box
          heights beyond the box: long = box low - mult x height, short = box
          high + mult x height. Anchored to the BOX, not the fill, so backtest and
          live compute the same level. Live from the first bar held, so it covers
          the grace period. A bar whose wick touches it exits at the next open —
          what the live runner can actually do (the acceptor has no resting stop
          orders), so slightly pessimistic vs a real stop order.

  WITH THE BOX STOP OFF THERE IS NO PRICE STOP BEFORE BAR N. Fading a sweep means
  buying a falling knife, and between entry and bar N nothing can close the
  position at any price. Even with it on, a one-bar wick can liquidate a 25x
  position INSIDE that bar before any bar-based stop reacts — only an exchange
  stop order or lower leverage prevents that. Size accordingly.

No ATR anywhere: break_depth and the box stop are fractions of the BOX HEIGHT (the
Asia range is itself a volatility reading — a wide box means a wild day), and the
main stop is structural. The optional regime filter is the only lookback.

Engine contract — this file OWNS its position state, like vwma_reversion_v2:
  - cond_long / cond_short         : entry signals, emitted only when flat
  - bar_exit_long / bar_exit_short : TP, box stop, the N-bar structural stop, or
                                     the time cutoff (see _exit_reason)
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
from services.strategies.session_utils import (
    parse_hhmm, in_window_live, session_mask, is_weekend_utc,
)
from services.strategies.regime import RegimeDetector, _regime_labels, _regime_params


# ---------------------------------------------------------------------------
# Decisions shared by vectorized() and on_candle() — one copy, so the backtest
# and the live runner cannot drift apart.
# ---------------------------------------------------------------------------

def _entry_side(lo, hi, c, bh, bl, depth, can_long, can_short) -> int:
    """+1 / -1 for a sweep+reclaim on this bar, else 0. The wick must get
    strictly past the edge (by `depth` box heights) and the SAME bar must close
    back inside. A bar that sweeps BOTH sides is skipped."""
    h = bh - bl
    go_long = can_long and lo < bl - depth * h and c > bl
    go_short = can_short and hi > bh + depth * h and c < bh
    if go_long and go_short:
        return 0
    return 1 if go_long else -1 if go_short else 0


def _box_stop_level(side, bh, bl, enabled, mult) -> float:
    """The emergency stop `mult` box heights beyond the box; NaN when off."""
    if not enabled:
        return float("nan")
    h = bh - bl
    return bl - mult * h if side == 1 else bh + mult * h


def _exit_reason(pos, c, hi, lo, ebh, ebl, armed, stop_level, ts, deadline):
    """Why an open position exits on this bar, or None. Every exit fills at the
    next open, so the order below only picks the label. NaN stop_level = the box
    stop is off (comparisons with NaN are False)."""
    if pos == 1:
        if c >= ebh:
            return "box_tp"
        if lo <= stop_level:
            return "box_stop"
        if armed and c <= ebl:
            return "range_lost"
    else:
        if c <= ebl:
            return "box_tp"
        if hi >= stop_level:
            return "box_stop"
        if armed and c >= ebh:
            return "range_lost"
    if ts >= deadline:
        return "time_cutoff"
    return None


def _five_params(p) -> dict:
    return _regime_params({"adx_period": p["regime_adx_period"],
                           "adx_trend_thresh": p["regime_adx_threshold"]})


def _allowed(p) -> list:
    return [k for k, on in (p.get("allowed_regimes") or {}).items() if on]


def _regime_mask(df: pd.DataFrame, p) -> np.ndarray:
    """Per-bar 'the regime allows an entry' for the backtest (causal)."""
    if p.get("regime_method") == "five":
        return np.isin(_regime_labels(df, _five_params(p)), _allowed(p))
    return RegimeDetector(p["regime_adx_period"], p["regime_adx_threshold"]).detect(df).to_numpy()


def _regime_ok_last(df: pd.DataFrame, p) -> bool:
    """The same answer for the LAST bar of `df` (live)."""
    if p.get("regime_method") == "five":
        return _regime_labels(df, _five_params(p))[-1] in _allowed(p)
    rd = RegimeDetector(p["regime_adx_period"], p["regime_adx_threshold"])
    return rd.last_adx(df) < p["regime_adx_threshold"]


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
        ParamSpec("skip_weekends", ParamType.BOOL, True, group="Entry Window",
                  description="No box and no new trades on Saturday/Sunday (UTC day). The setup "
                              "relies on London/NY liquidity, which is absent at the weekend. A "
                              "Friday trade is already closed by the time cutoff before Saturday."),
        # ---- Direction ----
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": False}, group="Direction",
                  description="Long = fade a sweep BELOW the box (buy, target the top). Short = the "
                              "mirror: fade a sweep ABOVE the box (sell, target the bottom). Both = "
                              "either side, still one trade per day."),
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
        ParamSpec("use_box_stop", ParamType.BOOL, False, group="Stop",
                  description="Emergency price stop, live from the FIRST bar (it covers the grace "
                              "period). Sits box_stop_mult box heights beyond the box: below the low "
                              "for longs, above the high for shorts. A wick touching it exits at the "
                              "next open."),
        ParamSpec("box_stop_mult", ParamType.FLOAT, 1.0, min=0.1, max=5.0, step=0.1, group="Stop",
                  description="Distance of the emergency stop in box heights. 1 = one full box height "
                              "beyond the box edge. Only used when use_box_stop is on."),
        # ---- Regime filter (entries only; exits always fire) ----
        ParamSpec("use_regime", ParamType.BOOL, False, group="Regime",
                  description="Master switch: only take entries while the regime allows it. Exits "
                              "always fire. Measured on this chart's bars — on 15m it reads the last "
                              "few hours, not the bigger trend."),
        ParamSpec("regime_method", ParamType.SELECT, "adx", group="Regime",
                  options=[
                      {"value": "adx",  "label": "ADX (ranging vs trending)"},
                      {"value": "five", "label": "5-Regime classifier"},
                  ],
                  description="ADX: trade only while ADX is below the threshold (ranging — where "
                              "fades work). 5-Regime: trade only in the regimes ticked below."),
        ParamSpec("regime_adx_period",    ParamType.INT,   20,   min=5,  max=50,  step=1,   group="Regime",
                  description="Bars used to compute ADX (a 0-100 gauge of trend strength) for the "
                              "regime filter. Only used when use_regime is on."),
        ParamSpec("regime_adx_threshold", ParamType.FLOAT, 40.0, min=10.0, max=60.0, step=1.0, group="Regime",
                  description="ADX method: enter only while ADX is below this (a sideways market). "
                              "5-Regime method: ADX at/above this counts as trending."),
        ParamSpec("allowed_regimes", ParamType.REGIMES,
                  {"Trending Up": False, "Trending Down": False,
                   "High-Volatility": False, "Quiet": True, "Choppy-Range": True},
                  group="Regime",
                  description="5-Regime method: only allow entries while the market is in one of the "
                              "checked regimes."),
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
        description=("Failed-sweep fade of the Asia box: a wick pokes past the range edge and the SAME "
                     "bar closes back inside. Long by default (short / both optional). Targets the far "
                     "side of the box; exits on a close back outside after an N-candle grace period, "
                     "an optional box-height emergency stop, or a hard time cutoff. Optional regime "
                     "filter. One trade/day, no ATR."),
        schema=PARAM_SCHEMA,
        guide=(
            "Boxes the Asia-session high and low (00:00-04:00 UTC) and fades a one-bar 'liquidity "
            "sweep': price pokes past the box to trigger other traders' orders, then snaps back.\n\n"
            "- Buys (long) when: between 04:00 and 09:00 UTC a bar's wick dips below the box and "
            "the same bar closes back above it. Entry at the next bar's open.\n"
            "- Sells short when: off by default (the mirror image).\n"
            "- Closes the trade when: a bar closes at or above the box top, or at 20:00 UTC.\n"
            "- Stop loss: from the 5th bar after entry, a close at or below the box low. Nothing "
            "protects the trade before that.\n\n"
            "Good to know: a simpler, no-ATR take on ICT Asia Range Breakout, with sessions set in "
            "Philippine time (UTC+8). A close below the box cancels longs for the day. One trade "
            "per UTC day, weekends off."
        ),
    )

    OVERLAYS = [
        OverlaySpec("box_top", "Range top", from_column="box_top_disp",
                    color="#22c55e", line_width=2, line_style="solid"),
        OverlaySpec("box_bot", "Range bottom", from_column="box_bot_disp",
                    color="#ef4444", line_width=2, line_style="solid"),
        OverlaySpec("stop", "Structural stop", from_column="stop_price",
                    color="rgba(239,68,68,0.85)", line_width=1, line_style="dashed"),
        OverlaySpec("box_stop", "Box-height stop", from_column="box_stop_disp",
                    color="rgba(249,115,22,0.9)", line_width=1, line_style="dashed"),
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

        sides = p.get("sides") or {}
        allow_long = bool(sides.get("long", True))
        allow_short = bool(sides.get("short", False))
        use_box_stop = bool(p.get("use_box_stop", False))
        box_stop_mult = float(p.get("box_stop_mult", 1.0))
        # Regime gate on the signal bar — all True when the filter is off.
        regime_ok = _regime_mask(out, p) if p.get("use_regime") else np.ones(n, dtype=bool)

        cond_long = np.zeros(n, dtype=bool)
        cond_short = np.zeros(n, dtype=bool)
        bar_exit_long = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)
        box_stop_disp = np.full(n, np.nan)
        box_top_disp = np.full(n, np.nan)
        box_bot_disp = np.full(n, np.nan)

        skip_wk = bool(p.get("skip_weekends", True))

        # Pass 1 — freeze each UTC day's Asia box onto that day's post-Asia bars.
        # No box on a skipped weekend day means no entry can arm that day.
        for d in np.unique(day_a):
            if skip_wk and is_weekend_utc(d * 86400):
                continue
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
        long_dead = short_dead = False
        done_today = False
        pos = 0                      # 1 long, -1 short, 0 flat
        bars_held = 0
        entry_box_high = entry_box_low = np.nan
        box_stop_level = np.nan
        deadline = 0

        for t in range(n):
            if day_a[t] != cur_day:
                cur_day = day_a[t]
                long_dead = short_dead = False
                done_today = False

            c = close_a[t]

            # ---- manage the open position (exits ignore the session windows) ----
            if pos != 0:
                bars_held += 1
                # The structural stop only exists once the grace period has
                # elapsed; until then the line is drawn faintly by leaving
                # stop_price NaN. The box stop (if on) is live from bar 1.
                armed = bars_held >= stop_bars
                if armed:
                    stop_price[t] = entry_box_low if pos == 1 else entry_box_high
                box_stop_disp[t] = box_stop_level
                if _exit_reason(pos, c, high_a[t], low_a[t], entry_box_high, entry_box_low,
                                armed, box_stop_level, time_a[t], deadline):
                    (bar_exit_long if pos == 1 else bar_exit_short)[t] = True
                    pos = 0
                continue        # one action per bar, exactly like on_candle

            # ---- flat: hunt the day's sweep+reclaim ----
            bh = box_top_disp[t]
            bl = box_bot_disp[t]
            can_long = allow_long and not long_dead
            can_short = allow_short and not short_dead
            if (done_today or not (can_long or can_short) or not np.isfinite(bh)
                    or not np.isfinite(bl) or asia_mask[t] or not entry_mask[t]):
                continue

            # The one-bar rule: wick out AND the SAME bar closes back inside.
            side = _entry_side(low_a[t], high_a[t], c, bh, bl, depth, can_long, can_short)
            if side and regime_ok[t]:
                (cond_long if side == 1 else cond_short)[t] = True
                pos = side
                bars_held = 0
                entry_box_high, entry_box_low = bh, bl
                box_stop_level = _box_stop_level(side, bh, bl, use_box_stop, box_stop_mult)
                deadline = self._deadline(int(time_a[t]), cutoff_h)
                done_today = True
                continue
            # A close back outside means that side's range did not hold — no fade today.
            if c <= bl:
                long_dead = True
            if c >= bh:
                short_dead = True

        out["cond_long"] = cond_long
        out["cond_short"] = cond_short
        out["bar_exit_long"] = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        # Base Strategy contract (also what the chart markers read).
        out["entry_long"] = cond_long
        out["entry_short"] = cond_short
        out["exit_long"] = bar_exit_long
        out["exit_short"] = bar_exit_short
        out["stop_price"] = stop_price
        out["box_stop_disp"] = box_stop_disp
        out["box_top_disp"] = box_top_disp
        out["box_bot_disp"] = box_bot_disp
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Live, stateful mirror of the backtest.

        State: cur_day, box_high/low, long_dead, short_dead, done_today, pos
        (1 long / -1 short / 0 flat), bars_held, entry_box_high/low,
        box_stop_level (None when off), deadline, and `buf` (recent candles —
        only kept while the regime filter is on, the strategy's one lookback).

        Known seam (shared with every live path here): the backtest fills at the
        NEXT bar's open, while live can only transact at the close of the bar that
        confirmed.
        """
        if not bool(candle.get("isClosed", False)):
            return None

        p = self.p
        ts = int(candle["time"])
        c = float(candle["close"])
        hi = float(candle["high"])
        lo = float(candle["low"])
        day = ts // 86400

        if p.get("use_regime"):
            buf = state.setdefault("buf", [])
            buf.append({"time": ts, "open": float(candle["open"]), "high": hi, "low": lo,
                        "close": c, "volume": float(candle.get("volume") or 0.0)})
            keep = self.warmup_bars() * 2
            if len(buf) > keep:
                del buf[: len(buf) - keep]

        # New UTC day → reset the box and the invalidation flags.
        if state.get("cur_day") != day:
            state["cur_day"] = day
            state["box_high"] = None
            state["box_low"] = None
            state["long_dead"] = False
            state["short_dead"] = False
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

        # Extend the Asia box while inside the Asia window (never on a skipped
        # weekend day — no box means no entry, exactly like the backtest).
        weekend_off = bool(p.get("skip_weekends", True)) and bool(is_weekend_utc(ts))
        if in_asia and not weekend_off:
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
            stop_level = state.get("box_stop_level")
            reason = _exit_reason(pos, c, hi, lo,
                                  state.get("entry_box_high", np.nan), state.get("entry_box_low", np.nan),
                                  held >= stop_bars,
                                  np.nan if stop_level is None else float(stop_level),
                                  ts, int(state.get("deadline", 0)))
            if reason:
                state["pos"] = 0
                return Signal(side="long" if pos == 1 else "short", kind="exit",
                              price=c, time=ts, reason=reason)
            return None

        # ---- Flat: hunt the day's sweep+reclaim ----
        sides = p.get("sides") or {}
        can_long = bool(sides.get("long", True)) and not state.get("long_dead")
        can_short = bool(sides.get("short", False)) and not state.get("short_dead")
        if state.get("done_today") or not (can_long or can_short):
            return None
        box_high = state.get("box_high")
        box_low = state.get("box_low")
        if box_high is None or box_low is None or box_high <= box_low:
            return None
        if in_asia or not in_entry:
            return None

        side = _entry_side(lo, hi, c, box_high, box_low, float(p["break_depth"]), can_long, can_short)
        if side and self._regime_ok_live(state, p):
            lvl = _box_stop_level(side, box_high, box_low, bool(p.get("use_box_stop", False)),
                                  float(p.get("box_stop_mult", 1.0)))
            state.update({"pos": side, "bars_held": 0,
                          "entry_box_high": box_high, "entry_box_low": box_low,
                          # None, not NaN: the state is saved as JSON.
                          "box_stop_level": None if np.isnan(lvl) else float(lvl),
                          "deadline": self._deadline(ts, int(p["force_exit_hour_utc"])),
                          "done_today": True})
            return Signal(side="long" if side == 1 else "short", kind="entry",
                          price=c, time=ts, reason="sweep_reclaim")
        if c <= box_low:
            state["long_dead"] = True
        if c >= box_high:
            state["short_dead"] = True
        return None

    # ---- live helpers --------------------------------------------------
    def _regime_ok_live(self, state: dict, p) -> bool:
        """Mirrors the backtest's `regime_ok[t]` on the bar just closed."""
        if not p.get("use_regime"):
            return True
        return _regime_ok_last(pd.DataFrame(state.get("buf") or []), p)

    def warmup_bars(self) -> int:
        # The 5-regime labeler needs its full volatility lookback, or the live
        # label won't match the backtest's.
        p = self.p
        if p.get("use_regime") and p.get("regime_method") == "five":
            rp = _five_params(p)
            return max(500, int(rp["vol_lookback"]) + int(rp["vol_window"]))
        return 500
