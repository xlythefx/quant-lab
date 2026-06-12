"""
HLC3 test twin of the 'lunar_ts_test' TradeStation-port strategy.

Identical to LunarTSTestStrategy except the session-ATR rising filter (the only
price indicator — it gates SHORT entries) uses the typical price (H+L+C)/3 as its
per-session reference instead of the raw close. All other logic (bar-based phase
lags, Date+2 phase, $-breakeven, next-bar-open entries) is inherited unchanged.
"""
from __future__ import annotations

from services.strategies.base import StrategyMeta
# Import the module (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover LunarTSTestStrategy and log a spurious duplicate-id warning.
from services.strategies import lunar_ts_test as _lunar_ts


class LunarTSTestHLC3Strategy(_lunar_ts.LunarTSTestStrategy):
    USE_HLC3 = True

    META = StrategyMeta(
        id="lunar_ts_test_hlc3",
        name="Lunar Tradestation Test HLC3 Strategy",
        description=("HLC3 test twin of 'lunar_ts_test': the session-ATR short filter uses "
                     "typical price (H+L+C)/3 instead of close. All other logic identical."),
        schema=_lunar_ts.LunarTSTestStrategy.PARAM_SCHEMA,
        kind="hlc",
    )
