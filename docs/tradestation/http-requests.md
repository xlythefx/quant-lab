# TradeStation — HTTP Requests

> Source: Official TradeStation WebAPI docs.

---

## Basics

- All API access is over **HTTPS**
- Base URLs:
  - Live: `https://api.tradestation.com/v3`
  - SIM: `https://sim-api.tradestation.com/v3`
- All data is sent and received as **JSON** (authentication endpoints are the exception — they use `application/x-www-form-urlencoded`)

---

## Authentication Header

Every request requires a Bearer token in the `Authorization` header:

```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

---

## Example Request

```bash
curl --request GET \
  --url 'https://api.tradestation.com/v3/marketdata/barcharts/MSFT?interval=1&unit=Daily&barsback=2&startdate=2020-12-05T21:00:00Z' \
  --header 'Authorization: Bearer TOKEN'
```

**Example response:**
```json
{
  "Bars": [
    {
      "High": "216.38",
      "Low": "213.65",
      "Open": "214.61",
      "Close": "214.24",
      "TimeStamp": "2020-12-03T21:00:00Z",
      "TotalVolume": "25120922",
      "DownTicks": 114646,
      "DownVolume": 14430027,
      "OpenInterest": "0",
      "IsRealtime": false,
      "IsEndOfHistory": false,
      "TotalTicks": 226992,
      "UnchangedTicks": 0,
      "UnchangedVolume": 0,
      "UpTicks": 112346,
      "UpVolume": 10690895,
      "Epoch": 1607029200000
    },
    {
      "High": "215.38",
      "Low": "213.18",
      "Open": "214.22",
      "Close": "214.36",
      "TimeStamp": "2020-12-04T21:00:00Z",
      "TotalVolume": "24666039",
      "DownTicks": 110196,
      "DownVolume": 13201417,
      "OpenInterest": "0",
      "IsRealtime": false,
      "IsEndOfHistory": true,
      "TotalTicks": 218338,
      "UnchangedTicks": 0,
      "UnchangedVolume": 0,
      "UpTicks": 108142,
      "UpVolume": 11464622,
      "Epoch": 1607115600000
    }
  ]
}
```

---

## Common Conventions

- **Blank fields** may be included as `null` or omitted entirely — parsers must handle both
- **Numeric values** (prices, volumes) are returned as **strings** (e.g. `"216.38"`) — always parse with `Decimal` or `float`, never assume int
- `IsEndOfHistory: true` marks the last bar in the response
- `Epoch` is milliseconds since Unix epoch (UTC)
- `TimeStamp` is ISO 8601 UTC

---

## AI Implementation Notes

- Use `Decimal` (not `float`) for price fields to avoid floating-point precision loss in financial calculations.
- Always check `IsEndOfHistory` to know when pagination is complete on historical bar requests.
- The `Authorization` header must be refreshed before the access token's 20-minute expiry — see [auth-refresh-tokens.md](auth-refresh-tokens.md).
- Switch base URL via `TS_BASE_URL` env var to toggle SIM/LIVE — see [sim-vs-live.md](sim-vs-live.md).
