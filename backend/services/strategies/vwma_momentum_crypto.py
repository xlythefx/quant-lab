"""
VWMA Momentum (Crypto) — a preset clone of VWMA Momentum with crypto-tuned
defaults. IDENTICAL logic (it subclasses vwma_momentum); only the default
parameters differ, so the original `vwma_momentum` is untouched and both appear
separately in the registry.

Defaults baked in here: VWMA length 10, RSI 22 (long floor 30 / short ceiling 60),
volume MA 107 × 2.55, LONG-only, trades 24/7 (sessions ignored).
"""
from __future__ import annotations

from services.strategies import vwma_momentum as _vm
from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType,
)


class VwmaMomentumCryptoStrategy(_vm.VwmaMomentumStrategy):
    # Same fields as VwmaMomentumStrategy.PARAM_SCHEMA, only the defaults changed.
    PARAM_SCHEMA = [
        ParamSpec("vwma_length",        ParamType.INT,   10,   min=10, max=300, step=1, group="VWMA"),
        ParamSpec("use_rsi_filter",     ParamType.BOOL,  True,                          group="RSI"),
        ParamSpec("rsi_length",         ParamType.INT,   22,   min=5,  max=50,  step=1, group="RSI"),
        ParamSpec("rsi_long_min",       ParamType.INT,   30,   min=10, max=80,  step=1, group="RSI",
                  description="Long requires RSI above this floor."),
        ParamSpec("rsi_short_max",      ParamType.INT,   60,   min=20, max=90,  step=1, group="RSI",
                  description="Short requires RSI below this ceiling."),
        ParamSpec("use_volume_filter",  ParamType.BOOL,  True,                          group="Volume"),
        ParamSpec("vol_length",         ParamType.INT,   107,  min=5,  max=200, step=1, group="Volume"),
        ParamSpec("vol_mult",           ParamType.FLOAT, 2.55, min=0.5, max=5.0, step=0.05, group="Volume",
                  description="Bar volume must exceed avg × this multiplier."),
        ParamSpec("trade_24_7", ParamType.BOOL, True, group="Sessions",
                  description="Trade any time of day; the session windows below are ignored."),
        ParamSpec("sessions", ParamType.SESSIONS,
                  {
                    "tokyo":  {"enabled": True,  "start": "00:00", "end": "04:00"},
                    "london": {"enabled": True,  "start": "05:00", "end": "09:00"},
                    "ny_am":  {"enabled": True,  "start": "12:30", "end": "16:00"},
                    "ny_pm":  {"enabled": False, "start": "17:00", "end": "20:00"},
                  },
                  group="Sessions",
                  description="UTC session windows where new entries are allowed."),
        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": False},
                  group="Direction"),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=20, step=1, group="Risk",
                  description="Max concurrent positions per side. Each tranche is sized at the strategy's Risk%. Set to 1 to disable stacking."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade. Notional = equity × risk_pct ÷ entry_price."),
    ]

    META = StrategyMeta(
        id="vwma_momentum_crypto",
        name="VWMA Momentum (Crypto)",
        description=("VWMA Momentum with crypto-tuned defaults: fast VWMA(10), RSI(22) "
                     "long-only above 30, heavy volume gate (107 × 2.55), trading 24/7. "
                     "Same engine as VWMA Momentum — only the defaults differ."),
        schema=PARAM_SCHEMA,
    )
