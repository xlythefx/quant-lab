# Symbol Map — TradeStation

How TradeStation names symbols, how quant-laptop names symbols, and the
translation between them.

## TradeStation symbol conventions

| Form | Meaning | Example |
|---|---|---|
| `XXX` | Equity ticker | `AAPL`, `MSFT`, `SPY` |
| `@XXX` | **Continuous futures** (back-adjusted, rolls automatically) | `@ES`, `@NQ`, `@CL`, `@GC` |
| `XXXMYY` | **Specific futures contract** (month code + 2-digit year) | `ESM26` = E-mini S&P, June 2026; `NQU26` = Nasdaq, Sep 2026 |
| `XXX.X` | Options | varies — out of scope for now |

**Month codes** (CME convention, same in TS):
`F`=Jan `G`=Feb `H`=Mar `J`=Apr `K`=May `M`=Jun
`N`=Jul `Q`=Aug `U`=Sep `V`=Oct `X`=Nov `Z`=Dec

## quant-laptop canonical conventions

The existing repo uses simple uppercase tickers (`BTCUSDT`, `ES`, etc.).
For futures we extend this with explicit suffixes that disambiguate
continuous vs. contract — because mixing them silently is the kind of
bug that produces wrong backtests for months before anyone notices.

| Canonical symbol | Meaning | TS equivalent |
|---|---|---|
| `ES_CONT` | E-mini S&P 500 continuous | `@ES` |
| `ES_M26` | E-mini S&P 500 June 2026 contract | `ESM26` |
| `NQ_CONT` | Nasdaq-100 continuous | `@NQ` |
| `CL_CONT` | Crude oil continuous | `@CL` |
| ... | | |

Canonical symbol → provider symbol lives in
`backend/data/assets/tradestation.json` (same pattern as the existing
`yahoo.json`):

```json
{
  "ES_CONT":  { "ts_symbol": "@ES",  "asset_class": "future", "exchange": "CME",   "tick_size": 0.25,  "contract_size": 50 },
  "NQ_CONT":  { "ts_symbol": "@NQ",  "asset_class": "future", "exchange": "CME",   "tick_size": 0.25,  "contract_size": 20 },
  "MES_CONT": { "ts_symbol": "@MES", "asset_class": "future", "exchange": "CME",   "tick_size": 0.25,  "contract_size": 5  },
  "MNQ_CONT": { "ts_symbol": "@MNQ", "asset_class": "future", "exchange": "CME",   "tick_size": 0.25,  "contract_size": 2  },
  "CL_CONT":  { "ts_symbol": "@CL",  "asset_class": "future", "exchange": "NYMEX", "tick_size": 0.01,  "contract_size": 1000 },
  "GC_CONT":  { "ts_symbol": "@GC",  "asset_class": "future", "exchange": "COMEX", "tick_size": 0.10,  "contract_size": 100  }
}
```

The lookup is bidirectional in code:
- `to_provider("NQ_CONT")` → `"@NQ"` (used when calling TS endpoints)
- `to_canonical("@NQ")` → `"NQ_CONT"` (used when normalizing TS responses)

## Seed list (from Sinegual Lab sample exports)

The 59 sample CSVs at the Sinegual SSH path
`C:\Users\Administrator\Desktop\Api x SL\Csv Fixed session hours` mention
these futures roots — these are the symbols we'll need on day 1:

**Index futures**
ES, MES, NQ, MNQ, YM, MYM

**Energy**
CL, MCL, NG, RB, HO

**Metals**
GC, MGC, PL, HG

**FX futures**
EC (= 6E, Euro), JY (= 6J, Yen), BP (= 6B, British Pound)

**Softs / Ags**
S (Soybean), FC (Feeder Cattle), LC (Live Cattle), LH (Lean Hogs),
CT (Cotton)

**Note on legacy symbol codes:** the Sinegual files use older 2-letter
codes for FX (`EC`, `JY`, `BP`). Modern TS / CME naming is
`6E`, `6J`, `6B`. Both may resolve in TS — confirm during smoke-testing
which form `/v3/marketdata/barcharts/` accepts. The canonical
`backend/data/assets/tradestation.json` will use modern codes
(`6E_CONT` etc.) with an `aliases` array carrying the legacy codes
for the parser.

## Continuous vs front-month — the load-bearing decision

This deserves its own callout because it's silently bug-generating.

| Choice | Pros | Cons |
|---|---|---|
| **Continuous (`@ES`)** | One symbol forever; no rollover code; matches "long-term backtest" mental model | TS back-adjusts prices to remove rollover gaps, which **changes historical price levels** vs. what actually traded. Comparing to TS desktop's *contract-specific* runs will not match. |
| **Front-month contract (`ESM26`)** | Real prices that actually traded; matches Sinegual sample exports (those were run on `@ESM26`) | Requires rollover logic — you need to know which contract was front-month on each date and stitch together. |

The Sinegual sample `BD MD MOON ES TILL 25 APRIL.csv` was run with
TradeStation chart symbol `@ESM26` (per the embedded "Settings" section).
**For the validation/parity goal, the ingestion must match that** —
contract-specific, not continuous. Otherwise the comparison is invalid.

**Recommendation:** support **both** in storage. Use `source` and
`symbol` together as the primary key (see `architecture.md` and
`storage.md`), so `ES_CONT` and `ES_M26` are different rows. Strategies
declare which form they want. Lock this in `decisions.md` before any
code lands.

## Futures rollover (when we eventually do continuous correctly)

If we build our own continuous series from contract-specific data
(rather than trusting TS's `@`-prefixed back-adjusted series), the
options are:

- **Back-adjusted (panama):** subtract the rollover gap from all prior
  history. Preserves return-on-return calculations but distorts levels.
- **Ratio-adjusted:** multiply prior history by the ratio. Same idea,
  multiplicative.
- **Calendar-stitched (unadjusted):** raw concatenation, gaps visible.
  Accurate prices, broken for return calculations across rollovers.

Most academic / institutional code uses **panama**. TradeStation
defaults to panama too **[verify]**. If we ever emit our own
continuous series, match TS's convention so they're comparable.

This is **post-prototype** work. The prototype just stores whatever
contract Christian specifies for `@NQ`.

## Open question to confirm

- Did Christian mean `@NQ` (continuous) or a specific contract when he
  wrote "request NQ bars"? See `decisions.md`.
