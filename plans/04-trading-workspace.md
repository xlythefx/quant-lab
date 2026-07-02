# 04 — Trading workspace (chart + live price + signals)

**Status:** ⬜ Todo
**Created:** Jul 01, 2026
**Depends on:** 02 (shell), 03 (ticker/candles channels).

## Goal

Build the terminal's **Trading** workspace: the live candle chart with VWMA/Z-band/
session shading, a symbol switcher, timeframe selector, live price header, and the
**strategy signal markers/chips** for whatever's armed on that symbol. Order Book and
Time & Sales render as clearly-labeled **SIMULATED** placeholders (real feed later).

## Context / why

- We already have a capable chart in [TradingChart.jsx](../frontend/src/components/TradingChart.jsx)
  (candles, VWMA, z-bands, session bands, markers). Reuse it inside the terminal panel
  rather than porting the handoff's hand-rolled canvas.
- Live signals come from the `strategy` channel (phase 05) and/or the live alerter.

## Checklist

- [ ] Trading layout: row1 `2fr 1fr 1fr` (chart | order book | time&sales), row2 `repeat(4,1fr)` (positions | liquidations | funding/OI | news).
- [ ] Chart panel: mount `TradingChart` in live mode fed by `useLiveChannel('candles'|'ticker')`; overlay VWMA(14) + Z-band(1.5σ) + Asia/LDN/NY session shading (styles per handoff tokens).
- [ ] Live price header overlay: symbol switcher (name + class tag + ▾), price (22px), change %, H/L/V line.
- [ ] Symbol switcher menu: venue-grouped Binance instruments (from `/api/live/instruments`); switching resubscribes channels (03) + refreshes chips.
- [ ] Timeframe selector `1m 5m 15m 1H 4H 1D` → resubscribe candles at that tf.
- [ ] Strategy chips (top-right of chart): deployments armed on this symbol (from 05); show live P&L / status.
- [ ] Signal markers: draw entry/exit triangles from the `strategy` channel / live alerter events.
- [ ] **Order Book** panel — placeholder: real layout (asks/spread/bids + depth bars) fed by a labeled SIMULATED generator behind a `useOrderBook(symbol)` seam; "SIMULATED" chip in header. Real Binance wiring path is ready in [ref-binance-orderbook.md](ref-binance-orderbook.md) (partial depth stream) — swapped in during 08.
- [ ] **Time & Sales** panel — placeholder likewise (streaming prints, SIMULATED chip).
- [ ] Perp panels (positions/liq/funding/news) left as stubs here; fleshed in 08.
- [ ] `vite build` passes; manual check on BTCUSDT.

- [ ] Ship with **BTCUSDT** and **LTCUSDT** selectable first (more symbols later).

## Done when

Selecting a Binance symbol shows a live-updating candle chart with VWMA/Z-bands and
session shading, a live price header that ticks, working symbol + timeframe switching,
and any armed strategy's signals/chips — with Order Book and Time & Sales visibly
labeled SIMULATED.

## Notes

- Don't fake the chart data — it's real. Only book/tape are simulated, and must say so.
- Keep the reused `TradingChart` visually reskinned to the terminal tokens (no rounded corners).
