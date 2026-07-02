---
tags: [validation]
type: tool
---

# Monte Carlo

`pages/MonteCarlo.jsx`. Stress-tests a result by resampling/perturbing (trade order, synthetic OHLC paths) to show the **distribution** of outcomes — a guard against the "one lucky history" problem from [[Validation and Overfitting]]. You only ever observed one path; this estimates the others that could have happened.

Related: [[Walk-Forward]] · [[Grid Search]]
