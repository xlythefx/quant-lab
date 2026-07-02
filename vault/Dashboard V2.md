---
tags: [page]
type: page
---

# Dashboard V2

`frontend/src/pages/DashboardV2.jsx` — the main **multi-strategy, shared-cash portfolio** dashboard. Runs via [[Portfolio Runner]] (`/api/backtest/portfolio`). Tabs: Performance (KPIs + equity + underwater + monthly heatmap), Chart, Trades, Config.

- **Chart** uses `PriceChartV2` → wraps `TradingChart` with the strategy's `regime_segments`, so the [[Regime Detection]] ribbon + 5-MOOD/ADX/HMM lens shows there.
- **Live run progress**: a strip dims stale results and shows the real backend stage (strategy → HMM refit % → simulate → stats) + elapsed, fed by `backtest_progress` socket events from [[Portfolio Runner]].
- **Analytics →** deep-link opens [[Analytics]] on the *same* backtest (via `lastResultStore`).

Deliberately the *fast loop*; depth lives in [[Analytics]]. Settings panel = `components/StrategyEditor.jsx` (the regime method picker + grey-out lives here).

Related: [[Dashboard V1]] · [[Analytics]] · [[VWMA Reversion]]
