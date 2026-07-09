# 02 — App shell + Go Live mode switch

**Status:** ✅ Done (Jul 02, 2026)
**Created:** Jul 01, 2026
**Depends on:** 01 (overview). No backend needed — pure frontend skeleton.

## Goal

Introduce a top-level **mode**: "Research / Backtest" (the app as it is today) vs
**"Live Terminal"** (the new institutional shell). A **Go Live** control flips between
them. Build the empty Live shell (rail, top bar, tab strip, footer) with the handoff's
tokens — no live data yet, just the frame + navigation.

## Context / why

- Today the app is hash-routed (`#dashboardv2`, `#livealerts`, …) via
  [App.jsx](../frontend/src/App.jsx) + [IconNavRail.jsx](../frontend/src/components/dashboardv2/IconNavRail.jsx).
- Live Terminal is a *separate world* with its own rail/tabs, so we add a mode above routing.
- Use the handoff palette as a scoped theme so the two worlds look distinct (see 01).

## Checklist

- [x] Add an app-level `mode` state ("research" | "live"), persisted (localStorage), read in [App.jsx](../frontend/src/App.jsx).
- [x] **Hard flip:** in "live" mode render ONLY the terminal shell (backtest rail/pages hidden); in "research" mode render the app as today. The existing `LiveAlerts` / live alerter stay untouched in research mode — additive, nothing removed.
- [x] Add a **Go Live / Exit Live** switch that's always visible (top bar in both worlds); flips `mode`.
- [x] Create `frontend/src/pages/live/LiveTerminal.jsx` — the shell: 52px left rail, 54px top bar, 32px workspace tabs, content area, 24px footer (grid per 01 tokens).
- [x] Scope the handoff palette (bg `#0a0a0f`, panel `#0f0f17`, border `#1e1e2e`, green/red/amber/cyan/purple) as CSS vars under a `.live-terminal` root class — do NOT touch the global theme.
- [x] Left rail: 6 workspace icons (Trading, Markets, Risk, Blotter, Strategies, Analytics) + brand diamond + bottom search/⌘K icon. Active = green.
- [x] Top bar: wordmark + venue chip (● BINANCE), ACCOUNT EQUITY / DAY P&L blocks (static stubs for now), blinking LIVE dot, UTC clock (client-side, 1s), bell w/ badge (stub 0).
- [x] Workspace tab strip: 6 tabs, active = white + 2px amber underline; content swaps by active workspace (empty panels for now).
- [x] Footer: `● GATEWAY … · LATENCY … · FEED OK · SESSION …` (static) + clock + version.
- [x] Each workspace renders an empty labeled panel ("Trading — coming in 04", etc.) so navigation works end-to-end.
- [x] Verify `vite build` passes.

## Done when

You can click **Go Live**, land in the dark terminal shell, click all 6 workspace
tabs and the rail icons, see the clock ticking and the LIVE dot blinking, and click
**Exit Live** to return to the normal backtest app — with the mode remembered on reload.

## Notes

- Keep the shell a dumb frame; all data wiring is later phases.
- ⌘K palette can be a stub button now; full palette is optional polish (own mini-plan if wanted).
