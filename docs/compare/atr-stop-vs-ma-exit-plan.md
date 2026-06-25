# VWMA Reversion — ATR stop vs MA-only exit

**Status:** 📋 Planned · **Strategy:** `vwma_reversion` · **Symbol:** BTCUSDT

## The question in one line

When VWMA Reversion is in a trade, are we better off keeping the ATR stop-loss —
or removing it and exiting **only** when price reverts back to the VWMA, accepting
whatever happens in between, win or lose?

## Why this matters (plain words)

Mean-reversion strategies live with a built-in tension. A stop-loss caps the rare
disaster trade — the one where price keeps moving against you and never comes back.
But that same stop also kills trades that *would* have reverted to a profit if you'd
just held on a little longer, turning would-be winners into realized losers.

So a stop is not free insurance. It costs you something every time it cuts a trade
that would have recovered. This experiment measures that trade-off directly: **how
much do we actually lose (or gain) by turning the ATR stop on versus off?**

A second motive: the current ATR multiplier is **6×ATR**, which is a *wide* stop.
There's a real chance it barely ever fires — meaning the strategy is effectively
already running MA-only, and the stop is a knob that does almost nothing. This test
confirms or kills that suspicion too.

*Terms, defined once:*
- **ATR (Average True Range)** — a measure of how much price typically moves per bar.
  We size the stop as a multiple of it, so the stop is wide in volatile periods and
  tight in calm ones.
- **MA exit** — here the **VWMA** (volume-weighted moving average). The strategy's
  natural exit: close the trade when price crosses back to the average it strayed from.
- **Drawdown** — the worst peak-to-trough drop in account equity. The headline risk number.

## What "on" and "off" actually mean in the code

This is controlled by one boolean param, `atr_stop`:

- **ON (`atr_stop = True`)** — exit on whichever comes **first**: price reverts to the
  VWMA (the mean-reversion exit), **or** price moves `atr_mult × ATR` against the entry
  (the stop fires).
- **OFF (`atr_stop = False`)** — the strategy stops emitting its `atr` column, and the
  engine disables all stop logic. The **only** way out is price reverting to the VWMA.
  A losing trade stays open, however deep underwater, until price comes back — or until
  the test ends. **There is no safety net in this mode.**

Reference: `vectorized()` in
[backend/services/strategies/vwma_reversion.py](../../backend/services/strategies/vwma_reversion.py)
only attaches the `atr` column when `atr_stop` is on; the engine gates its stop logic
on that column's presence.

## Hypothesis (to be confirmed or killed)

- **ATR off** → higher win rate (more trades eventually revert to small wins), longer
  average holds, but **bigger worst-case losses and deeper max drawdown** (no cap on the tail).
- **ATR on** → smaller tail risk, but some would-be winners get cut into realized losses.
- **At mult = 6 the two may be nearly identical** because the stop rarely triggers. If so,
  the handful of trades where they differ *is* the whole story — look at those specifically.

Which side wins on **net return** is exactly what we don't know. That's the experiment.

## Method

**Fixed inputs**
- Symbol: BTCUSDT
- Window: ~1 year (use the longest cached window; record the exact start/end dates when run)
- Timeframe: 15m as the primary view; repeat on 5m and 1h as a robustness check
- All other params at current defaults; **pyramiding = 1** (one position at a time, so the
  comparison is clean and backtest/live stay comparable)

**Runs**
- **A** — `atr_stop = True` at current defaults (`atr_length = 10`, `atr_mult = 6`)
- **B** — `atr_stop = False` (MA-only exit)
- **Spectrum** — repeat run A across `atr_mult ∈ {2, 3, 4, 6, 10}`. On/off are just the two
  ends of a dial: a tiny multiplier ≈ a tight stop, a huge one ≈ no stop at all. The sweep
  shows the *shape* of the trade-off between those extremes, not just the endpoints.

## What to measure ("how much do we lose / gain")

- **Headline:** total return, in dollars and percent.
- **Risk:** max drawdown, worst single trade, average losing trade.
- **Quality:** win rate, profit factor, and the risk-adjusted return measures
  (Sharpe / Sortino / Calmar — return earned per unit of risk taken).
- **Behaviour:** number of trades, average holding time, and — for the ATR-on run —
  **how often the stop actually fired** versus how often the MA exit fired. If the stop
  almost never fires at mult 6, that alone is a finding: the knob is nearly inert.
- **The deep cut (the true cost of the stop):** for each trade the stop closed, ask what
  *would* have happened if it had been held to the MA exit — did it later revert to a win,
  or keep losing? Summed up, that is the precise, trade-by-trade cost/benefit of the stop.

## How we'll run it

Two options, simplest first:

1. **By hand in the UI** — toggle the ATR stop param, re-run the backtest, read the stats
   off the cards. Fast and fine for a first look, but eyeball-only and not reproducible.
2. **A small repeatable script** (preferred for the record) — loop `atr_stop` True/False and
   the `atr_mult` values through the same backtest engine and write a side-by-side comparison.
   Mirror the honest, reproducible style of the existing
   [backend/services/cost_sweep.py](../../backend/services/cost_sweep.py) harness. Dated output,
   no eyeballing.

## Honest caveats (read before trusting any number)

- **In-sample, one symbol, one year.** This is a research *lead*, not proof. The durable
  takeaway is the **direction** of the effect (does a stop help or hurt mean reversion here),
  not the exact "best" `atr_mult` — that specific number is curve-fit to this one year.
- **Confirm before acting.** Re-check any survivor with walk-forward and on at least one
  other symbol before changing how you actually trade.
- **Stops are checked on the bar close, not intrabar.** A fast move could fill worse in
  reality than the backtest shows, so the ATR-on results are mildly optimistic on the stop side.
- **Decide the rule before you look.** e.g. *"I'll drop the stop only if it adds ≥ X% return
  AND keeps max drawdown / worst trade within my tolerance."* Set the threshold first so the
  numbers can't talk you into it after the fact.

## Decision this informs

Whether to keep `atr_stop` on by default for BTCUSDT VWMA Reversion, tighten the multiplier,
or drop the stop entirely in favour of MA-only exits.

## Relationship to the "Strategy Sandbox" idea

This experiment is the concrete, near-term step. The interactive Sandbox (separate discussion)
is an optional later tool for exploring this kind of question by eye — we do the focused,
honest measurement first, then decide whether the Sandbox is still worth building.
