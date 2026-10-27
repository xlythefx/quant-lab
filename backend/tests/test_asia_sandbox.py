"""
ICT Asia Range Breakout (Sandbox) — direction, regime filter and box stop.

  - backtest (vectorized) and live (on_candle replay) signal on the SAME bars
    for every combination of the new settings;
  - short is the exact mirror of long (flip the chart upside down);
  - the box stop actually fires, and only when it is switched on.

Runs on a slice of the locally cached LINKUSDT 15m file; skipped if missing.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd
import pytest

from services.strategies.asia_range_breakout_sandbox import AsiaRangeBreakoutSandboxStrategy as Strat

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "data", "binance", "LINKUSDT_15m.parquet")
pytestmark = pytest.mark.skipif(not os.path.exists(DATA), reason="LINKUSDT 15m not cached")

BOTH = {"sides": {"long": True, "short": True}}
CONFIGS = {
    "default (long)": {},
    "short only": {"sides": {"long": False, "short": True}},
    "both": BOTH,
    "box stop": {**BOTH, "use_box_stop": True, "box_stop_mult": 0.3},
    "regime adx": {**BOTH, "use_regime": True, "regime_method": "adx", "regime_adx_threshold": 25.0},
    "regime five": {**BOTH, "use_regime": True, "regime_method": "five"},
    "everything": {**BOTH, "use_box_stop": True, "box_stop_mult": 0.5,
                   "use_regime": True, "regime_method": "five"},
}


@pytest.fixture(scope="module")
def df():
    d = pd.read_parquet(DATA)
    return d.iloc[-12_000:].reset_index(drop=True)    # ~4 months of 15m bars


def _vectorized(df, params):
    s = Strat(params).vectorized(df)
    ev = []
    for col, side, kind in (("cond_long", "long", "entry"), ("cond_short", "short", "entry"),
                            ("bar_exit_long", "long", "exit"), ("bar_exit_short", "short", "exit")):
        ev += [(int(i), side, kind) for i in np.nonzero(s[col].to_numpy())[0]]
    return sorted(ev)


def _replay(df, params):
    strat, state, ev = Strat(params), {}, []
    for i, r in enumerate(df.itertuples(index=False)):
        sig = strat.on_candle({"time": int(r.time), "open": r.open, "high": r.high, "low": r.low,
                               "close": r.close, "volume": r.volume, "isClosed": True}, state)
        if sig:
            ev.append((i, sig.side, sig.kind))
    return sorted(ev)


@pytest.mark.parametrize("name", list(CONFIGS))
def test_backtest_and_live_signal_on_the_same_bars(df, name):
    want = _vectorized(df, CONFIGS[name])
    got = _replay(df, CONFIGS[name])
    assert want, f"{name}: no signals at all — the test would prove nothing"
    assert got == want


def test_short_is_the_mirror_of_long(df):
    # Flip the chart upside down: highs become lows. Every long sweep becomes a
    # short sweep on the same bar.
    m = 2 * float(df["high"].max())
    flipped = df.copy()
    flipped["high"], flipped["low"] = m - df["low"], m - df["high"]
    flipped["open"], flipped["close"] = m - df["open"], m - df["close"]
    longs = [(i, k) for i, s, k in _vectorized(df, {}) if s == "long"]
    shorts = [(i, k) for i, s, k in _vectorized(flipped, {"sides": {"long": False, "short": True}})]
    assert longs and shorts == longs


def test_box_stop_only_fires_when_on(df):
    off = Strat({**BOTH, "box_stop_mult": 0.3}).vectorized(df)
    on = Strat({**BOTH, "use_box_stop": True, "box_stop_mult": 0.3}).vectorized(df)
    assert off["box_stop_disp"].isna().all()
    assert on["box_stop_disp"].notna().any()
    # A tight stop must cut at least one trade short somewhere in 4 months.
    exits = lambda s: np.nonzero((s["bar_exit_long"] | s["bar_exit_short"]).to_numpy())[0].tolist()
    assert exits(on) != exits(off)


def test_regime_filter_only_removes_entries(df):
    entries = lambda p: set(np.nonzero((Strat(p).vectorized(df)[["cond_long", "cond_short"]]
                                        .any(axis=1)).to_numpy())[0])
    free = entries(BOTH)
    gated = entries({**BOTH, "use_regime": True, "regime_method": "adx", "regime_adx_threshold": 25.0})
    assert gated and len(gated) < len(free)
