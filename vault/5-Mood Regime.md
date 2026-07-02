---
tags: [method]
type: method
---

# 5-Mood Regime

Deterministic, rule-based regime detection — `backend/services/strategies/regime.py`. Always the same 5 named labels (a fixed rulebook, no learning):

**Trending Up · Trending Down · High-Volatility · Quiet · Choppy-Range**

`_regime_labels(df, params)` derives them causally from ADX + a rolling-linreg slope + a trailing volatility percentile (every feature at bar *i* uses only bars ≤ *i*). Shared by [[VWMA Reversion]] entry gating (`regime_method = "five"`, `allowed_regimes`) and [[Market Lab]]'s regime ribbon.

Contrast with the self-learning [[HMM Regime]] and the binary [[ADX Regime]]. Because it's fast rule-based math, it's the best candidate for *auto-tuning to match your eye* (paint regions → fit the rule thresholds).

Related: [[Regime Detection]] · [[Validation and Overfitting]]
