---
tags: [concept]
type: idea
---

# Parameter Sensitivity

How much does the strategy's result *change* when you nudge a knob? A good strategy is **not fragile** — small param changes shouldn't swing it wildly. There are **two different flavors** (people usually mean the first):

## 1. Plateau — "does a *range* of values all work?"
Vary one param across its values and look at performance:
- **Flat, good region (plateau)** → robust. Many values work, so you didn't have to nail one exact number.
- **One lone good value in a sea of bad (spike)** → you probably **overfit** to that number.
- **No effect at all** → the param never binds (a filter that isn't doing anything, an inert sizing knob).

Lives in: [[Grid Search]] → the **Plateau panel** (`GridPlateauPanel.jsx`). Verdicts: ✓ plateau / ⚠ sensitive / ∅ no-effect. **In-sample.**

## 2. Drift / stability — "does the *best* value stay put over time?"
Re-optimize each period and watch the chosen best value:
- **Stays similar each window** → stable, trustworthy.
- **Jumps around every period** → fragile; there isn't really a stable best value.

Lives in: [[Walk-Forward]] → the parameter **drift chart** + a **stability score**, plus the seed **robust/mixed/fragile** verdict. **Out-of-sample-ish.**

## The gap (proposed build — not done yet)
**Out-of-sample plateau.** Compute the plateau *shape* (performance across each value), but score every value with **walk-forward out-of-sample** instead of one full-history backtest. You'd get the familiar flat-vs-spike picture, but judged on data the model never saw — the honest merge of the two tools above. Today the plateau is in-sample ([[Grid Search]]) and the OOS honesty is only a score/drift ([[Walk-Forward]]); nothing draws "plateau on unseen data." Status: **idea, on the backlog.**

Related: [[Validation and Overfitting]] · [[Filters and Sessions]]
