"""
ANN Strategy v2+ (Insights) — the ANN Strategy v2 idea, cleaned up.

Plain-English rule set (anchor = 1D → "yesterday", UTC):

  x    = (this bar's ohlc4 − previous period's ohlc4) / previous period's ohlc4
  band = band_k × previous period's range, (high − low) / ohlc4

  LONG   when x >  band   (price is clearly above yesterday's average)
  SHORT  when x < −band   (clearly below)
  in between → keep the current side (no flip)

What changed vs the Original (ann_strategy_v2.py):
  - signal = "trend" by default: plain sign(x). The Pine network IS sign(x) for any
    |x| < ~18% and only turns around on extreme days (a +30% day → short), which is a
    training leftover, not a design choice. "ann" keeps the network for A/B tests.
  - Dead band: the Original flips on every tiny cross of yesterday's average (~3 flips a
    day on 15m), so trading costs eat the whole edge. The band only lets it flip on a
    clear move. It is scaled to yesterday's range rather than a fixed %, so the same
    band_k means the same thing on a calm coin and a wild one. band_k = 0 = no band.
  - Sides: a side that is switched off is held flat (e.g. long-only: long above the band,
    flat below it).

Fill model = QuantLab honest mode: signal on the bar's close, fill at the next bar's open.
band_k's default (0.25) is a middle value from a rough full-history look, NOT a tuned
setting — choose it with walk-forward.
"""
from __future__ import annotations

from typing import Union

import numpy as np
import pandas as pd

from .base import Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec
from .ann_strategy_v2 import (_ANCHORS, ann, prev_period_stats, live_prev_period,
                              flip_columns, live_flip)


_SIGNALS = [
    {"value": "trend", "label": "Price vs anchor (plain rule)"},
    {"value": "ann",   "label": "ANN network (original)"},
]


def _bias(x, rng, band_k: float, signal: str):
    """+1 / -1 past the band, NaN inside it (= keep the last side). Works on arrays and floats."""
    x = np.asarray(x, dtype=float)
    s = np.sign(ann(x)) if signal == "ann" else np.sign(x)
    outside = np.abs(x) > band_k * np.asarray(rng, dtype=float)
    return np.where(outside & (s > 0), 1.0, np.where(outside & (s < 0), -1.0, np.nan))


class AnnStrategyV2Plus(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("signal", ParamType.SELECT, "trend", group="Signal", options=_SIGNALS,
                  description="Plain rule = sign of the move vs the anchor. ANN = the original "
                              "network (same except on ±18% days, where it turns around)."),
        ParamSpec("anchor", ParamType.SELECT, "1D", group="Signal", options=_ANCHORS,
                  description="Price is compared with the PREVIOUS period's average (ohlc4). "
                              "1 day = yesterday, UTC."),
        ParamSpec("band_k", ParamType.FLOAT, 0.25, min=0.0, max=2.0, step=0.05, group="Signal",
                  description="Dead band as a multiple of the previous period's high−low range. "
                              "0.25 = must be a quarter of yesterday's range past its average to "
                              "flip. 0 = no band (flips like the original)."),
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction",
                  description="A side that is off is held flat instead."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of equity."),
    ]

    META = StrategyMeta(
        id="ann_v2_plus",
        name="ANN Strategy v2+ (Insights)",
        description=("ANN Strategy v2 reduced to what it really does — long above yesterday's "
                     "average price, short below — plus a dead band scaled to yesterday's range "
                     "so it only flips on clear moves, and long/short switches."),
        schema=PARAM_SCHEMA,
        guide=(
            "Our rebuilt version of ANN Strategy v2: follow the move away from yesterday's average "
            "price, but only flip after a clear move.\n\n"
            "- Buys (long) when: price is clearly above yesterday's average, past the dead band (a "
            "buffer zone around the average, sized from yesterday's high-to-low range).\n"
            "- Sells short when: price is clearly below it.\n"
            "- Closes the trade when: price clearly crosses to the other side. Inside the band it keeps "
            "its current position.\n"
            "- Stop loss: none.\n\n"
            "Good to know: Signal 'Plain rule' only follows the move; 'ANN network' also bets against "
            "moves over ~18%, like the Original. Dead band 0 flips on every cross, like the Original."
        ),
    )

    OVERLAYS = [
        OverlaySpec("anchor",  "Prev period ohlc4", from_column="anchor",  color="#60a5fa",
                    line_width=2, line_style="dashed"),
        OverlaySpec("band_up", "Long above",        from_column="band_up", color="#22c55e"),
        OverlaySpec("band_dn", "Short below",       from_column="band_dn", color="#ef4444"),
    ]

    def warmup_bars(self) -> int:
        return 1000 if self.p["anchor"] == "1W" else 500

    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        prev_o4, prev_rng = prev_period_stats(out, p["anchor"])
        o4 = ((out["open"] + out["high"] + out["low"] + out["close"]) / 4.0).to_numpy(dtype=float)
        k = float(p["band_k"])
        out["anchor"]  = prev_o4
        out["band_up"] = prev_o4 * (1.0 + k * prev_rng)
        out["band_dn"] = prev_o4 * (1.0 - k * prev_rng)
        bias = _bias((o4 - prev_o4) / prev_o4, prev_rng, k, str(p["signal"]))
        return flip_columns(out, bias, p["sides"])

    def on_candle(self, candle: dict, state: dict) -> Union[Signal, list[Signal], None]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        prev_o4, prev_rng = live_prev_period(candle, state, p["anchor"])
        bias = None
        if prev_o4 is not None:
            o4 = (float(candle["open"]) + float(candle["high"]) + float(candle["low"]) + float(candle["close"])) / 4.0
            b = float(_bias(np.array([(o4 - prev_o4) / prev_o4]), np.array([prev_rng]),
                            float(p["band_k"]), str(p["signal"]))[0])
            bias = None if np.isnan(b) else int(b)
        return live_flip(state, bias, p["sides"], int(candle["time"]), float(candle["close"]), "ann_flip")
