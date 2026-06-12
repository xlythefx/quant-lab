# Analytics quant-correctness audit — round 2 (2026-06-11)

Scope: the Analytics page ([Analytics.jsx](../frontend/src/pages/Analytics.jsx),
[CorrelationMatrix.jsx](../frontend/src/components/analytics/CorrelationMatrix.jsx)) and every
backend module feeding it: `backtest_engine.py`, `quant_metrics.py`, `portfolio_correlation.py`,
`portfolio_runner.py`, `walkforward.py`, `monte_carlo.py`.

This is a follow-up to [audit-dashboard-analytics.md](audit-dashboard-analytics.md) (round 1),
whose fixes are logged in
[06112026-changes-backtest-analytics-correctness-fixes.md](06112026-changes-backtest-analytics-correctness-fixes.md).
Round 1's headline engine bugs (E1 entry fees, P1/P2 portfolio sizing, W1 WF warm-up, Q1 deflated
Sharpe) were re-verified as fixed and are not re-listed here.

Verification: `python scripts\verify_audit_2026_06_11.py` — **17/17 checks pass**;
`npm run build` clean.

---

## 1. Checked and found CORRECT (no action)

These were flagged as suspects during the audit and survived scrutiny — listed so future audits
don't re-litigate them:

| Item | Verdict |
|---|---|
| **Annualization via `infer_bars_per_year`** (quant_metrics.py) | Correct, including futures. The mean bar interval *includes* session/weekend gaps, so `365.25d / mean_dt` self-corrects to true bars-per-calendar-year. The claimed "futures Sharpe overstated 23%" does not hold. |
| **`fmtPct` units** (format.js:32) | Expects percent-units input (15 → "+15.00%"). The claimed Buy & Hold ×100 display bug is false — `(last/first − 1) × 100` into `fmtPct` is correct. |
| **Correlation basis** (portfolio_correlation.py) | Computed on daily dollar **P&L deltas**, not equity levels — no spurious common-trend correlation. |
| **Sharpe basis** (backtest_engine.py) | Per-bar MTM equity returns, ddof=1, annualized by inferred bar frequency. Reflects pyramiding/leverage honestly. |
| **Sortino downside deviation** (quant_metrics.py:186-196) | RMS of shortfalls over ALL periods (ddof=0) is the textbook Sortino/van-der-Meer target-downside-deviation at MAR=0. Deliberately differs from Sharpe's ddof=1 (Bessel doesn't apply to an RMS about a fixed target). Now documented in-code. |
| **Fees/slippage** | Per-side, symmetric, adverse on all four legs; futures $/contract vs crypto %-notional branch correct. |
| **Leave-one-out deltas** (portfolio_correlation.py) | Sign convention correct (round-1 F1 fix in place). |
| **Max-Sharpe suggested weights** | `pinv(cov) @ mu` on raw daily moments — scale-invariant to the annualization factor, unaffected by fix #1 below. |
| **Kelly, Gaussian overlay, monthly Pearson corr** (Analytics.jsx) | Formulas correct (Kelly `(pR−q)/R` with payoff>0 guard; PDF scaled by `n·binWidth`; Bessel-corrected sample stats). |
| **Frontend null-handling** | `fmtNum/fmtPct/fmtInt(null)` → "—"; all `sharpe` consumers tolerate null (verified before making sharpe nullable). |

## 2. Fixed this round

| # | Issue | Files | Verification |
|---|---|---|---|
| 1 | **Portfolio correlation hard-coded `sqrt(252)`.** Crypto produces ~365 daily P&L points/yr → portfolio Sharpe, leave-one-out `delta_sharpe`, and `base_stats.sharpe` were understated ~20% and inconsistent with the engine's calendar-based annualization. Added `_periods_per_year(days)` (inferred from the observed day grid, like `infer_bars_per_year`) and threaded it through all `_sharpe` call sites. | portfolio_correlation.py | Contiguous-365-day grid → ppy 365.25; weekday grid → 262; new Sharpe = old × 1.2039 ≈ √(365.25/252) |
| 2 | **C2/C3 small-sample correlation stats.** Downside corr could compute on as few as 2 days; co-crash counted mostly-flat (sparse) strategies' zero-P&L days as "crashes" because their 5th percentile is exactly 0. Now: downside corr needs ≥20 days and ≥10 tail days; co-crash needs ≥20 days and strictly-negative P&L membership, else `None`. | portfolio_correlation.py, CorrelationMatrix.jsx (shows "insufficient data (<20 days)") | 10-day portfolio → both `None`; 120-day with sparse strategy → flat days excluded |
| 3 | **Engine Sharpe silent 0.0 fallback.** Degenerate runs (zero vol, <3 bars) reported `sharpe: 0.0`, indistinguishable from "measured, no edge". Now `None`, matching `quant_metrics._safe` convention. Empty-result stubs in engine + portfolio runner aligned; `monte_carlo.py` original-stats builder made None-safe (would have raised `TypeError`). | backtest_engine.py, portfolio_runner.py, monte_carlo.py | 2-bar run → `sharpe is None`; full BTCUSDT run JSON-serializable; `_score_from_stats({"sharpe": None}) == 0.0` |
| 4 | **Breakeven trades counted as losses.** `losses = n_trades − wins` lumped pnl==0 trades into losses (inconsistent with `quant_metrics.n_losers` which is strict pnl<0). Now strict `pnl<0` plus a new additive `breakeven` stats key; side blocks aligned; Win Rate KPI shows "/ N BE" when present. | backtest_engine.py, Analytics.jsx | `wins + losses + breakeven == trades` on real run |
| 5 | **W3: walk-forward stitch invented compounding for futures.** The multiplicative rebase (`eq = carry × local_eq/capital`, trades × `carry/capital`) is correct for %-of-equity crypto sizing but wrong for fixed-contract futures, whose P&L is absolute dollars regardless of equity. The stitch now detects contract sizing (same `assets.get` check as the engine) and rebases additively — equity `carry + Δ$`, trades pass through unscaled (which also stops scaling their fees — round-1 W4 — for futures). | walkforward.py | ES 1h, 5 windows: stitched final == starting + Σ window $P&L **to the cent**; all 21 stitched trade P&Ls unscaled. BTCUSDT: multiplicative invariant unchanged (final == starting × Π growth) |
| 6 | **W5: `oos_sharpe or 0.0` coercion.** A window whose Sharpe wasn't computable was scored as 0 in `window_pairs`/`best_sharpe_oos`, polluting the "% positive OOS windows" denominator and the deflated-Sharpe input. Now preserved as `None` (downstream `_robustness` already filters None). | walkforward.py | Contract test on `_score_from_stats`; `_robustness` None-filter re-verified |
| 7 | **A3 (display honesty): annual Return %.** Divides each year's P&L by the *original* starting capital — correct for fixed-contract futures (no compounding exists) but overstates later years on compounding crypto runs. Per user decision: relabeled "Return % (of starting capital)" with an explanatory tooltip rather than changing the math. | Analytics.jsx | Visual |
| 8 | **Rolling Sharpe label.** The 20-trade rolling Sharpe is a raw per-trade mean/std (not annualized) — label now says so explicitly, so it isn't compared against the annualized headline Sharpe. | Analytics.jsx | Visual |

API note: `stats.sharpe` may now be `null` and `stats.breakeven` /
`drawdown_overlap.co_crash_days: null` are additive — all known consumers (frontend formatters,
scorers, PDF export, AI insights) verified tolerant.

## 3. Ranked remaining suggestions (not implemented this round, per user decision)

1. **M1 — overlapping forward-return windows in Market Lab** (med-high): edge scans use
   overlapping windows but iid t-stats. Use Newey-West/HAC errors or a block bootstrap before
   trusting any "edge" p-value.
2. **E4 — intrabar stop modeling** (low-med): ATR stops trigger on *close*, filling next open —
   a bar that spikes through the stop intrabar shows a smaller loss than live trading would.
   Conservative option: trigger on bar low/high, fill at `min(stop, next open)` for longs.
3. **S1/S2 — live-runner accounting parity** (med-high if live trading matters): the live equity
   model differs from the engine's; replayed stats won't reconcile with backtests.
4. **W6 — WF Sharpe CIs use iid bootstrap** (low): per-bar equity returns are autocorrelated;
   a stationary block bootstrap (block ≈ √n) widens the CI honestly.
5. **Risk-free rate** (low, documentation): Sharpe/Sortino assume rf = 0 everywhere. Fine for
   crypto self-comparison; at today's rates a ~5% cash yield materially changes "is this better
   than T-bills". Either document the convention in the UI or add `risk_free_rate` to risk_config.
6. **W4 (crypto remainder) — stitched cost attribution**: crypto trade fees are scaled by the
   carry multiplier while slippage stays embedded in fills; the Costs panel mixes the two. Futures
   side resolved by fix #5.
7. **A3 enhancement**: per-year return on year-opening equity, asset-class-aware (compounding
   denominator for crypto, starting capital for futures).
8. **Carried forward from round 1** (original severities): P3 (counterfactual exits ignore
   stops), D4 (Apply&Re-run splices N=1 into portfolio view), Q4 (ruin approximation), E5
   (exact-fill MAE/MFE overrun), M4–M6 (lab purge/cache/cap), A4 (trades/month denominator), A5
   (Gaussian clip), A6 (local-TZ labels), D5/D6, R2, F3 (ADX warm-up NaNs labeled safe).
9. **Heatmap color scale** (cosmetic): positive and negative P&L normalize separately, so
   +$10k and −$10k can render at different intensities; symmetric normalization would make the
   grid visually comparable.

## 4. How to re-verify

```powershell
# backend invariants (17 checks: ppy inference, C2/C3 guards, sharpe None,
# breakeven partition, crypto/futures stitch invariants, monte carlo)
python scripts\verify_audit_2026_06_11.py

# frontend
cd frontend; npm run build
```
