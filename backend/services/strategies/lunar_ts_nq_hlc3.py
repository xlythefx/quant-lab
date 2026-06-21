"""
@NQ variant of the Lunar Tradestation HLC3 moon-cycle bias strategy.

Same engine as 'lunar_ts_test_hlc3' (HLC3 session-ATR short filter, bar-based
Phase[1/35/65] lags, Date+2 phase, $-breakeven, next-bar-open entries) but with
the MultiCharts/TradeStation defaults for the @NQ contract instead of the
ES-fitted ones. Look-ahead bias defaults OFF (honest, tradeable).

TradeStation source (verbatim) -------------------------------------------------
  instrument: @NQ   platform: multicharts/tradestation   session: 17-16
  timeframe: 60 + 1380m   type: Bias - Multiday - Moon Cycle Engine QTLab
  IS 01.01.2008..31.12.2019   OS 01.01.2020..today
  input: nCon(1);
  var: AtrPeriod(10), stp(3000), tgt(4250), nBarExit(345);
  Phase = AbsValue(2*(FracPortion(DateToJulian(Date+2)/29.53059 + .4137) -.5));
  ... (entries on Phase[1/35/65] peak/trough at OpenS; short gated by
       avgtruerange(10) of data2 rising; $-breakeven at +/-10 ticks;
       maxbars nBarExit; setstoploss(stp); setprofittarget(tgt))
NQ economics: $20 / point, tick 0.25 (10 ticks = 2.5 pts breakeven offset).
-------------------------------------------------------------------------------
"""
from __future__ import annotations

from dataclasses import replace

from services.strategies.base import StrategyMeta
# Import the MODULE (not the class) so the registry's dir() scan of THIS module
# doesn't re-discover the HLC3 base and log a spurious duplicate-id warning.
from services.strategies import lunar_ts_test_hlc3 as _hlc3

# Override the HLC3 twin's ES-fitted defaults back to the raw TradeStation @NQ
# values, plus the NQ instrument economics. min/max on the base specs already
# admit these, so no bound widening is needed.
_NQ_OVERRIDES = {
    "atr_period":      {"default": 10},      # TS AtrPeriod(10)
    "atr_rising_mult": {"default": 1.0},     # TS atr > 1*atr[1]
    "n_bars_exit":     {"default": 345},     # TS nBarExit(345)
    "stop_dollars":    {"default": 3000.0},  # TS stp(3000)
    "target_dollars":  {"default": 4250.0},  # TS tgt(4250)
    "point_value":     {"default": 20.0},    # NQ = $20 / point
}
_NQ_SCHEMA = [
    replace(spec, **_NQ_OVERRIDES[spec.name]) if spec.name in _NQ_OVERRIDES else spec
    for spec in _hlc3.LunarTSTestHLC3Strategy.PARAM_SCHEMA
]


class LunarTSNQHLC3Strategy(_hlc3.LunarTSTestHLC3Strategy):
    PARAM_SCHEMA = _NQ_SCHEMA

    META = StrategyMeta(
        id="lunar_ts_nq_hlc3",
        name="Lunar Tradestation Test HLC3 Strategy - NQ",
        description=("HLC3 moon-cycle bias engine ported for @NQ (MultiCharts/TS datafeed, "
                     "session 17-16, 60m + 1380m). AtrPeriod=10, ATR-rising short filter, "
                     "$3000 stop / $4250 target, nBarExit=345, $20/point. Look-ahead OFF. "
                     "IS 2008-2019 / OS 2020-today."),
        schema=_NQ_SCHEMA,
        kind="hlc",
    )

    # IS+OS window (2008 -> today). No end cap so OS runs to the latest data.
    SYMBOL_BACKTEST_START = {"NQ": "2008-01-01"}
    SYMBOL_BACKTEST_END = {}
