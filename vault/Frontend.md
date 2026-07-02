---
tags: [area]
type: overview
---

# Frontend

React + Vite + Tailwind, hash-routed in `frontend/src/App.jsx`. Pages in `frontend/src/pages/`, components in `frontend/src/components/`. Charts use `lightweight-charts` plus hand-rolled SVG primitives.

## Pages

- [[Dashboard V2]] — the main multi-strategy dashboard (`pages/DashboardV2.jsx`)
- [[Dashboard V1]] — legacy single dashboard (`pages/Dashboard.jsx`)
- [[Analytics]] — deep-dive metrics (`pages/Analytics.jsx`)
- [[Market Lab]] — read-only analyses (`pages/MarketLab.jsx`)
- [[Report Import]] — TradeStation CSV → dashboard (`pages/ReportImport.jsx`)
- [[Walk-Forward]], [[Grid Search]], [[Monte Carlo]], [[Cost Sweep]]

## Conventions

- Number/date/percent formatting via `services/format.js` (`fmtUsd`, `fmtPct`, `fmtDateLong`) — never raw `.toFixed`.
- Settings panel: `components/StrategyEditor.jsx` (renders `PARAM_SCHEMA`; supports number/bool/select/sessions/sides/regimes).

Related: [[Architecture]] · [[Backend]]
