# TradeStation — Refresh Tokens

> Source: Official TradeStation WebAPI Authentication docs.

---

> **Security:** Refresh Tokens must be stored securely — never in plaintext on disk or in logs.

> **Rate:** Do NOT fetch a new access token per request. Only refresh when the current token is approaching expiry or has expired.

> **Scope:** Revocation of a single refresh token revokes **ALL** refresh tokens for that API key.

> **Prerequisite:** `offline_access` scope must be included in the original authorization request.

---

## Access Token Lifetime

Access tokens expire after **20 minutes** (`expires_in: 1200`).

| Refresh Token Mode | Lifetime | Notes |
|---|---|---|
| Default (non-rotating) | Indefinite | Tokens remain valid until explicitly revoked |
| Rotating (opt-in) | 30-minute rotation, 24-hour absolute | User must re-authenticate every 24 hours. Contact ClientExperience@tradestation.com to enable. |

---

## Refreshing an Access Token

```
POST https://signin.tradestation.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

| Parameter | Required | Value |
|---|---|---|
| `grant_type` | required | `refresh_token` |
| `client_id` | required | Your API Key |
| `client_secret` | optional* | Your API Secret — required for standard Auth Code Flow, not required for PKCE |
| `refresh_token` | required | The refresh token from the original token response |

**Example curl:**
```bash
curl --request POST \
  --url 'https://signin.tradestation.com/oauth/token' \
  --header 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=refresh_token' \
  --data 'client_id=YOUR_CLIENT_ID' \
  --data 'client_secret=YOUR_CLIENT_SECRET' \
  --data 'refresh_token=YOUR_REFRESH_TOKEN'
```

**Example response:**
```json
{
  "access_token": "eGlhc2xv...MHJMaA",
  "expires_in": 1200,
  "scope": "openid offline_access",
  "id_token": "vozT2Ix...wGVFPQ",
  "token_type": "Bearer"
}
```

> With rotating refresh tokens enabled, the response will also include a new `refresh_token`. Replace the stored one immediately.

---

## Revoking Refresh Tokens

Use this if a refresh token is compromised. **Revokes all refresh tokens for the API key**, not just the one passed in.

```
POST https://signin.tradestation.com/oauth/revoke
Content-Type: application/json
```

| Parameter | Required | Value |
|---|---|---|
| `client_id` | required | Your API Key |
| `client_secret` | optional | Your API Secret |
| `token` | required | A valid refresh token |

**Example curl:**
```bash
curl --request POST \
  --url 'https://signin.tradestation.com/oauth/revoke' \
  --header 'content-type: application/json' \
  --data '{ "client_id": "YOUR_CLIENT_ID", "client_secret": "YOUR_CLIENT_SECRET", "token": "YOUR_REFRESH_TOKEN" }'
```

**Response:** `200 OK` (no body)

---

## AI Implementation Notes

- The broker module should run a background token-refresh loop: check `expires_in`, refresh ~2 minutes before expiry.
- Store `refresh_token` in an environment variable or secrets manager — never hardcode or log it.
- If using rotating refresh tokens, always replace the stored refresh token with the one returned in the refresh response.
- After revocation, the broker must re-run the full [Auth Code Flow](auth-code-flow.md) (user redirect + login) to obtain new tokens — there is no silent path.
- For the prototype, non-rotating (default) tokens are simpler; rotating tokens are recommended for production.
