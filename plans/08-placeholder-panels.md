# 08 — Placeholder panels (design-faithful, SIMULATED)

**Status:** ⬜ Todo
**Created:** Jul 01, 2026
**Depends on:** 02 (shell); best done after the real core (04–07).

## Goal

Fill in the panels QuantLab has **no real feed** for so the terminal *looks* complete,
but render them as clearly-labeled **SIMULATED** with client-side data — ready to swap
to real feeds later. This is the "faithful placeholders" half of the chosen scope.

**These panels are retained for future use, not throwaway** (see 01 migration
principles): each is built as a real, reusable component with a clean data seam so
wiring a live feed is a drop-in. The Order Book has the shortest path to real — the
Binance endpoints are already researched in
[ref-binance-orderbook.md](ref-binance-orderbook.md).

## Context / why

- Design faithfulness matters (it's a high-fidelity handoff), but we must never let a
  simulated panel read as real trading data. Every placeholder carries a visible
  **SIMULATED** chip and uses the muted empty-state where appropriate.

## Checklist

- [ ] Shared `SimulatedBadge` + a single `simFeed` util (seeded random-walk) so all placeholders share one honest labeling + generator.
- [ ] **Markets** workspace: sortable instruments table (symbol/last/24h%/funding/…/sparkline). Real where we have it (last/24h% from Binance), SIMULATED for funding if unavailable.
- [ ] **Order Book** + **Time & Sales** (from 04): keep SIMULATED generators behind a `useOrderBook(symbol)` seam so real wiring is a drop-in.
- [ ] **Order Book → real (soon):** wire to Binance **Partial Book Depth Stream** `btcusdt@depth20@100ms` / `ltcusdt@depth20@100ms` (top-20 snapshot per push, no local-book reconciliation). Full spec + REST fallback in [ref-binance-orderbook.md](ref-binance-orderbook.md). Route it through the phase-03 channel layer + ~1.5s server-side throttle; drop the SIMULATED badge only once it's live.
- [ ] **Funding & Open Interest** panel: funding rate, countdown, OI area/line, long/short bar — SIMULATED.
- [ ] **Liquidations** panel: streaming feed + long/short pressure bar — SIMULATED.
- [ ] **News** marquee: auto-scrolling headlines + sentiment tags — SIMULATED (or wire a real headline source later).
- [ ] **Risk** workspace: 4-up cards (equity/dayPnl/gross/netDelta/margin/VaR/…), exposure bars, margin bar, correlation matrix, position-risk table. Derive what we can from real positions; SIMULATE margin/VaR (no engine).
- [ ] **Blotter → Order Entry**: ticket UI (BUY/SELL, type, price, size, leverage, notional/margin, SUBMIT) that, per the chosen model, **routes to the webhook** (06) rather than an in-app OMS — or is disabled with a clear "webhook-only" note.
- [ ] Panel adaptation by instrument class (`adaptPanels`): stock→key-stats, index→breadth, fx→carry — SIMULATED.
- [ ] Audit: every non-real number on screen has a SIMULATED marker. No exceptions.

## Done when

All six workspaces are visually complete and match the handoff density/look, with every
non-real panel unmistakably labeled SIMULATED and driven by one shared honest generator —
and each is structured so wiring a real feed later is a drop-in.

## Notes

- Order entry is intentionally NOT a real OMS (scope decision) — it either drives the
  webhook or is clearly marked non-functional.
- Keep it obvious what's real vs simulated — mirrors Market Lab's "honest" tone.
