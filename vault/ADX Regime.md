---
tags: [method]
type: method
---

# ADX Regime

The simplest regime filter: a **binary** ADX gate. `RegimeDetector(period, threshold).detect(df)` → bool Series (True = ranging/safe for mean reversion, ADX below threshold; False = trending). `last_adx(df)` for live.

In [[VWMA Reversion]]: `regime_method = "adx"` — block entries when ADX says "trending." One yes/no, fast, no labels. Chart lens colors: Ranging (green) vs Trending (red).

Contrast with [[5-Mood Regime]] (5 labels) and [[HMM Regime]] (learned moods).

Related: [[Regime Detection]]
