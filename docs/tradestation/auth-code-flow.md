# TradeStation — Auth Code Flow (OAuth2 Authorization Code Grant)

> Source: Official TradeStation WebAPI Authentication docs. For Auth0 API keys only.
> For OAuth2 keys see [faq.md](faq.md) for key format differences.

---

## Overview

The **Authorization Code Grant** flow lets a user log in with TradeStation directly and authorize your app to make API calls on their behalf. Access tokens expire after **20 minutes** and must be renewed via refresh tokens.

This flow requires:
- A browser / user-agent that can follow redirects
- A server capable of receiving the callback redirect
- `client_id` and `client_secret` from your registered TradeStation app

---

## Step-by-Step

### Step 1 — Redirect user to TradeStation authorization URL

```
GET https://signin.tradestation.com/authorize
```

| Parameter | Required | Value |
|---|---|---|
| `response_type` | required | `code` |
| `client_id` | required | Your API Key |
| `audience` | required | `https://api.tradestation.com` |
| `redirect_uri` | required | One of the allowed localhost URLs (see below) |
| `scope` | required | Space-separated scopes — `openid` always required, `offline_access` for refresh tokens |
| `state` | recommended | Random alphanumeric string — CSRF protection |
| `prompt` | optional | `login` forces login screen even if session exists |

**Allowed `redirect_uri` values:**
```
http://localhost
http://localhost:80
http://localhost:3000
http://localhost:3001
http://localhost:8080
http://localhost:31022
```

> To add a custom callback URL, email ClientExperience@tradestation.com.

**Example authorization URL:**
```
https://signin.tradestation.com/authorize
  ?response_type=code
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=http://localhost:8080
  &audience=https://api.tradestation.com
  &state=STATE
  &scope=openid offline_access profile MarketData ReadAccount Trade Matrix OptionSpreads
```

---

### Step 2 — User logs in and grants consent

TradeStation presents a login page, then a consent dialog asking the user to approve API access.

- **Approved** → flow continues, authorization code returned
- **Declined** → redirect returns `?error=access_denied&error_description=...`

When using a `localhost` redirect_uri, a **second consent dialog** may appear on first login or if access was previously revoked. Once approved, this dialog is suppressed for subsequent logins with the same key/login combination (unless scopes change).

---

### Step 3 — Receive the Authorization Code

On success, TradeStation redirects to your `redirect_uri` with the code in the query string:

```
HTTP/1.1 302 Found
Location: http://localhost:8080?code=AUTHORIZATION_CODE&state=xyzABC123
```

> The authorization code length is variable (not fixed).

---

### Step 4 — Exchange Authorization Code for Tokens

```
POST https://signin.tradestation.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

| Parameter | Required | Value |
|---|---|---|
| `grant_type` | required | `authorization_code` |
| `client_id` | required | Your API Key |
| `client_secret` | required | Your API Secret |
| `code` | required | The authorization code from Step 3 |
| `redirect_uri` | required | Same `redirect_uri` used in Step 1 |

**Example curl:**
```bash
curl --request POST \
  --url 'https://signin.tradestation.com/oauth/token' \
  --header 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=authorization_code' \
  --data 'client_id=YOUR_CLIENT_ID' \
  --data 'client_secret=YOUR_CLIENT_SECRET' \
  --data 'code=YOUR_AUTHORIZATION_CODE' \
  --data 'redirect_uri=http://localhost:8080'
```

**Example response:**
```json
{
  "access_token": "eGlhc2xv...MHJMaA",
  "refresh_token": "eGlhc2xv...wGVFPQ",
  "id_token": "vozT2Ix...wGVFPQ",
  "token_type": "Bearer",
  "scope": "openid profile MarketData ReadAccount Trade offline_access",
  "expires_in": 1200
}
```

> `expires_in: 1200` = 20 minutes. After expiry, use the `refresh_token` to get a new access token — see [Refresh Tokens](auth-refresh-tokens.md).

---

## Token Types

| Token | Purpose |
|---|---|
| `access_token` | Bearer token — attach to every API request as `Authorization: Bearer <token>` |
| `refresh_token` | Long-lived — use to get a new `access_token` after expiry. Requires `offline_access` scope. |
| `id_token` | JWT containing user profile info. Decode to personalize UX. Not used for API calls. |

---

## Scopes Reference

| Scope | Purpose |
|---|---|
| `openid` | Always required |
| `offline_access` | Required to receive a `refresh_token` |
| `profile` | User profile info in `id_token` |
| `MarketData` | Read market data (bars, quotes, streaming) |
| `ReadAccount` | Read account balances, positions, orders |
| `Trade` | Place, modify, cancel orders |
| `Matrix` | Level 2 / options matrix data |
| `OptionSpreads` | Options spread trading |

---

## AI Implementation Notes

- The `redirect_uri` used in Step 1 and Step 4 **must match exactly** — any mismatch returns an error.
- Store `access_token` and `refresh_token` in memory only (never disk) during prototype phase.
- `state` parameter should be verified on callback to prevent CSRF.
- The broker module in this project should call this flow at startup, then use the refresh token loop to stay authenticated — see [setup.md](setup.md) for credential storage conventions.
- Allowed callback URLs are constrained to localhost — our prototype's local Flask server (`http://localhost:8080`) is already on the allowed list.
