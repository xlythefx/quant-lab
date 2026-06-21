"""
Donchian Breakout (Trend-Filtered) — the intraday Donchian breakout, but shorts
are only allowed while the daily trend is DOWN.

A variant of `donchian_breakout` (DonchianBreakoutStrategy). Everything is
identical except the short side now respects the same trend gauge the long side
already uses: MovingUp = the 100-day daily SMA rising. The base port shorts every
downside breakout regardless of trend, which is what blew the account up across the
2021-2022 oil rally (it kept shorting into a doubling market). This variant blocks
shorts whenever the 100-day SMA is rising — i.e. it refuses to fight the trend.

This is a strategy-LOGIC change (a directional filter the strategy already
computes), not an execution/order-type change. It reuses the base strategy's
realistic stop-entry fills, exits, and live logic unchanged via SHORT_TREND_FILTER.

NOTE: a research variant, not a vindication. It addresses the directional mistake
(short-into-bull); it does not, on its own, manufacture an edge — judge it on the
walk-forward / out-of-sample numbers like anything else.
"""
from __future__ import annotations

from services.strategies.base import StrategyMeta
# Import the module (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover DonchianBreakoutStrategy and log a spurious duplicate-id warning.
from services.strategies import donchian_breakout as _db


class DonchianBreakoutTrendStrategy(_db.DonchianBreakoutStrategy):
    # Only short when the 100-day daily SMA is falling (no shorting in an uptrend).
    SHORT_TREND_FILTER = True

    META = StrategyMeta(
        id="donchian_breakout_trend",
        name="Donchian Breakout (Trend-Filtered) - CL 1H",
        description=("Intraday 60m Donchian breakout, long & short, with the short side gated by "
                     "the daily trend: shorts only fire when the 100-day SMA is falling (no shorting "
                     "into an uptrend). Same realistic stop entries and exits as the base Donchian "
                     "port; adds one directional filter to avoid fighting the trend."),
        schema=_db.DonchianBreakoutStrategy.PARAM_SCHEMA,
        archived=True,
    )
