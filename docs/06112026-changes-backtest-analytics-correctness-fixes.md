# 2026-06-11 — Backtest & Analytics Correctness Fixes

**What this is:** a round of correctness fixes to the backtest engine, portfolio runner,
walk-forward, quant metrics, Market Lab, and the Dashboard/Analytics UI. All changes are
smoke-tested. Full audit (findings, severities, what's still open) lives in
[audit-dashboard-analytics.md](audit-dashboard-analytics.md).

**TL;DR:** the app was quietly flattering strategies — overstating profit (missing a fee),
faking robustness (broken statistics), and silently dropping trades (futures cash bug). All
corrected and verified. **Re-run cached backtests** — old on-screen numbers were computed with
the flawed math.

---

## Plain-English summary

### Changed actual trade results

| # | What was wrong | What it does now | Why it matters |
|---|---|---|---|
| 1 | Each trade only subtracted the **exit** fee, not the entry fee | Both fees counted; trades sum to the equity curve exactly | Win rate / profit factor / avg trade were slightly overstated on every strategy |
| 2 | Running 2+ strategies (or pyramiding) **undersized** trades — an open position made the app think you had less money | Uses true total equity; single strategy now matches the plain engine exactly | Multi-strategy & pyramiding results were wrong |
| 3 | One futures contract drove the cash pool negative and **silently blocked every other trade** (incl. crypto) — no error | Futures reserve margin only, like a real broker | Any portfolio mixing futures with anything else was badly broken — and invisibly |
| 4 | Walk-forward tested with "blind" indicators (no warm-up history) | Each window gets warm-up history; indicators valid from bar 1 | Walk-forward was measuring a crippled strategy |

### Changed the "is it real?" statistics

| # | What was wrong | What it does now | Why it matters |
|---|---|---|---|
| 5 | Deflated-Sharpe ("probability the edge is real") used a broken formula — **inflated ~10×** | Correct Bailey–López de Prado formula; only shown for Sharpe-optimized runs | A noise strategy used to read ~70% confidence; now reads low |
| 6 | Volatility "forecast skill" compared a number to a near-copy of itself → fake ~99% | Predicts genuinely future volatility (~46% on BTC 1h) | The headline skill stat was meaningless |
| 7 | Correlation tab's "deepens the drawdown?" column had its **sign flipped** | Correct direction | A risk-adding strategy looked safe and vice versa |

### Display-only (math was fine, screen was wrong)

| # | What was wrong | What it does now |
|---|---|---|
| 8 | "OOS positive windows" showed up to **6,000%** (×100 twice) | Correct percentage |
| 9 | "Max Drawdown" meant 3 different things under one label | Each spot labeled with its convention |
| 10 | Live/replay "Max DD" reset to 0 at each new high; profit factor showed "∞" while streaming | Tracks the worst drawdown; "∞" only for genuine no-loss, "—" for missing |

---

## Technical detail

Every Dashboard button, walk-forward, and Monte Carlo run funnels through the same engine, so a
fix in one place corrects all surfaces:

```
/strategies/run (N=1)  ─┐
/backtest/portfolio    ─┴─► portfolio_runner.run_portfolio()
                              ├─ backtest_engine._trade / _compute_stats / _compute_analytics
                              │     └─ quant_metrics.compute()
                              └─ portfolio_correlation.compute()
```

### Files changed

**`backend/services/backtest_engine.py`**
- **E1** — per-trade `pnl_dollars` (and `win`) now net of both fees (`pnl - tr["fee_open"]` at all
  3 close sites). Equity accounting unchanged — `fee_open` still hits `realized_cum` at entry.
- **E3** — final equity point refreshed after force-closing open positions so the curve's last
  value equals `stats.final_equity` exactly.
- **W1** — new `trade_start_time` param: indicators compute over the full slice, but entry signals
  before this epoch are masked. Lets walk-forward warm up indicators without generating warm-up
  trades.
- **E6** — empty-result heatmap no longer aliases one row list.

**`backend/services/portfolio_runner.py`**
- **P1** — entry sizing/gating equity is now `cash + unrealized + locked_notional` (the same
  identity used for the equity snapshot), not `cash + unrealized`.
- **P2** — futures (contract-sized) entries deduct **fee only** from cash (margin model); closes
  settle P&L only; `locked_notional()` returns 0 for futures so the equity identity stays exact.
- **P9** *(found while fixing P1)* — `last_close` was advanced to the current bar's close *before*
  entry sizing, so entries were sized using the bar's close (not yet known at the open). Now
  advanced in a new "Phase B½" after entries — this was the last gap to exact engine equivalence.
- **P4** — skip-log `required_notional` now includes the open fee (matches the gate).
- **E1/E6** mirror of the engine fixes for the portfolio close path / empty result.

**`backend/services/walkforward.py`**
- **W1** — feeds each IS/OOS window `warmup_bars` (default 200) of prior history, masks pre-window
  entries via `trade_start_time`, drops warm-up equity points when stitching, and recomputes
  per-window stats on the in-window slice (`_window_stats`) so the flat warm-up prefix doesn't
  dilute Sharpe.
- **W2** — profit-factor IS score capped at 10 (was `+inf` for any no-loss window, which let one
  lucky trade dominate Optuna).
- Adds `metric` to the `wf_trials` bundle so downstream stats know whether ratios are
  unit-commensurable.

**`backend/services/quant_metrics.py`**
- **Q1** — Deflated Sharpe now includes the mean-trial term `E[max] = mean + std·(...)` (the
  missing term caused the ~10× overstatement) and is only computed when the IS metric is `sharpe`.
- **Q2** — Walk-Forward Efficiency only computed for the `sharpe` metric (don't divide an OOS
  Sharpe by an IS profit-factor).
- **Q3** — geometric mean per-trade return now derived from the equity curve
  `(final/start)^(1/n) − 1`, not by compounding additive `pnl_pct_equity` values.

**`backend/services/portfolio_correlation.py`**
- **F1** — `delta_maxdd_pct` sign flipped to `dd_rest − base_maxdd` so ">0 = deepens the DD"
  matches the UI legend (was inverted vs its own comment).

**`backend/services/market_lab.py`**
- **M2** — `cluster_patterns` honors the `stride` param (was parsed but ignored → maximal window
  overlap).
- **M3** — volatility forecast skill targets the non-overlapping forward vol over
  `forecast_horizon` bars (was a trailing window vs a shifted copy of itself → mechanical ~0.99).
- **F2** — regime forward-return / transition stats and the MR scan's by-regime stats now use
  **unsmoothed (causal)** labels; `smooth_bars` smoothing is display-only (it merges into the
  *next* run, which is future-dependent).

**Frontend**
- **A1** — `Analytics.jsx`: "OOS positive windows" no longer multiplies an already-0–100 value by
  100; threshold compared against 50.
- **A2/E2** — `Analytics.jsx`: Overview "Max Drawdown" sub-labeled "% of starting capital" and
  shows the peak-relative figure; Drawdown chart header names its convention.
- **D1** — `Dashboard.jsx`: streamed "Max DD" tracks the running minimum, not the instantaneous
  drawdown.
- **D2** — `StatsPanel.jsx`: profit factor distinguishes `undefined` (missing → "—") from `null`
  (no losing trades → "∞").

---

## Verification (all passing)

Run from `backend/`:

```python
from services import backtest_engine
from services.portfolio_runner import run_portfolio, StrategySpec

sid, sym, tf = "vwma_reversion", "BTCUSDT", "15m"
for params in ({}, {"pyramiding": 3}):
    e = backtest_engine.run(sid, sym, tf, dict(params))
    p = run_portfolio([StrategySpec(strategy_id=sid, symbol=sym, timeframe=tf,
                                    params=dict(params), priority=1)])
    es, ps = e["stats"], p["stats"]
    assert abs(sum(t["pnl_dollars"] for t in e["trades"]) - es["total_return_dollars"]) < 0.05  # E1
    assert es["trades"] == ps["trades"]                                                          # P1/P2/P9
    assert abs(es["final_equity"] - ps["final_equity"]) < 0.05                                   # P1/P2/P9
    assert abs(e["equity"][-1]["equity"] - es["final_equity"]) < 1e-6                            # E3
```

Results observed:
- `Σ trade P&L == total_return_dollars` exactly (E1) — 1,821 and 4,057-trade runs.
- Engine vs portfolio N=1: **identical trade sets and final equity to the cent**, default and
  `pyramiding=3` (P1/P2/P9/E3).
- ES futures (lunar, 1h): portfolio == engine exactly, pyramiding 1 and 2, zero skips (P2).
- Mixed ES+BTC: BTC takes **all 101** of its solo trades alongside ES's 18 — no starvation (P2).
- `trade_start_time`: no entries before window start; equity flat through warm-up; warm window
  found 6 trades where the cold window found 5 (W1).
- Deflated Sharpe with mean term: 0.319 where the old formula said ~0.68; PF/return metrics → None
  (Q1/Q2).
- Correlation: synthetic crash-correlated strategy → `delta_maxdd_pct = +23.3` (deepener > 0) (F1).
- `cluster_patterns` stride=5 → ~n/5 windows (M2); regimes/MR scan clean with `smooth_bars=8` (F2).
- Modified JSX parses clean (esbuild).

---

## Action items for users

1. **Re-run cached backtests.** Anything currently displayed predates these fixes.
2. **Expect slightly lower numbers** on win rate / PF / expectancy (fees now counted) and much
   lower Deflated-Sharpe readings (they were inflated). The new numbers are the honest ones.
3. **Multi-strategy and futures portfolios are now trustworthy** — they were the most broken and
   are now verified to match the single-strategy engine exactly.

---

## Still open (deferred this round)

Not yet addressed — see the audit's §14 "Still open" list:
M1 (overlap-aware t-tests / effective sample size), S1–S2 (live-runner accounting parity),
D4 (Apply & Re-run standalone-vs-pool splice), W3–W4 (futures stitch compounding + cost
attribution scaling), P3 (counterfactual exits ignore stops), E4–E5 (close-triggered ATR stop,
exact-fill timestamps), Q4 (probability-of-ruin model), C2–C3 (co-crash threshold, downside-corr
min sample), M4–M8, A3–A6, D5–D8, R2, F3.
