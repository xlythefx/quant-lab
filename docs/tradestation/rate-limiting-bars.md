# Historical Bars Data Limits — TradeStation API

These limits apply **only to minute-bar requests** (`unit=minute`) and are
enforced in addition to the standard 500 barchart requests per 5-minute
window from [`rate-limiting.md`](rate-limiting.md).

---

## Hard Per-Request Limits

| Limit | Value |
|---|---|
| Max bars returned per request | 57,600 bars (any interval) |
| Max minutes in a `barsback` request | 500,000 minutes (`barsback × interval`) |
| Max date range in a `firstdate` request | 3 calendar years |

These apply to both REST snapshot and streaming bar requests. If a request
exceeds these limits, split it into smaller ranges and save results locally.

### Bars Back Limit — Examples

| `barsback` | `interval` | Total minutes | Result |
|---|---|---|---|
| 3,000 | 60 | 180,000 | OK |
| 10,000 | 60 | 600,000 | **Exceeds limit** |

### Date Range Limit — Examples

| `firstdate` | `lastdate` | Duration | Result |
|---|---|---|---|
| 2023-01-01 | 2025-07-31 | ~2y 7m | OK |
| 2021-01-01 | 2025-07-31 | ~4y 7m | **Exceeds limit** |

---

## Credit-Based History Rate Limit

In addition to per-request limits, a **credits system** caps how much total
history a user can request within a 1-minute period.

**Allocation:** 200 credits, replenished at 200 credits/minute (evenly
spaced), never exceeding 200. When credits are exhausted, requests return
`429 Too Many Requests` until enough credits are restored.

> Credits of **0.25 or less** are treated as zero — small requests do not
> count toward this limit.

### Credit Calculation

**`barsback` requests:**

```
credits = barsback × interval / 100,000
```

Round down to 2 decimal places. Discard any further decimals. Credits ≤ 0.25
are treated as 0.

**`firstdate` / date range requests:**

```
credits = (days_between(firstdate, lastdate) + 1) / 365
```

If `lastdate` is omitted, use the current date. Round down to 2 decimal
places. Credits ≤ 0.25 are treated as 0.

### Credit Calculation Example

| Request | Calculation | Credits Used |
|---|---|---|
| `barsback=2000`, `interval=60` | 2000 × 60 / 100,000 | **1.20** |
| `barsback=500`, `interval=120` | 500 × 120 / 100,000 | **0.60** |
| `barsback=3000`, `interval=5` | 3000 × 5 / 100,000 = 0.15 → ≤ 0.25 | **0** |
| `firstdate=2023-01-01`, `lastdate=2024-06-30` | 547 days / 365 = 1.49 | **1.49** |

Total for the four requests: **3.29 credits** — well within the 200-credit
per-minute allocation.

Scaling example: running all four requests for every symbol in the Dow 30
would use ~99 credits (under the limit). For all NASDAQ 100 symbols, credits
would exceed 200 — requests would need to be spread across more than 1 minute.

---

## How to Avoid Being Rate Limited

1. **Use streaming bar requests.** Open a stream once; it delivers history
   first, then transitions to real-time bars. No repeated large requests
   needed.

2. **Cache history locally.** Make a snapshot request once per day and save
   to memory or file. Don't re-fetch the same historical range on every
   startup.

3. **Pace multi-symbol requests.** If your symbol universe is large (e.g.
   NASDAQ 100), add delays between batches to stay within the 200-credit
   per-minute budget. If data is needed before market open, schedule the
   retrieval early enough to complete within the credit limit.

4. **Split large ranges.** If a single request would exceed the 500,000
   minute or 3-year caps, break it into sequential date ranges and
   concatenate results.

---

## Related Documents

- [`rate-limiting.md`](rate-limiting.md) — Overall rate limit overview,
  resource category quotas, and the standard barchart 500/5-min limit.
- [`endpoints.md`](endpoints.md) — Bar chart endpoint signatures
  (`/v3/marketdata/barcharts/`, `/v3/marketdata/stream/barcharts/`).
