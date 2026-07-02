# Live Terminal — the plan in plain English

Created: Jul 01, 2026 · Plain-language companion to [01-live-terminal-overview.md](01-live-terminal-overview.md)

This is the "explain it like I'm not an engineer" version. For the technical detail,
each item links to its full plan file.

## The big picture (what we're building, and why)

1. Right now QuantLab has one dashboard that mixes two very different jobs: testing
   ideas on old data (backtesting) and watching things happen live.
2. We're splitting them into two separate worlds so each is clean:
   - a Research world — everything you already use for backtesting, and
   - a brand-new Live Terminal — a slick, dark, "trading desk" screen for when you're
     actually live.
3. A single "Go Live" button flips you between the two, like changing TV channels.
4. The Live Terminal's look comes from a professional design pack you had made (the
   "Institutional Trading Terminal") — think Bloomberg or TradingView style.

## The ground rules we agreed on

1. Nothing that works today gets removed. Your current live alerts keep running the
   whole time. We only retire the old version after the new one is proven — and that's
   a separate step for later.
2. Build the real stuff first; fake the rest honestly. Some fancy panels (like the
   order book) need data we don't have yet. We'll build those as good-looking
   placeholders clearly stamped "SIMULATED" so nothing pretends to be real money data —
   and we keep them so they're easy to make real later.
3. "Live" means alerts plus a nudge to your broker. When a strategy triggers, you get
   an alert, and it can also ping your broker automatically (a webhook). QuantLab itself
   won't place or manage orders.
4. Start with Binance, and with two coins first: BTCUSDT and LTCUSDT.
5. Go Live is a full switch (a "hard flip"): live mode shows only the terminal; your
   backtest pages are hidden but one click away.
6. You create alerts and webhooks with a pop-up form (a modal), exactly like the alerts
   page works today. Your alerts — both the rules and the history of ones that fired —
   are stored inside QuantLab (a local file plus a small local database) and can be
   deleted. We are not tying this to your WAMP server; WAMP stays only as the place your
   alerts get sent to.
7. Because a live alert can trigger a real trade at your broker, the live side has safety
   rails: webhooks start in a safe test mode, there is a one-click "disarm everything",
   turning a strategy live asks you to confirm, and the same signal can never fire twice.
8. Each strategy has a simple Demo or Live account switch, so you can run it live with fake
   money first, then flip to real when you trust it.
9. The new terminal has its own fresh look (the professional design). It does not borrow
   screens from the backtest side and does not push its screens into it — the two only
   share the data underneath.

## The work, one plan at a time

Each of these is its own checklist file. We do them in order, one at a time, and only
start when you say so.

1. [Overview](01-live-terminal-overview.md) — the master map: decisions, what we reuse,
   the look-and-feel, and how it all fits. (Reading, not building.)
2. [The shell + Go Live button](02-app-shell-and-go-live.md) — build the empty terminal
   screen (side icons, top bar, tabs, clock, footer) and the Go Live switch. No live
   data yet — just the frame you can click around in.
3. [The live pipes](03-realtime-plumbing.md) — connect real Binance prices and candles
   so numbers actually update in real time. Plumbing behind the scenes.
4. [The trading screen](04-trading-workspace.md) — the main chart with live price, your
   strategy's buy and sell signals drawn on it, and a symbol and timeframe picker. The
   order book and trade tape start as SIMULATED.
5. [Run strategies live](05-strategies-deployments.md) — pick a strategy, point it at a
   coin, and turn it on or off ("deploy", pause, kill). Shows live profit and trade
   count. This reuses the alert engine you already have.
6. [Alerts + broker nudge](06-alerts-and-webhooks.md) — the new home for your live
   alerts, plus the optional auto-ping to your broker when a signal fires (with a safe
   "test" mode).
7. [Live scorecard](07-analytics-live.md) — track how your live trades are actually
   doing (win rate, profit, drawdown, and so on) using the same math as your backtests,
   so the numbers line up. Live trades get saved so history sticks around.
8. [The remaining panels](08-placeholder-panels.md) — fill in the rest of the terminal
   (markets list, risk view, order book, funding, news) as tidy SIMULATED placeholders,
   built so we can make them real later. The order book is first in line to go real —
   the Binance how-to is already written ([ref-binance-orderbook.md](ref-binance-orderbook.md)).
9. [Real positions, risk and reconciliation](09-positions-risk-reconciliation.md) — show
   your real open positions and profit (read from your existing WAMP database that already
   tracks them), and check that every alert that fired actually opened a real position at
   the broker — so a "fired but nothing happened" can't slip by.
10. [Retire the old alerts](10-cutover.md) — once the new terminal is proven, make it the
   only home for live, and switch off the old alerts page (only after double-checking they
   behave the same, so nothing is lost).

For whoever builds this (for example Fable 5): the how-to-build guide is in
[EXECUTION-NOTES.md](EXECUTION-NOTES.md) — coding conventions, what to reuse, a mock-data
mode so panels can be built without a live connection, and the safety and reconnect rules.

## How you'll know it's working (the finish line)

1. You click Go Live and land in a clean trading terminal, separate from backtesting.
2. You see live Binance prices and candles for BTC and LTC updating on their own.
3. You can turn a strategy on live, watch its signals appear on the chart, and see it in
   a running list you can pause or stop.
4. When it triggers, you get an alert (and optionally your broker gets pinged).
5. A live scorecard tracks real performance with the same numbers as backtests.
6. The rest of the terminal looks complete, with anything not-yet-real clearly marked
   SIMULATED — and your old live alerts still work the whole time.

## Where we are

All plans are written but not started — nothing has been built yet. When you're ready,
say "let's start 02" and we begin, ticking off the checklist as we go.
