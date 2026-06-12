# How VWMA Reversion Works — in plain English

A simple, no-math walkthrough of what the **VWMA Reversion** strategy actually does.
The code lives in [backend/services/strategies/vwma_reversion.py](../backend/services/strategies/vwma_reversion.py).

---

## The one-sentence idea

> When price stretches unusually far **below** its recent average, buy and wait for it to snap
> back. When it stretches unusually far **above**, short and wait for it to fall back. The bet is
> that price tends to return ("revert") to its average.

That's it. Everything else is just **how it decides "unusually far"** and **when it's allowed to
play**.

---

## The center line it watches: the VWMA

**VWMA = Volume-Weighted Moving Average.** It's the recent average price, but bars with more
volume count more. Think of it as "where the crowd has been trading lately" — a fairer center
than a plain average because it leans toward the prices people actually traded at.

The strategy assumes price wanders away from this line and then comes back. The VWMA is the
yellow line you see on the chart.

---

## How it measures "too far": the z-score

Price is always a little above or below the VWMA — that's normal. The strategy needs to know when
the gap is **abnormally** large. It uses a **z-score**, which just means:

> "How many *typical wiggles* away from the average are we right now?"

- A z-score of **0** = price is sitting right on the average.
- A z-score of **−1.5** = price is one-and-a-half "typical moves" *below* average (looks oversold).
- A z-score of **+1.5** = one-and-a-half typical moves *above* average (looks overbought).

The default trigger is **1.5**. So the strategy only gets interested once price has stretched
about 1.5 "normal wiggles" away from the line. The dashed bands on the chart mark this trigger
distance.

---

## The second opinion: RSI

The z-score alone can be fooled, so the strategy asks a second indicator to agree. **RSI**
(Relative Strength Index) is a classic 0–100 "is it oversold or overbought?" gauge.

- To go **long**, it wants RSI **below ~35** (confirming oversold).
- To go **short**, it wants RSI **above ~65** (confirming overbought).

Both the z-score **and** the RSI have to agree before it acts. Two filters, fewer false alarms.

---

## When it's allowed to trade: sessions

The market behaves differently at different times of day. By default the strategy only opens
**new** trades during specific **UTC time windows** (it ships with Tokyo, London, and NY-morning
turned on). Outside those windows it sits on its hands.

You can flip on **"trade 24/7"** to ignore the clock entirely. (Exits are never blocked by the
clock — if you're in a trade, it can always get you out.)

---

## Putting an entry together

To **open a long**, all of these must be true at the same time:

1. Price is **z-score below −1.5** (stretched well under the VWMA), **and**
2. RSI is **below ~35** (confirmed oversold), **and**
3. It's inside an **allowed session window**, **and**
4. (optional) the **market regime** allows it — see below.

Shorts are the mirror image (stretched above, RSI overbought).

---

## How it gets out

A trade closes for one of two reasons:

1. **It worked — price reverted.** Price climbs back to the VWMA center line (for a long) or
   falls back to it (for a short). Goal achieved, take the trade off. This is the *intended* exit.
2. **It didn't — the stop hit.** If price keeps going the wrong way, an **ATR stop-loss** cuts the
   trade. ATR ("Average True Range") just measures how big the bars have been lately, so the stop
   automatically sits wider in choppy markets and tighter in calm ones. The default stop is
   **6× ATR** away from entry — fairly loose, giving the reversion room to happen.

So: **win by reverting to the average, or lose a controlled amount if the stop is hit.**

---

## Optional safety switch: the regime filter

Mean reversion's worst enemy is a strong **trend** — if price is marching one direction, "it'll
snap back" keeps losing. The strategy has an optional **regime filter** to stay out of trends:

- **Simple version (ADX):** a trend-strength gauge. If the market is trending hard, block new
  entries.
- **5-regime version:** labels the market as *Trending Up / Trending Down / High-Volatility /
  Quiet / Choppy-Range*, and you pick which labels are allowed to trade (defaults: only **Quiet**
  and **Choppy-Range**, the calm sideways markets reversion likes).

This is **off by default** — turn it on if a strategy is bleeding in trends.

---

## The knobs you can turn

| Knob | Plain meaning | Default |
|---|---|---|
| **VWMA length** | How many bars the center-line average looks back over | 30 |
| **Z threshold** | How stretched price must be before acting (higher = pickier) | 1.5 |
| **RSI length / long-max / short-min** | The oversold/overbought confirmation band | 25 / 35 / 65 |
| **ATR stop / length / mult** | The safety stop and how wide it sits | on / 10 / 6× |
| **Sessions / trade 24/7** | What times of day new trades are allowed | Tokyo+London+NY-am |
| **Sides** | Allow longs, shorts, or both | both |
| **Regime filter** | Skip trades in trending markets | off |
| **Risk %** | How much of your account each trade uses | 3% |
| **Pyramiding** | How many trades it can stack in the same direction | 1 (no stacking) |

There are also **built-in presets** tuned per symbol (BTC 15m, LTC, ZEC) so you don't have to dial
everything in from scratch.

---

## A worked example

> On BTC 15-minute bars, price drops sharply during the London session. It's now **1.8 "typical
> moves" below** the VWMA (z = −1.8, past the 1.5 trigger) and RSI has fallen to **30** (below 35).
> Both filters agree, it's an allowed session, and the market isn't trending. → **Buy.**
>
> Two hours later price drifts back up and touches the VWMA line. → **Sell, trade closed for a
> profit.** (If instead it had kept crashing 6×ATR below entry, the stop would have closed it for a
> small controlled loss.)

---

## Two honest caveats

- **It's a "fade" strategy.** It profits from calm, range-bound, choppy markets and *struggles in
  strong trends* — that's the nature of betting on reversion. The regime filter exists for exactly
  this reason.
- **Live ≠ backtest with pyramiding.** The backtest can stack multiple trades (pyramiding); the
  live runner currently holds only one position at a time. If you set pyramiding > 1, live results
  won't match the backtest curve (noted in the code).

---

## Where it lives in the app

- **Chart overlays:** the yellow **VWMA** line + the two dashed **±z·σ bands** (the trigger
  distance).
- **Dashboard:** add it, pick a symbol/timeframe, hit **Run Backtest**.
- **Tuning it:** the **Settings** panel exposes every knob above; **Walk-Forward** tests whether a
  given setting holds up out-of-sample before you trust it.
