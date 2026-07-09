# Handoff: XlytheAI Institutional Trading Terminal

## Overview
A dense, single-screen institutional trading terminal (Bloomberg/TradingView-class) for a multi-asset broker. One full-viewport application shell with a left icon rail, a top status bar, a workspace tab strip, a content area that swaps between **six workspaces**, and a status footer. Workspaces: **Trading, Markets, Risk, Blotter, Strategies, Analytics**, plus a global **Command Palette (⌘K)** and an **Alerts** view.

The terminal is built around live, streaming market data and an automated **strategy engine** that emits trades against deployed strategies. Every numeric surface updates in real time.

---

## About the Design Files
The files in this bundle (`XlytheAI Terminal.dc.html`) are a **design reference created in HTML/Canvas** — a working prototype that demonstrates the intended look, layout, density, data shapes, and motion. **It is not production code to copy.** All data in the prototype is **simulated client-side** (random walks, setInterval loops). 

Your task is to **recreate this design in the existing React codebase**, wiring it to the **Python backend** for real data instead of the simulated feeds. Use the codebase's established patterns: its component library, state/data-fetching layer (React Query / Redux / Zustand / etc.), styling system, and chart library. Where the prototype hand-rolls a `<canvas>` chart, you may either port the canvas drawing (it is compact and documented) or substitute the codebase's existing charting library (lightweight-charts, uPlot, ECharts) — match the visual spec either way.

This README is self-sufficient. Companion docs:
- **`ARCHITECTURE_REACT.md`** — proposed React component tree, state model, and how the single prototype class maps to components/hooks.
- **`BACKEND_PYTHON.md`** — REST + WebSocket API contracts and data models the frontend expects.
- **`ANIMATIONS.md`** — exact specs for the workspace entrance animations and progressive chart drawing.

---

## Fidelity
**High-fidelity.** Final colors, typography, spacing, density, and interactions are all specified. Recreate the UI pixel-accurately using the codebase's libraries. The one area with latitude is the **charting implementation** (canvas vs. a chart lib) — match the visual result.

---

## Design Tokens

### Color palette (exact hex)
| Token | Hex | Usage |
|---|---|---|
| `bg` | `#0a0a0f` | App background, content area |
| `bg-chrome` | `#0c0c12` | Left rail, top bar, panel footers, sub-headers |
| `panel` | `#0f0f17` | Panel/card surface |
| `border` | `#1e1e2e` | Hairline borders, grid gaps, dividers |
| `grid` | `#15151f` | Chart gridlines, inner row dividers, hover bg |
| `row-divider` | `#13131d` | List/table row separators |
| `text` | `#e2e2f0` | Primary text, numbers |
| `text-muted` | `#6b6b8a` | Labels, secondary text, axis |
| `text-dim` | `#3a3a4e` | Empty-state text |
| `green` | `#00d4a1` | Up / long / buy / positive P&L |
| `red` | `#ff4d6d` | Down / short / sell / negative / liquidations |
| `amber` | `#fbbf24` | Brand accent, VWMA line, active tab underline, POC |
| `cyan` | `#22d3ee` | Z-band, OI line, info actions, LIVE venue |
| `purple` | `#8b5cf6` | Asia session, Trend strategy |

Tinted fills are the accent at low alpha, e.g. green depth bar `rgba(0,212,161,0.13)`, red `rgba(255,77,109,0.13)`, session shading `rgba(...,0.05–0.06)`, VP value-area `rgba(34,211,238,0.18)`, POC bucket `rgba(251,191,36,0.5)`.

### Typography
- **UI / labels / headings:** system stack — `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`.
- **All numeric / tabular data:** `ui-monospace, monospace`. This is the dominant typeface of the terminal — every price, size, time, %, and table cell is monospace.
- Common sizes: section labels `9–10px` uppercase `letter-spacing:.08–.1em` muted; table cells `10.5–11px`; primary price `22px/700`; top-bar equity & P&L `16px/700`; tab labels `11px/600` `letter-spacing:.1em`.
- Section/eyebrow labels are UPPERCASE, muted, wide-tracked. Numbers use weight 600–700 for emphasis, 400–500 otherwise.

### Layout grid (app shell)
- Root: `display:grid; grid-template-columns: 52px 1fr; grid-template-rows: 54px 32px minmax(0,1fr) 24px; height:100vh; width:100vw; overflow:hidden;`
  - Col 1 = left rail (spans all rows). Col 2 = top bar / tabs / content / footer.
- **1px borders are achieved via grid `gap:1px` over a `border` (`#1e1e2e`) background** — panels sit on a border-colored grid so the gaps read as hairlines. Preserve this technique (or replicate with borders).
- Panels: `background:#0f0f17; display:flex; flex-direction:column; min-height:0; overflow:hidden;` with a `flex:none` header row (`padding:6px 10px; border-bottom:1px solid #1e1e2e;` muted uppercase label) and a `flex:1; min-height:0; overflow:auto` body.
- **No border-radius anywhere** — this is a sharp, terminal aesthetic. No rounded corners on panels, rows, or buttons (only the small notification badge and status dots are circular). Don't introduce rounding.
- Density is high: row padding `1.5px–6px`, gaps `4px`, font `9–11px`. Respect it.

### Spacing
Effective scale: `1, 2, 4, 6, 7, 8, 10, 11, 12, 13, 14, 16, 20px`. Panel header padding `6px 10px`; card padding `11px 13px`; page section padding `14px 16px`.

---

## Application Shell

### Left rail (52px)
Vertical icon nav, `background:#0c0c12; border-right:1px solid #1e1e2e`. Top: a 16px amber diamond (`transform:rotate(45deg)`) brand mark. Then 6 workspace icons (38×38 hit area, centered SVG, `stroke-width≈1.6`): Trading (candlestick), Markets (bars), Risk (warning triangle), Blotter (lines), Strategies (node graph), Analytics (line chart). Active icon = `green (#00d4a1)`, inactive = `muted (#6b6b8a)`, hover → `#e2e2f0`. Spacer pushes a **search/command** icon to the bottom (opens ⌘K).

### Top bar (54px)
`background:#0c0c12; border-bottom:1px solid #1e1e2e`, three zones (space-between):
- **Left:** wordmark "**XlytheAI** Terminal" (XlytheAI bold `#e2e2f0`, Terminal muted) + a venue chip — bordered pill, `font:600 10px mono letter-spacing:.08em`, cyan dot + venue name (e.g. `● BINANCE`), color cyan.
- **Center:** two stat blocks, label (`9px muted`) over value (`16px/700 mono`): **ACCOUNT EQUITY** (`$130.3K`, white) and **DAY P&L** (`+$5296`, green/red by sign).
- **Right:** a blinking green dot + `LIVE` (mono, green, `animation: blink 1.6s infinite`), a UTC clock (`HH:MM:SS UTC`, updates every 1s), and a bell with a red count badge (armed/running deployments count).

### Workspace tabs (32px)
`background:#0a0a0f; border-bottom:1px solid #1e1e2e`. Six tabs: `TRADING MARKETS RISK BLOTTER STRATEGIES ANALYTICS`, `font:600 11px mono letter-spacing:.1em`. Active = white text + `2px solid #fbbf24` bottom border; inactive = muted + transparent border. Right side: a `⌘K command` hint chip.

### Content area
`grid-row:3; position:relative`. Holds one container per workspace; only the active one is shown (`display:grid` for Trading, `display:block` for the rest; others `display:none`). Switching tabs triggers the per-panel entrance animation (see ANIMATIONS.md).

### Footer (24px)
`background:#0c0c12; border-top:1px solid #1e1e2e`, mono `9–10px`. Left: `● GATEWAY NY4 · LATENCY 8ms · FEED OK · SESSION NEW YORK` (latency/session update ~2s). Right: `DAY P&L +$5346 · HH:MM:SS UTC · XLY-OS v4.2.1`.

---

## Workspaces

### 1. TRADING
Two rows (`grid-template-rows: 6fr 4fr`, `gap:1px`).

**Row 1** — `grid-template-columns: 2fr 1fr 1fr`:
- **Chart panel** (canvas). Header: left `VWMA(14) · Z-SCORE 1.5σ · VOL PROFILE` + a cyan `+ ATTACH STRATEGY` button; right a timeframe selector `1m 5m 15m 1H 4H 1D` (active = white text on `#1e1e2e`). Canvas overlays (absolute):
  - Top-left: clickable **symbol switcher** — symbol name (`14px/700 mono`), an instrument-class tag (`PERP`/`STOCK`/…), a ▾; below it the live price (`22px/700`), change % (green/red), and an `H / L / V` line. Clicking opens a venue-grouped instrument menu.
  - Top-right: **strategy chips** column (deployed strategies on this symbol).
  - Bottom-left: a legend (`━ VWMA`, `⎓ Z-BAND`, `■ ASIA / LDN / NY`).
  - Hover: an OHLCV tooltip following the cursor.
  - **Chart contents:** session-shaded background columns (Asia/London/NY by UTC hour), a **volume profile** drawn from the right edge (POC bucket amber, value-area cyan, rest muted) with a dashed amber **POC** line, price gridlines + right-edge axis labels, dashed cyan **Z-bands (±1.5σ)**, **candlesticks** (green/red), an amber **VWMA(14)** line, and small triangle markers where price pierces a Z-band.
- **Order Book** panel. Header `Order Book`. Column header `PRICE / SIZE / TOTAL`. Asks (red) stacked descending above a center **spread** row (`SPREAD <abs> <bps%>`, on `#0c0c12`), bids (green) below. Each row has a right-anchored cumulative-depth bar (tinted) behind mono numbers. Updates ~1.5s.
- **Time & Sales** panel. Header `Time & Sales`, columns `TIME / PRICE / SIZE`. Newest on top; buys green / sells red; large prints (`size>2.2`) get a tinted row background. Streams ~0.8s.

**Row 2** — `grid-template-columns: repeat(4,1fr)`:
- **Positions & PnL** — columns `SYMBOL SIDE ENTRY MARK uPNL` (uPNL shows $ and % stacked); footer `TOTAL UNREALIZED` (green/red). Drives the top-bar equity & day-P&L.
- **Liquidations** (perp) — streaming feed `TIME [SIDE] $X.XK price`; footer **LIQUIDATION PRESSURE** heatmap: a long/short split bar + `LONG $… / $… SHORT`. New liqs slide in (`slideIn .4s`). *Adapts by instrument class* (see below).
- **Funding & Open Interest** (perp) — funding rate (`22px`, red=longs pay), next-funding countdown (`HH:MM:SS`), predicted funding; an **OI** area+line canvas (`24h`, cyan) with current value; a **long/short ratio** split bar with labels. *Adapts by class.*
- **News Feed** — vertically auto-scrolling headlines; each item: time, headline, and a sentiment tag (`BULLISH` green / `BEARISH` red / `NEUTRAL`). Continuous marquee (`transform:translateY`, pauses on hover).

**Panel adaptation by instrument class** (`adaptPanels()`): when the selected instrument isn't a perp, the Liquidations and Funding/OI panels swap content & titles:
- `stock` → "Sentiment" + "Key Statistics" (market cap, P/E, EPS, div yield, avg vol, next earnings).
- `index` → breadth (advancers/decliners, top movers).
- `fx` → swap/carry rates, rate differential, sessions.

### 2. MARKETS
Single scrollable view. Header `MARKETS · PERPETUAL FUTURES · N INSTRUMENTS`. A **sortable table**: `SYMBOL / LAST / 24H% / FUNDING / … / sparkline`. Clicking a column header toggles sort (asc/desc, arrow indicator). 24h% green/red; funding colored (positive=red). Each row has a small inline **sparkline** SVG. Row hover tint.

### 3. RISK
Header `RISK · PORTFOLIO EXPOSURE & MARGIN`. 
- A 4-up **card grid** (`repeat(4,1fr)`, gap 1px): ACCOUNT EQUITY, DAY P&L, GROSS EXPOSURE (with leverage), NET DELTA, MARGIN USED (% of equity), FREE MARGIN, EST. VaR 1-DAY 95%, MAINT. MARGIN. Card = `panel + 1px border`, label (`9px muted`) / value (`17px/700`, colored) / sub-label.
- **Net Exposure by Instrument** — horizontal bars per position (long green / short red) with notional labels.
- **Margin Utilization** — a used/limit bar (`util>60`=red, `>35`=amber, else green) with `% used` and `limit 100%`.
- **Cross-Asset Correlation** (30D) — a colored correlation matrix (green↔red heat, diagonal = 1.00).
- **Position Risk** table — `SYMBOL LEV NOTIONAL LIQ PRICE DIST uPNL`; liq price red, distance-to-liq %, uPNL colored.

### 4. BLOTTER
Header `BLOTTER · ORDER ENTRY & EXECUTION`, with a sub-tab bar: **ORDER ENTRY** | **TRADE LOG / JOURNAL**.
- **Order Entry** (`grid: 300px 1fr`): a **ticket** card — BUY/SELL toggle (green/red fill on active), order type (MARKET/LIMIT/…), price input, size input + leverage selector (class-aware presets), Post-Only toggle, computed notional/margin, and a colored **SUBMIT** button. Right column: **Working Orders** (cancelable) and **Fills** (recent executions: time, symbol, side, price, size, fee). Submitting a market order pushes a fill; limit orders create a working order.
- **Trade Log / Journal**: filter selects (Strategy / Asset / Venue), a summary strip (Net, Win%, PF, Exp R, N trades), and a dense table: `TIME STRATEGY ASSET SIDE VENUE ENTRY EXIT R P&L HOLD` (strategy colored by its accent, P&L/R green/red).

### 5. STRATEGIES
Header + strategy roster. Each of 5 strategy types is a **card** (accent-colored): VWMA Z-Reversion (cyan, Mean Reversion), Momentum Breakout (green), Funding Arbitrage (amber, perp-only), Liquidation Fade (red, perp-only), Trend Follower EMA-X (purple). Cards show type, applicable asset classes, tunable params, and a **Deploy** action. **Deployments** list: strategy · symbol · venue · timeframe · preset (Conservative/Balanced/Aggressive) · status (RUNNING/PAUSED) · live P&L · trade count, with toggle (pause/resume) and kill controls. A **Deploy popup** (modal) lets you pick strategy, instrument, timeframe, preset, tune params, choose a **webhook** target, and deploy. A "test signal" action emits a signal. The bell badge counts RUNNING deployments.

### 6. ANALYTICS
Header `ANALYTICS · PERFORMANCE` with a period selector `7D / 30D / ALL` and an optional active-filter chip (clearable).
- **8 stat cards** (`repeat(8,1fr)`): NET P&L (+N trades), WIN RATE, PROFIT FACTOR, SHARPE (annualized), MAX DRAWDOWN, EXPECTANCY (R, avg/trade), AVG HOLD, TRADES. Colored by good/bad thresholds.
- **Cumulative Equity Curve** (canvas, 170px): area+line, green if ending positive else red, dashed zero line. **Draws in progressively on entry** (see ANIMATIONS.md).
- **Breakdown** table grouped by `STRATEGY / ASSET / BROKER` (toggle): `NET WIN% PF SHARPE EXP-R N`, sorted by net desc. Clicking a row sets a filter (drill-down) and re-computes all stats + the curve.

### Command Palette (⌘K)
Global overlay (`⌘K`/`Ctrl-K` toggles; `Esc` closes). A search input + filtered list of actions grouped by kind (WORKSPACE / ACTION / SYMBOL): jump to any workspace, new order ticket, deploy strategy, open trade log, jump to a symbol. Type to filter, arrow/enter to run.

---

## Interactions & Behavior

### Navigation
- Left-rail icon or top tab → `setWorkspace(name)`: shows that workspace, updates active states on both rail + tabs, lazily renders the workspace's content, and plays the entrance animation. Trading additionally (re)starts the progressive chart draw.
- ⌘K palette actions call the same `setWorkspace` / open-modal handlers.

### Symbol switching
Clicking the on-chart symbol switcher opens a venue-grouped instrument menu. Selecting an instrument: updates symbol/venue/class, regenerates candles & book & tape for the new base price, **adapts the perp-specific panels** to the instrument class, redraws + **replays the progressive chart draw**, and refreshes strategy chips.

### Timeframe
Clicking `1m…1D` regenerates candles for that timeframe and redraws.

### Live update cadence (prototype simulation → replace with real streams)
| Feed | Interval | Real source |
|---|---|---|
| UTC clock | 1000 ms | client clock |
| Footer latency/session | 2000 ms | gateway heartbeat |
| Price tick (last candle + price) | 2200 ms | ticker WS |
| Order book | 1500 ms | L2 depth WS |
| Time & sales | 800 ms | trades WS |
| Liquidations (perp) | 3800 ms | liquidations WS |
| Strategy engine trade | 5200 ms | strategy-engine events |
| Open interest shift | periodic | OI WS/poll |

In React, do **not** port these as raw `setInterval`s — subscribe to backend WebSocket channels (see `BACKEND_PYTHON.md`) and update state; only the clock stays client-side.

### Animations
Two systems, fully specified in **`ANIMATIONS.md`**: (1) **per-container staggered entrance** when a workspace becomes active, and (2) **progressive "draw-in"** of the candle chart, VWMA/Z-bands, OI, and the equity curve. Both must be implemented; both have safety fallbacks so content never gets stuck hidden if rAF is throttled.

### States to handle
- **Empty:** no alerts / no positions / filtered-to-zero tables → muted "No …" text (`#3a3a4e`).
- **Loading:** prototype has none (data is synchronous). For real integration, add skeletons matching panel layout; keep the chart's progressive draw as the "data arrived" reveal.
- **Sign coloring:** every P&L/change value is green when ≥0, red when <0 — centralize this.
- **Hover:** rows (`.ob-row/.pos-row/.news-item/.mkt-row`) tint to `#15151f`/`#13131d`; rail icons brighten; tabs brighten.

---

## State Management (what the data layer must provide)
See `ARCHITECTURE_REACT.md` for the full model. At a glance the app needs:
- `activeWorkspace`, `selectedInstrument {symbol, venue, class, base, meta}`, `timeframe`.
- Live: `ticker`, `candles[]`, `orderbook {bids,asks}`, `trades[]`, `positions[]`, `liquidations[]`, `funding`, `openInterest[]`, `longShortRatio`, `news[]`.
- Portfolio/risk derived from `positions[]` + account equity.
- `strategies[]`, `deployments[]`, `webhooks[]`, `tradeLog[]` (journal), `workingOrders[]`, `fills[]`, `alerts[]`.
- `analytics` stats computed from `tradeLog[]` (net, win%, PF, Sharpe, max DD, expectancy, equity curve).
- `commandPaletteOpen`.

---

## Assets
- **No external image/font assets.** Icons are inline SVG (recreate with the codebase's icon set — they are simple line/solid glyphs). Fonts are system + `ui-monospace` (no web fonts to ship).
- The brand mark is a CSS amber rotated square (no logo file).
- Charts are drawn on `<canvas>` — no image assets.

## Files in this bundle
- `XlytheAI Terminal.dc.html` — the full design reference (open in a browser to interact). All logic lives in the `<script type="text/x-dc">` class at the bottom; markup is the `<x-dc>` body. Ignore the `support.js`/DC runtime wrapper — it's the prototype's harness, not part of the design.
- `ARCHITECTURE_REACT.md`, `BACKEND_PYTHON.md`, `ANIMATIONS.md` — companion specs.
