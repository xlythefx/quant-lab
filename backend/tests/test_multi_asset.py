"""
Multi-Asset speed-ups must not change any number:
  - the month-boundary lookup in _compute_analytics gives the same monthly
    table as the old per-bar strftime;
  - the thinned equity curve keeps first/last, every peak and trough;
  - ann_vol_pct matches the browser's annualizedVol on the full curve.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from services import backtest_engine, multi_asset


def _curve(start: str, end: str, step_s: int, seed: int = 7) -> list[dict]:
    t0 = int(datetime.fromisoformat(start).replace(tzinfo=timezone.utc).timestamp())
    t1 = int(datetime.fromisoformat(end).replace(tzinfo=timezone.utc).timestamp())
    times = np.arange(t0, t1, step_s)
    rng = np.random.default_rng(seed)
    eq = 100_000 * np.cumprod(1 + rng.normal(0, 0.002, len(times)))
    return [{"time": int(t), "equity": float(e)} for t, e in zip(times, eq)]


def _old_month_open_eq(curve, starting_capital):
    out, prev = {}, float(starting_capital)
    for pt in curve:
        ym = datetime.fromtimestamp(pt["time"], tz=timezone.utc).strftime("%Y-%m")
        if ym not in out:
            out[ym] = prev
        prev = float(pt.get("equity", prev))
    return out


def test_monthly_returns_match_old_per_bar_lookup():
    # 15m bars across a year boundary, starting mid-month.
    curve = _curve("2023-11-17T13:45:00", "2024-03-04T00:00:00", 900)
    for p in curve:
        p["value"] = p["equity"] / 1000
        p["drawdown"] = 0.0
    # One trade entering in each month the curve touches.
    trades = []
    for ym, pnl in (("2023-11-20", 10.0), ("2023-12-31", -4.0), ("2024-01-15", 7.5),
                    ("2024-02-29", -12.0), ("2024-03-02", 3.0)):
        ts = int(datetime.fromisoformat(ym + "T23:00:00").replace(tzinfo=timezone.utc).timestamp())
        trades.append({"entry_time": ts, "exit_time": ts + 3600, "pnl_dollars": pnl,
                       "win": pnl > 0, "side": "long", "duration_min": 60,
                       "pnl_pct_equity": pnl / 1000})

    class _Stub:
        p = {"sessions": {}}

    got = backtest_engine._compute_analytics(
        trades, curve, pd.DataFrame({"time": [p["time"] for p in curve]}), _Stub(), 100_000,
    )["monthly_returns"]
    want = _old_month_open_eq(curve, 100_000)
    assert [m["month"] for m in got] == ["2023-11", "2023-12", "2024-01", "2024-02", "2024-03"]
    for m in got:
        assert m["equity_start"] == want[m["month"]]


def test_thin_equity_keeps_extremes_and_ends():
    curve = _curve("2021-01-01T00:00:00", "2026-01-01T00:00:00", 900)
    thin = multi_asset.thin_equity(curve, max_points=4000)
    assert len(thin) <= 4002
    assert thin[0] is curve[0] and thin[-1] is curve[-1]
    times = [p["time"] for p in thin]
    assert times == sorted(times)
    eq = [p["equity"] for p in curve]
    kept = {p["time"] for p in thin}
    assert curve[int(np.argmax(eq))]["time"] in kept
    assert curve[int(np.argmin(eq))]["time"] in kept


def test_thin_equity_leaves_short_curves_alone():
    curve = _curve("2024-01-01T00:00:00", "2024-01-10T00:00:00", 3600)
    assert multi_asset.thin_equity(curve, max_points=4000) is curve


def _js_annualized_vol(curve, sc):
    """Straight port of frontend metrics.js annualizedVol, fed what the
    browser saw (equity rounded to cents)."""
    v = [round(p["equity"], 2) / sc * 100 for p in curve]
    v = [x for x in v if x > 0]
    rets = [v[i] / v[i - 1] - 1 for i in range(1, len(v))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    dts = [curve[i]["time"] - curve[i - 1]["time"] for i in range(1, len(curve))]
    dts = [d for d in dts if d > 0]
    return math.sqrt(var) * math.sqrt(365.25 * 24 * 3600 / (sum(dts) / len(dts))) * 100


def test_ann_vol_matches_browser_formula():
    curve = _curve("2024-01-01T00:00:00", "2024-06-01T00:00:00", 900)
    got = multi_asset.annualized_vol_pct(curve, 100_000)
    assert math.isclose(got, _js_annualized_vol(curve, 100_000), rel_tol=1e-9)


def test_ann_vol_too_short_is_none():
    assert multi_asset.annualized_vol_pct(_curve("2024-01-01", "2024-01-01T00:30:00", 900), 100_000) is None
