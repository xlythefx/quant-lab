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
        name="Lunar HLC3 (Moon Cycle Bias) - ES",
        description=("HLC3 test twin of 'lunar': the session-ATR short filter uses typical "
                     "price (H+L+C)/3 instead of close. All other logic identical."),
        schema=_lunar.LunarStrategy.PARAM_SCHEMA,
        kind="hlc",
        archived=True,
        guide=(
            "Bets that ES (S&P 500 futures) follows the moon. A 'phase' number comes from the "
            "New York calendar date alone: near 1 at full moon, near 0 at new moon (29.53-day "
            "cycle). Trades open only on a session's first hourly bar.\n\n"
            "- Buys (long) when: the daily phase peaked 3 sessions ago (full moon just passed).\n"
            "- Sells short when: the phase bottomed 3 sessions ago (new moon just passed) and "
            "the ATR (average daily price range) grew in the last finished session.\n"
            "- Closes the trade when: the opposite turn appears at a session start, the $3,250 "
            "target is hit, or after 345 bars.\n"
            "- Stop loss: $1,750; once $1,750 up, it moves to just past entry.\n\n"
            "Good to know: archived. Like 'Lunar', but the ATR uses HLC3 (average of high, low, "
            "close) instead of the close."
        ),
    )
