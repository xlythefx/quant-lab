# 07 — Analytics (live) + trade journal

**Status:** ✅ Done (Jul 02, 2026)
**Created:** Jul 01, 2026
**Depends on:** 05 (deployments produce trades).

## Goal

The terminal's **Analytics** workspace + **Trade Log / Journal**, computed server-side
from the **live** trade log — reusing QuantLab's existing analytics math so live and
backtest report identically.

## Context / why

- Backtest already computes net/win%/PF/Sharpe/maxDD/expectancy/equity-curve in
  [backtest_engine.py](../backend/services/backtest_engine.py) (`_compute_stats`,
  `_compute_analytics`) + [quant_metrics.py](../backend/services/quant_metrics.py).
  Reuse these on live trades so numbers are consistent.
- First we need to **persist live trades** (open question in 01).

## Checklist

- [x] Persist live trades in **SQLite** (decided): a `journal_trades` table written by the alerter on each realized round-trip.
- [x] Backend: record each live round-trip as a `JournalTrade {time, strategy, symbol, side, venue, entry, exit, r, pnl, hold}` on exit.
- [x] Backend: `GET /api/analytics?period=&group=&filter=` → reuse `_compute_stats`/`_compute_analytics` over the live journal (net, win%, PF, Sharpe, maxDD, expectancy, curve, breakdown).
- [x] Backend: `GET /api/trades/journal?period=&strat=&symbol=&venue=` → filtered journal rows.
- [x] Frontend Analytics: 8 stat cards + cumulative equity curve (progressive draw) + breakdown table grouped by STRATEGY/ASSET/BROKER; row click sets a drill-down filter and recomputes.
- [x] Frontend Blotter → Trade Log tab: filters (strategy/asset/venue), summary strip (Net, Win%, PF, ExpR, N), dense table.
- [x] Cross-check: a handful of live trades produce the same metric formulas as the backtest engine.
- [x] **Live vs expectation:** compare live results against what the backtest predicted (win rate, expectancy, drawdown), so you can see whether reality is tracking the test. Prefer the broker's ACTUAL realized P&L (WAMP `*_pastpositions`, phase 09) over our own guess where available.

## Done when

Live trades persist to a journal, and the terminal's Analytics + Trade Log render real
stats (net, win%, PF, Sharpe, maxDD, expectancy, equity curve, breakdown) computed by
the SAME engine the backtest uses — with working period/group/drill-down filters.

## Notes

- Keep the metric definitions identical to backtest (don't fork the math).
- Equity-curve "draw-in" animation per [design-handoff/ANIMATIONS.md](design-handoff/ANIMATIONS.md).
