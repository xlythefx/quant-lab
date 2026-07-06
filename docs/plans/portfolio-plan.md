# Portfolio plan — how it works today, and where it goes next

Plain-language guide to QuantLab's portfolio engine. Two halves: **(A) what the
code already does** (so you understand your own tool), and **(B) the plan** to
turn the optimizer it *already computes* into sizing you actually trade.

Ladder position: this is **Level 6–7** (sizing optimization + portfolio
allocation). It only pays off once you have **two or more separately-validated,
genuinely-different edges** — combining two versions of the same bet buys nothing.

---

## Part A — How your portfolio works today

### The core idea: one shared wallet

`backend/services/portfolio_runner.py` walks N strategies through **one shared
cash pool**, bar by bar. Think of it as several traders sharing a single bank
account:

- Each strategy keeps its own positions and its own `risk_pct` / `pyramiding`.
- **Sizing reads the *aggregate* equity.** Strategy A's `risk_pct = 2%` means 2%
  of the *whole portfolio's* current equity, not 2% of some slice. So as the pool
  grows or shrinks, everyone's bet size moves with it.
- **Cash is a real constraint.** Opening a position deducts `notional + fee` from
  the shared cash. Closing returns `notional + pnl − fee`. If there isn't enough
  cash, the signal is **skipped** (no partial fills) — but the runner records a
  *counterfactual* P&L (what that trade *would* have made) so you can see the cost
  of being cash-constrained. See `_counterfactual_pnl`.
- **Conflicts on the same bar** are resolved by a user-set `priority` number
  (lower wins). So if two strategies both want the last of the cash on the same
  bar, priority decides.
- **Symbol overlap is allowed.** Two strategies can both trade BTCUSDT with
  independent positions; cash is the only thing they share.
- **Futures are margin-based, not cash-based.** Index futures (ES/NQ, etc.) only
  deduct the *fee* from cash on entry (not the full notional), because they use
  margin. The equity identity `cash + locked + unrealized` still nets out exactly.
- **N = 1 is identical to a single-strategy backtest.** The runner re-uses
  `backtest_engine`'s trade/stats/analytics builders, so one strategy through the
  portfolio == the same strategy through the Dashboard (modulo response shape).
  This is the parity guarantee — keep it.

The output has the same shape as a normal backtest (equity curve, trades, stats,
analytics) **plus** a `per_strategy` block: each strategy's own equity curve, so
you can see who contributed what.

### The analysis layer: are these real diversifiers?

`backend/services/portfolio_correlation.py` answers the question the aggregate
stats can't: *are these strategies different bets, or the same bet three times?*
It reads each strategy's daily dollar-P&L and computes:

- **Correlation matrix** — pairwise, on daily P&L. High correlation = redundant.
- **Downside correlation** — correlation *only on the portfolio's worst-decile
  days*. This is the one that matters: things that look uncorrelated in calm
  markets often crash together. (Needs 20+ days / 10+ tail days, else reported as
  null — small samples here are noise.)
- **Diversification ratio** — sum of each strategy's stand-alone volatility
  divided by the volatility of the combined book. Higher = more genuine
  diversification.
- **Effective N** — how many *truly independent* bets you really have (via a
  Herfindahl concentration measure and a correlation "participation ratio"). You
  might run 4 strategies but have an effective N of 1.8 if they overlap.
- **Drawdown overlap** — on the portfolio's deep-drawdown days, how often are 2+
  strategies deep at the same time? High = they sink together = false safety.

### The hidden gem: you already compute optimizer weights

`_suggested_weights` (portfolio_correlation.py) **already computes** three classic
allocations from the daily-P&L covariance:

- **min_variance** — weights that minimize combined volatility.
- **equal_risk_contribution (ERC / "risk parity")** — each strategy contributes
  the *same amount of risk* to the book (not the same dollars).
- **max_sharpe** — the mean-variance "optimal" weights.

**But these are advisory only.** Right now the runner sizes by your hand-set
`risk_pct` + `priority`; the suggested weights are shown for information and never
touched by the simulation. That's the gap Part B closes.

---

## Part B — The plan

Guiding principle: **robust and simple beats optimal and fragile.** We climb the
sizing ladder in the order that adds the most safety per unit of complexity, and
we stop before the fragile end (raw max-Sharpe / Markowitz).

### Phase 1 — Volatility targeting (highest value, lowest fragility)

*Goal:* keep each strategy's **risk** roughly constant instead of its dollar bet.
Bet less when the market is wild, more when it's calm.

*Why first:* it's ~80% of what Kelly and risk parity are reaching for, it's robust
(no fragile matrix inversion), and **the engine already supports it.** Both
`backtest_engine` and `portfolio_runner` read an optional per-bar `risk_scale`
column (`has_risk_scale`) that multiplies sizing at entry.

*How:* a strategy emits `risk_scale = target_vol / recent_realized_vol` (clamped
to a sane band, e.g. 0.25×–2×). No new engine plumbing — it's one derived column
in the strategy's `vectorized()`.

*Validate it like any change:* it must survive the **same** walk-forward +
Monte-Carlo gauntlet. Vol targeting usually improves risk-adjusted return (Sharpe,
Calmar) more than raw return — judge it on those, not on total %.

### Phase 2 — Act on the suggested weights (risk parity)

*Goal:* let the already-computed **equal_risk_contribution** weights actually
drive capital allocation across strategies, instead of hand-set `risk_pct`.

*Why ERC and not max_sharpe:* max-Sharpe / Markowitz weights are notoriously
fragile — they amplify estimation error and hand you concentrated, unstable
allocations that look great in-sample and fall apart live. ERC is the robust
middle: it uses the correlation structure but doesn't bet the farm on noisy
return estimates.

*How (proposed, incremental):*
1. Surface the three weight sets in the portfolio UI (they're computed already) —
   read-only first, so you can eyeball them vs. your manual weights.
2. Add an **allocation mode** toggle: `manual` (today) | `risk_parity` (ERC).
   In ERC mode, translate each strategy's target weight into its effective
   `risk_pct` for the run.
3. **Compute weights on a rolling/expanding window, never full-sample.** Using the
   whole history's covariance to weight the whole history is look-ahead — the same
   sin the HMM experiment carries. Re-estimate weights on data *before* each
   allocation period (this mirrors walk-forward's discipline).

*Guardrails:*
- Weight caps (e.g. no single strategy > 40%) so the optimizer can't go all-in.
- Minimum history before trusting weights (fall back to equal-weight below ~20
  overlapping P&L days — the correlation module already treats small samples as
  noise; sizing should too).
- Turnover damping so weights don't thrash bar to bar.

### Phase 3 — Optional: fractional-Kelly ceiling + min-variance mode

*Goal:* a "don't overbet" guardrail and a low-vol allocation option.

- **Fractional Kelly as a ceiling, not a target.** Compute each strategy's Kelly
  fraction from its validated edge; use it only to *flag* when your `risk_pct`
  exceeds, say, half-Kelly. Kelly's real gift is telling you where the cliff is —
  overbetting is catastrophic and irreversible. Never size *up* to full Kelly.
- **min_variance mode** for a deliberately defensive book. Already computed; same
  wiring as Phase 2's ERC mode.

### What we deliberately do NOT build

- **Raw max-Sharpe / full Markowitz as the live sizer.** Too fragile for a
  self-use book. It stays advisory/for-comparison only.
- **Market-impact / liquidity-aware sizing.** Irrelevant at your capital.
- **Cross-strategy leverage stacking.** The shared-cash model is the safety rail;
  don't defeat it.

### How you'll know it worked

A portfolio change is only "good" if the **combined book** clears the same bar as
a single strategy — survives walk-forward, stays profitable under Monte Carlo,
stable to small weight perturbations — **and** the correlation block shows genuine
diversification (effective N meaningfully > 1, low downside correlation). A
portfolio of correlated strategies that share drawdowns is one bet wearing a
disguise, no matter how the weights are set.

---

## One-glance summary

- **Today:** shared-cash simulation + rich correlation analysis + optimizer weights
  *computed but not applied*. You're further up Level 7 than you thought.
- **Next:** Phase 1 volatility targeting (engine already supports it, do this first)
  → Phase 2 wire ERC/risk-parity weights with rolling estimation + guardrails →
  Phase 3 Kelly ceiling / min-variance as options.
- **Never:** raw max-Sharpe as the live sizer.
- **Prerequisite for any of it:** two or more separately-validated, genuinely
  uncorrelated edges. Until then, portfolio work optimizes nothing.
