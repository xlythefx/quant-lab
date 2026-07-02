---
tags: [page]
type: page
---

# Report Import

`frontend/src/pages/ReportImport.jsx` + `services/tradestation_report.py` (route `/api/report/tradestation`). Drop a **TradeStation Performance Report** CSV → a live dashboard: stat cards, equity curve, underwater drawdown, monthly heatmap, P&L histogram, trades table, and a **reconciliation** of TradeStation's printed numbers vs the same metrics recomputed from the trade list.

Session-only (nothing stored). The parser is section-aware (the export is several stacked tables) and handles `($...)` negatives, two date formats, and the merged entry/exit row pairs. Recompute matched TradeStation to the penny on the sample (DONK ID CL).

Related: [[Analytics]]
