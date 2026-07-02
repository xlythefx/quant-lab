---
tags: [page]
type: page
---

# Market Lab

`frontend/src/pages/MarketLab.jsx` + `services/market_lab.py`. **Read-only**, causal, deliberately "honest" market-structure analyses (in-sample edges flagged, t-tests vs baselines, no look-ahead). Synchronous POSTs over one DataFrame.

Tabs: Regime, **HMM Regime**, Volatility, Statistics, Alpha Scanner, Fade Safety, Feature Importance, Pattern Finder, Similarity, Model Bench.

The **HMM Regime** tab is the research lens for [[HMM Regime]] — tune `n_states` / `ranging_ratio` / `undecided_below` / windows, raise the bar cap to 60k, and read the state signatures, forward returns, transitions. Use it to *form* hypotheses, then confirm with [[Walk-Forward]] → [[Validation and Overfitting]].

Related: [[Regime Detection]] · [[Data]]
