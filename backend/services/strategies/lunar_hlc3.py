"""
HLC3 test twin of the production 'lunar' strategy.

Identical to LunarStrategy except the session-ATR rising filter (the only price
indicator in the strategy — it gates SHORT entries) uses the typical price
(H+L+C)/3 as its per-session reference instead of the raw close. Everything else
(moon-phase entries at the next-bar open, dollar stops/targets, breakeven, etc.)
is inherited unchanged. Use it side-by-side with 'lunar' to compare close vs HLC3.
"""
from __future__ import annotations

from services.strategies.base import StrategyMeta
# Import the module (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover LunarStrategy and log a spurious duplicate-id warning.
from services.strategies import lunar as _lunar


class LunarHLC3Strategy(_lunar.LunarStrategy):
    USE_HLC3 = True

    META = StrategyMeta(
        id="lunar_hlc3",
        name="Lunar HLC3 (Moon Cycle Bias)",
        description=("HLC3 test twin of 'lunar': the session-ATR short filter uses typical "
                     "price (H+L+C)/3 instead of close. All other logic identical."),
        schema=_lunar.LunarStrategy.PARAM_SCHEMA,
        kind="hlc",
    )
