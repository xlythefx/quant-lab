# TradeStation — Logout

> Source: Official TradeStation WebAPI Authentication docs.

---

## Behavior

The logout endpoint ends the user's session on the TradeStation authentication server — they cannot receive new access tokens without re-authenticating or using a refresh token.

**What logout does NOT do:**
- It does **not** invalidate the current access token (still valid for its remaining 20-minute lifetime)
- It does **not** invalidate existing refresh tokens

**What your app must do on logout:**
- Discard the `access_token` from memory
- Discard the `refresh_token` from memory/storage
- Redirect the user to the logout endpoint

---

## Logout Endpoint

```
GET https://signin.tradestation.com/v2/logout
```

| Parameter | Required | Description |
|---|---|---|
| `returnTo` | optional | URL to redirect the user after logout. Must be in the Allowed Logout URLs list. Defaults to `https://www.tradestation.com` if omitted. |
| `client_id` | optional | Your API Key. Required when `returnTo` is provided. Omitting it redirects to `https://www.tradestation.com`. |

**Example request:**
```
https://signin.tradestation.com/v2/logout?returnTo=http://localhost:8080/logout&client_id=YOUR_CLIENT_ID
```

---

## Allowed Logout URLs (default)

| URL |
|---|
| `https://tradestation.com` |
| `http://localhost/logout` |
| `http://localhost:80/logout` |
| `http://localhost:3000/logout` |
| `http://localhost:3001/logout` |
| `http://localhost:8080/logout` |
| `http://localhost:31022/logout` |

To add, update, or remove allowed logout URLs, contact **ClientExperience@tradestation.com**.

---

## AI Implementation Notes

- On broker shutdown or explicit logout, the module must clear both `access_token` and `refresh_token` from memory before redirecting to the logout URL.
- For the prototype's local Flask server, `http://localhost:8080/logout` is already in the allowed list — use this as the `returnTo` value.
- If no `returnTo` is provided, the user lands on `tradestation.com` — acceptable for CLI tools where there is no UI redirect.
- After logout, re-authentication requires the full [Auth Code Flow](auth-code-flow.md) again (browser redirect + login).
