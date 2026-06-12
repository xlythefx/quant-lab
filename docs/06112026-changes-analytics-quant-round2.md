# 2026-06-11 — Analytics Quant-Correctness Fixes (round 2)

**What this is:** a second round of correctness fixes, this time focused on the Analytics page and
the metric modules behind it — portfolio correlation, the backtest stats dict, walk-forward
stitching, and Monte Carlo. All changes are verified by an automated suite
(`scripts/verify_audit_2026_06_11.py`, 17/17 passing) and a clean frontend build. Full audit
(what was checked, what's correct, what's still open) lives in
[audit-analytics-quant-2026-06-11.md](audit-analytics-quant-2026-06-11.md). Round 1 (the engine
bugs) is in [06112026-changes-backtest-analytics-correctness-fixes.md](06112026-changes-backtest-analytics-correctness-fixes.md).

**TL;DR:** the engine math from round 1 was sound, but the **portfolio analytics** still
understated crypto Sharpe (~20%), **invented compounding** for futures walk-forwards, and computed
**tail-risk stats on too few days**. Some metrics also reported a fake `0.0` where they should have
said "couldn't measure". All corrected. **Re-run portfolio and walk-forward analytics** — Sharpe
and futures WF equity curves change.

---

## Plain-English summary

### Changed analytics numbers

| # | What was wrong | What it does now | Why it matters |
|---|---|---|---|
| 1 | Portfolio Sharpe (and the leave-one-out "does this strategy help?" deltas) annualized as if every market trades **252 days/year** | Infers the real trading frequency from the data (~365 for crypto, ~252 for futures) | Crypto portfolio Sharpe was understated ~20%; the "keep or cut" rankings used the wrong scale |
| 2 | Walk-forward **stitched futures like crypto** — multiplying fixed-contract dollar P&L by an equity-growth factor it can't actually earn | Futures windows chain **additively** (real dollars); crypto still compounds | Futures walk-forward equity curves and final returns were inflated/distorted |
| 3 | "Co-crash days" and downside correlation could be computed from as **few as 2 days**, and a barely-active strategy's flat days counted as "crashes" | Both require ≥20 days; only genuinely losing days count as crashes; otherwise shows "insufficient data" | Tail-risk stats on sparse portfolios were noise dressed up as signal |

### Changed "couldn't measure" honesty

| # | What was wrong | What it does now | Why it matters |
|---|---|---|---|
| 4 | Sharpe reported **`0.0`** when it couldn't be computed (flat equity, too few bars) — indistinguishable from a real zero | Reports "—" (null) when unmeasurable | A degenerate run looked like a real no-edge result; one path would have crashed Monte Carlo |
| 5 | Walk-forward counted an unmeasurable window's Sharpe as **0** in its "% of positive OOS windows" | Skips the window instead of scoring it 0 | Robustness percentages were diluted by phantom zeros |
| 6 | **Break-even trades** (exactly $0) were lumped into losses | Counted separately; shown as "/ N BE" on the Win Rate card | Loss counts were slightly overstated |

### Display-only (math was fine, label was misleading)

| # | What was wrong | What it does now |
|---|---|---|
| 7 | Annual "Return %" divides every year by the **original** starting capital — overstates later years on compounding runs, but the label didn't say so | Relabeled "Return % (of starting capital)" with a tooltip explaining the convention |
| 8 | "Rolling Sharpe" (20-trade window) sat next to the annualized headline Sharpe with no distinction | Labeled "(per-trade, non-annualized)" so the two aren't compared |

---

## Technical detail

### Files changed

**`backend/services/portfolio_correlation.py`**
- **Fix 1** — new `_periods_per_year(days)` infers annualization frequency from the observed
  day grid (`days.size / calendar_span_years`), analogous to `quant_metrics.infer_bars_per_year`.
  `_sharpe(daily)` → `_sharpe(daily, periods_per_year)`; threaded through `base_sharpe`,
  leave-one-out `s_rest`. `TRADING_DAYS = 252.0` kept as the fallback. The max-Sharpe suggested
  weights (`pinv(cov) @ mu`) are scale-invariant to this factor, so weights are unchanged.
- **C3** — downside correlation now requires `R.shape[0] >= 20` days and `mask.sum() >= 10`
  tail days (was 10 / 2).
- **C2** — co-crash requires `>= 20` days and strictly-negative membership
  (`(R <= bad_thresh) & (R < 0)`) so a sparse strategy's zero-P&L days (whose 5th percentile is
  exactly 0) no longer count as crashes; emits `co_crash_days = None` below the threshold.

**`backend/services/backtest_engine.py`**
- **Fix 4** — `sharpe` initialized to `None` (not `0.0`); emitted as `float(...)` or `None`.
  Degenerate cases (zero vol, <3 bars) now report `None`, matching `quant_metrics._safe`.
- **Fix 6** — `losses` is now a strict `pnl_dollars < 0` count; new additive `breakeven` stat
  = `n_trades - wins - losses`. `_side_block` losses aligned. `win_rate` (wins/n) unchanged.
- `_empty_result` stub: `sharpe: None`, `breakeven: 0`.

**`backend/services/portfolio_runner.py`**
- `_empty_portfolio_result` stub aligned: `sharpe: None`, `breakeven: 0`.

**`backend/services/monte_carlo.py`**
- **Fix 4 follow-through** — `original.sharpe` builder is None-safe (`float(...)` only when not
  None); previously `float(None)` would have raised `TypeError` once Sharpe became nullable.

**`backend/services/walkforward.py`**
- **W3** — detects fixed-contract futures once (same `assets.get(symbol, broker)` check as the
  engine, `asset_class in ("equity_index_future", "futures") and contract_size > 1.0`). In the
  stitch block, futures rebase **additively** at all three sites — `multiplier_carry = 1.0`,
  per-point `eq = carry + (window_eq − capital)`, carry-forward `carry += Δ$`. Trades pass through
  unscaled (which also stops scaling their fees — round-1 W4 — for futures). Crypto keeps the
  multiplicative rebase.
- **W5** — `oos_sharpe` preserves `None` (was `float(... or 0.0)`); `best_oos_sharpe` and
  `window_pairs` skip rather than coerce unmeasurable windows. Downstream `_robustness` already
  filters `None`.

**`backend/services/quant_metrics.py`**
- **Doc only** — extended the Sortino comment: the downside deviation's `ddof=0` (RMS about a
  fixed MAR=0 target) is deliberate and correctly differs from Sharpe's `ddof=1`. Not a bug.

**Frontend**
- **Fix 7** — `Analytics.jsx`: Annual P&L "Return %" header → "Return % (of starting capital)"
  with an explanatory `title` tooltip. Math unchanged (per decision: honest for fixed-contract
  futures and mixed portfolios).
- **Fix 8** — `Analytics.jsx`: rolling Sharpe label → "Rolling Sharpe (per-trade, non-annualized)".
- **Fix 6** — `Analytics.jsx`: Win Rate KPI appends "/ N BE" when `breakeven > 0`.
- **C2** — `CorrelationMatrix.jsx`: Co-Crash card shows "insufficient data (<20 days)" when
  `co_crash_days` is null.

---

## Verification (all passing)

`python scripts\verify_audit_2026_06_11.py` — **17/17**. Key invariants:

- **Annualization (Fix 1):** contiguous 365-day grid → ppy 365.25; weekday-only grid → 262;
  crypto Sharpe = old × **1.2039** ≈ √(365.25/252).
- **Small-sample guards (C2/C3):** 10-day portfolio → `downside_corr` and `co_crash_days` both
  `None`; 120-day sparse strategy → flat days excluded from co-crash.
- **Engine stats (Fix 4/6):** `wins + losses + breakeven == trades`; `Σ trade P&L ==
  total_return_dollars` (round-1 E1 still holds); full BTCUSDT run JSON-serializable; 2-bar run →
  `sharpe is None`.
- **Scoring contract (Fix 5):** `_score_from_stats({"sharpe": None}, "sharpe") == 0.0`.
- **WF stitch (W3):** ES 1h, 5 windows → stitched final == starting + Σ window $P&L **to the
  cent**; all 21 stitched trade P&Ls unscaled. BTCUSDT → multiplicative invariant
  (final == starting × Π growth) unchanged.
- **Monte Carlo (Fix 4):** `original.sharpe` float-or-None, no exception.

Frontend: `npm run build` clean.

---

## Action items for users

1. **Re-run portfolio correlation and walk-forward analytics.** Crypto portfolio Sharpe (and the
   leave-one-out keep/cut deltas) will rise ~20%; futures walk-forward equity curves will change.
2. **Expect "—" instead of 0** for Sharpe on degenerate runs — that's the honest reading.
3. **Sparse / short portfolios** may now hide co-crash and downside-correlation stats with
   "insufficient data" rather than showing noise.

---

## Still open (deferred this round, per decision)

Methodology items documented as ranked suggestions rather than implemented — see
[audit-analytics-quant-2026-06-11.md](audit-analytics-quant-2026-06-11.md) §3:
M1 (overlap-aware significance in Market Lab), E4 (intrabar stop modeling), S1/S2 (live-runner
parity), W6 (block-bootstrap WF CIs), configurable risk-free rate, W4 crypto cost attribution,
A3 enhancement (year-opening-equity returns), and the round-1 carry-forwards (P3, Q4, E5, M4–M6,
A4–A6, D5/D6, R2, F3).
