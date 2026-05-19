# Backtest Engine Notes

A reference for how the backtest engine, strategies, Monte Carlo, and risk config interact. Read top-to-bottom when you want to double-check the model, or when a result surprises you. Update this file when the engine changes.

The intent is twofold: explain how things work today, and call out the assumptions you should periodically verify against reality.

---

## Bar timing model (entries, exits, stops)

The engine is strictly causal — no lookahead.

Every decision works on a one-bar lag:

- Indicators are computed using only data up to and including bar `t`.
- Entry, exit, and stop checks read the signal at the **close of bar `t-1`**.
- The trade fills at the **open of bar `t`**, with slippage applied against you (longs pay a bit more, shorts receive a bit less).
- Position sizing uses MTM equity at the close of bar `t-1` (no peek at bar `t` close).

That contract is the same for entries, mean-revert exits, and ATR-stop exits. It's implemented in `backend/services/backtest_engine.py:160` onward.

What this means in practice: a signal that forms at 10:00 close gets filled at the 10:05 open (on a 5m chart). You never trade at the same close you observed the signal on.

Things to verify periodically:

- The strategy's `vectorized()` function returns the right column names (`cond_long`, `cond_short`, `bar_exit_long`, `bar_exit_short`, optionally `atr`). The engine prefers those over the legacy one-shot `entry_long` / `exit_long` arrays.
- All indicators in the strategy are causal (`rolling`, `ewm(adjust=False)`, `shift(1)`). No mean-of-future-bars, no centered windows.

---

## Fills, slippage, fees

Fills happen at the next bar's open. Slippage and fees come from `backend/data/risk_config.json`:

- `slippage_bps` — basis points applied to the fill (against you, both sides).
- `fee_flat` — flat dollars per trade, each side.
- `fee_pct` — percent of notional per trade, each side.

There is one source of truth for fees in the whole system — risk config. Backtest, Monte Carlo, and walk-forward all run through `backtest_engine.run()`, so changing the config changes every metric at once.

The only fill that does **not** include slippage is the final force-close at the end of the dataset (any tranche still open on the last bar gets marked-to-market at `close[-1]` with fees but no slip). This is a minor convenience for trade-list completeness — it doesn't shift the equity curve.

Things to verify:

- Are your slippage / fee values realistic for the venue you intend to trade?
- Default values shipped in `risk_config.py` (0.04% fee, 1bp slip) are sane starting points for spot crypto. Futures or low-liquidity pairs may need higher slip.

---

## Position sizing

Each tranche is sized as `(current_equity × risk_pct) / fill_price`.

A few consequences worth knowing:

- "Current equity" means MTM equity at the close of bar `t-1`, including unrealized PnL of any open tranches. As equity grows, new tranches grow with it (compounding). As equity drops, new tranches shrink (drawdown protection).
- This is **not** "fixed cash per trade" like TradingView's `strategy.cash` mode. To match a TV script that uses fixed cash, you need to either (a) match the dollar amount only at the first trade and accept divergence over time, or (b) we'd need a `qty_type=fixed_cash` mode added to the engine. See "Possible paths" below.
- With pyramiding > 1, total notional can exceed equity. That's by design — but be aware when reading Sharpe and max-drawdown values.

Things to verify:

- `risk_pct` in `risk_config.json` is on a percent scale (10 = 10%, not 0.10).
- `pyramiding` value matches your intent. Default is 1. Strategies that stack into trends or mean reversions usually want higher.

---

## Stops (ATR-based)

The VWMA Reversion strategy has an optional ATR stop, toggled via the `atr_stop` param (default on).

When enabled:

- Stop level for a long tranche: `entry_price − atr_mult × atr_at_entry`.
- The stop is checked at the **close** of each bar, not intra-bar.
- A triggered stop fills at the **next** bar's open.

So a wick that pierces the stop level mid-bar but recovers by close is **not** treated as a stop-out. This is consistent with the rest of the engine's "decisions at close, fills at next open" model, but it diverges from TradingView's `strategy.exit(stop=…)` which checks intra-bar against the bar's high/low and fills at the stop level.

When `atr_stop` is off, the strategy stops emitting the `atr` column, and the engine's `has_atr_stop` check evaluates to false automatically — no other settings need changing.

Things to verify:

- If your TradingView reference doesn't use a stop (e.g. just a mean-revert exit), turn `atr_stop` off here too. Otherwise our equity curve will close trades that TV holds through.
- If you want to match TradingView-style intra-bar stops, see "Possible paths" below.

---

## Exits (mean reversion)

VWMA Reversion exits a long when the close crosses back through the VWMA (`close >= mean`), short when `close <= mean`.

A few details:

- The exit signal is observed at the close of bar `t-1` and the fill happens at the open of bar `t`, same as entries.
- All open tranches on the same side close together when the exit signal fires (TV's `strategy.close("Long")` behaves the same way — closes the whole "Long" position).

---

## Z-score

The z-score uses **population** standard deviation (`ddof=0`), not sample (`ddof=1`).

This matters because:

- Pandas `.std()` defaults to `ddof=1`, which biases the denominator and shrinks z-scores by about 2% at length=23. We override it.
- TradingView's `ta.stdev()`, NumPy's `np.std()`, and TA-Lib's `STDDEV` all use population. The pandas default is the outlier.
- Mathematically, a rolling window of N closes is **the** distribution you're describing — not a sample of an unknown larger one. Sample stdev is for inferring an unknown population variance, which is not what we're doing.

Things to verify:

- The fix lives in `backend/services/strategies/vwma_reversion.py`. If you add a new mean-reversion strategy, use `ddof=0` there too.

---

## Indicators

All implemented self-contained inside each strategy, using only pandas/numpy:

- **VWMA** — rolling sum of `close × volume` over the rolling sum of volume. Standard formula. Matches `ta.vwma`.
- **RSI** — Wilder's smoothing via `ewm(alpha=1/length, adjust=False)`. Matches `ta.rsi`.
- **ATR** — same Wilder smoothing on true range. Matches `ta.atr`.

All three are strictly causal. None use centered windows or future bars.

Things to verify:

- Volume column conventions. Binance spot vs futures, and Binance vs Bitfinex, report volume differently. If you change data sources, VWMA values will shift.

---

## Sessions

Session windows are stored as UTC times in the strategy params.

- Each session has `enabled`, `start`, `end` keys.
- Times wrap across midnight if `start > end`.
- TradingView's `time(timeframe.period, "HHMM-HHMM")` uses **exchange time** for the chart, which on Binance happens to be UTC — but if you ever wire up a venue in another zone, this mismatch will bite.
- A "trade 24/7" toggle bypasses the session filter entirely.

Things to verify:

- Your session windows match the TradingView reference, accounting for any DST shifts in the reference's exchange.
- If your TV script uses one wide session (00:00-23:45) as a "trade anytime" hack, our equivalent is `trade_24_7 = True`, not "enable all sessions" (since our defaults are narrow).

---

## Pyramiding

Engine-level, controlled by `risk_config.pyramiding`.

- Each new entry signal opens a new tranche, up to `max_tranches`.
- Each tranche is sized independently off current MTM equity.
- Exits close all tranches on that side.
- ATR stops are per-tranche: each tranche records its `atr_at_entry` at fill time and uses that to compute its own stop level.

Things to verify:

- Pyramiding matches your TradingView `pyramiding=` setting.
- For a strategy you intend to "trade once, hold until reversion", `pyramiding=1` is correct.

---

## Monte Carlo

Three methods, all in `backend/services/monte_carlo.py`. All three start from a base backtest produced by `backtest_engine.run()`, so they automatically inherit fees, slippage, sizing, stops, and sessions:

- **trade_bootstrap** — resamples per-trade `pnl_dollars` with replacement.
- **block_bootstrap** — resamples per-bar equity returns in blocks (preserves short-term autocorrelation).
- **synthetic_paths** — bootstraps OHLC relative returns in blocks to build synthetic price series, then re-runs the strategy on each path. Most expensive.

No fee or slip config is needed at the Monte Carlo layer — change the global risk config and every method picks it up.

Things to verify:

- Number of sims is high enough for stable distributions (1000 is fine for trade/block bootstrap; cap synthetic at 200 because it re-runs the engine).
- Block size is reasonable. Default is `n^(1/3)` rounded — for 50k bars, that's around 37, which is fine for short-term momentum/reversion strategies.

---

## Per-symbol defaults

A strategy class can declare `SYMBOL_DEFAULTS = {SYMBOL: {param: value, ...}}`. These are exposed through the `/api/strategies` endpoint and applied by the dashboard's "Reset Defaults" button when that symbol is selected.

The merge is sparse: only fields that differ from the universal schema defaults need to be listed. For nested types (`sessions`, `sides`), sub-keys merge rather than replace, so you can override just `ny_pm.enabled` without wiping out `start` / `end`.

Things to verify:

- When you add a preset for a new symbol, sanity-check by hitting Reset Defaults on the dashboard with that symbol selected.

---

## Things worth periodically auditing

A short list of things that are easy to drift out of sync:

- The set of enabled sessions on each active strategy. Easy to forget after a research session.
- Fee and slippage in `risk_config.json` vs the venue you actually plan to trade.
- Pyramiding value — if you copy a strategy idea from TradingView, theirs might be 10 while ours defaults to 1.
- ATR stop on/off. The default is on, but plenty of reference Pine scripts compute ATR for visualization only and never use it as a stop.
- Symbol presets — when you add a new strategy or rename params, presets can silently drift to defaults if the param name changes.

---

## Possible paths forward

Things we could build if you want closer parity with reference platforms or more realistic backtests. None are urgent; pick when motivated.

**Fixed-cash position sizing.** Add a `qty_type` to risk config (`pct_equity` vs `fixed_cash`). Would let you match TradingView's `default_qty_type=strategy.cash` exactly. Small engine change in the entry sizing block.

**Intra-bar stop checks.** A flag in risk config that switches the ATR-stop test from "close ≤ stop" to "low ≤ stop, fill at stop price". Makes stops more honest but increases stop count. Same change for shorts using `high`. Useful when you want to study how robust a strategy is to wick-driven stop-outs.

**Exchange-timezone sessions.** Per-symbol exchange tz on the dataset metadata, with session times rendered/applied in that tz. Removes the silent UTC assumption.

**Hide ATR Length / ATR Multiplier in the editor when `atr_stop` is off.** Cosmetic — the params are inert when off, but showing them implies they matter. Pure frontend change.

**Symbol presets browser.** Read the `SYMBOL_DEFAULTS` of every strategy into a "Presets" tab on the Strategies page so it's easy to see which symbols have curated defaults.

**Pine-script importer.** A guided form that asks for the key TradingView strategy properties (`pyramiding`, `default_qty_type`, `commission`, etc.) and translates them into our risk config + strategy params. Helps avoid the divergence we hit on LTCUSDT — most of those mismatches are recoverable from the Pine `strategy()` header.

**Realistic stop modeling combined with gap detection.** When `open[t]` gaps past the stop level, fill at the open (worse than the stop, like reality). When intra-bar low touches stop without gapping, fill at the stop. Two-tier model.

**Multi-symbol portfolio backtest.** Today each strategy runs against one symbol. A portfolio mode would aggregate equity across multiple symbols with a shared starting capital and per-symbol risk allocation.
