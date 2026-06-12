# Black-Scholes — what it is and how to use it here

A friendly guide. No quant background needed.

## The one idea

Black-Scholes' famous result is the **"expected move"**:

```
normal move  =  price  ×  volatility  ×  √time
```

It tells you **how big a price move is *normal*** right now. That's it. Everything
else (option prices, the Greeks) is built on top of that one idea.

Why we care: **VWMA Reversion is a "fade the move" strategy** — it buys when price
drops below its average and sells when it pops above, betting price comes back.

- If the move it's fading is a **normal-sized** move → coming back is likely → **safe**.
- If the move is a **freak / tail** move → it may keep running → **this is where the
  strategy bleeds.**

Black-Scholes gives us a clean, math-based line between "normal" and "freak."

## The one number to watch: `stretch`

```
stretch  =  how far price actually moved  ÷  the normal move
```

| stretch | meaning | what to do |
|--------|---------|-----------|
| ≤ 0.5  | very calm | textbook fade — safe |
| ≤ 1.0  | normal | safe to fade |
| 1–2    | stretched | fade with caution |
| > 2.0  | tail event | **do NOT fade** |

## How to run it (you can do this today)

A read-only report on any symbol you have cached — touches nothing, trades nothing:

```powershell
# default: BTCUSDT 15m
python scripts/black_scholes_demo.py

# pick a symbol / timeframe
python scripts/black_scholes_demo.py --symbol BTCUSDT --timeframe 1h

# CME futures (needs the parquet pulled already)
python scripts/black_scholes_demo.py --symbol ES --timeframe 1h --broker databento
```

You'll get a plain-English report: % of bars that are safe to fade, % that are tail
events, and a verdict on the most recent bar.

There's also a self-test of the textbook math (prices an option, recovers its vol):

```powershell
python backend/services/black_scholes.py
```

## Using it in your own code

```python
from services import black_scholes as bs

# df is any OHLCV frame (load_parquet gives you one)
fs = bs.fade_safety(df, vol_window=20, n_sigma=1.0)

fs["stretch"]    # the number above, per bar
fs["fade_safe"]  # True/False  (stretch <= 1)
fs["bs_move"]    # the "normal move" in price units
```

To gate VWMA Reversion entries on it, the change is one line — only enter when
`fade_safe` is True. We have **not** done that yet; the module is standalone and
safe to delete (`backend/services/black_scholes.py` + `scripts/black_scholes_demo.py`).

## The honest caveats

- `stretch` is measured against the **rolling mean / VWMA**, so on a trending market
  it stays high — that's correct (don't fade trends), not a bug.
- This uses **realized** (past) volatility. The *real* Black-Scholes superpower —
  **implied** volatility, the market's forward expectation — needs an **option data
  feed** (ES options via Databento, or Deribit for crypto). The pricer + implied-vol
  solver in the module are already built and tested for that day.
- Before trusting `fade_safe` as a filter, the quant-correct step is to check that
  your **losing** VWMA-reversion trades actually cluster in high-`stretch` bars. If
  they do, the filter has a real reason to exist — not just a backtest fit.

## Files

| File | What it is |
|------|-----------|
| `backend/services/black_scholes.py` | the toolkit (pricer, Greeks, implied vol, expected move, fade safety, reporting) |
| `scripts/black_scholes_demo.py` | the friendly report runner |
| `docs/black-scholes.md` | this guide |
