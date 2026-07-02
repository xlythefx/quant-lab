---
tags: [strategy]
type: strategy
---

# VWMA Reversion

`backend/services/strategies/vwma_reversion.py`. Z-score mean reversion around the **volume-weighted moving average**, gated by RSI bands and UTC [[Filters and Sessions|session windows]], with an ATR stop-loss. Long when oversold near the band, short when overbought. The reference strategy and the **only** one that uses [[Regime Detection]] entry gating.

## Regime gating (the method picker)

- `use_regime` (bool) = master switch. `regime_method` (select) = **adx** / **five** / **hmm**.
  - **adx** → [[ADX Regime]] binary filter.
  - **five** → [[5-Mood Regime]] membership (`allowed_regimes`).
  - **hmm** → [[HMM Regime]] moods (`allowed_hmm_moods`) — *backtest only, slower* (re-fits the model over the window; cached). Live skips HMM gating.
- Legacy `use_five_regime` is migrated to `regime_method` in the constructor.

## Other

- Self-contained indicators (VWMA, RSI, ATR, z-score) — no shared lib.
- Presets per symbol (BTC 15m, LTCUSDT, ZECUSDT). LTC trades ~24/7; FET/BTC use session windows → see [[Filters and Sessions]].
- Live `on_candle` is single-position; pyramiding>1 diverges from backtest.

Related: [[Strategies]] · [[Sizing and Fees]] · [[Validation and Overfitting]]
