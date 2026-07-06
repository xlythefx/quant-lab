# Validating a strategy — the gauntlet

A step-by-step guide for judging whether a strategy is **real** or just **lucky /
overfit**. Written for a new quant researcher: each gate says *what* to check,
*why* it matters, and *where the number already lives in QuantLab*.

The mental frame: everything here is one question asked eight ways — **"Did I find
a real edge, or did I fool myself?"** Markets are mostly noise, and it is
astonishingly easy to find a backtest that looks brilliant purely by chance. These
gates exist to catch *you*, not the market.

> **Jargon, once:** *In-sample (IS)* = data you optimized on. *Out-of-sample (OOS)*
> = data the strategy was tuned *away* from. *Overfitting* = fitting noise instead
> of signal, so it looks great on the past and fails on the future.

---

## The eight gates

### 1. Parameter plateau, not a spike
**Check:** when you nudge each parameter up and down a little, does performance stay
good? A robust edge sits on a **flat plateau** — its neighbors are all decent. A
fragile one sits on a lone **spike** — move the knob by one and it collapses.
**Why:** a spike means you found the one setting that happened to fit past noise. A
plateau means the edge is structural and doesn't care about the exact number.
**In the app:** `parameter_stability_score` in the walk-forward robustness block
(closer to 1 = flatter/robust). Also just eyeball the Grid Search surface — you
want a broad green region, not one bright pixel.
**Rule:** use the best params, but only trust them if the *neighbors* are stable.

### 2. Pessimistic costs
**Check:** re-run with fees and slippage cranked up (2–5×). Does the edge survive?
**Why:** live trading always costs more than backtest assumes. An edge that only
exists at 1bp slippage is not an edge — it's a rounding error you can't capture.
**In the app:** Cost Sweep page + `cost_attribution` (shows how much PnL costs ate).
**Rule:** if it dies under realistic-pessimistic costs, stop here.

### 3. Walk-forward holds out-of-sample
**Check:** roll IS→OOS windows across history, optimize on each IS, test on the
*next* OOS. Is it profitable on the OOS windows it never saw?
**Why:** this is the core anti-overfit test. Anything looks good in-sample; only OOS
counts.
**In the app:** the Walk-Forward page. Key numbers: `pct_windows_positive_oos` (what
fraction of OOS windows made money) and **walk-forward efficiency / WFE** (OOS
performance ÷ IS performance — how much of the in-sample promise actually showed up
live; near or above 1 is good, near 0 means the edge evaporates out-of-sample).

### 4. Monte Carlo still profitable
**Check:** shuffle the order of trades, and bootstrap synthetic price paths, then
re-measure. Is the strategy still profitable across most simulated paths?
**Why:** your single equity curve is *one* draw of luck. Monte Carlo asks "how much
of this was the *order* things happened in?" A robust edge survives reshuffling; a
fragile one was carried by a couple of lucky sequences.
**In the app:** Monte Carlo page (trade bootstrap, block bootstrap, synthetic
paths). Look at `prob_profit` and the p05 (worst-5%) equity envelope — you care
about the bad paths, not the median.

### 5. Locked holdout — the final, once-only test
**Check:** *before* you start researching, carve off the most recent ~6–12 months
and **never look at it.** Do all your tuning, walk-forward, everything, on the data
*before* that line. At the very end, run the finished strategy on the holdout
**exactly once.**
**Why:** walk-forward reuses all your data across its windows, and by the time
you've tuned the WF settings themselves you've effectively "seen" everything. The
locked holdout is the only slice your research process never touched — so it's the
strongest, most honest evidence you can get.
**In the app (discipline, not a feature yet):** pick a holdout start date; keep every
research run's end date *before* it; at the end, run one backtest on
`[holdout_start, holdout_end]`. If it holds there, believe it. If it falls apart,
your earlier "success" was overfit — and you just saved real money.
**Rule:** exactly once. The moment you tweak-and-rerun on the holdout, it stops being
a holdout and becomes just more training data.

### 6. Cross-strategy honesty (the biggest hidden trap)
**Check:** count how many *distinct* things you've tried — strategies × symbols ×
timeframes. Be more skeptical the more you tested.
**Why:** deflated Sharpe (below) corrects for the many parameter trials *within one
walk-forward run*. It has **no idea** you also tried 5 other strategies on 4 symbols
across 4 timeframes. Test ~80 combinations and keep the best, and something will
look fantastic **purely by luck** — that's guaranteed, not bad luck. This is the
error that fools the most people because each individual backtest looks legit.
**The fix is discipline, not a metric:** keep a simple tally of every idea you've
seriously tested. If you've tried 40 things, your "winner" needs to clear the bar by
a wide margin — one that a lucky-best-of-40 couldn't fake — and ideally survive the
locked holdout (gate 5), which luck can't cross.

### 7. Enough trades + beats a baseline
**Check (two parts):** (a) are there *enough* trades for the stats to mean anything?
(b) does it beat simply **buying and holding**, and is its average trade
*statistically* different from zero?
**Why:** a gorgeous Sharpe on 15 trades is noise wearing a suit — tiny samples
produce extreme numbers by chance. And if a strategy underperforms buy-and-hold, all
its complexity bought you nothing.
**In the app:** trade count in stats; `t_pvalue` / `significance` (the t-test on mean
trade return — "significant" = unlikely to be zero by chance); `bh_return_pct` per
window (buy-and-hold benchmark). Rough floor: be very wary below ~30 trades, and
prefer 100+.

### 8. Consistency across sub-periods
**Check:** is it green in 2022 *and* 2023 *and* 2024 — or did one monster year drag
a losing record into the black?
**Why:** an edge that only worked in one regime/year is a bet that that year repeats.
Steady-but-modest beats spiky-but-huge for anything you'll actually trade.
**In the app:** per-window OOS breakdown (each window's return/Sharpe) and the
monthly-returns view. A strategy positive in aggregate but red in 3 of 5 windows is
**fragile** — flag it, don't trust it.

---

## Turning it into a verdict

No single gate is a yes/no. Read them together:

- **Real (trade-worthy candidate):** plateau stable, survives costs, OOS-positive
  across *most* windows, Monte-Carlo profitable on the bad paths too, statistically
  significant on enough trades, beats buy-and-hold, consistent across sub-periods —
  and then confirmed on the locked holdout.
- **Fragile:** works, but leans on one period / a few trades / a param spike. Not
  dead, but size it small and keep watching.
- **Overfit / luck:** great in-sample, falls apart OOS or on the holdout, or was one
  of many things you tried. Kill it without regret — killing fake edges early is the
  whole point.

---

## Proposed feature — the Walk-Forward "Verdict" sub-page

*Status: proposed, not built. Design sketch for us to build together.*

**Problem:** the gauntlet's answers are scattered across raw metrics. A new
researcher shouldn't have to remember that `parameter_stability_score = 0.82` is
"good" — the app should *translate the numbers into plain verdicts.*

**Idea:** a new tab/panel on the Walk-Forward results page. One **stat card per
gate**, each showing:
- a plain-English claim ("Holds up out-of-sample", "Enough trades to trust"),
- a traffic light — PASS / WARN / FAIL,
- the actual number behind it,
- a one-line "what this means" in plain words.

Card set maps 1:1 to the gates that WF already has data for:
1. **Parameter plateau** ← `parameter_stability_score`
2. **Out-of-sample** ← `pct_windows_positive_oos` + WFE
3. **Sub-period consistency** ← a little per-window traffic-light strip (green/red
   per window) so you *see* the consistency at a glance
4. **Significance & sample size** ← `t_pvalue` / `significance` + trade count
5. **Beats baseline** ← strategy vs `bh_return_pct` per window
6. **Many-trials penalty** ← `deflated_sharpe_probability`
7. **Not luck-dependent** ← `top10_winners_share` / `luck_dependent_wins` flags

Plus a headline **overall verdict** at the top ("Looks Real / Fragile / Overfit")
synthesized from the lights, with the two or three reasons that drove it.

Gates the WF run can't answer on its own — **locked holdout** (gate 5) and
**cross-strategy honesty** (gate 6) — appear as greyed reminder cards ("Run the
holdout test once", "You've logged N strategies tested") rather than auto-passes, so
they're never silently skipped.

**How we'd build it (when you're ready):** the numbers already come back in the WF
result's `analytics.advanced.robustness` + per-window blocks, so this is mostly a
*presentation* layer — a new component that reads the existing result and renders
cards. No new backend math for gates 1–7. We'd do it together, card by card, so you
learn what each metric means as we wire it.
