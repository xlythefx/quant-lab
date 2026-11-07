"""
Pair Check (services/pair_check.py) on synthetic data, fully offline:

  - a pair built with a real leash passes the rolling test most of the time, and
    two unrelated random walks pass only about as often as luck allows;
  - the ADF test and its MacKinnon cutoffs behave (noise passes, a random walk doesn't);
  - nothing looks ahead: cutting off the future changes no earlier z, test or trade;
  - the per-bar P&L adds up to the per-trade P&L.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from services import pair_check as pc

HOUR = 3600
N = 24 * 240                      # 240 days of 1h bars


def _frame(log_y, log_x, t0=1_600_000_000):
    t = t0 + np.arange(len(log_y)) * HOUR
    cy, cx = np.exp(log_y), np.exp(log_x)
    return pd.DataFrame({"time": t, "open_y": np.r_[cy[0], cy[:-1]], "close_y": cy,
                         "open_x": np.r_[cx[0], cx[:-1]], "close_x": cx})


def _walk(rng, n, vol=0.01, start=10.0):
    return start + np.cumsum(rng.normal(0, vol, n))


def _leashed(seed=1, n=N):
    rng = np.random.default_rng(seed)
    lx = _walk(rng, n)
    gap = np.zeros(n)
    for i in range(1, n):          # AR(1) gap, half-life ~7 bars
        gap[i] = 0.9 * gap[i - 1] + rng.normal(0, 0.004)
    return _frame(0.5 + 1.2 * lx + gap, lx)


def test_crit_values_match_mackinnon():
    assert pc.crit_value(1, 0.05, 10**9) == pytest.approx(-2.86154, abs=1e-4)
    assert pc.crit_value(2, 0.05, 10**9) == pytest.approx(-3.33613, abs=1e-4)
    # Fitting the hedge ratio makes the cutoff stricter.
    assert pc.crit_value(2, 0.05, 700) < pc.crit_value(1, 0.05, 700)


def test_adf_separates_noise_from_random_walk():
    rng = np.random.default_rng(3)
    noise = rng.normal(0, 1, 800)
    walk = np.cumsum(rng.normal(0, 1, 800))
    t_noise, n = pc.adf_tstat(noise, 4)
    t_walk, _ = pc.adf_tstat(walk, 4)
    assert t_noise < pc.crit_value(1, 0.01, n)
    assert t_walk > pc.crit_value(1, 0.10, n)


def test_real_leash_passes_and_beats_fake_pair():
    out = pc.analyze(_leashed(), "1h", {"window_days": 30})
    s = out["summary"]
    assert s["pass_pct"]["5"] > 80
    assert s["fake_pass_pct"]["5"] < 30
    assert s["verdict"]["label"] == "A real leash"
    assert s["beta_median"] == pytest.approx(1.2, abs=0.1)
    assert s["halflife_median_hours"] < 24


def test_unrelated_walks_pass_about_as_often_as_luck():
    rng = np.random.default_rng(11)
    rates = []
    for k in range(4):
        df = _frame(_walk(rng, N), _walk(rng, N))
        rates.append(pc.analyze(df, "1h", {"window_days": 30})["summary"]["pass_pct"]["5"])
    # The test's size is 5%; overlapping windows make single runs noisy, so check the average.
    assert np.mean(rates) < 20


@pytest.mark.parametrize("hedge", ["rolling", "equal"])
def test_nothing_looks_ahead(hedge):
    df = _leashed(seed=5)
    p = pc._params({"window_days": 20, "hedge": hedge, "use_gate": False})
    cut = N - 24 * 30
    ly, lx = np.log(df["close_y"].to_numpy()), np.log(df["close_x"].to_numpy())
    W, step = 20 * 24, 24
    full = pc._fit(ly, lx, W, step, hedge)
    part = pc._fit(ly[:cut], lx[:cut], W, step, hedge)
    np.testing.assert_allclose(full["z"][:cut], part["z"], equal_nan=True)
    k = part["test_idx"].size
    np.testing.assert_array_equal(full["grade"][:k], part["grade"])

    t_arr = df["time"].to_numpy()
    oy, ox = df["open_y"].to_numpy(), df["open_x"].to_numpy()
    a = pc._run_trades(t_arr, oy, ox, full, p, HOUR, False)["rows"]
    b = pc._run_trades(t_arr[:cut], oy[:cut], ox[:cut], part, p, HOUR, False)["rows"]
    done = [r for r in a if r["x"] < cut - 1]
    assert done and done == b[:len(done)]


def test_bar_pnl_adds_up_to_trade_pnl():
    df = _leashed(seed=8)
    p = pc._params({"window_days": 20, "fee_pct": 0.05, "slippage_bps": 2, "use_gate": False})
    ly, lx = np.log(df["close_y"].to_numpy()), np.log(df["close_x"].to_numpy())
    fit = pc._fit(ly, lx, 20 * 24, 24, "rolling")
    run = pc._run_trades(df["time"].to_numpy(), df["open_y"].to_numpy(), df["open_x"].to_numpy(),
                         fit, p, HOUR, False)
    rows = run["rows"]
    assert len(rows) > 20
    assert (run["leg_y"] + run["leg_x"]).sum() == pytest.approx(sum(r["gross"] for r in rows))
    assert run["net_curve"][-1] == pytest.approx(sum(r["net"] for r in rows) * 100)
    # A leashed pair is the case the trade is built for: it should make money before costs.
    assert sum(r["gross"] for r in rows) > 0
