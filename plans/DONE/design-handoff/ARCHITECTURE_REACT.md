# React Architecture (proposed)

The prototype is a single `Component extends DCLogic` class (~880 lines) with all state on `this` and imperative `render*()` methods that write `innerHTML`. For the React codebase, decompose it into a component tree with a typed data layer. Below is a recommended mapping — adapt to the host codebase's conventions (its component library, state manager, and data-fetching layer).

## Component tree

```
<TerminalShell>                         // grid: 52px | 1fr  ×  54 / 32 / 1fr / 24
├── <LeftRail activeWs onSelect onCommand/>
├── <TopBar venue equity dayPnl clock live notifications/>
├── <WorkspaceTabs active onSelect/>
├── <WorkspaceHost active>              // position:relative; renders active workspace
│   ├── <TradingWorkspace/>             // 6fr / 4fr
│   │   ├── <ChartPanel instrument timeframe>      // Canvas + overlays
│   │   │   ├── <SymbolSwitcher/>   <PriceHeader/>  <StrategyChips/>
│   │   │   ├── <TimeframeSelector/>  <ChartLegend/>  <OhlcvTooltip/>
│   │   │   └── <PriceChartCanvas/>     // candles+VWMA+Zband+VP+POC+sessions
│   │   ├── <OrderBookPanel/>
│   │   ├── <TimeAndSalesPanel/>
│   │   ├── <PositionsPanel/>
│   │   ├── <ActivityPanel/>            // Liquidations | Sentiment (class-adaptive)
│   │   ├── <InstrumentPanel/>          // Funding+OI | KeyStats | Breadth | FX (adaptive)
│   │   └── <NewsPanel/>
│   ├── <MarketsWorkspace/>             // sortable instruments table + sparklines
│   ├── <RiskWorkspace/>               // exposure cards, bars, correlation matrix, table
│   ├── <BlotterWorkspace/>            // tabs: OrderTicket+Working+Fills | TradeLog
│   ├── <StrategiesWorkspace/>         // strategy cards + deployments + <DeployModal/>
│   └── <AnalyticsWorkspace/>          // stat cards + <EquityCurveCanvas/> + breakdown
├── <StatusFooter/>
└── <CommandPalette open/>             // ⌘K overlay (portal)
```

`<ChartPanel>`, `<EquityCurveCanvas>`, and `<OrderBookDepthBar>` are the only places that need imperative canvas/measure work; everything else is ordinary declarative JSX + flex/grid.

## State & data layer

Keep a thin global store (Zustand/Redux/Context — whatever the codebase uses) plus server-state via the codebase's data layer (React Query/RTK Query). Suggested shape (TypeScript):

```ts
type AssetClass = 'perp' | 'stock' | 'index' | 'fx';
type Venue = 'BINANCE' | 'CAPITAL' | 'IG';            // crypto perps | stocks | index/fx

interface Instrument {
  venue: Venue; cls: AssetClass; symbol: string; base: number;
  meta?: Record<string, unknown>;   // class-specific: {mcap,pe,eps,div,avgvol,earn} | {adv,dec,movers} | {swapL,swapS,rateDiff}
}

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }
interface BookLevel { price: number; size: number; cum: number; }
interface Trade { side: 'BUY'|'SELL'; price: number; size: number; t: number; }
interface Position { symbol: string; side: 'LONG'|'SHORT'; entry: number; price: number; size: number; lev: number; }
interface Liquidation { side: 'LONG'|'SHORT'; usd: number; price: number; t: number; }

interface Strategy {
  id: string; name: string; type: string; color: string; classes: AssetClass[];
  params: { k: string; label: string; def: number; unit: string }[];
  presets: Record<'Conservative'|'Balanced'|'Aggressive', Record<string, number>>;
  bias: { wr: number; r: number };   // backtest win-rate & avg R (for sim only; real = engine output)
}
interface Deployment {
  id: number; stratId: string; symbol: string; venue: Venue; cls: AssetClass;
  tf: string; preset: string; status: 'RUNNING'|'PAUSED'; since: number; pnl: number; n: number;
}
interface Webhook { id: string; label: string; url: string; }

interface JournalTrade {
  id: number; ts: number; strat: string; symbol: string; venue: Venue; cls: AssetClass;
  side: 'LONG'|'SHORT'; entry: number; exit: number; pnl: number; R: number; fees: number; durMin: number;
}
interface WorkingOrder { id: number; symbol: string; side: 'BUY'|'SELL'; type: string; price: number; size: number; }
interface Fill { time: string; sym: string; side: 'BUY'|'SELL'; price: number; size: number; fee: number; }
interface Alert { id: number; symbol: string; venue: Venue; type: 'PRICE'|'PCT'|'SIGNAL'; cond: string; val: number; status: 'ARMED'|'TRIGGERED'; }
```

### Derived/computed (pure selectors — port these from the prototype)
- **Indicators** `computeIndicators(candles, win=14)` → `{ vwma[], up[], lo[] }` where `up/lo = vwma ± 1.5·stdev` over a rolling window (volume-weighted MA + rolling stdev of close). Prototype: search `computeIndicators`.
- **Volume profile** `buildVolProfile()` → bins, bucket volumes, POC index, value-area lo/hi (70% of volume).
- **Session** by UTC hour: 8–13 London (amber tint), 13–22 New York (blue tint), else Asia (purple tint).
- **Analytics stats** `computeStats(trades)` → `{ net, win, pf, sharpe, maxdd, exp, avgHold, n, curve }`. The `curve` is the cumulative-P&L series the equity canvas draws.
- **Risk** per position: notional `price·size`, margin `notional/lev`, liq price (long: `entry·(1−1/lev)`-ish), distance-to-liq %, uPNL. Gross/net exposure, margin used, VaR, free margin aggregate from positions + equity.
- **Sign color** helper: `pnl >= 0 ? green : red` — used everywhere.

## How prototype methods map to React

| Prototype (imperative) | React (declarative) |
|---|---|
| `setWorkspace(name)` + `display` toggles | `activeWorkspace` state + conditional render; entrance anim via a hook (see ANIMATIONS.md) |
| `renderBook/renderTape/renderPositions/...` (`innerHTML`) | components that `.map()` over state arrays |
| `drawChart/drawOI/drawEquity` (canvas) | `<canvas>` components with a `useEffect` redraw on `[data, size, progress]`; or swap for the codebase chart lib |
| `genCandles/tick/updateBook/...` (setInterval sim) | WebSocket subscriptions → store updates (delete the sim) |
| `adaptPanels()` (swap innerHTML by class) | render `<ActivityPanel>`/`<InstrumentPanel>` variants by `instrument.cls` |
| `initCmdK/openCmd/onKey` | `<CommandPalette>` + a global `useHotkeys('mod+k')` |
| `wireBlotter` / `data-*` click handlers | normal React `onClick`/`onChange` props |
| `engineTick()` (fake trades) | server-sent strategy events → append to `tradeLog`, bump deployment P&L |

## Notes for the implementer
- **Canvas vs. chart lib:** the prototype's canvas drawing is compact and exact (sessions → VP → grid → Z-bands → candles → VWMA → markers → POC, in that z-order). Porting it 1:1 guarantees the look. If you prefer the codebase's chart library, replicate: candlesticks, an amber MA line, dashed cyan ± bands, a right-aligned horizontal volume histogram, a dashed POC line, and faint vertical session bands. Keep DPR scaling (`canvas.width = cssWidth · devicePixelRatio`).
- **Don't introduce border-radius, gradients-as-decoration, or new accent colors.** Stay within the token table.
- **Monospace everything numeric.** It's the core of the aesthetic.
- **Virtualize** the long tables (Markets, Trade Log) with the codebase's list-virtualization if row counts grow.
- Keep all the **sign/threshold coloring** logic in selectors so cards/tables/headers stay consistent.
