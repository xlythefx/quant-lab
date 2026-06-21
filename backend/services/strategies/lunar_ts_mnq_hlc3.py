"""
@MNQ variant of the Lunar Tradestation HLC3 moon-cycle bias strategy.

Same engine as 'lunar_ts_test_hlc3' (HLC3 session-ATR short filter, bar-based
Phase[1/35/65] lags, Date+2 phase, $-breakeven, next-bar-open entries) but with
the MultiCharts/TradeStation defaults for the @MNQ (Micro Nasdaq-100) contract.
Look-ahead bias defaults OFF (honest, tradeable).

TradeStation source (verbatim) -------------------------------------------------
  instrument: @MNQ  platform: multicharts/tradestation   session: 17-16
  timeframe: 60 + 1380m   type: Bias - Multiday - Moon Cycle Engine QTLab
  IS 01.01.2008..31.12.2019   OS 01.01.2020..today
  input: nCon(1);
  var: AtrPeriod(10), stp(300), tgt(425), nBarExit(345);
  Phase = AbsValue(2*(FracPortion(DateToJulian(Date+2)/29.53059 + .4137) -.5));
  ... (entries on Phase[1/35/65] peak/trough at OpenS; short gated by
       avgtruerange(10) of data2 rising; $-breakeven at +/-10 ticks;
       maxbars nBarExit; setstoploss(stp); setprofittarget(tgt))
MNQ economics: $2 / point, tick 0.25 (10 ticks = 2.5 pts breakeven offset).
Stops/targets are exactly 1/10 of @NQ's, matching the 1/10 point value.
-------------------------------------------------------------------------------
"""
from __future__ import annotations

from dataclasses import replace

from services.strategies.base import StrategyMeta
# Import the MODULE (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover the HLC3 base and log a spurious duplicate-id warning.
from services.strategies import lunar_ts_test_hlc3 as _hlc3

# Override the HLC3 twin's ES-fitted defaults back to the raw TradeStation @MNQ
# values, plus the MNQ instrument economics.
_MNQ_OVERRIDES = {
    "atr_period":      {"default": 10},     # TS AtrPeriod(10)
    "atr_rising_mult": {"default": 1.0},    # TS atr > 1*atr[1]
    "n_bars_exit":     {"default": 345},    # TS nBarExit(345)
    "stop_dollars":    {"default": 300.0},  # TS stp(300)
    "target_dollars":  {"default": 425.0},  # TS tgt(425)
    "point_value":     {"default": 2.0},    # MNQ = $2 / point
}
_MNQ_SCHEMA = [
    replace(spec, **_MNQ_OVERRIDES[spec.name]) if spec.name in _MNQ_OVERRIDES else spec
    for spec in _hlc3.LunarTSTestHLC3Strategy.PARAM_SCHEMA
]


class LunarTSMNQHLC3Strategy(_hlc3.LunarTSTestHLC3Strategy):
    PARAM_SCHEMA = _MNQ_SCHEMA

    META = StrategyMeta(
        id="lunar_ts_mnq_hlc3",
        name="Lunar Tradestation Test HLC3 Strategy - MNQ",
        description=("HLC3 moon-cycle bias engine ported for @MNQ (Micro Nasdaq-100, "
                     "MultiCharts/TS datafeed, session 17-16, 60m + 1380m). AtrPeriod=10, "
                     "ATR-rising short filter, $300 stop / $425 target, nBarExit=345, "
                     "$2/point. Look-ahead OFF. IS 2008-2019 / OS 2020-today."),
        schema=_MNQ_SCHEMA,
        kind="hlc",
    )

    # IS+OS window (2008 -> today). No end cap so OS runs to the latest data.
    # NOTE: the MNQ contract only launched May 2019; pre-2019 history depends on
    # the continuous @MNQ series your datafeed provides.
    SYMBOL_BACKTEST_START = {"MNQ": "2008-01-01"}
    SYMBOL_BACKTEST_END = {}
