# Scopes — TradeStation API

During the authorization flow, two categories of scopes are passed in the
`scope` parameter: TradeStation API scopes (what the app can do) and
OAuth/OIDC scopes (token behavior).

---

## TradeStation API Scopes

Configured on the API key itself. Default scopes are applied automatically;
contact Client Experience to add additional ones.

| Scope | Default / By Request | Description |
|---|---|---|
| `MarketData` | Default | Look up or stream market data. |
| `ReadAccount` | Default | View brokerage accounts belonging to the current user. |
| `Trade` | Default | Execute orders on behalf of the current user's account(s). |
| `OptionSpreads` | Default | Access options-related endpoints. |
| `Matrix` | Default | Access market depth (Level 2) endpoints. |

---

## Other Relevant Scopes (Refresh Tokens & ID Tokens)

These are standard OAuth 2.0 / OIDC scopes. Include them in the `scope`
query parameter at authorization time.

| Scope | Required / Optional | Description |
|---|---|---|
| `openid` | **Required** | Returns the `sub` claim (unique user identifier). ID Token will also include `iss`, `aud`, `exp`, `iat`, and `at_hash`. |
| `offline_access` | **Required** for Refresh Tokens | Enables Refresh Token issuance. Without this, only a short-lived Access Token is returned. |
| `profile` | Optional | Adds basic profile claims to the ID Token: `name`, `family_name`, `given_name`, `middle_name`, `nickname`, `picture`, `updated_at`. |
| `email` | Optional | Adds `email` and `email_verified` claims to the ID Token. |

---

## Usage Notes

- Scopes are **case-sensitive** and **space-separated** in the `scope`
  parameter.
- Minimum viable scope string (market data + refresh tokens):
  ```
  openid offline_access MarketData
  ```
- Full default scope string (all defaults + tokens + profile):
  ```
  openid offline_access profile MarketData ReadAccount Trade OptionSpreads Matrix
  ```
- The ID Token is a JWT — decode it to extract profile/email claims for use
  in your application.
- Access Tokens expire after **20 minutes**. Include `offline_access` so
  your app can renew them silently via the Refresh Token flow.

---

## Related Documents

- [`auth-fundamentals.md`](auth-fundamentals.md) — Default API key scope
  configuration and how to request changes from Client Experience.
- [`auth-pkce.md`](auth-pkce.md) — PKCE flow with full scope parameter example.
- [`auth-code-flow.md`](auth-code-flow.md) — Standard Auth Code Flow scope usage.
- [`setup.md`](setup.md) — Which scopes to request when bootstrapping this
  project (`MarketData`, `openid`, `offline_access` at minimum).
