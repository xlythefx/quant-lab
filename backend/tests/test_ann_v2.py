"""
ANN Strategy v2 (Original) and v2+ (Insights).

  - backtest (vectorized) and live (on_candle replay) signal on the SAME bars, for both
    strategies, every anchor, with and without the band, long-only;
  - the network equals sign(x) for |x| < 18% and turns around past ~18.13%;
  - band_k = 0 with the ANN signal reproduces the Original exactly;
  - a band only ever cuts flips.

Runs on a slice of the locally cached BTCUSDT 15m file; skipped if missing.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd
import pytest

from services.strategies.ann_strategy_v2 import AnnStrategyV2, ann
from services.strategies.ann_strategy_v2_plus import AnnStrategyV2Plus

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "data", "binance", "BTCUSDT_15m.parquet")
pytestmark = pytest.mark.skipif(not os.path.exists(DATA), reason="BTCUSDT 15m not cached")

CONFIGS = {
    "original 1D":        (AnnStrategyV2, {}),
    "original 4h":        (AnnStrategyV2, {"anchor": "240"}),
    "original 1W":        (AnnStrategyV2, {"anchor": "1W"}),
    "original long only": (AnnStrategyV2, {"sides": {"long": True, "short": False}}),
    "original short only":(AnnStrategyV2, {"sides": {"long": False, "short": True}}),
    "plus default":       (AnnStrategyV2Plus, {}),
    "plus ann signal":    (AnnStrategyV2Plus, {"signal": "ann"}),
    "plus no band":       (AnnStrategyV2Plus, {"band_k": 0.0}),
    "plus long only":     (AnnStrategyV2Plus, {"sides": {"long": True, "short": False}}),
    "plus short only 4h": (AnnStrategyV2Plus, {"anchor": "240", "sides": {"long": False, "short": True}}),
}


@pytest.fixture(scope="module")
def df():
    d = pd.read_parquet(DATA)
    return d.iloc[-30_000:].reset_index(drop=True)     # ~10 months of 15m bars, starts mid-day


def _vectorized(df, cls, params):
    s = cls(params).vectorized(df)
    ev = []
    for col, side, kind in (("cond_long", "long", "entry"), ("cond_short", "short", "entry"),
                            ("bar_exit_long", "long", "exit"), ("bar_exit_short", "short", "exit")):
        ev += [(int(i), side, kind) for i in np.nonzero(s[col].to_numpy())[0]]
    return sorted(ev)


def _replay(df, cls, params):
    strat, state, ev = cls(params), {}, []
    for i, r in enumerate(df.itertuples(index=False)):
        sig = strat.on_candle({"time": int(r.time), "open": r.open, "high": r.high, "low": r.low,
                               "close": r.close, "volume": r.volume, "isClosed": True}, state)
        for s in (sig if isinstance(sig, list) else [sig] if sig else []):
            ev.append((i, s.side, s.kind))
    return sorted(ev)


@pytest.mark.parametrize("name", list(CONFIGS))
def test_backtest_and_live_signal_on_the_same_bars(df, name):
    cls, params = CONFIGS[name]
    want = _vectorized(df, cls, params)
    assert want, f"{name}: no signals at all — the test would prove nothing"
    assert _replay(df, cls, params) == want


def test_network_is_sign_of_x_below_18pct():
    x = np.linspace(-0.18, 0.18, 360_001)
    assert np.array_equal(np.sign(ann(x)), np.sign(x))
    assert ann(0.30) < 0 < ann(-0.30)          # turns around on extreme days
    assert ann(0.0) == 0.0


def test_plus_with_ann_signal_and_no_band_is_the_original(df):
    assert _vectorized(df, AnnStrategyV2Plus, {"signal": "ann", "band_k": 0.0}) == \
           _vectorized(df, AnnStrategyV2, {})


def test_band_cuts_flips(df):
    n = [len(_vectorized(df, AnnStrategyV2Plus, {"band_k": k})) for k in (0.0, 0.25, 0.5)]
    assert n[0] > n[1] > n[2] > 0


def test_no_signal_before_first_full_day(df):
    s = AnnStrategyV2(None).vectorized(df)
    first = np.nonzero(s["cond_long"].to_numpy() | s["cond_short"].to_numpy())[0][0]
    day = df["time"].to_numpy() // 86_400
    assert day[first] >= day[0] + 2            # day 0 is partial, day 1 is the first anchor
