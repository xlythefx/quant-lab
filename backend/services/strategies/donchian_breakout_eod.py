"""
Donchian Breakout (Naked / EoD-Only) — Variant A: the intraday Donchian breakout
with EVERY protective exit stripped out. Enter on the channel break exactly like
the base port, then hold to the end-of-day flatten — no dollar stop, no target,
no ATR/channel trailing stop, no breakeven lock.

WHY THIS EXISTS
---------------
The base port (`donchian_breakout`) is profitable on TradeStation's @CL data
(+$54k, PF 1.18) but loses on Databento's CL — both the raw front-month splice and
the seam-adjusted `databento_v2` build (~-$100k, PF 0.67). Trade-by-trade
reconciliation against the TS trade list showed the ENTRIES match TS trade-for-
trade (same shorts, same days), so the engine/port is faithful. The divergence is
entirely in the EXITS: the tight 1.2-point ($1200) stop and the ATR trailing fire
on the exact intraday high/low PATH, and that path differs bar-to-bar between
feeds (different continuous-contract construction / roll dates). The same short
flips win<->loss across feeds — that fragility, not a real edge, is what the base
strategy is trading.

An end-of-day exit samples only the session CLOSE. The close carries the same
roll/back-adjust offset as the entry, so the offset cancels in the P&L and the
result becomes largely data-feed-independent. So this variant is the robustness
test:

  - If a real breakout edge exists, it should read ~the SAME on raw and v2 here,
    and ideally be positive.
  - If it is flat/losing but consistent across feeds, the base strategy's profit
    was the stop curve-fitting TradeStation's specific intraday noise.

WHAT CHANGES vs THE BASE
------------------------
Only the exit stack. Entries, the daily MovingUp / CloseStrong filters, the weekly
vf2 filter, the entry time-window and the end-of-day flatten are inherited
unchanged. `EXITS_EOD_ONLY = True` neutralizes the dollar stop, dollar target, ATR
trailing stop and breakeven inside the shared engine, so those Exits-group params
(stop_dollars, target_dollars, trail_length, atr_length, breakeven_*) are INERT
here — left in the schema only so the shared `vectorized()`/`on_candle()` read
them without special-casing.

CAVEAT: removing the stops is NOT a P&L fix. With no stop, an intraday short in a
strong rally (e.g. 2022) can run further against you before the EoD flatten — bigger
swings are expected. The goal is to expose whether a real signal survives once the
noise-fitting stops are gone, not to manufacture profit. As always, run with
`look_ahead` OFF — the look-ahead fill is a fiction on any data.
"""
from __future__ import annotations

from services.strategies.base import StrategyMeta
# Import the module (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover DonchianBreakoutStrategy and log a spurious duplicate-id warning.
from services.strategies import donchian_breakout as _db


class DonchianBreakoutEodStrategy(_db.DonchianBreakoutStrategy):
    # Disable all protective / profit-taking exits; ride every trade to the
    # end-of-day flatten. See the base class flag + module docstring.
    EXITS_EOD_ONLY = True

    META = StrategyMeta(
        id="donchian_breakout_eod",
        name="Donchian No Stoplosses - CL 1H",
        description=("Naked / EoD variant (no stop-losses). Intraday 60m Donchian breakout (long & short) with the same rising-SMA / "
                     "close-strength / weekly (vf2) filters and entry window as the base port, but "
                     "ALL exits removed: no dollar stop, target, ATR trailing or breakeven — the "
                     "position simply holds to the end-of-day flatten. A robustness variant: an "
                     "EoD-only exit is feed-independent, so a genuine edge should read the same on "
                     "raw and seam-adjusted (v2) data. Exits-group params are inert."),
        schema=_db.DonchianBreakoutStrategy.PARAM_SCHEMA,
    )
