# TradeStation — SIM vs. LIVE Environments

> Source: Official TradeStation WebAPI docs.

---

## Overview

TradeStation provides two identical API environments. The only difference is the base URL and the accounts behind it.

| | SIM | LIVE |
|---|---|---|
| Base URL | `https://sim-api.tradestation.com/v3` | `https://api.tradestation.com/v3` |
| Accounts | Fake accounts seeded with fake money | Real funded accounts |
| Orders | Simulated fills — not executed | Actually executed |
| API surface | Identical | Identical |

> **Warning:** TradeStation is not liable for mistakes made by applications that allow users to switch between SIM and Live environments. Switching must be treated as a critical operation.

---

## Switching Environments

To target SIM, replace the base URL in all requests:

```python
# SIM
BASE_URL = "https://sim-api.tradestation.com/v3"

# LIVE
BASE_URL = "https://api.tradestation.com/v3"
```

Everything else — authentication, endpoints, request format, response schema — is identical.

---

## Use Cases for SIM

- **Development & testing** — test order flows without financial risk
- **App validation** — verify behavior before going live to customers
- **Learning / onboarding** — paper trading without real consequences
- **Trading competitions or games** — simulated portfolios
- **Exploring API behavior** — experiment freely

---

## AI Implementation Notes

- The broker module should read `BASE_URL` from an environment variable (e.g. `TS_BASE_URL`) so SIM/LIVE can be toggled without code changes.
- Never allow silent fallback from LIVE to SIM or vice versa — the switch must be explicit and logged.
- The prototype should default to SIM until credentials are confirmed working, then require an explicit opt-in flag to switch to LIVE.
- Credential authentication (OAuth tokens) is shared — same `client_id`/`client_secret` work against both environments.
