# Lunar Strategy — TradeStation ES Backtest (2018–2026)

> **This is the primary Python comparison reference** — overlaps exactly with our available
> ES 1h parquet (May 2016 – May 2026). First trade: 4/6/2018. Use this for trade-by-trade diff.
> See also: `lunar_tradestation_reference.md` for the longer 2008–2026 IS/OS summary.

## Setup

| Field | Value |
|---|---|
| Instrument | @ES (E-mini S&P 500 Futures) |
| Platform | MultiCharts / TradeStation datafeed |
| Session | Default (17:00–16:00 ET) |
| Timeframe | 60m + 1380m (data2 for ATR) |
| Stop | $1,750 / contract |
| Target | $3,250 / contract |
| Max Bars | 345 |
| Contracts | 1 fixed |
| Period | 4/6/2018 → 4/6/2026 (~8 years) |

---

## Performance Summary

### P&L

| Metric | All | Long | Short |
|---|---:|---:|---:|
| Total Net Profit | $89,904.74 | $59,664.61 | $30,240.13 |
| Gross Profit | $188,679.21 | $128,685.51 | $59,993.70 |
| Gross Loss | -$98,774.47 | -$69,020.90 | -$29,753.57 |
| Profit Factor | 1.91 | 1.86 | 2.02 |
| Adjusted Net Profit | $57,858.77 | $33,259.53 | $12,070.53 |
| Adjusted Profit Factor | 1.52 | 1.42 | 1.33 |

### Trade Stats

| Metric | All | Long | Short |
|---|---:|---:|---:|
| Total Trades | **156** | 109 | 47 |
| Win Rate | **63.46%** | 63.30% | 63.83% |
| Winners | 99 | 69 | 30 |
| Losers | 57 | 40 | 17 |
| Avg Trade Net Profit | $576.31 | $547.38 | $643.41 |
| Avg Winner | $1,905.85 | $1,865.01 | $1,999.79 |
| Avg Loser | -$1,732.89 | -$1,725.52 | -$1,750.21 |
| Win/Loss Ratio | 1.10 | 1.08 | 1.14 |
| Largest Winner | **$3,249.79** | $3,249.79 | $3,249.79 |
| Largest Loser | **-$1,762.71** | -$1,762.71 | -$1,750.21 |

### Returns

| Metric | Value |
|---|---|
| Return on Initial Capital | 89.90% |
| Annual Rate of Return | 6.47% |
| Return on Account | 741.32% |
| Sharpe Ratio | 0.28 |
| RINA Index | 666.44 |
| % Time in Market | 12.56% |
| Avg Monthly Return | $505.59 |
| Avg Bars in Trade | 52.25 (winners: 60.14, losers: 38.54) |
| Avg Time in Trade | 2d 21h 59m |

### Drawdown

| Metric | All | Long | Short |
|---|---:|---:|---:|
| Max DD (Intra-day) | -$12,927.52 | -$14,993.59 | -$7,788.34 |
| Max DD Date | 3/22/2023 | | |
| Max DD % | 12.93% | 14.99% | 7.79% |
| Max DD (Close-to-Close) | -$12,127.73 | -$13,881.09 | -$6,876.05 |
| Max Trade Drawdown | -$1,762.50 | -$1,762.50 | -$1,750.00 |
| Net Profit / Max DD | 695.45% | | |

---

## Annual Breakdown

| Year | Net Profit | % Gain | PF | Trades | Win% |
|---|---:|---:|---:|---:|---:|
| 2018 | $5,822.48 | 5.82% | 1.75 | 12 | 58.33% |
| 2019 | $14,895.91 | 14.08% | 2.70 | 20 | 75.00% |
| 2020 | $19,821.22 | 16.42% | 2.87 | 19 | 63.16% |
| 2021 | $23,396.12 | 16.65% | 3.99 | 19 | 73.68% |
| 2022 | $5,745.59 | 3.50% | 1.33 | 21 | 52.38% |
| 2023 | $7,745.38 | 4.56% | 1.49 | 22 | 59.09% |
| 2024 | -$2,003.99 | -1.13% | 0.87 | 19 | 52.63% |
| 2025 | $8,108.30 | 4.62% | 1.66 | 20 | 65.00% |
| 2026 YTD | $6,373.74 | 3.47% | 2.82 | 6 | 66.67% |

> **Best years:** 2021 (+16.65%, PF 3.99) and 2020 (+16.42%, PF 2.87) — COVID volatility
> **Worst year:** 2024 (-1.13%, PF 0.87) — only losing year

## Monthly Average

| Month | Avg Profit | Avg % | Win% |
|---|---:|---:|---:|
| January | $552.76 | 0.55% | 66.67% |
| February | $1,559.03 | 1.00% | 78.57% |
| March | $2,044.94 | 1.30% | 81.25% |
| April | $1,305.25 | 0.82% | 66.67% |
| May | -$248.78 | -0.16% | 40.00% |
| June | $1,448.20 | 0.97% | 72.73% |
| July | -$436.23 | -0.29% | 38.46% |
| August | $2,585.62 | 1.73% | 85.71% |
| September | $1,377.74 | 0.90% | 62.50% |
| October | $1,104.29 | 0.72% | 56.25% |
| November | $598.12 | 0.39% | 69.23% |
| December | -$816.03 | -0.52% | 35.29% |

> **Best months:** August, March, February — **Worst months:** December, July, May

---

## Full Trade List

> Format: `# | Type | Date | Signal | Entry | Exit | P&L`
> Signals: LE=Long Entry, LX=Long Exit, SE=Short Entry, SX=Short Exit

| # | Side | Entry Date | Signal | Entry $ | Exit Date | Exit Signal | Exit $ | P&L |
|---|---|---|---|---:|---|---|---:|---:|
| 1 | L | 4/6/2018 1:00 | LE - Full Moon | 3339.25 | 4/6/2018 14:00 | Stop Loss | 3304.25 | -1750.21 |
| 2 | L | 5/30/2018 1:00 | LE - Full Moon | 3397.00 | 6/6/2018 2:00 | Profit Target | 3462.00 | +3249.79 |
| 3 | L | 6/29/2018 1:00 | LE - Full Moon | 3429.75 | 7/9/2018 20:00 | Profit Target | 3494.75 | +3249.79 |
| 4 | L | 7/29/2018 19:00 | LE - Full Moon | 3515.75 | 8/13/2018 1:00 | LX - Full Moon Exit | 3522.25 | +324.79 |
| 5 | L | 8/28/2018 1:00 | LE - Full Moon | 3599.75 | 9/11/2018 1:00 | LX - Full Moon Exit | 3584.75 | -750.21 |
| 6 | L | 9/26/2018 1:00 | LE - Full Moon | 3622.75 | 10/4/2018 13:00 | Stop Loss | 3587.75 | -1750.21 |
| 7 | S | 10/10/2018 1:00 | SE - New Moon | 3581.25 | 10/10/2018 15:00 | Profit Target | 3516.25 | +3249.79 |
| 8 | L | 10/25/2018 1:00 | LE - Full Moon | 3364.50 | 10/25/2018 18:00 | LX-Breakeven | 3367.00 | +124.79 |
| 9 | L | 11/23/2018 1:00 | LE - Full Moon | 3330.50 | 11/28/2018 12:00 | Profit Target | 3395.50 | +3249.79 |
| 10 | S | 12/9/2018 19:00 | SE - New Moon | 3310.00 | 12/11/2018 5:00 | Stop Loss | 3345.00 | -1750.21 |
| 11 | L | 12/24/2018 1:00 | LE - Full Moon | 3121.25 | 12/24/2018 7:00 | Stop Loss | 3086.25 | -1750.21 |
| 12 | L | 12/25/2018 19:00 | LE - Full Moon | 3037.00 | 12/26/2018 10:00 | LX-Breakeven | 3039.50 | +124.79 |
| 13 | L | 1/22/2019 1:00 | LE - Full Moon | 3343.25 | 1/22/2019 15:00 | Stop Loss | 3308.25 | -1750.21 |
| 14 | S | 2/6/2019 1:00 | SE - New Moon | 3423.25 | 2/12/2019 7:00 | SX-Breakeven | 3420.75 | +124.79 |
| 15 | L | 2/20/2019 1:00 | LE - Full Moon | 3468.50 | 2/27/2019 10:00 | LX-Breakeven | 3471.00 | +124.79 |
| 16 | S | 3/7/2019 1:00 | SE - New Moon | 3457.00 | 3/11/2019 10:00 | SX-Breakeven | 3454.50 | +124.79 |
| 17 | L | 3/21/2019 1:00 | LE - Full Moon | 3515.25 | 3/22/2019 9:00 | LX-Breakeven | 3517.75 | +124.79 |
| 18 | L | 4/22/2019 1:00 | LE - Full Moon | 3590.00 | 5/2/2019 11:00 | LX-Breakeven | 3592.50 | +124.79 |
| 19 | S | 5/7/2019 1:00 | SE - New Moon | 3603.25 | 5/9/2019 9:00 | Profit Target | 3538.25 | +3249.79 |
| 20 | L | 5/20/2019 1:00 | LE - Full Moon | 3557.75 | 5/20/2019 8:00 | Stop Loss | 3522.75 | -1750.21 |
| 21 | L | 5/21/2019 1:00 | LE - Full Moon | 3541.75 | 5/23/2019 9:00 | Stop Loss | 3506.75 | -1750.21 |
| 22 | L | 6/19/2019 1:00 | LE - Full Moon | 3609.00 | 6/25/2019 13:00 | LX-Breakeven | 3611.50 | +124.79 |
| 23 | S | 7/3/2019 1:00 | SE - New Moon | 3657.50 | 7/11/2019 20:00 | Stop Loss | 3692.50 | -1750.21 |
| 24 | L | 7/18/2019 1:00 | LE - Full Moon | 3661.00 | 7/31/2019 14:00 | LX-Breakeven | 3663.50 | +124.79 |
| 25 | S | 8/1/2019 1:00 | SE - New Moon | 3662.75 | 8/2/2019 10:00 | Profit Target | 3597.75 | +3249.79 |
| 26 | L | 8/16/2019 1:00 | LE - Full Moon | 3544.50 | 8/19/2019 7:00 | Profit Target | 3609.50 | +3249.79 |
| 27 | L | 9/16/2019 1:00 | LE - Full Moon | 3670.00 | 9/25/2019 10:00 | Stop Loss | 3635.00 | -1750.21 |
| 28 | S | 10/1/2019 1:00 | SE - New Moon | 3669.75 | 10/2/2019 4:00 | Profit Target | 3604.75 | +3249.79 |
| 29 | L | 10/15/2019 1:00 | LE - Full Moon | 3653.50 | 10/28/2019 9:00 | Profit Target | 3718.50 | +3249.79 |
| 30 | L | 11/13/2019 1:00 | LE - Full Moon | 3764.00 | 11/27/2019 1:00 | LX - Full Moon Exit | 3824.50 | +3024.79 |
| 31 | L | 12/12/2019 1:00 | LE - Full Moon | 3825.25 | 12/19/2019 16:00 | Profit Target | 3890.25 | +3249.79 |
| 32 | S | 12/29/2019 19:00 | SE - New Moon | 3918.25 | 1/8/2020 5:00 | SX-Breakeven | 3915.75 | +124.79 |
| 33 | L | 1/12/2020 19:00 | LE - Full Moon | 3944.50 | 1/21/2020 21:00 | Profit Target | 4009.50 | +3249.79 |
| 34 | S | 1/26/2020 19:00 | SE - New Moon | 3936.00 | 1/30/2020 16:00 | Stop Loss | 3971.00 | -1750.21 |
| 35 | L | 2/10/2020 1:00 | LE - Full Moon | 4005.50 | 2/19/2020 14:00 | Profit Target | 4070.50 | +3249.79 |
| 36 | S | 2/25/2020 1:00 | SE - New Moon | 3931.50 | 2/25/2020 10:00 | Profit Target | 3866.50 | +3249.79 |
| 37 | L | 3/11/2020 1:00 | LE - Full Moon | 3479.00 | 3/11/2020 5:00 | LX-Breakeven | 3481.50 | +124.79 |
| 38 | L | 4/8/2020 1:00 | LE - Full Moon | 3348.00 | 4/8/2020 14:00 | Profit Target | 3413.00 | +3249.79 |
| 39 | L | 5/8/2020 1:00 | LE - Full Moon | 3601.75 | 5/12/2020 15:00 | Stop Loss | 3566.75 | -1750.21 |
| 40 | L | 6/7/2020 19:00 | LE - Full Moon | 3890.25 | 6/10/2020 19:00 | Stop Loss | 3855.25 | -1750.21 |
| 41 | L | 7/7/2020 1:00 | LE - Full Moon | 3863.75 | 7/8/2020 2:00 | Stop Loss | 3828.75 | -1750.21 |
| 42 | L | 8/5/2020 1:00 | LE - Full Moon | 3999.50 | 8/11/2020 2:00 | Profit Target | 4064.50 | +3249.79 |
| 43 | L | 9/3/2020 1:00 | LE - Full Moon | 4273.50 | 9/3/2020 10:00 | Stop Loss | 4238.50 | -1750.21 |
| 44 | S | 9/18/2020 1:00 | SE - New Moon | 4056.00 | 9/18/2020 13:00 | Profit Target | 3991.00 | +3249.79 |
| 45 | L | 10/2/2020 1:00 | LE - Full Moon | 4044.50 | 10/2/2020 1:00 | Stop Loss | 4009.50 | -1750.21 |
| 46 | L | 10/4/2020 19:00 | LE - Full Moon | 4066.00 | 10/6/2020 14:00 | Profit Target | 4131.00 | +3249.79 |
| 47 | L | 11/2/2020 1:00 | LE - Full Moon | 3984.50 | 11/2/2020 13:00 | LX-Breakeven | 3987.00 | +124.79 |
| 48 | L | 11/3/2020 1:00 | LE - Full Moon | 4025.00 | 11/3/2020 10:00 | Profit Target | 4090.00 | +3249.79 |
| 49 | L | 12/2/2020 1:00 | LE - Full Moon | 4358.25 | 12/8/2020 18:00 | Profit Target | 4423.25 | +3249.79 |
| 50 | L | 12/30/2020 1:00 | LE - Full Moon | 4447.25 | 1/4/2021 10:00 | LX-Breakeven | 4449.75 | +124.79 |
| 51 | L | 1/29/2021 1:00 | LE - Full Moon | 4451.75 | 1/29/2021 9:00 | LX-Breakeven | 4454.25 | +124.79 |
| 52 | L | 2/28/2021 19:00 | LE - Full Moon | 4553.75 | 3/1/2021 14:00 | Profit Target | 4618.75 | +3249.79 |
| 53 | L | 3/30/2021 1:00 | LE - Full Moon | 4690.00 | 4/2/2021 8:00 | Profit Target | 4755.00 | +3249.79 |
| 54 | L | 4/28/2021 1:00 | LE - Full Moon | 4911.25 | 5/4/2021 9:00 | Stop Loss | 4876.25 | -1750.21 |
| 55 | S | 5/12/2021 1:00 | SE - New Moon | 4851.50 | 5/12/2021 15:00 | Profit Target | 4786.50 | +3249.79 |
| 56 | L | 5/27/2021 1:00 | LE - Full Moon | 4914.75 | 6/3/2021 6:00 | LX-Breakeven | 4917.25 | +124.79 |
| 57 | L | 6/25/2021 1:00 | LE - Full Moon | 4997.50 | 7/2/2021 9:00 | Profit Target | 5062.50 | +3249.79 |
| 58 | S | 7/11/2021 19:00 | SE - New Moon | 5099.25 | 7/18/2021 20:00 | Profit Target | 5034.25 | +3249.79 |
| 59 | L | 7/26/2021 1:00 | LE - Full Moon | 5127.75 | 8/10/2021 1:00 | LX - Full Moon Exit | 5157.25 | +1474.79 |
| 60 | L | 8/24/2021 1:00 | LE - Full Moon | 5219.50 | 9/3/2021 8:00 | Profit Target | 5284.50 | +3249.79 |
| 61 | L | 9/22/2021 1:00 | LE - Full Moon | 5097.75 | 9/23/2021 5:00 | Profit Target | 5162.75 | +3249.79 |
| 62 | S | 10/7/2021 1:00 | SE - New Moon | 5118.75 | 10/7/2021 9:00 | Stop Loss | 5153.75 | -1750.21 |
| 63 | L | 10/21/2021 1:00 | LE - Full Moon | 5264.75 | 10/26/2021 10:00 | Profit Target | 5329.75 | +3249.79 |
| 64 | S | 11/7/2021 19:00 | SE - New Moon | 5430.50 | 11/12/2021 15:00 | SX-Breakeven | 5428.00 | +124.79 |
| 65 | L | 11/21/2021 19:00 | LE - Full Moon | 5443.25 | 11/22/2021 11:00 | LX-Breakeven | 5445.75 | +124.79 |
| 66 | S | 12/7/2021 1:00 | SE - New Moon | 5365.00 | 12/7/2021 5:00 | Stop Loss | 5400.00 | -1750.21 |
| 67 | L | 12/20/2021 1:00 | LE - Full Moon | 5309.50 | 12/20/2021 11:00 | Stop Loss | 5274.50 | -1750.21 |
| 68 | L | 12/21/2021 1:00 | LE - Full Moon | 5347.75 | 12/22/2021 10:00 | Profit Target | 5412.75 | +3249.79 |
| 69 | L | 1/19/2022 1:00 | LE - Full Moon | 5296.00 | 1/19/2022 15:00 | LX-Breakeven | 5298.50 | +124.79 |
| 70 | S | 2/2/2022 1:00 | SE - New Moon | 5314.50 | 2/3/2022 12:00 | Profit Target | 5249.50 | +3249.79 |
| 71 | L | 2/17/2022 1:00 | LE - Full Moon | 5203.50 | 2/17/2022 9:00 | Stop Loss | 5168.50 | -1750.21 |
| 72 | S | 3/3/2022 1:00 | SE - New Moon | 5139.25 | 3/3/2022 12:00 | SX-Breakeven | 5136.75 | +124.79 |
| 73 | L | 3/18/2022 1:00 | LE - Full Moon | 5134.50 | 3/18/2022 15:00 | Profit Target | 5199.50 | +3249.79 |
| 74 | L | 3/20/2022 19:00 | LE - Full Moon | 5218.00 | 3/21/2022 13:00 | Stop Loss | 5183.00 | -1750.21 |
| 75 | L | 4/18/2022 1:00 | LE - Full Moon | 5123.75 | 4/18/2022 12:00 | LX-Breakeven | 5126.25 | +124.79 |
| 76 | L | 4/19/2022 1:00 | LE - Full Moon | 5166.00 | 4/20/2022 7:00 | Profit Target | 5231.00 | +3249.79 |
| 77 | S | 5/3/2022 1:00 | SE - New Moon | 4924.50 | 5/4/2022 14:00 | Stop Loss | 4959.50 | -1750.21 |
| 78 | L | 5/17/2022 1:00 | LE - Full Moon | 4781.25 | 5/17/2022 15:00 | Profit Target | 4846.25 | +3249.79 |
| 79 | S | 6/1/2022 1:00 | SE - New Moon | 4908.00 | 6/1/2022 11:00 | Profit Target | 4843.00 | +3249.79 |
| 80 | L | 6/15/2022 1:00 | LE - Full Moon | 4505.50 | 6/15/2022 14:00 | Profit Target | 4570.50 | +3249.79 |
| 81 | L | 7/14/2022 1:00 | LE - Full Moon | 4561.50 | 7/14/2022 4:00 | Stop Loss | 4526.50 | -1750.21 |
| 82 | L | 8/14/2022 19:00 | LE - Full Moon | 5032.50 | 8/17/2022 6:00 | LX-Breakeven | 5035.00 | +124.79 |
| 83 | S | 8/28/2022 19:00 | SE - New Moon | 4785.00 | 8/29/2022 13:00 | Stop Loss | 4820.00 | -1750.21 |
| 84 | L | 9/12/2022 1:00 | LE - Full Moon | 4825.00 | 9/13/2022 2:00 | Profit Target | 4890.00 | +3249.79 |
| 85 | S | 9/27/2022 1:00 | SE - New Moon | 4438.00 | 9/27/2022 9:00 | Stop Loss | 4473.00 | -1750.21 |
| 86 | L | 10/12/2022 1:00 | LE - Full Moon | 4359.25 | 10/13/2022 3:00 | Stop Loss | 4324.25 | -1750.21 |
| 87 | S | 10/26/2022 1:00 | SE - New Moon | 4577.75 | 10/26/2022 10:00 | Stop Loss | 4612.75 | -1750.21 |
| 88 | L | 11/9/2022 1:00 | LE - Full Moon | 4574.00 | 11/9/2022 9:00 | Stop Loss | 4539.00 | -1750.21 |
| 89 | L | 12/9/2022 1:00 | LE - Full Moon | 4717.00 | 12/9/2022 8:00 | Stop Loss | 4682.00 | -1750.21 |
| 90 | L | 1/8/2023 19:00 | LE - Full Moon | 4634.25 | 1/9/2023 14:00 | LX-Breakeven | 4636.75 | +124.79 |
| 91 | L | 2/7/2023 1:00 | LE - Full Moon | 4840.75 | 2/7/2023 13:00 | LX-Breakeven | 4843.25 | +124.79 |
| 92 | S | 2/22/2023 1:00 | SE - New Moon | 4724.00 | 2/23/2023 14:00 | SX-Breakeven | 4721.50 | +124.79 |
| 93 | L | 3/8/2023 1:00 | LE - Full Moon | 4699.50 | 3/9/2023 13:00 | Stop Loss | 4664.50 | -1750.21 |
| 94 | S | 3/22/2023 1:00 | SE - New Moon | 4716.25 | 3/22/2023 15:00 | Profit Target | 4651.25 | +3249.79 |
| 95 | L | 4/6/2023 1:00 | LE - Full Moon | 4783.50 | 4/10/2023 8:00 | LX-Breakeven | 4786.00 | +124.79 |
| 96 | L | 5/5/2023 1:00 | LE - Full Moon | 4768.75 | 5/5/2023 14:00 | Profit Target | 4833.75 | +3249.79 |
| 97 | L | 5/7/2023 19:00 | LE - Full Moon | 4828.00 | 5/10/2023 13:00 | Stop Loss | 4793.00 | -1750.21 |
| 98 | L | 6/5/2023 1:00 | LE - Full Moon | 4960.50 | 6/12/2023 18:00 | Profit Target | 5025.50 | +3249.79 |
| 99 | L | 7/5/2023 1:00 | LE - Full Moon | 5121.00 | 7/6/2023 8:00 | Stop Loss | 5086.00 | -1750.21 |
| 100 | S | 7/19/2023 1:00 | SE - New Moon | 5218.75 | 7/27/2023 4:00 | Stop Loss | 5253.75 | -1750.21 |
| 101 | L | 8/2/2023 1:00 | LE - Full Moon | 5211.75 | 8/2/2023 10:00 | Stop Loss | 5176.75 | -1750.21 |
| 102 | S | 8/17/2023 1:00 | SE - New Moon | 5055.00 | 8/18/2023 8:00 | Profit Target | 4990.00 | +3249.79 |
| 103 | L | 9/1/2023 1:00 | LE - Full Moon | 5154.50 | 9/6/2023 3:00 | Stop Loss | 5119.50 | -1750.21 |
| 104 | S | 9/15/2023 1:00 | SE - New Moon | 5148.00 | 9/15/2023 13:00 | Profit Target | 5083.00 | +3249.79 |
| 105 | S | 9/17/2023 19:00 | SE - New Moon | 5087.00 | 9/20/2023 7:00 | SX-Breakeven | 5084.50 | +124.79 |
| 106 | L | 10/1/2023 19:00 | LE - Full Moon | 4924.25 | 10/2/2023 11:00 | Stop Loss | 4889.25 | -1750.21 |
| 107 | S | 10/17/2023 1:00 | SE - New Moon | 4977.25 | 10/18/2023 23:00 | Profit Target | 4912.25 | +3249.79 |
| 108 | L | 10/31/2023 1:00 | LE - Full Moon | 4754.50 | 11/1/2023 10:00 | Profit Target | 4819.50 | +3249.79 |
| 109 | L | 11/29/2023 1:00 | LE - Full Moon | 5152.75 | 12/4/2023 9:00 | LX-Breakeven | 5155.25 | +124.79 |
| 110 | S | 12/13/2023 1:00 | SE - New Moon | 5233.75 | 12/13/2023 14:00 | Stop Loss | 5268.75 | -1750.21 |
| 111 | L | 12/28/2023 1:00 | LE - Full Moon | 5370.50 | 12/29/2023 11:00 | Stop Loss | 5335.50 | -1750.21 |
| 112 | S | 1/11/2024 1:00 | SE - New Moon | 5358.50 | 1/12/2024 9:00 | SX-Breakeven | 5356.00 | +124.79 |
| 113 | L | 1/26/2024 1:00 | LE - Full Moon | 5436.50 | 1/31/2024 10:00 | LX-Breakeven | 5439.00 | +124.79 |
| 114 | S | 2/11/2024 19:00 | SE - New Moon | 5572.75 | 2/13/2024 8:00 | Profit Target | 5507.75 | +3249.79 |
| 115 | L | 2/26/2024 1:00 | LE - Full Moon | 5622.00 | 3/4/2024 14:00 | Profit Target | 5687.00 | +3249.79 |
| 116 | S | 3/12/2024 1:00 | SE - New Moon | 5670.25 | 3/12/2024 11:00 | Stop Loss | 5705.25 | -1750.21 |
| 117 | L | 3/26/2024 1:00 | LE - Full Moon | 5751.25 | 4/1/2024 11:00 | LX-Breakeven | 5753.75 | +124.79 |
| 118 | S | 4/10/2024 1:00 | SE - New Moon | 5732.00 | 4/10/2024 8:00 | Profit Target | 5667.00 | +3249.79 |
| 119 | L | 4/24/2024 1:00 | LE - Full Moon | 5591.25 | 4/24/2024 11:00 | Stop Loss | 5556.25 | -1750.21 |
| 120 | L | 5/23/2024 1:00 | LE - Full Moon | 5827.00 | 5/23/2024 9:00 | Stop Loss | 5792.00 | -1750.21 |
| 121 | L | 6/23/2024 19:00 | LE - Full Moon | 5939.75 | 6/28/2024 12:00 | LX-Breakeven | 5942.25 | +124.79 |
| 122 | L | 7/23/2024 1:00 | LE - Full Moon | 6003.75 | 7/24/2024 0:00 | Stop Loss | 5968.75 | -1750.21 |
| 123 | S | 8/6/2024 1:00 | SE - New Moon | 5691.75 | 8/6/2024 9:00 | Profit Target | 5626.75 | +3249.79 |
| 124 | L | 8/21/2024 1:00 | LE - Full Moon | 6031.75 | 8/22/2024 11:00 | LX-Breakeven | 6034.25 | +124.79 |
| 125 | S | 9/4/2024 1:00 | SE - New Moon | 5913.75 | 9/4/2024 9:00 | Stop Loss | 5948.75 | -1750.21 |
| 126 | L | 9/18/2024 1:00 | LE - Full Moon | 6043.25 | 9/18/2024 15:00 | LX-Breakeven | 6045.75 | +124.79 |
| 127 | L | 10/18/2024 1:00 | LE - Full Moon | 6226.50 | 10/23/2024 11:00 | Stop Loss | 6191.50 | -1750.21 |
| 128 | S | 11/3/2024 19:00 | SE - New Moon | 6091.00 | 11/5/2024 9:00 | Stop Loss | 6126.00 | -1750.21 |
| 129 | L | 11/18/2024 1:00 | LE - Full Moon | 6253.25 | 11/19/2024 8:00 | Stop Loss | 6218.25 | -1750.21 |
| 130 | L | 12/17/2024 1:00 | LE - Full Moon | 6417.25 | 12/18/2024 14:00 | Stop Loss | 6382.25 | -1750.21 |
| 131 | S | 1/1/2025 19:00 | SE - New Moon | 6210.00 | 1/2/2025 3:00 | Stop Loss | 6245.00 | -1750.21 |
| 132 | L | 1/15/2025 1:00 | LE - Full Moon | 6154.00 | 1/15/2025 8:00 | Profit Target | 6219.00 | +3249.79 |
| 133 | S | 1/29/2025 1:00 | SE - New Moon | 6367.75 | 1/30/2025 3:00 | SX-Breakeven | 6365.25 | +124.79 |
| 134 | L | 2/13/2025 1:00 | LE - Full Moon | 6356.00 | 2/18/2025 1:00 | Profit Target | 6421.00 | +3249.79 |
| 135 | S | 2/28/2025 1:00 | SE - New Moon | 6150.50 | 2/28/2025 15:00 | Stop Loss | 6185.50 | -1750.21 |
| 136 | L | 3/16/2025 19:00 | LE - Full Moon | 5877.75 | 3/17/2025 9:00 | Profit Target | 5942.75 | +3249.79 |
| 137 | S | 3/30/2025 19:00 | SE - New Moon | 5813.00 | 3/31/2025 11:00 | SX-Breakeven | 5810.50 | +124.79 |
| 138 | L | 4/14/2025 1:00 | LE - Full Moon | 5673.00 | 4/14/2025 10:00 | LX-Breakeven | 5675.50 | +124.79 |
| 139 | L | 4/15/2025 1:00 | LE - Full Moon | 5654.75 | 4/15/2025 10:00 | LX-Breakeven | 5657.25 | +124.79 |
| 140 | L | 5/14/2025 1:00 | LE - Full Moon | 6127.00 | 5/15/2025 4:00 | Stop Loss | 6092.00 | -1750.21 |
| 141 | L | 6/11/2025 1:00 | LE - Full Moon | 6242.25 | 6/11/2025 14:00 | LX-Breakeven | 6244.75 | +124.79 |
| 142 | L | 7/11/2025 1:00 | LE - Full Moon | 6475.50 | 7/13/2025 18:00 | Stop Loss | 6440.25 | -1762.71 |
| 143 | L | 8/10/2025 19:00 | LE - Full Moon | 6586.75 | 8/13/2025 8:00 | Profit Target | 6651.75 | +3249.79 |
| 144 | L | 9/9/2025 1:00 | LE - Full Moon | 6679.75 | 9/11/2025 10:00 | Profit Target | 6744.75 | +3249.79 |
| 145 | S | 9/24/2025 1:00 | SE - New Moon | 6830.25 | 9/25/2025 8:00 | Profit Target | 6765.25 | +3249.79 |
| 146 | L | 10/8/2025 1:00 | LE - Full Moon | 6880.00 | 10/9/2025 10:00 | LX-Breakeven | 6882.50 | +124.79 |
| 147 | L | 11/6/2025 1:00 | LE - Full Moon | 6927.25 | 11/6/2025 10:00 | Stop Loss | 6892.25 | -1750.21 |
| 148 | S | 11/21/2025 1:00 | SE - New Moon | 6681.75 | 11/21/2025 6:00 | SX-Breakeven | 6679.25 | +124.79 |
| 149 | L | 12/5/2025 1:00 | LE - Full Moon | 6991.50 | 12/8/2025 12:00 | Stop Loss | 6956.50 | -1750.21 |
| 150 | S | 12/21/2025 19:00 | SE - New Moon | 6956.00 | 12/23/2025 9:00 | Stop Loss | 6991.00 | -1750.21 |
| 151 | L | 1/5/2026 1:00 | LE - Full Moon | 6962.00 | 1/6/2026 10:00 | Profit Target | 7027.00 | +3249.79 |
| 152 | S | 1/20/2026 1:00 | SE - New Moon | 6954.50 | 1/20/2026 10:00 | SX-Breakeven | 6952.00 | +124.79 |
| 153 | L | 2/4/2026 1:00 | LE - Full Moon | 6998.50 | 2/4/2026 10:00 | Stop Loss | 6963.50 | -1750.21 |
| 154 | L | 3/4/2026 1:00 | LE - Full Moon | 6838.25 | 3/4/2026 6:00 | Profit Target | 6903.25 | +3249.79 |
| 155 | L | 4/3/2026 1:00 | LE - Full Moon | 6611.00 | 4/5/2026 18:00 | Stop Loss | 6576.00 | -1750.21 |
| 156 | L | 4/5/2026 19:00 | LE - Full Moon | 6587.50 | 4/6/2026 10:00 | Profit Target | 6652.50 | +3249.79 |

---

## Exit Type Breakdown

| Exit Type | Count | Notes |
|---|---:|---|
| Profit Target | 54 | ~$3,250 each |
| Stop Loss | 57 | ~-$1,750 each |
| LX/SX-Breakeven | 35 | ~$125 each |
| LX/SX - Full Moon/New Moon Exit (phase flip) | 10 | Variable |

---

## Python Comparison Targets (2018–2026 equivalent)

When running Python backtest filtered to 4/6/2018 onwards, compare:

| Metric | TS Target | Tolerance |
|---|---|---|
| **Total trades** | **156** | ±15 |
| **Win rate** | **63.46%** | ±5% |
| **Long / Short** | 109 / 47 (70/30%) | ±5% |
| **Profit factor** | 1.91 | >1.5 good |
| **Largest win** | ~$3,250 | Near target |
| **Largest loss** | ~-$1,762 | Near stop |
| **Stop exits** | 57 | Key signal: if Python has significantly more, stops firing early |
| **Breakeven exits** | 35 | If Python has fewer, BE detection lagging |
| **Phase flip exits** | 10 | If significantly different, ATR filter affecting entry count |

## Key Observation: Exit Type Distribution Matters

The **35 breakeven exits** at ~$125 each vs **57 stop losses** at ~-$1,750 each is critical.
Each breakeven saved ~$1,625 vs a full stop loss. If Python misses breakeven exits,
win rate will be lower and losses larger than TS.
