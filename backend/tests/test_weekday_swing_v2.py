"""
Weekday Swing V2 — backtest/live parity and the weekend-wrap fix.

  - backtest (vectorized) and live (on_candle replay) signal on the SAME bars
    for every trend filter, both directions, and a trade that crosses the weekend;
  - every trade is held exactly entry → exit time, including Fri → Mon
    (V1 force-closed those one bar after entry);
  - the trend filter only ever removes entries.

Runs on a slice of the locally cached BTCUSDT 1h file; skipped if missing.
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd
import pytest

from services.strategies.weekday_swing_v2 import WeekdaySwingV2Strategy as Strat

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "data", "binance", "BTCUSDT_1h.parquet")
pytestmark = pytest.mark.skipif(not os.path.exists(DATA), reason="BTCUSDT 1h not cached")

BOTH = {"sides": {"long": True, "short": True}}
WEEKEND = {"long_entry_day": "5", "long_entry_hour": 20, "long_exit_day": "1", "long_exit_hour": 1}
CONFIGS = {
    "default (long, ema)": {},
    "vwma": {"trend_filter": "vwma", "ma_length": 50},
    "filter off": {"trend_filter": "off"},
    "both sides": BOTH,
    "short only": {"sides": {"long": False, "short": True}},
    "weekend wrap": WEEKEND,
    "full-week hold": {"trend_filter": "off", "long_exit_day": "1", "long_exit_hour": 1},
}


@pytest.fixture(scope="module")
def df():
    d = pd.read_parquet(DATA)
    return d.iloc[-6_000:].reset_index(drop=True)     # ~8 months of 1h bars


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
        for s in (sig if isinstance(sig, list) else [sig] if sig else []):
            ev.append((i, s.side, s.kind))
    return sorted(ev)


@pytest.mark.parametrize("name", list(CONFIGS))
def test_backtest_and_live_signal_on_the_same_bars(df, name):
    want = _vectorized(df, CONFIGS[name])
    # The backtest never enters on the very last bar (nothing to fill on); live can.
    got = [e for e in _replay(df, CONFIGS[name]) if not (e[0] == len(df) - 1 and e[2] == "entry")]
    assert want, f"{name}: no signals at all — the test would prove nothing"
    assert got == want


def _held_hours(df, params, side="long"):
    s = Strat(params).vectorized(df)
    t = df["time"].to_numpy()
    ins = np.nonzero(s[f"cond_{side}"].to_numpy())[0]
    outs = np.nonzero(s[f"bar_exit_{side}"].to_numpy())[0]
    return [(t[o] - t[i]) / 3600 for i, o in zip(ins, outs)]


def test_weekend_trade_is_held_fri_to_mon(df):
    held = _held_hours(df, {**WEEKEND, "trend_filter": "off"})
    assert len(held) > 20
    assert set(held) == {53.0}        # Fri 20:00 → Mon 01:00


def test_default_hold_is_mon_to_wed(df):
    held = _held_hours(df, {"trend_filter": "off"})
    assert held and set(held) == {62.0}   # Mon 01:00 → Wed 15:00


def test_trend_filter_only_removes_entries(df):
    entries = lambda p: set(np.nonzero(Strat(p).vectorized(df)["cond_long"].to_numpy())[0])
    free = entries({"trend_filter": "off"})
    for flt in ("ema", "vwma"):
        gated = entries({"trend_filter": flt})
        assert gated and gated < free


@pytest.mark.parametrize("ed,xd,eh,xh", [(3, 4, 0, 0), (5, 1, 20, 1), (1, 1, 0, 0)])
def test_market_lab_windows_match_the_strategy(df, ed, xd, eh, xh):
    # The Market Lab "Weekday Windows" cell must be the same trades V2 takes
    # with the filter off — same count and same open-to-open returns.
    from services import market_lab
    t0, t1 = int(df["time"].iloc[0]), int(df["time"].iloc[-1])
    res = market_lab.weekday_windows("BTCUSDT", "1h", t0, t1, {
        "entry_hour": eh, "exit_hour": xh, "holdout_months": 0, "fee_pct": 0, "slippage_bps": 0})
    cell = next(c for c in res["sides"]["long"] if c["entry_day"] == ed and c["exit_day"] == xd)

    s = Strat({"trend_filter": "off", "long_entry_day": str(ed), "long_entry_hour": eh,
               "long_exit_day": str(xd), "long_exit_hour": xh}).vectorized(df)
    ent = np.nonzero(s["cond_long"].to_numpy())[0][: int(s["bar_exit_long"].sum())]
    ext = np.nonzero(s["bar_exit_long"].to_numpy())[0]
    keep = ext + 1 < len(df)
    o = df["open"].to_numpy()
    rets = o[ext[keep] + 1] / o[ent[keep] + 1] - 1
    assert cell["is"]["n"] == len(rets) > 10
    assert cell["is"]["avg_net_pct"] == pytest.approx(rets.mean() * 100, abs=1e-9)
