---
tags: [concept]
type: overview
---

# Regime Detection

"Regime" = what kind of market you're in (trending / ranging / calm / volatile). There is **no ground truth** — it's a judgment call, which is why it's tuned/validated, not assumed. A regime is used as an entry **filter**, never a signal → see [[Filters and Sessions]].

Three systems exist on the chart lens (5-MOOD / ADX / HMM); keep them straight:

- **[[5-Mood Regime]]** — deterministic rulebook, fixed 5 labels (`services/strategies/regime.py`).
- **[[ADX Regime]]** — binary "ranging vs trending" on/off.
- **[[HMM Regime]]** — data-driven, self-learning moods (`services/strategies/regime_hmm.py`).

Only [[5-Mood Regime]]/[[ADX Regime]] gate trades today via [[VWMA Reversion]]; [[HMM Regime]] is also wired as a gate now (backtest-only) and used as a research lens in [[Market Lab]].

> Key truth: **no filter is universal.** Regime helps some strategy + asset combos and hurts others. It must *earn its place* out-of-sample → [[Validation and Overfitting]].

Related: [[Market Lab]] · [[VWMA Reversion]]
