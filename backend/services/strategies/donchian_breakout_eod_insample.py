"""
Donchian Breakout (IN-SAMPLE ONLY · overfit demo) — a frozen snapshot of the
in-sample-best parameters of the naked/EoD variant, pinned to the 2016-2022
in-sample window so you can SEE the overfit peak on the chart.

⚠ THIS IS NOT A TRADEABLE STRATEGY. It exists to make the overfitting lesson
visible: it is the single highest in-sample configuration found in the
`donchian_length` sweep —

    donchian_length = 30, both sides, naked (EoD) exits
    -> in-sample (2016-08-29 .. 2022-12-31): +$65,740, PF 1.21

— and those exact params LOSE out-of-sample (2023-2026: ~-$1,510). Picking the
in-sample maximum is the definition of curve-fitting; this variant is the
cautionary exhibit, not a candidate. The robust pick is short-only at len ~30
(see `donchian_breakout_eod`), which trades some in-sample profit for a positive,
cross-feed-consistent out-of-sample result.

Mechanics: subclasses the naked EoD variant (inherits EXITS_EOD_ONLY=True), only
changing the `donchian_length` default 36 -> 30 and capping the dashboard date
window to the in-sample period via SYMBOL_BACKTEST_START/END (the UI picker still
overrides; full data is used for indicator warm-up). Run with look_ahead OFF.
"""
from __future__ import annotations

import dataclasses

from services.strategies.base import StrategyMeta
# Import modules (not class names) so the registry's dir() scan of THIS module
# doesn't re-discover the parent classes and log spurious duplicate-id warnings.
from services.strategies import donchian_breakout as _db
from services.strategies import donchian_breakout_eod as _eod

# In-sample-best schema: same as the base, but donchian_length defaults to 30.
_INSAMPLE_SCHEMA = [
    dataclasses.replace(s, default=30) if s.name == "donchian_length" else s
    for s in _db.DonchianBreakoutStrategy.PARAM_SCHEMA
]


class DonchianBreakoutEodInsampleStrategy(_eod.DonchianBreakoutEodStrategy):
    # Inherits EXITS_EOD_ONLY = True (naked exits). Override the runtime defaults
    # (cls.PARAM_SCHEMA drives _merge_with_defaults) AND the UI form (META.schema).
    PARAM_SCHEMA = _INSAMPLE_SCHEMA

    META = StrategyMeta(
        id="donchian_breakout_eod_insample",
        name="Donchian No Stops - Best Params - CL 1H",
        description=("IN-SAMPLE ONLY ⚠ NOT TRADEABLE — overfit exhibit. The single best in-sample config of the "
                     "naked Donchian breakout (donchian_length 30, both sides, EoD exits): "
                     "+$65,740 / PF 1.21 in-sample (2016-2022), but it LOSES out-of-sample. Pinned "
                     "to the 2016-2022 window so the overfit peak is visible on the chart. Compare "
                     "against the robust short-only variant for the honest picture."),
        schema=_INSAMPLE_SCHEMA,
    )

    # Cap the dashboard date window to the in-sample period (UI picker overrides;
    # full data still used for warm-up). v2 data begins 2016-08-29.
    SYMBOL_BACKTEST_START = {"CL": "2016-08-29"}
    SYMBOL_BACKTEST_END = {"CL": "2022-12-31"}
