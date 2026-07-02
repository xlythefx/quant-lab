---
tags: [page]
type: page
---

# Analytics

`frontend/src/pages/Analytics.jsx` — the **deep-dive** surface, wired to the dashboards' current backtest via the "Analytics →" deep-link (`lastResultStore`, key `${id|__portfolio__}|symbol|tf`). ~11 tabs:

Overview · Sessions · Heatmap (hour×day) · Monthly · Drawdown · Gaussian Fit · **T-Test** (significance, p-value, **prob-of-ruin**) · **Trade Quality** (expectancy, SQN, Kelly, top-10 luck flags) · **Risk & Robustness** (Sortino, Calmar, Omega, Ulcer, VaR/CVaR, skew/kurtosis, deflated Sharpe) · Trades (+ MAE/MFE/fees, CSV export) · **Correlation** + **Skipped Signals** (portfolio-only).

Numbers come from `services/quant_metrics.py` via [[Backtest Engine]] / [[Portfolio Runner]]. Headline Max Drawdown is peak-to-trough (matches [[Dashboard V2]]). These honesty metrics (t-test, prob-of-ruin, luck flags) are the practical tools for [[Validation and Overfitting]].

Related: [[Dashboard V2]] · [[Report Import]]
