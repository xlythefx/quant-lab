"""
Verification suite for the 2026-06-11 analytics quant-correctness fix pass.

Run:  python scripts\verify_audit_2026_06_11.py   (from repo root)

Checks (see docs/audit-analytics-quant-2026-06-11.md):
  1. portfolio_correlation periods-per-year inference (crypto 365 vs weekday ~261)
  2. C2/C3 small-sample guards (downside corr / co-crash)
  3. Engine stats: sharpe None convention, breakeven key, win/loss/BE partition
  4. _score_from_stats None coercion contract
  5. Walk-forward stitch invariants: multiplicative (crypto) / additive (futures)
  6. monte_carlo None-safe sharpe passthrough
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

import numpy as np

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append((name, detail))
    print(("  OK   " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail else ""))


# ---------------------------------------------------------------- 1. ppy
print("\n[1] portfolio_correlation periods-per-year inference")
from services import portfolio_correlation as pc

daily_grid = np.arange(20000, 20000 + 365, dtype=np.int64)          # contiguous days
ppy_crypto = pc._periods_per_year(daily_grid)
check("contiguous 365-day grid -> ~365.25/yr", abs(ppy_crypto - 365.25) < 2.0, f"ppy={ppy_crypto:.2f}")

weekdays = np.array([d for d in range(20000, 20000 + 365) if (d + 4) % 7 < 5], dtype=np.int64)
ppy_fut = pc._periods_per_year(weekdays)
check("weekday-only grid -> ~261/yr", 250.0 < ppy_fut < 266.0, f"ppy={ppy_fut:.2f}")

rng = np.random.default_rng(1)
x = rng.normal(50, 400, daily_grid.size)
old = float(x.mean() / x.std(ddof=1) * np.sqrt(252.0))
new = pc._sharpe(x, ppy_crypto)
ratio = new / old
check("crypto Sharpe rescales by sqrt(365.25/252) ~= 1.204",
      abs(ratio - math.sqrt(365.25 / 252.0)) < 0.01, f"ratio={ratio:.4f}")

# ---------------------------------------------------------------- 2. C2/C3
print("\n[2] C2/C3 small-sample guards")
SPD = pc.SECONDS_PER_DAY
start_cap = 100_000.0


def to_curve(daily, day0=20000):
    eq = start_cap + np.cumsum(daily)
    return [{"time": int((day0 + i) * SPD + 43200), "equity": float(e)}
            for i, e in enumerate(np.concatenate([[start_cap], eq]))]


small = {
    "a": {"equity": to_curve(rng.normal(0, 100, 10))},
    "b": {"equity": to_curve(rng.normal(0, 100, 10))},
}
res_small = pc.compute(small, start_cap)
check("10-day portfolio: downside_corr is None", res_small["downside_corr"] is None)
check("10-day portfolio: co_crash_days is None",
      res_small["drawdown_overlap"]["co_crash_days"] is None)

# 120 days; strategy "sparse" trades only 6 days (rest flat) -> its 5th pct is 0;
# flat days must NOT count as crashes.
n_days = 120
dense = rng.normal(20, 300, n_days)
sparse = np.zeros(n_days)
sparse[[5, 20, 40, 60, 80, 100]] = [-500, 400, -300, 200, -100, 600]
res_big = pc.compute({"dense": {"equity": to_curve(dense)},
                      "sparse": {"equity": to_curve(sparse)}}, start_cap)
cc = res_big["drawdown_overlap"]["co_crash_days"]
# co-crash requires BOTH below own 5th pct AND strictly negative; sparse has only
# 3 negative days, so co-crash can never exceed 3.
check("flat days excluded from co-crash", cc is not None and cc <= 3, f"co_crash={cc}")

# ---------------------------------------------------------------- 3. engine stats
print("\n[3] backtest engine stats on cached BTCUSDT 1h")
from services import backtest_engine

result = backtest_engine.run("vwma_reversion", "BTCUSDT", "1h", {})
s = result["stats"]
check("sharpe is finite float or None",
      s["sharpe"] is None or math.isfinite(s["sharpe"]), f"sharpe={s['sharpe']}")
check("breakeven key present", "breakeven" in s, f"breakeven={s.get('breakeven')}")
check("wins+losses+breakeven == trades",
      s["wins"] + s["losses"] + s["breakeven"] == s["trades"],
      f"{s['wins']}+{s['losses']}+{s['breakeven']} vs {s['trades']}")
tr_sum = sum(t["pnl_dollars"] for t in result["trades"])
check("sum(trade pnl) == total_return_dollars (E1 regression)",
      abs(tr_sum - s["total_return_dollars"]) < 0.01,
      f"{tr_sum:.2f} vs {s['total_return_dollars']:.2f}")
try:
    json.dumps({"stats": s, "analytics": result["analytics"]})
    check("stats+analytics JSON-serializable", True)
except (TypeError, ValueError) as e:
    check("stats+analytics JSON-serializable", False, str(e))

# Degenerate: 2-bar equity -> sharpe must be None (was 0.0 before this fix).
deg = backtest_engine._compute_stats(
    [], 100_000.0, np.array([0.0, 0.0]), np.array([0, 3600]), 100_000.0,
    equity_arr=np.array([100_000.0, 100_000.0]))
check("degenerate run: sharpe is None (not 0.0)", deg["sharpe"] is None)

# ---------------------------------------------------------------- 4. score contract
print("\n[4] walkforward scoring contract")
from services import walkforward as wf

check("_score_from_stats({'sharpe': None}) == 0.0",
      wf._score_from_stats({"sharpe": None}, "sharpe") == 0.0)

# ---------------------------------------------------------------- 5. WF stitch
print("\n[5] walk-forward stitch invariants (small real runs)")
from services import market_data


def mini_wf(symbol, timeframe, n_bars=2200):
    df = market_data.load_parquet(symbol, timeframe)
    t = df["time"].to_numpy()
    spec = {
        "strategy_id": "vwma_reversion", "symbol": symbol, "timeframe": timeframe,
        "start_time": int(t[max(0, len(t) - n_bars)]), "end_time": int(t[-1]),
        "base_params": {}, "search_space": [
            {"name": "vwma_length", "type": "int", "low": 10, "high": 14},
        ],
        "is_bars": 600, "oos_bars": 300, "n_trials": 1, "warmup_bars": 100,
        "metric": "sharpe", "seed": 7,
    }
    job = wf.WalkForwardJob(spec)
    job._run()  # synchronous
    if job.error:
        raise RuntimeError(job.error)
    return wf.get_last_result(), job


# Crypto: multiplicative — final == starting * prod(window growth factors)
res_c, job_c = mini_wf("BTCUSDT", "1h")
sc = res_c["stats"]
start = sc["starting_capital"]
prod = 1.0
for w in job_c.window_summaries:
    ws = w["oos_stats"]
    prod *= ws["final_equity"] / ws["starting_capital"]
check("crypto stitch: final == start * prod(window growth)",
      abs(sc["final_equity"] - start * prod) < 0.01,
      f"{sc['final_equity']:.2f} vs {start * prod:.2f} ({len(job_c.window_summaries)} windows)")

# Futures: additive — final == starting + sum(window dollar P&L); trades unscaled
res_f, job_f = mini_wf("ES", "1h")
sf = res_f["stats"]
startf = sf["starting_capital"]
add = sum(w["oos_stats"]["total_return_dollars"] for w in job_f.window_summaries)
check("futures stitch: final == start + sum(window $P&L)",
      abs(sf["final_equity"] - (startf + add)) < 0.01,
      f"{sf['final_equity']:.2f} vs {startf + add:.2f} ({len(job_f.window_summaries)} windows)")
stitched_sum = sum(t["pnl_dollars"] for t in res_f["trades"])
check("futures stitch: sum(stitched trade pnl) == total $P&L (no scaling)",
      abs(stitched_sum - sf["total_return_dollars"]) < 0.01,
      f"{stitched_sum:.2f} vs {sf['total_return_dollars']:.2f}, n={len(res_f['trades'])}")

# ---------------------------------------------------------------- 6. monte carlo
print("\n[6] monte_carlo None-safe sharpe")
from services import monte_carlo

mc = monte_carlo.run("trade_bootstrap",
                     [{"strategy_id": "vwma_reversion", "symbol": "BTCUSDT",
                       "timeframe": "1h", "params": {}}],
                     n_sims=10, seed=1)
osh = mc["original"]["sharpe"]
check("monte_carlo original.sharpe is float or None",
      osh is None or math.isfinite(osh), f"sharpe={osh}")

# ---------------------------------------------------------------- summary
print(f"\n{'=' * 60}\n{len(PASS)} passed, {len(FAIL)} failed")
for name, detail in FAIL:
    print(f"  FAILED: {name}  [{detail}]")
sys.exit(1 if FAIL else 0)
