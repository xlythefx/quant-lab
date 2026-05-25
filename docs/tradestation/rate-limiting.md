# Rate Limiting — TradeStation API

> **Recommendation:** Use streaming endpoints where available — they deliver
> real-time data without consuming request quotas.

## Overview

The TradeStation API rate-limits requests per user per API key to ensure
fairness and prevent abuse. Quotas are enforced per resource category on
fixed time windows. When a quota is exceeded, subsequent requests return
`429 Too Many Requests` until the window resets.

**Reset behavior:** Windows are fixed, not sliding. The interval starts from
the very first request in that category. After it expires the counter resets
to zero regardless of how many requests were made.

---

## Resource Category Limits

| Resource Category | Quota | Interval |
|---|---|---|
| Accounts | 250 | 5-minute |
| Order Details | 250 | 5-minute |
| Balances | 250 | 5-minute |
| Positions | 250 | 5-minute |
| Quote Change Stream | 500 | 5-minute |
| Barchart Stream | 500 | 5-minute |
| TickBar Stream | 500 | 5-minute |
| Each Option Endpoint | 90 | 1-minute |
| Quote Snapshot | 30 | 1-minute |
| MarketDepth Stream* | 30 | 1-minute |
| MarketDepth Stream* | 10 | concurrent |
| Option Quote Stream | 10 | concurrent |
| Option Chain Stream | 10 | concurrent |
| Order Stream | 40 | concurrent |
| Order Stream by Order Id | 40 | concurrent |
| Positions Stream | 40 | concurrent |

\* MarketDepth limit is a combined quota covering both Quotes and Aggregate
streams.

---

## How Windows Work

Quotas operate on **fixed** intervals — they do not slide.

**Example A — Accounts:**
A user calls `/v3/brokerage/accounts` once. The Accounts quota increments to
1. The user then immediately calls the same endpoint 250 more times. The
251st request fails with `429 Too Many Requests`. All subsequent requests
fail until the 5-minute window expires from the time of the first request.

**Example B — Positions:**
A user calls `/v3/brokerage/accounts/123456782/positions` once, then
immediately 250 more times. The last request fails with `429`. All subsequent
requests fail until the 5-minute window expires from the first request.

---

## Example: Throttled Request and Response

```http
GET https://api.tradestation.com/v3/brokerage/accounts/123456782/positions HTTP/1.1
Host: api.tradestation.com
Authorization: bearer eE45VkdQSnlBcmI0Q2RqTi82SFdMSVE0SXMyOFo5Z3dzVzdzdk
Accept: application/json
```

```http
HTTP/1.1 429 Too Many Requests
Content-Length: 55
Date: Thu, 04 Feb 2021 21:18:07 GMT

{"Error":"TooManyRequests","Message":"Rate quota exceeded"}
```

---

## Response Headers

The API includes rate limit headers on responses:

| Header | Description |
|---|---|
| `Rate-Limit-Remaining` | Requests remaining in the current window. |
| `Rate-Limit-Reset` | Timestamp when the current window resets. |
| `Rate-Limit-Total` | Total quota allocated for this resource category. |

---

## Best Practices

- **Prefer streaming** — streaming endpoints (Barchart Stream, Quote Change
  Stream, etc.) do not consume the snapshot quotas and are the right choice
  for any continuous feed.
- **Exponential backoff** — on a `429`, wait before retrying. Double the
  delay on each successive failure. Don't hammer the endpoint hoping the
  window resets sooner.
- **Cache responses** — avoid re-fetching data that hasn't changed, especially
  for slow-moving resources like account balances.
- **Track usage** — log request counts per category so you can spot quota
  pressure before it causes failures in production.
- **Contact Client Experience** for quota increases if your use case
  (e.g. algo trading at high frequency) consistently hits limits.

---

## Related Documents

- [`rate-limiting-bars.md`](rate-limiting-bars.md) — Historical Bars–specific
  data limits and row caps.
- [`endpoints.md`](endpoints.md) — Full endpoint reference with resource
  category labels.
- [`setup.md`](setup.md) — Troubleshooting note: avoid hammering the API
  during dev; cached responses are important.
