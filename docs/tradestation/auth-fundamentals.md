# Authentication Fundamentals — TradeStation API Keys

> **Note:** This covers Auth0 API keys. For the OAuth bootstrap procedure
> (getting tokens into `.env`), see [`setup.md`](setup.md).

## Default API Key Configuration

Unless you have requested changes from TradeStation Client Experience, your
API key ships with the following defaults.

### Application Type and Auth Flow

- Type: **Regular Web App** → uses the standard **Auth Code Flow**.
- If you need **Auth Code Flow with PKCE** (for a Single Page App or native
  app), contact Client Experience to request the change, then follow the PKCE
  documentation.

### Refresh Tokens

Enabled by default; set to **non-expiring**. You can request that Client
Experience change this to expire-and-rotate every 40 minutes for increased
security.

### Scopes

Default scopes: `MarketData`, `ReadAccount`, `Trade`. Contact Client
Experience to add additional scopes. See the [TradeStation Scopes
page](https://api.tradestation.com/docs/fundamentals/authentication/scopes)
for the full list including required/optional non-TS scopes.

### Account Access

By default, API access is restricted to the TradeStation accounts under your
own login (not a public/partner app). Up to 15 logins can be added per
application; contact Client Experience to add or remove logins, or to apply
for partner status to lift the limit.

---

## Application URIs

The only **required** URI is the Allowed Callback URL. All others are
optional. To add, update, or delete any URI, contact Client Experience.

### Allowed Login URI

Used when Auth0 needs to redirect to your application's own login page. Must
point to a route in your app that then redirects to the `/authorize` endpoint.

### Allowed Callback URLs

After the user authenticates, Auth0 redirects only to a URL on this list.
Always include the protocol (`https://` for deployed apps). Default localhost
ports for local development:

```
http://localhost
http://localhost:80
http://localhost:3000
http://localhost:3001
http://localhost:8080
http://localhost:31022
```

### Allowed Logout URLs

Valid redirect targets for the `returnTo` query parameter after a user logs
out from Auth0. Supports wildcard subdomains (`*.example.com`). Query strings
and hash fragments are ignored during validation. Default localhost ports:

```
http://localhost/logout
http://localhost:80/logout
http://localhost:3000/logout
http://localhost:3001/logout
http://localhost:8080/logout
http://localhost:31022/logout
```

### Allowed Web Origins

Origins permitted for Cross-Origin Authentication, Device Flow, and Web
Message Response Mode. Format: `{scheme}://{host}[:{port}]` (e.g.
`http://localhost:3000`). Supports subdomain wildcards
(`https://*.example.com`). Query strings and hash fragments are ignored.

### Allowed Origins (CORS)

Origins allowed to make JavaScript requests to the Auth0 API. All callback
URLs are included by default. Add additional origins here as needed. Supports
subdomain wildcards. Query strings and hash fragments are ignored.

---

## Additional API Key Actions (via Client Experience)

| Action | Effect |
|---|---|
| **Disable API Key** | Blocks new Access Tokens and Refresh Token grants. |
| **Enable API Key** | Re-enables token issuance. Non-expiring Refresh Tokens issued before disabling become valid again — disabling/re-enabling is **not** a safe way to handle compromised credentials. |
| **Rotate Client Secret** | Issues a new `client_secret`. Non-expiring Refresh Tokens generated before the rotation remain valid. |

---

## Related Documents

- [`setup.md`](setup.md) — Credential acquisition and OAuth bootstrap steps.
- [`faq.md`](faq.md) — API key types (Auth0 vs OAuth2), which API version to use.
- [`decisions.md`](decisions.md) — Open questions including sim-environment base URL.
