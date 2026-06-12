# QuantLab Dashboard + Analytics Correctness Audit

> **Implementation status (2026-06-11):** a first fix round has been implemented and
> smoke-tested — see **§14** for the fixed-findings table, verification results, the new
> finding (P9) discovered during fixing, and the list of findings still open.

Read-only audit of the Dashboard/Analytics surface and every backend computation feeding it.
Each finding: location, what's wrong & why, concrete fix, **confidence** (high/med/low that the
issue is real as described), **severity** (high/med/low impact on correctness of displayed numbers).
No code was changed. All line numbers verified by reading the files in this audit session
(2026-06-11, working tree with uncommitted changes — line numbers reflect that state).

Legend: 🔴 high severity · 🟠 medium · 🟡 low · ℹ️ info/methodology note

---

## 1. backend/services/backtest_engine.py

### E1 🔴 Per-trade P&L excludes the entry fee — all trade-level stats are systematically optimistic
- **Where:** `backtest_engine.py:257` / `:283` (`pnl = (fill - entry)*units - fee_close`), entry fee charged
  to `realized_cum` only at `:305`/`:321`; `_trade()` receives that `pnl` at `:259`/`:285`.
- **Why wrong:** the equity curve is net of BOTH fees, but each trade dict's `pnl_dollars` is net of the
  exit fee only. Consequences: `sum(trades.pnl_dollars) ≠ stats.total_return_dollars` (off by total open
  fees); `win` (`:462`), win-rate, profit factor, gross profit/loss, expectancy, avg trade, the t-test,
  the Gaussian/distribution tabs, per-session/heatmap/monthly P&L — every trade-derived number is
  overstated by `fee_open` per trade. A trade whose move covers the exit fee but not the entry fee is
  counted as a winner.
- **Fix:** make trade P&L net of both sides: in each close branch `pnl = move*units - fee_close - tr["fee_open"]`
  and stop pre-charging `fee_open` to `realized_cum` at entry (or keep the cash timing but pass
  `pnl - tr["fee_open"]` into `_trade`). The same change is needed in `portfolio_runner._close_tranche`.
- **Confidence:** high. **Severity:** high (small per-trade bias, but it touches every trade statistic and
  breaks trades↔equity reconciliation).

### E2 🟠 `stats.max_drawdown_pct` is starting-capital-relative but the UI labels it plainly "Max Drawdown"
- **Where:** `backtest_engine.py:533` (`max_dd_dollars / starting_capital`); rendered at
  `Analytics.jsx:709` (Overview KPI "Max Drawdown") and `Dashboard.jsx` statsById.
- **Why wrong:** industry convention (and the engine's own `max_drawdown_pct_peak`, `:505-513`) is
  peak-relative. For a run that grew equity, the starting-capital number overstates DD% vs the standard
  definition (e.g. $20k DD after equity doubled from $100k: 20% vs the conventional 10%). See X1 for the
  three-conventions problem.
- **Fix:** pick one convention per label; show "Max DD (of starting capital)" vs "Max DD (peak)" explicitly,
  or switch the headline KPI to `max_drawdown_pct_peak`.
- **Confidence:** high. **Severity:** med.

### E3 🟡 Force-close at the last bar: no slippage, and `final_equity` ≠ last equity-curve point
- **Where:** `backtest_engine.py:358-384` (fill = raw `close_a[-1]`, no `(1±slippage)`), `:386`
  (`equity = starting + realized_cum` now includes the force-close exit fees), vs `equity_curve[-1]`
  (`:388-397`) which is MTM *without* those exit fees.
- **Why wrong:** the "Final Equity" KPI and the equity chart's last point disagree by the force-close
  fees, and force-closed trades get slippage-free fills unlike every other exit.
- **Fix:** apply slippage on force-close fills and append/adjust a final equity point net of the exit fees
  (or document the convention).
- **Confidence:** high. **Severity:** low (visible only with positions open at data end).

### E4 🟡 ATR "stop" is a close-triggered stop, not an intrabar stop
- **Where:** `backtest_engine.py:247-248`/`:273-274` — `stop_hit = prev_close <= entry - mult*atr` —
  evaluated on bar close only; fills at next-bar open. The exact-fill path (`:251`, `:277`) applies only to
  `mean_revert` exits, never to `stop_hit`.
- **Why wrong:** a real stop order triggers intrabar; bars whose low penetrates the stop but close back
  above it are not stopped here. Loss tails are understated vs live stop behavior.
- **Fix:** check `low <= stop` (long) intrabar with fill at `max(stop, open)` of the breaching bar, or
  document the close-stop convention prominently.
- **Confidence:** high (it's what the code does); **Severity:** low-med depending on strategy reliance.

### E5 🟡 Exact-fill (Option B) exits: price from bar t-1, timestamp from bar t; MAE/MFE overrun
- **Where:** `backtest_engine.py:251-252` (fill = `efl_a[t-1]`), trade stamped `ts` = bar t; MAE/MFE for the
  closing tranche already absorbed ALL of bar t-1's range (`:332-345` ran at the end of iteration t-1)
  even though the fill occurred mid-bar t-1.
- **Why wrong:** exit_time lags the actual fill by one bar (duration_min overstated by one bar), and
  MAE/MFE can exceed what was possible before the intrabar exit.
- **Fix:** stamp `time_a[t-1]` for exact fills and freeze MAE/MFE at exit; or accept and document.
- **Confidence:** high. **Severity:** low.

### E6 🟡 `_empty_result` heatmap rows share one list object
- **Where:** `backtest_engine.py:761` — `"pnl": [[0]*24]*7` creates 7 references to the same inner list
  (same at `portfolio_runner.py:697`).
- **Why wrong:** classic aliasing; harmless today because it's serialized immediately, but a latent bug if
  anyone mutates a row.
- **Fix:** `[[0]*24 for _ in range(7)]`.
- **Confidence:** high. **Severity:** low (latent).

### E7 ℹ️ Long and short tranches can be open simultaneously
`:300`/`:316` gate per side only. If a strategy emits `cond_long` and `cond_short` on the same bar the
engine holds a hedged book paying double fees. Fine if strategies guarantee exclusivity — engine doesn't.

### E8 ℹ️ Sessions/heatmap/monthly book the whole trade P&L to the ENTRY timestamp bucket
`:576`, `:607`, `:617`. A multi-day trade's P&L lands entirely in its entry month/hour. Acceptable
convention, worth a UI hint.

### Checked, OK
Signal timing (act at bar-t open on bar-t-1 signals — causal) ✓ · slippage symmetric adverse ✓ ·
sizing branch matches the CLAUDE.md contract (futures fixed units / crypto %-of-MTM-equity) ✓ ·
`_fee` futures vs crypto split ✓ · Sharpe on per-bar MTM equity returns, ddof=1, annualized via
`infer_bars_per_year` (calendar-time correct) ✓ · exposure interval-union (no pyramiding double-count) ✓ ·
heatmap/sessions in UTC ✓ · distribution uses `pnl_pct_equity` not price % ✓.

---

## 2. backend/services/portfolio_runner.py

### P1 🔴 Entry sizing/gating equity omits locked notional — under-sizes and falsely blocks entries
- **Where:** `portfolio_runner.py:345` — `cur_eq = state.cash + sum(unrealized)` — versus the correct
  Phase-D identity `:373-374` `total_eq = cash + unrealized + locked_notional`.
- **Why wrong:** opening a position moved its notional from `cash` into `locked_notional`. Omitting
  `locked` means every open position shrinks the equity used for `risk_pct` sizing and the `cur_eq <= 0`
  gate (`:624`) by its full notional. Example: $100k start, one open $50k-notional position →
  `cur_eq ≈ $50k`, so the next entry sized at `risk_pct%` of HALF the true equity. This contradicts the
  module contract ("sizing reads the aggregate equity") and breaks the documented N=1 equivalence with
  `backtest_engine` (which sizes off full MTM `starting + realized + unrealized`, engine `:296-298`)
  whenever pyramiding ≥ 2 or any second strategy holds a position. Also distorts the counterfactual
  sizing for skipped signals (`equity_at_signal = cur_eq`).
- **Fix:** `cur_eq = state.cash + sum(s.unrealized() for s in streams) + sum(s.locked_notional() for s in streams)`.
- **Confidence:** high. **Severity:** high.

### P2 🔴 Futures "margin-based" entries still debit full notional from cash — one open contract silently blocks the whole portfolio
- **Where:** comment `portfolio_runner.py:633-634` ("don't cash-gate on full notional; only the fee needs
  to be funded") vs `:653` `state.cash -= required` where `required = notional + fee_open` for ALL
  instruments.
- **Why wrong:** 1 ES contract ≈ $250k+ notional with $100k capital → `cash ≈ -$150k` → with P1,
  `cur_eq ≤ 0` → **every** subsequent entry (futures and crypto alike) is silently dropped at `:624`
  (no `skipped_signals` row — futures skip the logging branch entirely, `:635`) until the position closes.
  The equity curve stays correct (locked notional is added back in Phase D), so the damage is invisible
  except as mysteriously missing trades. The Dashboard's single-strategy path (`/strategies/run`)
  also goes through this runner, so ES backtests with pyramiding ≥ 2 lose tranches 2..N.
- **Fix:** for `contract_sizing` streams deduct only the fee (and track margin separately if you want a
  margin gate), or implement the stated margin model; fix `cur_eq` per P1 so the gate uses true equity.
- **Confidence:** high. **Severity:** high (mixed or pyramided futures portfolios).

### P3 🟠 Counterfactual "would-be P&L" ignores ATR stops and exact fills
- **Where:** `portfolio_runner.py:193-233` — only walks `bxl_a`/`bxs_a` to the next-bar-open exit.
- **Why wrong:** the realized engine would also exit on ATR stop (`_process_exits:551-552`) and at exact
  fill prices; the counterfactual can hold a losing trade far past where the stop would have cut it, and
  prices the exit differently. The Skipped Signals tab's "would-be P&L" is therefore a different trade
  than the one that would actually have occurred. Sizing also uses the understated `cur_eq` (P1).
- **Fix:** mirror the full exit logic (stop + exact fill) in the counterfactual walk, or label the column
  "signal-to-signal estimate".
- **Confidence:** high. **Severity:** med (diagnostic display only).

### P4 🟡 `required_notional` in the skip log excludes the fee the gate includes
`:631-645` — gate compares `cash < notional + fee_open` but logs `required_notional = notional`. UI can
show `available_cash ≥ required` for a skipped row. Log `required = notional + fee_open` or both.

### P5 🟡 `final_equity` excludes force-close exit fees while trades include them
`:414` takes the last pre-force-close snapshot; `:388-404` then closes positions charging `fee_close`
into trades/realized but never re-snapshots. Mirror image of E3 (engine includes them in final equity,
portfolio excludes them). Same fix family as E3.

### P6 ℹ️ `risk_overrides["risk_pct"]` is silently ignored on the portfolio path
`run_portfolio` merges overrides into `rc` only (`:261-262`); `_Stream.risk_frac` reads `strategy.p`
(`:121`). The engine honors this override (engine `:128-131`); any cost-sweep-style caller using
`run_portfolio` would get no effect with no error.

### P7 ℹ️ Per-strategy stats use the full portfolio starting capital
`:482-485` — by design ("share of portfolio"); a strategy's `total_return_pct`/Sharpe is its contribution
measured against the whole pool, including flat bars from other symbols' unified timestamps. Worth a UI
footnote in the attribution table.

### P8 ℹ️ Aggregate streaks are computed on entry-time-ordered cross-strategy trades
`:412` sorts by entry_time; P&L realizes at exit time, and interleaved strategies make "consecutive"
fuzzy. Cosmetic.

### Checked, OK
Books balance: `cash + locked + unrealized` is conserved through open/close (`:602`, `:653`) ✓ ·
priority order: exits then entries, both in priority order, equity snapshot after exits ✓ ·
unified-timeline last-close marks for non-trading streams ✓ · per-strategy synthetic equity from
Phase-D snapshots ✓ · `_empty_portfolio_result` lacks a `correlation` key but the UI guards with
`rawResult?.correlation` ✓.

---

## 3. backend/services/portfolio_correlation.py

### C1 🟠 `delta_maxdd_pct` sign convention contradicts its own comment (and likely the UI reading)
- **Where:** `portfolio_correlation.py:244-245` — `"delta_maxdd_pct": base_maxdd - dd_rest  # >0: strategy DEEPENS the DD`.
- **Why wrong:** `_max_dd_pct` returns values ≤ 0 (`:108-115`, it returns `dd.min()`). If removing
  strategy j makes the DD shallower (strategy deepens it), `base_maxdd` is MORE negative than `dd_rest`,
  so `base - rest < 0` — the comment's ">0 means deepens" is inverted. Any UI copy built from that
  comment will praise/blame the wrong strategies.
- **Fix:** either return positive-magnitude DDs from `_max_dd_pct`, or flip to `dd_rest - base_maxdd`,
  and verify `CorrelationMatrix.jsx`'s interpretation matches.
- **Confidence:** high (math), med (whether the UI actually mis-reads — CorrelationMatrix.jsx not fully
  audited). **Severity:** med.

### C2 🟠 `co_crash_days` threshold degenerates to 0 for sparse strategies — flat days count as crashes
- **Where:** `:231-232` — `bad_thresh = np.quantile(R, 0.05, axis=0)` on zero-dominated daily P&L, then
  `R <= bad_thresh`.
- **Why wrong:** if fewer than 5% of a strategy's days are negative, its 5th percentile is exactly 0 and
  every flat (0-P&L) day satisfies `<= 0` — for two monthly-trading strategies, nearly every common flat
  day is a "co-crash". The reported count is meaningless for low-frequency books.
- **Fix:** restrict to strictly negative days (`R < min(bad_thresh, 0)`), or compute the quantile over
  non-zero days only.
- **Confidence:** high. **Severity:** med.

### C3 🟡 Downside correlation can be computed on as few as 2 days
`:186-188` — `mask.sum() >= 2` admits a 2-row correlation (always ±1). Require ≥ ~10 masked days; report
`n_days` (already returned) prominently in the UI.

### C4 ℹ️ Correlation on dollar P&L with compounding sizing
Documented design (`:11-22`). Crypto strategies compound (%-of-equity) so later-period dollar P&L has
larger variance — correlations are weighted toward the late sample. Fine, but worth a docs note.

### C5 ℹ️ ddof inconsistency
`R.std(axis=0)` (ddof=0) in `div_ratio`/`_corr_matrix` vs `ddof=1` in `_sharpe`. Immaterial; tidy when
touched.

### Checked, OK
Day bucketing & delta attribution ✓ · zero-variance columns reported as 0 corr ✓ · `mask` NameError
impossible (short-circuit) ✓ · ridge-regularized covariance + pinv ✓ · ERC fixed-point bounded ✓ ·
weights renormalized long-only and advisory-only ✓ · smoke-test assertions sane ✓.

---

## 4. backend/services/quant_metrics.py

### Q1 🔴 Deflated Sharpe omits the mean-trial term — significance wildly overstated (numerically verified)
- **Where:** `quant_metrics.py:485-499` — `expected_max_sr = sr_std * ((1-γ)z1 + γz2)`; Bailey & López de
  Prado's E[max SR] is `mean(SR_trials) + std(SR_trials)·((1-γ)Φ⁻¹(1-1/N) + γΦ⁻¹(1-1/(Ne)))`.
- **Verified:** with trial mean SR 1.0, std 0.5, N=100, best OOS 1.5 → implementation reports
  DSR-prob **0.681**; correct formula gives **0.063**. The "P(best Sharpe > null)" card can read ~70%
  for a strategy that's actually indistinguishable from selection noise.
- **Also:** when the WF metric is `profit_factor` or `total_return`, the trial *values* feeding `sr_std`
  are in PF/% units while `best_sharpe_oos` is a Sharpe — units mismatch makes the statistic meaningless
  for non-Sharpe metrics. (PF trials can also be `inf` — filtered, but the remaining distribution is
  truncated.)
- **Fix:** add the mean term; compute it only when `metric == "sharpe"`; ideally use the full DSR (PSR with
  skew/kurtosis and track length) or label the card "approximate".
- **Confidence:** high. **Severity:** high (it's the headline robustness number).

### Q2 🟠 Walk-Forward Efficiency mixes units when the optimization metric isn't Sharpe
`:501-516` — `oos_sharpe / is_score` where `is_score` is in the chosen metric's units (PF, return %).
Median of cross-unit ratios is not an efficiency. Fix: compute IS Sharpe for the chosen params per
window, or restrict WFE to `metric == "sharpe"`.
**Confidence:** high. **Severity:** med.

### Q3 🟠 `geometric_mean_return_pct` compounds non-compoundable quantities
`:101-107` — geo-mean of `1 + pnl_pct_equity/100` where `pnl_pct_equity = pnl / STARTING capital`
(engine `:434`). These are additive fractions of a fixed base, not sequential growth factors; with
pyramiding the same capital is counted per-tranche, and with futures fixed-contract sizing there is no
compounding process at all. The number shown as "per-trade compounded avg" is not that.
Fix: compound on the equity curve (`(final/start)^(1/n_trades) - 1`) or relabel.
**Confidence:** high. **Severity:** med.

### Q4 🟡 Probability of ruin uses the even-money gambler's-ruin formula with a non-unit payoff
`:360-381` — `((1-edge)/(1+edge))^n` is exact for ±1 unit bets; with payoff ≠ 1 it's a rough
approximation, and `n_bets = capital / avg_loss` (clamped 1000) assumes fixed-dollar bets while the
engine compounds %. Treat as order-of-magnitude; label it.
**Confidence:** high (approximation), **Severity:** low.

### Q5 🟡 `cost_attribution` slippage estimate wrong for force-closes and (worse) for stitched WF trades
`:557-605` — assumes slippage on both sides of every trade (force-closes have none, E3), and in the WF
path the trades' `fees` were scaled by the stitch multiplier while `units × price` (the slippage basis)
was not — fee share vs slippage share is mis-split (see W4).
**Confidence:** high. **Severity:** low-med (WF Costs panel).

### Q6 ℹ️ Trade-level t-test iid assumption
`:343-358` — pyramided tranches share bars; overlapping exposure violates independence. The Analytics
T-Test tab carries an honest caveat (✓ `Analytics.jsx:1682`); fine as labeled.

### Q7 ℹ️ `advanced.drawdown.max_drawdown_pct` (peak-relative) shares a name with `stats.max_drawdown_pct` (starting-capital-relative)
`:280` vs engine `:533`. Two fields, same name, different denominators — root cause of X1.

### Checked, OK
Sortino target-downside (RMS of min(r,0) over all bars) — textbook-correct ✓ · VaR/CVaR percentile
direction ✓ · tail-ratio sign guards ✓ · skew/kurt sample-size guards ✓ · K-ratio positivity guard ✓ ·
omega/gain-to-pain alias documented ✓ · `_safe` JSON hygiene ✓ · `infer_bars_per_year` mean-Δt
(correct calendar-time annualization) ✓ · parameter-stability heuristic scale-free and inf-filtered ✓.

---

## 5. backend/services/walkforward.py

### W1 🔴 OOS (and IS) windows run with cold indicators — no warm-up bars
- **Where:** `walkforward.py:352-355` — `backtest_engine.run(..., start_time=oos_start, end_time=oos_end)`;
  the engine slices the parquet to the window and `strategy.vectorized()` sees ONLY those bars.
- **Why wrong:** any indicator with lookback L (VWMA 30, regime ADX/percentile windows often 100+,
  `SYMBOL_BACKTEST_*` aside) is NaN for the first L bars of EVERY window. With `oos_bars=100` and a
  lookback ≥ 100, an OOS window can produce zero signals at all; with smaller lookbacks each window
  systematically under-trades its start. Stitched OOS equity, WFE, and "OOS positive windows" all
  measure a handicapped strategy, not the strategy. IS windows (500 bars) have the same cold start,
  mildly biasing optimization toward short-lookback params.
- **Fix:** run the engine on `[oos_start - warmup, oos_end]` and discard trades entered before
  `oos_start` (warm-up = max indicator lookback, exposed or inferred); same for IS.
- **Confidence:** high. **Severity:** high (methodology).

### W2 🟠 `profit_factor` metric maps "no losses" to +inf — Optuna selects degenerate params
`:140-151` — a single winning IS trade (PF undefined → `inf`) beats every finite PF. The optimizer is
attracted to ultra-selective configs that traded once. Fix: require a minimum trade count and cap PF
(e.g. score = min(PF, 10) − penalty for n_trades < N).
**Confidence:** high. **Severity:** med-high when the PF metric is used.

### W3 🟠 Stitch rebasing fabricates compounding for fixed-contract futures
`:357-412` — every window's equity and trade P&L are scaled by `carry_equity / starting_capital`.
Crypto (%-of-equity) compounds, so scaling preserves shape ✓; futures strategies earn fixed $/contract
regardless of equity, so multiplying later windows' P&L by the carry multiplier invents growth (or
shrinkage) that the sizing model cannot produce.
Fix: stitch additively (carry + Δdollars) when the spec's instrument is contract-sized.
**Confidence:** high. **Severity:** med (futures WF runs).

### W4 🟠 Stitched trades scale `fees` but not the slippage basis → Costs panel mis-attributes
`:401-406` scales `pnl_dollars`, `fees`, `pnl_pct_equity` by the multiplier but leaves `units`/prices
unscaled; `cost_attribution` (`:493-496`) then computes slippage from unscaled notional and fee share
from scaled fees. Fee% vs slippage% split is wrong by the average carry multiplier.
Fix: scale notional-derived slippage identically (or attribute costs per window pre-scale).
**Confidence:** high. **Severity:** med (Costs panel only).

### W5 🟡 `oos_sharpe or 0.0` coerces missing to 0 and feeds both `pct_windows_positive_oos` and `best_sharpe_oos`
`:461` — windows with no trades (sharpe 0.0 from the engine) are indistinguishable from genuinely flat
windows; with W1 those are common, deflating the positivity stat. Minor once W1 is fixed.

### W6 🟡 Bootstrap CI uses iid resampling on autocorrelated per-bar returns
`:64-74` — understates CI width. Use block bootstrap (e.g. stationary bootstrap, block ≈ √n).
**Severity:** low (advisory band).

### W7 ℹ️ Positions force-closed at every window boundary
Inherent to per-window engine runs; trades cannot span windows — adds boundary churn (fees, lost
carry). Document on the WF page.

### Checked, OK
Purge applied before `is_end` is computed ✓ (`:335-340`) · embargo via `TimeSeriesSplit(gap=)` ✓ ·
`min_bars` guard guarantees first fold's train ≥ is_bars ✓ · monotonic-time assertion ✓ ·
boundary-point de-dup with documented Sharpe rationale ✓ (`:362-367`) · `is_score` non-finite → None ✓ ·
trial records keep only COMPLETE trials ✓ · `pnl_pct_equity` scaling self-consistent with the constant
`starting_capital` definition ✓ (given W3 caveat).

---

## 6. backend/services/strategy_runner.py (replay/live streaming)

### S1 🟠 LiveRunner equity model is incompatible with the backtest engine
- **Where:** `strategy_runner.py:331-356` — `pnl_pct = move% × risk_pct`, added (not compounded) to a
  100-base equity; **no fees, no slippage, no pyramiding, no contract sizing**.
- **Why wrong:** for futures (ES, `contracts × $50/pt`) live equity has no relation to the engine's
  dollar P&L; for crypto it ignores fees and compounding. Replay mode (VectorizedRunner) streams the
  real engine curve — so the same Dashboard chart means different things in live vs replay vs hindsight.
- **Fix:** reuse the engine's accounting in live mode (track units/fees per the same rules), or label the
  live curve "indicative, fee-free".
- **Confidence:** high. **Severity:** med-high for live-mode fidelity.

### S2 🟡 Live drawdown is peak-relative; replay drawdown is starting-capital-relative
`:356` (`(eq-peak)/peak`) vs VectorizedRunner streaming the engine's `drawdown` field
(`dd_dollars/starting`, engine `:395`). Same Dashboard column, two denominators depending on mode.

### Checked, OK
Replay streams engine `value`(=100-base)/drawdown verbatim ✓ · cumulative trades/wins bucketed by exit
ts ✓ · one `equity_update` per closed tranche on multi-exit bars (idempotent chart point) ✓ · live state
persistence ✓.

---

## 7. frontend/src/pages/Dashboard.jsx

### D1 🟠 Streaming "Max DD" shows the CURRENT drawdown, not the max
- **Where:** `Dashboard.jsx:294` — `max_drawdown_pct: p.drawdown` in the `equity_update` handler;
  rendered by `StatsPanel.jsx:63-67` as "Max DD".
- **Why wrong:** the streamed `drawdown` is the instantaneous DD at that bar (engine equity-curve field);
  at every new equity peak the "Max DD" column resets toward 0 during replay/live.
- **Fix:** track the running min client-side:
  `max_drawdown_pct: Math.min(prev[p.strategy_id]?.max_drawdown_pct ?? 0, p.drawdown)`.
- **Confidence:** high. **Severity:** med.

### D2 🟠 StatsPanel renders "∞" Profit Factor for every strategy while streaming
- **Where:** `StatsPanel.jsx:61` — `st.profit_factor != null ? fmtNum(...) : "∞"`. The streamed stats
  object (`Dashboard.jsx:287-296`) never includes `profit_factor`, and `undefined != null` is `false`
  (loose equality), so the missing field renders the "∞" sentinel.
- **Why wrong:** "∞" is the deliberate backend sentinel for "no losing trades"; showing it for "no data"
  is wrong and alarming. Same column is correct in hindsight mode.
- **Fix:** use a distinct dash for missing: `st.profit_factor === undefined ? "—" : st.profit_factor == null ? "∞" : fmtNum(...)`
  (and/or stream PF in the payload).
- **Confidence:** high. **Severity:** med (display).

### D3 🟡 Marker win-recolor heuristic mis-colors pyramided entries
`Dashboard.jsx:302-316` — on each closed trade it recolors the LAST entry arrow matching side, even if
already recolored; with N tranches closing on one bar the same marker is repainted N times and earlier
entries keep the loss color. Track unconsumed entry markers per side (FIFO queue) instead.
**Severity:** low-med (visual).

### D4 🟠 "Apply & Re-run" splices a standalone run into a shared-pool portfolio view
`Dashboard.jsx:474-501` — `reRunOneHindsight` calls `/strategies/run` (full cash pool to itself, no
competition) and overwrites that strategy's overlays/markers/equity/stats inside a view whose other
strategies still show cash-constrained results; it also overwrites the per-strategy cache slice while
`__portfolio__|…` stays stale, so Analytics portfolio view and the dashboard cards disagree until the
next full Run. Fix: re-run the whole portfolio on apply when `active.length >= 2` (or mark the strategy
"stale" until re-run).
**Confidence:** high. **Severity:** med (methodology consistency in the UI).

### D5 🟡 Timeframe-defaults effect only fires on `timeframe` change
`Dashboard.jsx:235-252` (deps `[timeframe]`) — switching SYMBOL does not re-apply
`symbol_defaults[symbol]` until the timeframe also changes. Add `symbol` to the deps (the merge logic
already reads it).
**Severity:** low-med.

### D6 🟡 Cache-hydrate effect keyed on `active.length`, not contents
`Dashboard.jsx:451-468` — replacing strategy A with B in quick succession re-fires only via the
transient length change; an in-place swap at constant length would show stale chart state. Low priority
given the store's add/remove semantics.

### D7 ℹ️ `STARTING` captured from a once-fetched risk config
`Dashboard.jsx:276` — if the user edits starting capital in Risk Settings mid-session, streamed
`total_return_dollars` uses the stale value until reload.

### D8 ℹ️ Adding/removing one strategy while streaming restarts all strategies and wipes their streamed history
`Dashboard.jsx:345-360` (`resetStreamingState` + effect on `active.length`).

### Checked, OK
`inflightRef` stale-response guard covers both parallel fetches and the error path ✓ ·
`dateStrToEpoch` UTC + end-of-day 23:59:59 ✓ · `restoreFromCache` shape ✓ · symbol-disappeared cleanup ✓ ·
hidden-series reset on roster change ✓ · equity % convention consistent with engine/chart ✓ ·
portfolio line uses `portfolioResult.equity` value field ✓.

---

## 8. frontend/src/pages/Analytics.jsx

### A1 🔴 "OOS positive windows" is double-scaled — shows up to 10,000%
- **Where:** `Analytics.jsx:1963-1966` — `value={fmtNum(rob.pct_windows_positive_oos * 100)}%`, but the
  backend already returns a 0–100 percentage (`quant_metrics.py:508-509`:
  `pct_positive = positives/len(valid)*100.0`). 60% renders as "6,000.00%". The `positive=` threshold
  `>= 0.5` is also on the wrong scale (any non-zero % passes).
- **Fix:** drop the `* 100` and compare against `50`.
- **Confidence:** high. **Severity:** high (display of a key robustness stat).

### A2 🟠 Drawdown tab mixes two DD conventions; Overview adds a third presentation
- **Where:** `Analytics.jsx:1302-1303` (KPI "Max DD (peak-rel)" = `advanced.drawdown.max_drawdown_pct`,
  peak-relative) vs the chart at `:1264-1336` plotting `analytics.drawdown_curve` (engine `drawdown` =
  starting-capital-relative) with subtitle `max {dMin}%`; and Overview `:709` "Max Drawdown" =
  `stats.max_drawdown_pct` (starting-capital). Three numbers for "max drawdown" across two tabs.
- **Fix:** one convention per page, or always dual-label like StatsPanel does (`StatsPanel.jsx:63-67`,
  which is the good example).
- **Confidence:** high. **Severity:** med.

### A3 🟡 Annual "Return %" is each year's P&L over ORIGINAL starting capital
`Analytics.jsx:1196` — `yr.pnl / startingCapital` for every year; for a compounding curve, later years'
true return on year-start equity is misrepresented. Label "of starting capital" or divide by year-start
equity.
**Severity:** low-med.

### A4 🟡 "Avg Trades / Month" divides by months-that-had-trades
`:687-689` — `monthly_returns` omits zero-trade months, so sparse strategies overstate trades/month.
Use calendar months between `first_time`/`last_time`.

### A5 🟡 GaussianTab clips the Normal overlay at 1.15× max histogram count
`:1491` — visually flattens the theoretical peak when σ is small; cosmetic but it's the tab whose whole
point is curve-vs-bars comparison. Scale the y-domain to `max(maxCount, gaussPeak)` instead.

### A6 🟡 Local-timezone date labels on UTC data
`EquityVsBenchmarkChart`/`MonthlyMiniChart`/`DrawdownMiniChart` (`:535`, `:601`, `:656`) use
`toLocaleDateString`; `StatsPanel.jsx:3-8` likewise. Everything else (fmtTime/fmtDate, heatmap, trades
table) is UTC. Boundary-day labels can shift a day for non-UTC users.
**Severity:** low (cosmetic).

### A7 ℹ️ Subset view semantics
KPIs/charts full-portfolio while Trades/Skipped/attribution filter — clearly bannered (`:247-253`) ✓;
CSV export in subset mode exports the filtered list (consistent with what's displayed) ✓.

### A8 ℹ️ `RollingMiniChart` `colorNeg` prop is dead; rolling Sharpe is per-trade (labeled) and un-annualized — fine as a relative stability lens.

### Checked, OK
Kelly formula ✓ (`:1717-1720`) · Gaussian overlay count scaling `n·binWidth·pdf` ✓ (`:1478-1482`) ·
T-test tab p-value log positioning and honest iid caveat ✓ · heatmap insights argmax/min ✓ ·
DOW alignment with backend (Mon=0) ✓ · profit-factor "∞" handling correct here (None = no losses) ✓ ·
trades sorting/null placement ✓ · `fmtTinyProb` ✓ · skipped-signals 500-row truncation is labeled ✓ ·
recovery-factor/return-DD null guards ✓ · AITab sequential run-all has no stale-skip bug ✓.

---

## 9. backend/services/market_lab.py

### M1 🟠 Overlapping forward-return windows feed iid t-tests — significance systematically overstated
- **Where:** `_edge_stats` (`market_lab.py:686-717`) consumed by `scan_mean_reversion` (`:749-765`),
  `fade_safety_scan` (`:898-911`), HMM `side_edge` (`:318-331`), `cluster_patterns` (`:1176-1189`),
  `similarity_search` (`:1247-1249`); same issue in regime `forward_returns` win-rates and
  `_after_streaks`.
- **Why wrong:** with `fwd_horizon=10`, setups on adjacent bars share 9 of 10 forward bars; the t-test's
  n counts them as independent. Effective sample size is ~n/horizon; reported p-values (and the
  "significant" badges the module's honesty framing leans on) are too small by roughly that factor.
- **Fix:** sample non-overlapping events (enforce ≥ horizon bars between counted setups), or use
  HAC/Newey-West standard errors (lag ≈ horizon), or block bootstrap. At minimum surface "events may
  overlap; effective n lower" next to the significance badge.
- **Confidence:** high. **Severity:** med-high (the Lab's central honesty claim).

### M2 🟠 `cluster_patterns` `stride` parameter is parsed but never used
`:1144` defines `stride`; the window loop `:1157-1165` steps by 1. Maximal window overlap (compounding
M1) and a dead UI knob. Fix: `range(W-1, n, stride)`.
**Confidence:** high. **Severity:** med.

### M3 🟠 Volatility "forecast skill" predicts a target that overlaps its own input — corr is mechanically ~1
- **Where:** `:465-480` — `realized_next = rv[idx+1]` where `rv` is the TRAILING 20-bar std;
  `rv[idx+1]` shares 19 of 20 returns with `rv[idx]` (the persistence predictor) and with the info set
  of `ewma_vol[idx]`.
- **Why wrong:** `persistence_skill_corr` is essentially the lag-1 autocorrelation of a 20-bar moving
  window — ≈0.99 for any series, predictive or not. Neither number measures forecasting skill; the
  EWMA-vs-persistence comparison is nearly a tie by construction.
- **Fix:** target the non-overlapping FORWARD realized vol over the next `forecast_horizon` bars
  (`std(r[i+1 : i+1+h])`), which also gives the unused `forecast_horizon` knob a job.
- **Confidence:** high. **Severity:** med-high (headline "skill" stat).

### M4 🟡 feature_importance: no purge at the time split
`:1053-1059` — train rows within `h` bars of the 70/30 boundary have targets that extend into the test
period. Drop the last `h` train rows.
**Severity:** low-med.

### M5 🟡 HMM result cache never invalidates on new data
`:249-251`, `:414-416` — key is (symbol, tf, start, end, params); with `end=None` the dataset grows but
the cached labels/stats are returned until 8 other keys evict it or restart.
Fix: include `len(df)`/last bar ts in the key.

### M6 🟡 `scan_batch` silently caps at 20 symbols
`:1114` — `symbols[:20]` with no flag in the response (`n_symbols` counts returned rows only). Add a
`truncated: true` field.

### M7 ℹ️ z-sweep / edge-heatmap cells are raw mean forward returns, not baseline-adjusted "edge"
`:771-801` — overall/by-regime blocks subtract drift; the sweep/heatmap don't, but share the "edge"
label. Inconsistent definition across one response.

### M8 ℹ️ `_after_streaks` buckets are "at least k", every sub-position of a longer streak counted
`:623-651` — docstring says "exactly-or-more"; events overlap heavily (M1 applies). Label in UI as
"after ≥ N consecutive bars".

### M9 ℹ️ Dead code: `_forward_target` (`:1017-1023`) — `kind`/`train_frac` params unused; the docstring
describes behavior it doesn't have.

### Checked, OK
Regime/forward alignment drops the last h bars (no look-ahead) ✓ · EWMA recursion strictly causal ✓ ·
RV/ACF math standard ✓ · big-move threshold from train slice only ✓ · permutation importance on holdout ✓ ·
similarity excludes query-overlapping windows ✓ (but not neighbor-neighbor overlap — M1) ·
`_load_window` MIN_BARS guard ✓ · `_safe` everywhere ✓ · `_downsample` payload cap ✓ ·
regime thresholds descriptive, not optimized (per regime.py docs — regime.py internals not re-audited;
causality taken from CLAUDE.md + module docstring).

---

## 10. Routes & support files

### R1 ℹ️ `/api/strategies/run` wraps the N=1 portfolio runner
`strategy_routes.py:51-81` — the Dashboard's Apply&Re-run and Monte Carlo legacy path inherit P1/P2
(notably: ES with pyramiding ≥ 2 silently loses tranches 2..N even single-strategy).

### R2 🟡 `lastResultStore` sessionStorage writes can silently fail on large portfolios
`lastResultStore.js:21-23` — full portfolio results (per-strategy candles arrays) can exceed the ~5 MB
sessionStorage quota; `save()` swallows the exception. In-tab navigation still works (in-memory state),
but a refresh loses the cache with no signal. Consider stripping `candles` from the cached portfolio
copy or logging the failure.

### Checked, OK
`portfolio_routes` input validation (non-empty array, per-spec symbol/tf validation, int priority) ✓ ·
error mapping 400/404/500 ✓ · `format.js` null/NaN guards in every formatter ✓ ·
`CustomEquityChart` %-of-starting convention, $-tick conversion, downsample-with-last-point, hover
binary search ✓ · `StatsPanel` dual DD labeling (good pattern) ✓.

---

## 11. Cross-cutting findings

### X1 🟠 Three coexisting "max drawdown %" conventions
- `stats.max_drawdown_pct` — dollars below peak ÷ **starting capital** (engine `:533`).
- `stats.max_drawdown_pct_peak` — ÷ running **peak** (engine `:505-513`).
- `analytics.advanced.drawdown.max_drawdown_pct` — peak-relative, recomputed (quant_metrics `:280`).
Rendered: Overview KPI (starting-cap, unlabeled), Drawdown tab KPI (peak, labeled) + Drawdown chart
(starting-cap, same tab), StatsPanel (both, labeled — the model to copy), streamed "Max DD"
(instantaneous, D1). Equity-curve `drawdown` field is starting-cap-relative everywhere (engine `:395`,
portfolio `:383`, walkforward `:389`) — at least that's internally consistent.
**Fix:** one convention for headline KPIs (recommend peak-relative = industry standard), explicit
sub-labels everywhere else.

### X2 🟠 Trade-level stats are pre-entry-fee; equity-level stats are post-fee (E1 ripple)
Every consumer of `pnl_dollars`/`win` (stats, analytics, quant_metrics, correlation daily P&L is
equity-based so OK, Skipped counterfactuals, CSV export) carries the optimistic bias; equity-derived
stats (total return, Sharpe, DD, CAGR) don't. Reconciliations (e.g. PortfolioSummary share table sum vs
total) will be off by total entry fees.

### X3 ℹ️ Equity "value" 100-base convention — consistent end-to-end
Engine → portfolio → walkforward → socket → CustomEquityChart all use `value = equity/starting × 100` ✓.

### X4 ℹ️ Timezone chain — backend fully UTC; two frontend display spots use local time (A6)
Heatmap UTC claim verified against backend `datetime.fromtimestamp(tz=utc)` ✓; Python `weekday()`
(Mon=0) matches the frontend `DOW` array ✓.

---

## 12. Backend files discovered beyond the original scope

| File | Why it mattered |
|---|---|
| `backend/services/portfolio_runner.py` | The ACTUAL engine behind both Dashboard buttons (even N=1 via `/strategies/run`) — source of the two highest-severity sizing findings (P1, P2). |
| `backend/services/strategy_runner.py` | Producer of the `equity_update`/`signal_update` socket payloads the Dashboard streams (S1, S2, D1, D2). |
| `backend/services/portfolio_correlation.py` | Correlation tab producer (C1–C3). |
| `backend/routes/strategy_routes.py`, `portfolio_routes.py` | Confirmed the N=1-wraps-portfolio routing (R1) and input validation. |
| `backend/services/monte_carlo.py` | `_bars_per_year` import only — **not audited**. |
| `backend/services/black_scholes.py` | `fade_safety()` feeds the Fade Safety tab — **internals not audited** (consumed shape verified). |
| `backend/services/strategies/regime.py`, `regime_hmm.py` | Regime label producers — causality taken from module docs/CLAUDE.md, **internals not re-verified**. |
| `frontend/src/services/lastResultStore.js`, `format.js`, `components/StatsPanel.jsx`, `components/CustomEquityChart.jsx` | The Dashboard↔Analytics data bridge and shared renderers (R2, D2, X3). |

**Explicitly not audited:** `exportAnalyticsPdf.js`, `exportTrades.js`, `TradingChart.jsx`,
`market_lab_routes.py` parameter plumbing, `ai_insights`, `monte_carlo.py`, the strategy
implementations themselves, and `CorrelationMatrix.jsx` rendering details (flagged at C1).

---

## 13. Follow-up verification round (CorrelationMatrix.jsx, regime.py, black_scholes.py)

### F1 🟠 C1 CONFIRMED — the Correlation tab's Δ Max DD legend is inverted
- **Where:** `CorrelationMatrix.jsx:212` — *"Δ Max DD > 0 means it deepens the drawdown"* — and the
  signed rendering at `:198-199`.
- **Verified against backend:** `portfolio_correlation._max_dd_pct` returns values ≤ 0 (`:108-115`);
  `delta_maxdd_pct = base_maxdd − dd_rest` (`:245`). A strategy that DEEPENS the portfolio DD makes
  `base_maxdd` more negative than `dd_rest`, so its delta is **negative** — the on-screen legend states
  the opposite. A risk-adding strategy reads as benign and vice versa. (The "Verdict" column is driven
  by `delta_sharpe` only, which is correct — the damage is limited to the Δ Max DD column + legend.)
- **Fix:** flip the backend to `dd_rest − base_maxdd` (and its comment), or change the legend to
  "Δ Max DD < 0 means it deepens the drawdown". Prefer fixing the backend sign so the column and
  comment agree with intuition.
- **Confidence:** high (both sides read). **Severity:** med-high (risk-relevant verdict text inverted).

### F2 🟠 `_smooth_labels` makes regime labels look-ahead-dependent when `smooth_bars > 1`
- **Where:** `strategies/regime.py:129-154` — short runs are merged into the LONGER of the previous or
  **next** run (`runs[ri + 1]`), so a bar's final label depends on bars after it. Invoked at
  `regime.py:197-199` whenever `smooth_bars > 1`.
- **Why wrong:** the module's own header (`:91-94`) and `classify_regimes`' meta note claim full
  causality, and `market_lab.py:218` actively tells the user to *"Increase smooth_bars to merge short
  regime runs"* — doing so silently breaks the no-look-ahead guarantee for the regime ribbon, the
  forward-return/transition stats (`classify_regimes`), and the by-regime edge blocks in
  `scan_mean_reversion` (`market_lab.py:739` passes user params straight through).
- **Scope checked:** the tradeable path is safe **today** — `vwma_reversion.py:216-219` builds
  `_regime_params` without `smooth_bars`, so the default 0 applies. Fragile: any future param plumbing
  makes a live backtest look-ahead-biased with no warning.
- **Fix:** make smoothing causal (merge a short run only into its *previous* neighbor, or delay labels
  by the smoothing window), or compute forward-return stats on the UNSMOOTHED labels and use smoothing
  for display only; at minimum drop the causality claim from the meta note when `smooth_bars > 1`.
- **Confidence:** high. **Severity:** med (Market Lab honesty contract; conditional on the knob).

### F3 🟡 ADX warm-up bars are labeled "ranging/safe"
`regime.py:73-76` — `detect()` fills warm-up NaN ADX with 0, so `adx < threshold` is True: the binary
regime filter declares the first ~`period` bars safe for mean-reversion entries. Same `fillna(0.0)` at
`:163` biases early bars away from the Trending labels. Cosmetic for long histories; visible in short
windows. Fix: leave NaN → False (block entries until warm).
**Confidence:** high. **Severity:** low.

### Checked, OK (this round)
`black_scholes.py` — fully causal (`realized_vol` trailing window, `fade_safety` uses current close +
rolling ref) ✓ · `_d1_d2`/`bs_price`/Greeks/theta sign conventions textbook-correct ✓ · `implied_vol`
bisection with achievable-range guard ✓ · `expected_move ∝ √horizon` with the docstring's honest
discussion of the horizon-matching pitfall ✓ (and `fade_safety_scan` passes `bs_horizon=vwma_length`
accordingly ✓). `CorrelationMatrix.jsx` otherwise ✓ — weights rendered as fractions via `pct0` ✓,
downside toggle disabled when block absent and n_days surfaced ✓, matrix cells never null (backend
emits 0.0 for degenerate columns) ✓, heatmap hint honestly says "daily dollar P&L" ✓, methodology
caveat correctly distinguishes intrinsic curves from shared-cash contention ✓.

---

## 14. Implemented fixes (2026-06-11)

All changes smoke-tested; every test below passed on cached BTCUSDT (15m/1h) and ES 1h (databento).

| Finding | Fix | Where |
|---|---|---|
| **P1** | Entry sizing/gating equity now `cash + unrealized + locked_notional` (the Phase-D identity) | `portfolio_runner.py` Phase B |
| **P2** | Futures entries deduct **fee only** from cash (margin model); close settles pnl only; `locked_notional()` returns 0 for contract-sized streams | `portfolio_runner.py` `_try_open`/`_close_tranche`/`locked_notional` |
| **P9** *(new — found during fixing)* | `last_close` was advanced to the CURRENT bar's close before Phase-B sizing — entries were sized with the bar's close (info not available at the open) and N=1 ≠ engine under pyramiding. Now advanced in a new Phase B½ after entries | `portfolio_runner.py` walk loop |
| **P4** | Skip log `required_notional` now includes the open fee (matches the gate) | `portfolio_runner.py` |
| **E1/X2** | Per-trade `pnl_dollars` (and `win`) now net of BOTH fees; equity accounting unchanged. `Σ trades == total_return_dollars` exactly | `backtest_engine.py` ×3 sites, `portfolio_runner._close_tranche` |
| **E3/P5** | Final equity point refreshed after force-closes on both engine and portfolio — curve end == `stats.final_equity` exactly | `backtest_engine.py`, `portfolio_runner.py` |
| **E6** | Empty-result heatmaps no longer alias one row list | both |
| **W1** | Engine gained `trade_start_time` (warm-up masking); WF feeds each IS/OOS window `warmup_bars` (default 200) of history, masks pre-window entries, drops warm-up equity points when stitching, and recomputes per-window stats on the in-window slice (`_window_stats`) so the flat warm-up prefix doesn't dilute Sharpe | `backtest_engine.py`, `walkforward.py` |
| **W2** | Profit-factor IS score capped at 10 (was `+inf` for any no-loss window) | `walkforward.py` |
| **Q1** | Deflated Sharpe now includes the Bailey–LdP mean-trial term, and is only computed when the IS metric is `sharpe` (`wf_trials.metric` added) | `quant_metrics.py`, `walkforward.py` |
| **Q2** | WFE only computed when the IS metric is `sharpe` | `quant_metrics.py` |
| **Q3** | Geometric mean per-trade return now derived from the equity curve (`(final/start)^(1/n) − 1`), not compounded `pnl_pct_equity` | `quant_metrics.py` |
| **F1** | `delta_maxdd_pct` sign flipped to `dd_rest − base` — ">0 deepens" now true, matching the UI legend | `portfolio_correlation.py` |
| **M2** | `cluster_patterns` honors `stride` | `market_lab.py` |
| **M3** | Vol forecast skill now targets the NON-overlapping forward vol over `forecast_horizon` bars (skill dropped from a mechanical ~0.99 to a meaningful ~0.46 on BTC 1h) | `market_lab.py` |
| **F2** | Regime forward-return/transition stats and the MR scan's by-regime stats computed on UNSMOOTHED (causal) labels; smoothing is display-only | `market_lab.py` |
| **A1** | "OOS positive windows" no longer ×100-double-scaled; threshold 50 | `Analytics.jsx` |
| **A2/E2** | Overview "Max Drawdown" sub-labeled "% of starting capital" + shows peak-rel; Drawdown chart header names its convention | `Analytics.jsx` |
| **D1** | Streamed "Max DD" tracks the running minimum, not the instantaneous drawdown | `Dashboard.jsx` |
| **D2** | StatsPanel PF distinguishes `undefined` (missing → "—") from `null` (no losses → "∞") | `StatsPanel.jsx` |

**Verification (all passing):**
- `Σ trade pnl == total_return_dollars` exactly (E1), engine, 1 821 and 4 057-trade runs.
- Engine vs portfolio N=1: **identical trade sets and final equity to the cent**, default AND `pyramiding=3` (P1+P9+E3/P5).
- ES futures N=1 (lunar, 1h): portfolio == engine exactly, pyramiding 1 and 2, zero skips (P2).
- Mixed ES+BTC portfolio: BTC takes **all 101** of its solo trades alongside ES's 18 — no entry starvation (P2).
- `trade_start_time`: no entries before window start, equity flat through warm-up, warm window finds 6 trades where the cold window found 5 (W1).
- DSR with mean term: 0.319 on a synthetic where the old formula said ~0.68; PF/return metrics → `None` (Q1/Q2).
- Correlation: synthetic crash-correlated strategy gets `delta_maxdd_pct = +23.3` (deepener > 0) (F1).
- `cluster_patterns` stride=5 yields ~n/5 windows (M2); regimes/MR scan run clean with `smooth_bars=8` (F2).
- Modified JSX parses clean (esbuild).

**Still open (deferred, by design this round):** M1 (overlap-aware t-tests — needs HAC/block-bootstrap design), S1/S2 (live-runner accounting parity), D4 (Apply&Re-run standalone-vs-pool splice), W3/W4 (futures stitch compounding + cost-attribution scaling), P3 (counterfactual exits ignore stops), E4/E5 (close-triggered ATR stop, exact-fill timestamps), Q4 (ruin model), C2/C3 (co-crash threshold, downside-corr min-n), M4–M8, A3–A6, D5–D8, R2, F3.

---

## 15. Suggested priority order (user to re-rank)

1. **P1 + P2** — portfolio sizing equity & futures cash model (wrong trades generated).
2. **W1** — WF cold-start windows (walk-forward results not measuring the strategy).
3. **E1 / X2** — entry fee missing from per-trade P&L (every trade stat biased).
4. **Q1** — deflated Sharpe formula (verified ~10× overstatement of the headline robustness stat).
5. **A1** — OOS-positive-windows ×100 display bug (one-line fix).
6. **X1 / E2 / A2** — drawdown convention unification.
7. **F1** — inverted Δ Max DD legend on the Correlation tab (sign flip + legend, small fix).
8. **M1 / M3 / M2 / F2** — Market Lab significance overlap, vol-skill target, dead stride, smooth_bars look-ahead.
9. **D1 / D2 / D4 / S1** — streaming stats correctness and live-mode fidelity.
10. **W2 / W3 / W4 / Q2 / Q3** — WF metric/stitching refinements.
11. Remainder (🟡/ℹ️) as cleanup.
