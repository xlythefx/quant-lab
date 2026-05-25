# TradeStation WebAPI — Frequently Asked Questions

> Source: Official TradeStation WebAPI FAQ. Captured as reference for AI-assisted development.

---

## Getting an API Key

You must have a TradeStation account. If you already have a **funded** TradeStation account, email:

**ClientExperience@tradestation.com**

to obtain a key. For more information or to open an account, see the [TradeStation API Product Page](https://tradestation.github.io/api-docs/).

---

## Which Version of API Key Do I Have?

TradeStation issues two generations of API keys:

| Type | Format | Example |
|---|---|---|
| **Auth0** | Mixed upper/lowercase, **no dashes** | `8P07Yx8KLvYAgYWpVy7Mns7wN2mkgvH4` |
| **OAuth2** | All-caps, **with dashes** | `EAC7BF97-B3HE-4EGD-9D94-7686C542A8B3` |

OAuth2 authentication reference: https://tradestation.github.io/api-docs/#section/Authentication

---

## Which Version of the API Should I Use?

**Use API v3.** It is the recommended and actively developed version.

| Feature | API v3 | API v2 |
|---|---|---|
| Stocks | ✔ | ✔ |
| Options | ✔ | ✔ |
| Futures | ✔ | ✔ |
| New Features | ✔ | ✗ |

---

## Changing API Key Configuration

Email **ClientExperience@tradestation.com** with your requested changes.

---

## Code Examples

Sample code is available in the [TradeStation API Specifications](https://tradestation.github.io/api-docs/).

---

## Support

For general questions: **ClientExperience@tradestation.com**

---

## Downloading the API Specification

The full API spec can be downloaded from the [API Specification page](https://tradestation.github.io/api-docs/).

---

## Becoming a Business Partner

Email **ClientExperience@tradestation.com** with subject line: `Business Partner Request`

---

## Auth0 Authentication Training

A video tutorial covering Auth0 authentication is available via TradeStation's developer resources. Ask for the link when requesting your API key.

---

## AI Usage Notes

- This project targets **API v3** exclusively.
- The credential type expected here is **OAuth2** (all-caps + dashes format).
- OAuth2 flow is documented in [setup.md](setup.md).
- The `client_id` / `client_secret` from the OAuth2 app registration are what get stored in `.env` / secrets store — not the raw API key string shown above.
