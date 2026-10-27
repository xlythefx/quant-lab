"""
regime.py guarantees (verified by hand Oct 20, 2026 — locked in here):
  - ADX matches TA-Lib (an independent implementation) after warm-up;
  - labels are causal: a bar's label never changes once future bars arrive
    (smoothing is the documented exception — display only);
  - the vectorized slope equals the original per-bar loop.
Runs on a slice of the cached LINKUSDT 15m file; skipped if missing.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd
import pytest

from services.strategies.regime import (
    _calc_adx, _regime_features, _regime_labels, _regime_params, RegimeDetector,
)

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "data", "binance", "LINKUSDT_15m.parquet")
pytestmark = pytest.mark.skipif(not os.path.exists(DATA), reason="LINKUSDT 15m not cached")


@pytest.fixture(scope="module")
def df():
    return pd.read_parquet(DATA).iloc[-6000:].reset_index(drop=True)


def test_adx_matches_talib(df):
    talib = pytest.importorskip("talib")
    for p in (14, 20):
        ref = talib.ADX(df.high.to_numpy(float), df.low.to_numpy(float), df.close.to_numpy(float), timeperiod=p)
        assert np.nanmax(np.abs(_calc_adx(df, p).to_numpy() - ref)[500:]) < 1e-6


@pytest.mark.parametrize("name", ["adx", "five"])
def test_labels_are_causal(df, name):
    fn = (lambda d: RegimeDetector(20, 40.0).detect(d).to_numpy()) if name == "adx" \
        else (lambda d: _regime_labels(d, _regime_params({})))
    full = fn(df)
    for k in np.random.default_rng(1).integers(1200, len(df), 40):
        assert fn(df.iloc[:k])[-1] == full[k - 1], f"bar {k - 1} changed once the future was known"


def test_smoothing_is_not_causal(df):
    # Documented: smooth_bars > 1 looks ahead — only for the display ribbon.
    rp = _regime_params({"smooth_bars": 12})
    full = _regime_labels(df, rp)
    changed = sum(_regime_labels(df.iloc[:k], rp)[-1] != full[k - 1]
                  for k in np.random.default_rng(2).integers(1200, len(df), 60))
    assert changed > 0


def test_vectorized_slope_matches_the_loop(df):
    rp = _regime_params({})
    _, slope, _ = _regime_features(df, rp)
    c = df.close.to_numpy(float)
    tw = rp["trend_window"]
    x = np.arange(tw, dtype=float); xd = x - x.mean(); ss = float(np.dot(xd, xd))
    ref = np.zeros(len(c))
    for i in range(tw - 1, len(c)):
        w = c[i - tw + 1:i + 1]
        ref[i] = float(np.dot(xd, w - w.mean())) / ss / w[-1]
    ref[np.abs(ref) < 1e-12] = 0.0       # a flat window has no direction
    assert np.allclose(slope, ref, rtol=1e-9, atol=1e-15)
