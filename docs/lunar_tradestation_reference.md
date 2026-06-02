# Lunar Strategy — TradeStation Reference Benchmark

> **Purpose:** Reference target for Python backtest comparison. Not a goal to match exactly —
> fill-price differences (next-bar open vs exact level) will cause natural divergence.
> Use this to validate direction, trade count, and rough magnitude.

## Setup

| Field | Value |
|---|---|
| Instrument | @ES (E-mini S&P 500) |
| Platform | MultiCharts / TradeStation datafeed |
| Session | Default (17:00–16:00 ET) |
| Timeframe | 60m + 1380m (data2 for ATR) |
| Strategy | Bias - Multiday - Moon Cycle Engine QTLab |
| In-Sample | 01 Jan 2008 → 31 Dec 2019 |
| Out-of-Sample | 01 Jan 2020 → today |
| Contracts | 1 |
| Stop | $1,750 |
| Target | $3,250 |
| Max Bars | 345 bars (~15 days) |

---

## Performance Summary

### P&L

| Metric | All Trades | Long | Short |
|---|---:|---:|---:|
| Total Net Profit | $85,299.70 | $71,687.09 | $13,612.61 |
| Gross Profit | $202,702.32 | $144,771.12 | $57,931.20 |
| Gross Loss | -$117,402.62 | -$73,084.03 | -$44,318.59 |
| Profit Factor | 1.73 | 1.98 | 1.31 |
| Adjusted Net Profit | $51,958.63 | $44,149.78 | -$5,193.89 |
| Adjusted Profit Factor | 1.40 | 1.52 | 0.90 |

### Trade Stats

| Metric | All | Long | Short |
|---|---:|---:|---:|
| Total Trades | **180** | 121 | 59 |
| Win Rate | **60.00%** | 64.46% | 50.85% |
| Winners | 108 | 78 | 30 |
| Losers | 72 | 43 | 29 |
| Avg Trade Net Profit | $473.89 | $592.46 | $230.72 |
| Avg Winner | $1,876.87 | $1,856.04 | $1,931.04 |
| Avg Loser | -$1,630.59 | -$1,699.63 | -$1,528.23 |
| Avg Win / Avg Loss | 1.15 | 1.09 | 1.26 |
| Largest Winner | $3,249.79 | $3,249.79 | $3,249.79 |
| Largest Loser | -$1,762.71 | -$1,762.71 | -$1,750.21 |

> **Note:** Largest winner ≈ $3,250 (target hit). Largest loser ≈ $1,750–1,763 (stop hit ± slippage).
> This confirms stop/target logic is working in TS.

### Bars / Time

| Metric | All | Winners | Losers |
|---|---:|---:|---:|
| Avg Bars in Trade | 69.86 | 77.80 | 57.94 |
| Avg Time in Trade | 3d 23h 56m | 4d 12h 20m | 3d 5h 20m |
| Avg Time Between Trades | 15d 18h 28m | — | — |

### Returns

| Metric | Value |
|---|---|
| Return on Initial Capital | 85.30% |
| Annual Rate of Return | 6.22% |
| Return on Account | 593.13% |
| Avg Monthly Return | $380.59 |
| Std Dev Monthly Return | $2,466.36 |
| Sharpe Ratio | 0.21 |
| RINA Index | 402.95 |
| % Time in Market | 19.88% |
| Trading Period | 9Y 10M 26d |

### Drawdown

| Metric | All | Long | Short |
|---|---:|---:|---:|
| Max DD (Intra-day) | -$14,718.80 | -$14,993.59 | -$10,927.52 |
| Max DD as % Capital | 14.72% | 14.99% | 10.93% |
| Max DD (Close-to-Close) | -$14,381.30 | -$13,881.09 | -$9,053.36 |
| Max Trade Drawdown | -$1,762.50 | -$1,762.50 | -$1,750.00 |
| Net Profit / Max DD | 579.53% | 478.12% | 124.57% |

### Streaks

| Metric | Value |
|---|---|
| Max Consecutive Winners | 10 |
| Max Consecutive Losers | 5 |

### Costs

| Metric | Value |
|---|---|
| Total Slippage | $36.00 |
| Total Commission | $1.80 |
| Account Size Required | $14,381.30 |

---

## Trade Series Analysis

### Winning Series
| Series Length | # Occurrences | Avg Gain/Series | Avg Loss Next Trade |
|---:|---:|---:|---:|
| 1 | 17 | $1,861.55 | -$1,506.83 |
| 2 | 12 | $1,775.31 | -$1,751.35 |
| 3 | 4 | $2,468.54 | -$1,487.71 |
| 4 | 5 | $1,026.04 | -$1,750.21 |
| 5 | 1 | $2,579.79 | -$1,750.21 |
| 6 | 2 | $2,025.83 | -$1,750.21 |
| 8 | 1 | $2,637.29 | -$1,750.21 |
| 10 | 1 | $1,999.79 | -$1,750.21 |

### Losing Series
| Series Length | # Occurrences | Avg Loss/Series | Avg Gain Next Trade |
|---:|---:|---:|---:|
| 1 | 23 | -$1,705.10 | $2,349.25 |
| 2 | 12 | -$1,582.50 | $993.54 |
| 3 | 4 | -$1,454.38 | $2,215.41 |
| 4 | 2 | -$1,750.21 | $3,249.79 |
| 5 | 1 | -$1,750.21 | $3,249.79 |

---

## Key Validation Targets for Python Backtest

When comparing Python output, focus on these — they should be in the right ballpark:

| Check | TS Value | Tolerance |
|---|---|---|
| **Total trades** | **180** | ±15 trades |
| **Win rate** | **60%** | ±5% |
| **Largest winner** | ~$3,250 | Should be near target level |
| **Largest loser** | ~-$1,750 | Should be near stop level |
| **Profit factor** | 1.73 | >1.5 good |
| **Long / Short split** | 121 / 59 | Long-heavy is expected |
| **Avg bars in trade** | ~70 | Should not be near 345 (maxbars firing too often) |
| **% time in market** | ~20% | Confirms infrequent entry |

## Known Remaining Differences (Python vs TS)

Even after Option-A fixes, these gaps remain and cause natural divergence:

| Difference | Impact |
|---|---|
| Fill at next-bar open (Python) vs exact stop/target price (TS) | Slightly worse fills on stops, slightly worse on targets |
| Same-bar stop+target: Python checks stop first | Rare but can flip a win to a loss |
| No overnight gap handling for stop levels | Gaps through stop fill at open, not stop price |

> These would be fixed by **Option B** (engine-level dollar stop/target support).
