"""
VWMA Reversion (Streak Sizing) — the plain VWMA Reversion signals with a
win/loss-streak position-size ladder on top. BACKTEST-ONLY sizing experiment.

THE LADDER (base = risk_pct of CURRENT equity, so size still compounds)
-----------------------------------------------------------------------
  step 0: 1.00 x risk_pct    full size — every run starts here
  step 1: 0.50 x risk_pct    half
  step 2: 0.25 x risk_pct    quarter
  step 3: KILLED             only when use_kill_switch is on

  `streak_len` (default 2) LOSSES IN A ROW -> one step down.
  `streak_len` WINS IN A ROW               -> one step up (full size is the ceiling).

  A win clears the loss run and a loss clears the win run, and both runs restart
  at 0 whenever the step changes — it is always "N in a row at the current step".
  Kill switch OFF: quarter size is the floor, the strategy keeps trading. ON:
  another `streak_len` losses at quarter size stops it for the rest of the backtest
  (no new entries, equity goes flat) and a red "KILLED" line is drawn from the bar
  the last losing trade closed on, to the end of the chart. There is no coming back.

WIN / LOSS is scored on price only — fees and slippage are ignored by design. It
uses the fills the engine uses: enter at the open of the bar after the entry
signal, exit at the open of the bar after the exit signal. A trade that exits at
exactly its entry price counts as a loss (it didn't make money).

HOW IT DRIVES THE ENGINE
------------------------
Entries/exits come from the parent's own single-position loop. This class drops
the parent's pyramiding hooks (cond_*/bar_exit_*/atr) so the engine follows
entry_*/exit_* exactly — the same trades the streak replay scores — then feeds the
ladder to the engine through the opt-in `risk_scale` column (engine multiplies
risk_pct by it at entry; same hook VWMA Reversion PRO uses). Kill = entries masked
off from the kill bar onward. No shared-engine changes.

Pyramiding is fixed at 1 (a streak of stacked tranches is not well defined).

COMPARE FAIRLY: run THIS strategy with use_streak_sizing OFF as the baseline, not
the original VWMA Reversion. Off = identical trades at full size, so the only
difference between the two runs is the ladder. (The original uses the engine's
pyramiding path, which can flip long->short on one bar and re-enter right after an
ATR stop, so its trade list can differ slightly.) Judge on return / max drawdown,
not raw return — a ladder that only shrinks size will always earn less.

KNOWN LIMITS
  - Live (on_candle) is inherited unchanged: plain signals, no ladder, no kill.
    Live size is owned by the webhook acceptor anyway.
  - Walk-forward warm-up bars: the engine masks entries before trade_start_time,
    but this replay still scores those warm-up trades, so a window can start
    below full size. Single Dashboard backtests are exact.
  - look_ahead runs fill entries at the bar's extreme, not the next open, so the
    streak there is approximate (look_ahead is a diagnostic only).
  - In a multi-strategy portfolio, an entry skipped for insufficient cash would
    desync the replay. At 1% size on its own that doesn't happen.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from services.strategies.base import StrategyMeta, ParamSpec, ParamType, OverlaySpec
# Import the module (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover VwmaReversionStrategy and log a spurious duplicate-id warning.
from services.strategies import vwma_reversion as _vr


# Size multiplier per ladder step (x risk_pct). Index past the end = killed.
_LADDER = (1.0, 0.5, 0.25)


class VwmaReversionStreakStrategy(_vr.VwmaReversionStrategy):
    PARAM_SCHEMA = [s for s in _vr.VwmaReversionStrategy.PARAM_SCHEMA
                    if s.name not in ("pyramiding", "risk_pct")] + [
        ParamSpec("use_streak_sizing", ParamType.BOOL, True, group="Streak Sizing",
                  description="Step size down after losing streaks and back up after winning streaks "
                              "(full -> half -> quarter of Risk%). OFF = same trades at full size every "
                              "time — use that as the baseline when judging the ladder."),
        ParamSpec("streak_len", ParamType.INT, 2, min=1, max=10, step=1, group="Streak Sizing",
                  description="How many wins (or losses) IN A ROW move the size one step up (or down)."),
        ParamSpec("use_kill_switch", ParamType.BOOL, False, group="Streak Sizing",
                  description="After the size is already at quarter, another losing streak stops the "
                              "strategy for good (no new trades; marked by a red KILLED line on the chart). "
                              "OFF = quarter size is the floor and it keeps trading."),
        ParamSpec("risk_pct", ParamType.FLOAT, 1.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="FULL (base) size as % of current equity per trade. The ladder trades "
                              "1x / 0.5x / 0.25x of this. Notional = equity × risk_pct × step ÷ entry_price."),
    ]

    META = StrategyMeta(
        id="vwma_reversion_streak",
        name="VWMA Reversion (Streak Sizing)",
        description=("VWMA Reversion signals with a win/loss-streak size ladder: 2 losses in a row "
                     "halves the size (1% -> 0.5% -> 0.25%), 2 wins in a row steps it back up. "
                     "Optional kill switch stops the strategy after a losing streak at the smallest "
                     "size. Backtest-only sizing; single position."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = _vr.VwmaReversionStrategy.OVERLAYS + [
        # Flat line at the last losing trade's exit price, from the kill bar to the
        # end of the chart. NaN (nothing drawn) unless the kill switch fired.
        OverlaySpec("streak_killed", "KILLED (streak)", from_column="streak_killed",
                    color="rgba(239,68,68,0.95)", line_width=2, line_style="solid"),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = super().vectorized(df)
        # One-shot engine path: without these the engine would run its own
        # pyramiding/flip/ATR-stop logic and its trades could differ from the
        # entry_*/exit_* the replay below scores.
        out = out.drop(columns=["cond_long", "cond_short", "bar_exit_long",
                                "bar_exit_short", "atr"], errors="ignore")

        n = len(out)
        risk_scale = np.ones(n, dtype=float)
        killed_line = np.full(n, np.nan)
        if not bool(p.get("use_streak_sizing", True)) or n == 0:
            out["risk_scale"] = risk_scale
            out["streak_killed"] = killed_line
            return out

        entry_long = out["entry_long"].to_numpy(dtype=bool).copy()
        entry_short = out["entry_short"].to_numpy(dtype=bool).copy()
        exit_long = out["exit_long"].to_numpy(dtype=bool)
        exit_short = out["exit_short"].to_numpy(dtype=bool)
        open_a = out["open"].to_numpy(dtype=float)
        run_len = max(1, int(p.get("streak_len", 2)))
        kill_on = bool(p.get("use_kill_switch", False))

        step = 0           # index into _LADDER
        wins = losses = 0  # current run lengths (only one is ever > 0)
        pos = 0            # 0 flat, 1 long, -1 short
        entry_fill = np.nan
        kill_bar = None

        # Replay the parent's single-position trades in order. The parent never
        # exits and enters on the same bar, so the next entry is always at or
        # after the previous exit's fill bar — the step it uses is already known.
        for t in range(n):
            if pos != 0:
                if not ((pos == 1 and exit_long[t]) or (pos == -1 and exit_short[t])):
                    continue
                if t + 1 >= n:
                    break  # exit never fills inside the data; nothing follows it
                won = (open_a[t + 1] - entry_fill) * pos > 0
                pos = 0
                if won:
                    losses = 0
                    wins += 1
                    if wins >= run_len:
                        wins = 0
                        step = max(0, step - 1)
                else:
                    wins = 0
                    losses += 1
                    if losses >= run_len:
                        losses = 0
                        if step < len(_LADDER) - 1:
                            step += 1
                        elif kill_on:
                            kill_bar = t + 1   # the bar this losing trade closed on
                            break
                continue
            if entry_long[t] or entry_short[t]:
                risk_scale[t] = _LADDER[step]
                if t + 1 >= n:
                    break  # signal on the last bar never fills
                pos = 1 if entry_long[t] else -1
                entry_fill = open_a[t + 1]

        if kill_bar is not None:
            entry_long[kill_bar:] = False
            entry_short[kill_bar:] = False
            out["entry_long"] = entry_long
            out["entry_short"] = entry_short
            # Hide the ATR-stop line of the ghost trades the parent kept simulating.
            stop = out["stop_price"].to_numpy(dtype=float).copy()
            stop[kill_bar:] = np.nan
            out["stop_price"] = stop
            killed_line[kill_bar:] = open_a[kill_bar]

        out["risk_scale"] = risk_scale
        out["streak_killed"] = killed_line
        return out
