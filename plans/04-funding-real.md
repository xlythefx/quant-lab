# 04 — Funding & Open Interest → real (retire the simulated panel)

**Status:** 🟦 Pending
**Created:** Jul 07, 2026
**Depends on:** [01](01-production-overview.md). QuantLab-side only.

## Goal

Replace the SIMULATED Funding panel with real Binance data — funding rate, next-funding
countdown, open interest, and long/short ratio — so it stops showing made-up numbers.

## The key fact (why it's simulated today)

Funding, OI, and liquidations are **perpetual-futures** concepts — they do **not**
exist on spot. QuantLab's live chart streams Binance **spot**, so the panel has no real
data. Going real means reading the **USDⓈ-M Futures** feed (`fapi.binance.com` /
`fstream.binance.com`) for the *perp* of the same coin. No API key (public market data).

## Where to fetch it (verified endpoints)

- **Funding rate + next funding** (REST poll, simplest):
  `GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT`
  → `{ markPrice, indexPrice, lastFundingRate, nextFundingTime }`. Poll ~15–30s. This
  fills the FUNDING/8H number, predicted rate, and the exact countdown (from
  `nextFundingTime` — no more guessing the 8h boundary).
  *(Live option: `wss://fstream.binance.com/ws/btcusdt@markPrice@1s` pushes `{p,r,T}`.)*
- **Open interest:**
  current `GET /fapi/v1/openInterest?symbol=BTCUSDT`; history for the line
  `GET /futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=48`.
- **Long/short ratio:**
  `GET /futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m` → `longShortRatio`.
  (Binance updates every 5 min → poll every 5 min.)

## Checklist

- [ ] **Backend `GET /api/live/funding?symbol=`** — pull `premiumIndex` + `openInterest`
      (+ `openInterestHist`) + `globalLongShortAccountRatio` from `fapi.binance.com`,
      return the shape the panel already renders (rate, predicted, nextFundingTs, OI
      series, longShortRatio). Cache ~15–30s server-side (polite polling).
- [ ] **Frontend `useFunding(symbol)` hook** behind the existing panel seam (like
      `useOrderBook`): live mode hits the endpoint; drop the SIMULATED badge once a real
      frame lands; fall back to `simFeed` until then.
- [ ] **Wire `FundingPanel`** to the hook (it already renders rate/countdown/OI/LS —
      just swap the data source).
- [ ] **Symbol mapping / no-perp guard:** spot `BTCUSDT` maps 1:1 to the `BTCUSDT` perp,
      but not every alt has one. For a symbol with no perp, keep the panel SIMULATED/empty
      (don't show fake real data).

## Done when

The Funding panel shows real Binance perp funding, countdown, OI, and long/short for
symbols that have a perp — with the SIMULATED badge gone — and cleanly stays SIMULATED
for symbols that don't.

## Notes

- Liquidations (the other perp panel) is `fstream ...@forceOrder` — WebSocket-only,
  Binance-throttled to ~1/symbol/sec (a *sampled* feed, not the full tape). Separate,
  lower-priority; the user leaned toward replacing that panel with closed-positions or
  dropping it. Decide during the one-shot.
- Follows the same "real feed drops the badge automatically" seam the order book uses.
