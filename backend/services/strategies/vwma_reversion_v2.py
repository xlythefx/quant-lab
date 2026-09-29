"""
VWMA Reversion V2 — the VWMA z-score / RSI mean-reversion core from
`vwma_reversion.py`, turned into a LADDER.

Instead of one position, V2 opens up to `pyramiding` tranches ("rungs"), and
every extra rung has to be EARNED by a deeper stretch:

    rung k enters only at |z| >= z_threshold + k * z_step

so you add to the position only when price has moved further against it, never
just because another bar printed. Every rung is the same size (risk_pct of
current equity) — see LIVE PARITY below for why that matters.

The whole ladder is one thesis ("it will revert"), so it gets ONE shared stop:
        long:  avg_entry - atr_mult * avg_entry_atr
        short: avg_entry + atr_mult * avg_entry_atr
averaged over the open rungs, which means the stop tightens toward price as the
ladder grows. Breach it and every rung closes together, same as the mean-revert
exit. There is no staggered per-rung bleed-out.

Deliberately NO regime gating: the escalating z-threshold is itself the filter
("only add when the stretch is real"), and regime gating is a per-strategy
feature that has to earn its place through the gauntlet rather than be bolted on
by default. Use the base `vwma_reversion` strategy if you want regime gating.

WHY THIS NEEDS NO ENGINE CHANGES
--------------------------------
The escalating threshold needs the strategy to know how many rungs are already
open, which a position-independent signal column cannot express. It works
because exits are processed BEFORE entries within a bar (verified in
portfolio_runner / backtest_engine), so this strategy's own model of the ladder
stays in lockstep with the engine's real tranche count.

So V2 drives the engine through the cond_*/bar_exit_* path (like the base
strategy, so pyramiding works) but deliberately does NOT emit the `atr` column —
emitting it would switch on the engine's PER-TRANCHE stop machinery, which is
exactly the staggered bleed-out this design replaces.

A rung's modeled entry price is the NEXT bar's open — where the engine actually
fills a signal from this bar — not the signal bar's close. That is causal: the
ladder stop which uses it is only ever evaluated at later bars, by which time
that open has printed. The live path books the fill the same way, one bar late,
so both sides compute the same average entry. The only residual gap is slippage
(1bp by default, against a stop measured in whole ATRs).

KNOWN APPROXIMATION: if the engine skips a rung for insufficient cash it holds
fewer rungs than this model assumes. That errs conservative (V2 then demands a
deeper z than strictly needed) and every skip is recorded in `skipped_signals`.

NO SAME-BAR RE-ENTRY. After the ladder flattens, V2 waits for a fresh bar before
opening rung 1 again. The base strategy does re-enter on the very bar it exits
(its cond_ column is position-independent, so a stop-out frees the slot and the
stale signal refills it at that same bar's open — 27 times in a 20k-bar BTCUSDT
sample). Those fills cannot be reproduced live, where on_candle emits one signal
per bar, so V2 drops them on purpose. Consequence for A/B work: V2 at
pyramiding=1 with atr_stop OFF is trade-for-trade identical to the base strategy
(verified: 210/210, same entry and exit times); with the stop ON it trades
slightly less, and the difference is exactly those same-bar re-entries.

LIVE PARITY
-----------
Every rung is the same size, which is exactly what live does: `build_payload`
carries no quantity, so the acceptor sizes every order at
base_size * (balance / 500). The z-escalation, the rung count and the flatten-all
exit all transfer as-is, so live and the backtest take the same bars in and out.
The usual caveat still applies — the backtest sizes rungs as a % of equity
(compounding) while live is fixed-lot, so compare on direction and % per trade,
never on dollars or drawdown.

Indicator math is shared with vwma_reversion.py.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.vwma_reversion import _vwma, _rsi, _atr
from services.strategies.session_utils import parse_hhmm, in_window_live, session_mask


class VwmaReversionV2Strategy(Strategy):
    PARAM_SCHEMA = [
        # --- Core VWMA reversion (identical to the base strategy) -----------
        ParamSpec("vwma_length",   ParamType.INT,   30,  min=5,   max=200, step=1,   group="VWMA"),
        ParamSpec("z_threshold",   ParamType.FLOAT, 1.5, min=0.5, max=4.0, step=0.1, group="VWMA",
                  description="Stretch required for the FIRST rung. Each later rung needs this plus "
                              "Z step per rung already open."),
        ParamSpec("rsi_length",    ParamType.INT,   25,  min=5,  max=50, step=1, group="RSI"),
        ParamSpec("rsi_long_max",  ParamType.INT,   35,  min=25, max=40, step=1, group="RSI"),
        ParamSpec("rsi_short_min", ParamType.INT,   65,  min=60, max=75, step=1, group="RSI"),

        # --- The ladder ------------------------------------------------------
        ParamSpec("z_step", ParamType.FLOAT, 0.1, min=0.0, max=2.0, step=0.05, group="Ladder",
                  description="Extra z-score each new rung must reach. Rung 1 needs Z threshold, rung 2 "
                              "needs Z threshold + 1 step, rung 3 + 2 steps, and so on — so you only add "
                              "when price stretches FURTHER against you. Set 0 to make every rung use the "
                              "same threshold (the A/B control)."),
        ParamSpec("pyramiding", ParamType.INT, 4, min=1, max=20, step=1, group="Ladder",
                  description="Maximum rungs in the ladder (per side). Every rung is the same size, so a "
                              "full ladder carries pyramiding x Risk% in total. 1 disables laddering — the "
                              "right setting for an A/B against the base strategy, which it matches trade "
                              "for trade when ATR stop is also off."),

        # --- Shared ATR stop -------------------------------------------------
        ParamSpec("atr_stop", ParamType.BOOL, True, group="Stop",
                  description="ONE stop for the whole ladder, at average entry -/+ ATR mult x average "
                              "entry ATR. Breach it and every rung closes together. On by default; turn "
                              "it off only to measure what the stop is actually worth."),
        ParamSpec("atr_length", ParamType.INT,   10,  min=5, max=50, step=1,   group="Stop"),
        ParamSpec("atr_mult",   ParamType.FLOAT, 6.0, min=1, max=20, step=0.5, group="Stop",
                  description="Stop distance in ATRs from the ladder's AVERAGE entry (not from the first "
                              "rung), so the stop tightens toward price as you add."),

        # --- Sessions / direction --------------------------------------------
        ParamSpec("trade_24_7", ParamType.BOOL, True, group="Sessions",
                  description="Trade any time of day; the session windows below are ignored. On by "
                              "default — turn it off to restrict new rungs to the checked windows."),
        ParamSpec("sessions", ParamType.SESSIONS,
                  {
                    "tokyo":  {"enabled": True,  "start": "00:00", "end": "04:00"},
                    "london": {"enabled": True,  "start": "05:00", "end": "12:30"},
                    "ny_am":  {"enabled": True,  "start": "12:30", "end": "16:00"},
                    "ny_pm":  {"enabled": False, "start": "17:00", "end": "20:00"},
                  },
                  group="Sessions",
                  description="UTC windows where new rungs may open (only used when Trade 24/7 is off). "
                              "Exits fire in any session."),
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": False}, group="Direction",
                  description="Long only by default — a ladder into a falling market is the side that "
                              "behaves; enable shorts explicitly if you want to test them."),

        # --- Risk -------------------------------------------------------------
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Size of EVERY rung, as % of current equity. A full 4-rung ladder at 3% "
                              "therefore carries about 12% of equity."),
    ]

    META = StrategyMeta(
        id="vwma_reversion_v2",
        name="VWMA Reversion V2",
        description=("Laddered VWMA z-score / RSI mean reversion: each extra rung must be earned by a "
                     "deeper z-score, under one shared ATR stop on the ladder's average entry. Long-only "
                     "and 24/7 by default. Set pyramiding=1 for the plain single-position version."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("vwma",  "VWMA",  from_column="vwma",       color="#fbbf24", line_width=2),
        OverlaySpec("upper", "+z·σ",  from_column="upper_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
        OverlaySpec("lower", "-z·σ",  from_column="lower_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
        # Where the NEXT rung would trigger, given the ladder as it stands. Steps
        # deeper with every add; NaN when flat or when the ladder is full, so the
        # line only exists while another rung is actually possible.
        OverlaySpec("next_add", "next rung", from_column="next_add",
                    color="rgba(168,85,247,0.85)", line_width=1, line_style="dashed"),
        # The one shared ladder stop; NaN when flat or when atr_stop is off.
        OverlaySpec("atr_stop", "ladder stop", from_column="stop_price",
                    color="rgba(239,68,68,0.85)", line_width=1, line_style="dashed"),
    ]

    # ------------------------------------------------------------------ gates
    def _gates(self, df: pd.DataFrame, rsi: pd.Series):
        """Position-INDEPENDENT half of the entry test: session, side and RSI.
        The z-score test is deliberately excluded — it is the only part that
        changes per rung, so the ladder walk applies it itself."""
        p = self.p
        idx = df.index

        if bool(p.get("trade_24_7")):
            in_sess = pd.Series(True, index=idx)
        else:
            tsm = pd.to_datetime(df["time"], unit="s", utc=True)
            tsm.index = idx
            in_sess = session_mask(tsm, p["sessions"])

        sides = p["sides"]
        gate_long = (in_sess & (rsi < p["rsi_long_max"])) if sides.get("long") else pd.Series(False, index=idx)
        gate_short = (in_sess & (rsi > p["rsi_short_min"])) if sides.get("short") else pd.Series(False, index=idx)
        return (gate_long.fillna(False).to_numpy(dtype=bool),
                gate_short.fillna(False).to_numpy(dtype=bool))

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        vol = out["volume"].astype(float) if "volume" in out.columns else pd.Series(1.0, index=out.index)

        mean = _vwma(close, vol, p["vwma_length"])
        # ddof=0 (population) — matches TradingView's ta.stdev() and is the right
        # formula when the rolling window IS the distribution, not a sample of one.
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        gl, gs = self._gates(out, rsi)

        n = len(out)
        mean_a = mean.to_numpy(dtype=float)
        std_a = std.to_numpy(dtype=float)
        close_a = close.to_numpy(dtype=float)
        z_a = zscore.to_numpy(dtype=float)
        atr_a = atr.to_numpy(dtype=float)

        # Modeled rung entry price = the NEXT bar's open, which is where the
        # engine fills a signal raised on this bar. Causal: the ladder stop that
        # consumes it is only evaluated at bars > t, by which time it has printed.
        fill_a = np.empty(n, dtype=float)
        if n:
            fill_a[:-1] = out["open"].to_numpy(dtype=float)[1:]
            fill_a[-1] = close_a[-1]      # last bar can never fill; value unused

        cond_long = np.zeros(n, dtype=bool)
        cond_short = np.zeros(n, dtype=bool)
        bar_exit_long = np.zeros(n, dtype=bool)
        bar_exit_short = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)
        next_add = np.full(n, np.nan)

        zt = float(p["z_threshold"])
        zs = float(p["z_step"])
        mult = float(p["atr_mult"])
        atr_on = bool(p.get("atr_stop", True))
        max_rungs = max(1, int(p.get("pyramiding", 1)))

        # Ladder state, kept in lockstep with the engine's tranche list.
        pos = 0              # 0 flat, 1 long, -1 short
        rungs = 0            # open rungs
        sum_entry = 0.0      # running sum of modeled rung entry prices
        sum_atr = 0.0        # running sum of entry ATRs (finite ones only)
        n_atr = 0

        def _flatten():
            nonlocal pos, rungs, sum_entry, sum_atr, n_atr
            pos = 0; rungs = 0; sum_entry = 0.0; sum_atr = 0.0; n_atr = 0

        for t in range(n):
            m = mean_a[t]
            if not np.isfinite(m):
                continue
            c = close_a[t]
            z = z_a[t]                       # NaN compares False everywhere below

            # Display: where the next rung would trigger, given the ladder as it
            # stands coming INTO this bar. Steps deeper with each add.
            if pos != 0 and rungs < max_rungs and np.isfinite(std_a[t]):
                lvl = zt + rungs * zs
                next_add[t] = m - lvl * std_a[t] if pos == 1 else m + lvl * std_a[t]

            # ---- EXIT the whole ladder (mean revert or the shared stop) ----
            if pos != 0:
                avg_entry = sum_entry / rungs
                stop_lvl = np.nan
                if atr_on and n_atr:
                    avg_atr = sum_atr / n_atr
                    stop_lvl = (avg_entry - mult * avg_atr) if pos == 1 else (avg_entry + mult * avg_atr)
                    stop_price[t] = stop_lvl

                if pos == 1:
                    if c >= m or (np.isfinite(stop_lvl) and c <= stop_lvl):
                        bar_exit_long[t] = True
                        _flatten()
                        continue     # no same-bar re-entry; the engine flattens first
                else:
                    if c <= m or (np.isfinite(stop_lvl) and c >= stop_lvl):
                        bar_exit_short[t] = True
                        _flatten()
                        continue

            # ---- OPEN rung 1, or ADD the next rung ----
            if rungs >= max_rungs:
                continue
            need = zt + rungs * zs           # deeper for every rung already open
            if pos in (0, 1) and gl[t] and z <= -need:
                cond_long[t] = True
                sum_entry += fill_a[t]
                if np.isfinite(atr_a[t]):
                    sum_atr += atr_a[t]; n_atr += 1
                rungs += 1; pos = 1
            elif pos in (0, -1) and gs[t] and z >= need:
                cond_short[t] = True
                sum_entry += fill_a[t]
                if np.isfinite(atr_a[t]):
                    sum_atr += atr_a[t]; n_atr += 1
                rungs += 1; pos = -1

        # Engine hooks. cond_*/bar_exit_* drive the pyramiding path. `atr` is
        # deliberately NOT emitted — it would switch on the engine's per-tranche
        # stops, which this design replaces with the shared one. No `risk_scale`
        # either: every rung is the same size, so the engine's plain risk_pct
        # sizing is already correct.
        out["cond_long"] = cond_long
        out["cond_short"] = cond_short
        out["bar_exit_long"] = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        # Base Strategy contract (also what chart markers read).
        out["entry_long"] = cond_long
        out["entry_short"] = cond_short
        out["exit_long"] = bar_exit_long
        out["exit_short"] = bar_exit_short
        out["stop_price"] = stop_price
        # Overlay columns.
        out["vwma"] = mean
        out["upper_band"] = mean + std * zt
        out["lower_band"] = mean - std * zt
        out["next_add"] = next_add
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Live ladder — mirrors vectorized() bar for bar.

        Each closed bar: first test the whole-ladder exit (mean revert or the
        shared ATR stop on the average entry), which fires ONE exit signal that
        flattens everything at the acceptor. Otherwise, if the stretch has
        reached z_threshold + rungs * z_step and the session gate allows it, open
        one more rung — one rung per bar, exactly as the engine does.

        State: buf, pos (0/1/-1), rungs, sum_entry, n_filled, sum_atr, n_atr, and
        pending_rung (a rung signalled last bar, booked at this bar's open).
        """
        if not bool(candle.get("isClosed", False)):
            return None  # only act on closed bars

        p = self.p
        warmup = max(int(p["vwma_length"]), int(p["rsi_length"]), int(p["atr_length"])) * 4

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
        if len(buf) < warmup:
            return None  # not enough data yet

        df = pd.DataFrame(buf)
        close = df["close"]
        mean = _vwma(close, df["volume"], p["vwma_length"])
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(df["high"], df["low"], close, p["atr_length"])

        m = float(mean.iloc[-1]) if np.isfinite(mean.iloc[-1]) else np.nan
        if not np.isfinite(m):
            return None
        c = float(close.iloc[-1])
        z = float(zscore.iloc[-1])
        r = float(rsi.iloc[-1])
        a = float(atr.iloc[-1]) if np.isfinite(atr.iloc[-1]) else np.nan
        ts = int(df["time"].iloc[-1])

        pos = int(state.get("pos", 0))
        rungs = int(state.get("rungs", 0))
        sum_entry = float(state.get("sum_entry", 0.0))
        n_filled = int(state.get("n_filled", 0))
        sum_atr = float(state.get("sum_atr", 0.0))
        n_atr = int(state.get("n_atr", 0))
        atr_on = bool(p.get("atr_stop", True))
        mult = float(p["atr_mult"])

        # A rung signalled on the PREVIOUS bar fills at THIS bar's open — the same
        # anchor vectorized() models — so book it before anything else looks at the
        # ladder's average entry.
        pending = state.pop("pending_rung", None)
        if pending:
            sum_entry += float(df["open"].iloc[-1]); n_filled += 1
            pa = float(pending.get("atr", np.nan))
            if np.isfinite(pa):
                sum_atr += pa; n_atr += 1
            state.update({"sum_entry": sum_entry, "n_filled": n_filled,
                          "sum_atr": sum_atr, "n_atr": n_atr})

        def _flatten():
            state.update({"pos": 0, "rungs": 0, "sum_entry": 0.0, "n_filled": 0,
                          "sum_atr": 0.0, "n_atr": 0, "pending_rung": None})

        # ---- EXIT the whole ladder (always — ignores the session gate) ----
        # n_filled guards the average: a rung that signalled but hasn't been booked
        # yet (or state lost across a restart) must not skew the stop.
        if pos != 0 and n_filled > 0:
            avg_entry = sum_entry / n_filled
            stop_lvl = np.nan
            if atr_on and n_atr:
                avg_atr = sum_atr / n_atr
                stop_lvl = (avg_entry - mult * avg_atr) if pos == 1 else (avg_entry + mult * avg_atr)
            if pos == 1:
                stop_hit = np.isfinite(stop_lvl) and c <= stop_lvl
                if c >= m or stop_hit:
                    _flatten()
                    return Signal(side="long", kind="exit", price=c, time=ts,
                                  reason="ladder_stop" if stop_hit else "z_revert")
            else:
                stop_hit = np.isfinite(stop_lvl) and c >= stop_lvl
                if c <= m or stop_hit:
                    _flatten()
                    return Signal(side="short", kind="exit", price=c, time=ts,
                                  reason="ladder_stop" if stop_hit else "z_revert")

        # ---- OPEN rung 1, or ADD the next rung (session gated) ----
        max_rungs = max(1, int(p.get("pyramiding", 1)))
        if rungs >= max_rungs:
            return None

        if bool(p.get("trade_24_7")):
            in_sess = True
        else:
            utc = datetime.fromtimestamp(ts, tz=timezone.utc).time()
            in_sess = False
            for cfg in (p["sessions"] or {}).values():
                if not cfg or not cfg.get("enabled"):
                    continue
                win = (parse_hhmm(cfg.get("start", "00:00")), parse_hhmm(cfg.get("end", "00:00")))
                if in_window_live(utc, win):
                    in_sess = True
                    break
        if not in_sess:
            return None

        sides = p["sides"]
        need = float(p["z_threshold"]) + rungs * float(p["z_step"])
        long_ok = bool(sides.get("long")) and pos in (0, 1) and z <= -need and r < p["rsi_long_max"]
        short_ok = bool(sides.get("short")) and pos in (0, -1) and z >= need and r > p["rsi_short_min"]
        if not (long_ok or short_ok):
            return None

        # The rung's price is booked on the NEXT bar, at its open (see above); the
        # ATR is the signal bar's, which is what the engine uses too.
        state.update({
            "pos": 1 if long_ok else -1,
            "rungs": rungs + 1,
            "pending_rung": {"atr": float(a) if np.isfinite(a) else float("nan")},
        })
        side = "long" if long_ok else "short"
        return Signal(side=side, kind="entry", price=c, time=ts,
                      reason=f"z_{side}" if rungs == 0 else f"z_{side}_rung{rungs + 1}")
