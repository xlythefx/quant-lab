"""
HLC3 test twin of the 'lunar_ts_test' TradeStation-port strategy.

Identical to LunarTSTestStrategy except the session-ATR rising filter (the only
price indicator — it gates SHORT entries) uses the typical price (H+L+C)/3 as its
per-session reference instead of the raw close. All other logic (bar-based phase
lags, Date+2 phase, $-breakeven, next-bar-open entries) is inherited unchanged.
"""
from __future__ import annotations

from dataclasses import replace

from services.strategies.base import StrategyMeta, ParamSpec, ParamType
# Import the module (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover LunarTSTestStrategy and log a spurious duplicate-id warning.
from services.strategies import lunar_ts_test as _lunar_ts

# HLC3-twin default overrides. The base lunar_ts_test keeps the TS-exact values
# (atr_period=11, atr_rising_mult=1.0) as the reference port; the HLC3 twin
# defaults to atr_period=1 (no session-ATR smoothing — alpha=1, so ATR = the
# latest session's True Range) and a near-1 rising threshold (0.953). Each entry
# overrides the matching ParamSpec field(s); min/step are widened where the base
# bounds would clip the new default. Clone the base schema so the base is left
# untouched.
_FIELD_OVERRIDES = {
    "atr_period":      {"default": 1, "min": 1},
    "atr_rising_mult": {"default": 0.953, "step": 0.001},
}
_HLC3_SCHEMA = [
    replace(spec, **_FIELD_OVERRIDES[spec.name]) if spec.name in _FIELD_OVERRIDES else spec
    for spec in _lunar_ts.LunarTSTestStrategy.PARAM_SCHEMA
]
# Look-ahead is exposed ONLY on this HLC3 test twin (not the base port). When on,
# the engine fills entries on the signal bar's OWN open — i.e. acts on a bar using
# the close that hasn't happened yet. This is genuine look-ahead bias: the P&L it
# produces is FICTITIOUS and NOT achievable live. Kept as a labeled diagnostic /
# perfect-foresight ceiling; defaults OFF and the result is flagged look_ahead=True.
_HLC3_SCHEMA = _HLC3_SCHEMA + [
    ParamSpec("look_ahead", ParamType.BOOL, False, group="Execution",
              description="⚠ LOOK-AHEAD (fictitious, NOT tradeable): fills entries on the "
                          "signal bar's own open, using the close that produced the signal. "
                          "Inflates P&L — diagnostic / perfect-foresight ceiling ONLY, never live."),
]


class LunarTSTestHLC3Strategy(_lunar_ts.LunarTSTestStrategy):
    USE_HLC3 = True
    PARAM_SCHEMA = _HLC3_SCHEMA

    META = StrategyMeta(
        id="lunar_ts_test_hlc3",
        name="Lunar HCL3 - ES (MAIN)",
        description=("HLC3 test twin of 'lunar_ts_test': the session-ATR short filter uses "
                     "typical price (H+L+C)/3 instead of close. Defaults atr_period=1, "
                     "atr_rising_mult=0.953; all other logic identical."),
        schema=_HLC3_SCHEMA,
        kind="hlc",
        guide=(
            "Main ES (S&P 500 futures) moon strategy. A 'phase' number comes from the New "
            "York date plus two days: near 1 at full moon, near 0 at new moon (29.53-day "
            "cycle). Trades open only on a session's first hourly bar.\n\n"
            "- Buys (long) when: the phase 35 bars ago tops both 1 and 65 bars ago (full moon "
            "just passed).\n"
            "- Sells short when: the reverse (new moon just passed) and the last full "
            "session's range beat 95.3% of the one before.\n"
            "- Closes the trade when: the opposite turn appears at a session start, the $3,250 "
            "target is hit, or after 345 bars.\n"
            "- Stop loss: $1,750; once $1,750 up, it moves to 2.5 points past entry.\n\n"
            "Good to know: the TradeStation port with an HLC3 (average of high, low, close) "
            "short filter. Keep Look-ahead off: it fakes results."
        ),
    )
