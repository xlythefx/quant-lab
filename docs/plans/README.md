# Plans (docs/plans)

Forward-looking design + strategy notes for QuantLab, written in plain language.
Different from the top-level `plans/` folder (that one tracks the **Live Terminal**
build, phases 01–10). This folder is for *research/roadmap* thinking.

- [validation-checklist.md](validation-checklist.md) — the **gauntlet**: the eight gates a
  strategy must clear before you believe it (plateau, costs, walk-forward, Monte Carlo, locked
  holdout, cross-strategy honesty, significance/baseline, sub-period consistency), each with the
  "why" and where the number lives in the app — plus the spec for a WF "Verdict" sub-page.
- [portfolio-plan.md](portfolio-plan.md) — how the portfolio engine works **today**,
  and the plan to turn its already-computed "suggested weights" into real sizing
  (volatility targeting → risk parity). This is Level 6–7 on the algo ladder.
- [level-8-adaptive-future.md](level-8-adaptive-future.md) — the "someday, maybe"
  bucket: regime-conditional allocation, ML signal blending, dynamic adaptation.
  Deliberately parked. Read the "why not now" section first.

## The ladder these sit on

Levels of a trading algo, cheapest-first, with the value curve bending down as you climb:

0. A rule (a signal) — a hypothesis, worth ~nothing alone
1. A backtest — first evidence
2. An **honest** backtest (costs + no look-ahead) — toy vs. real  ← *done*
3. Risk & exits (signal → strategy) — makes an edge survivable  ← *done*
4. Robustness (walk-forward, Monte Carlo, stability, deflated Sharpe) — kills fake
   edges; the highest-value filter  ← *done, unusually strong*
5. Execution realism (live vs. backtest, latency, funding, tracking error) ← *current frontier*
6. Sizing optimization (vol targeting, fractional Kelly) ← *this folder, Phase 1*
7. Portfolio (combine uncorrelated edges, allocate) ← *this folder, engine half-built*
8. Adaptive / meta (regime allocation, ML, factor models) ← *parked; level-8 doc*

The knee of the curve is right after Level 4. Everything above is polishing a
*confirmed* edge — real, but diminishing, and rising in fragility.
