# Setup — TradeStation API Credentials

> **Currently blocked.** No credentials yet. This file is the operational
> checklist; the protocol-level detail lives in
> [`auth-code-flow.md`](auth-code-flow.md) (captured from official TS docs)
> and [`auth-fundamentals.md`](auth-fundamentals.md) (Auth0 key defaults).
> When the two disagree, the official docs win — update this file.

## Step 0 — Account prerequisites

You need a **funded TradeStation brokerage account**. The brokerage
account itself is not enough — API access is a separate request.

- [ ] Have a funded TradeStation brokerage account.
- [ ] Email **ClientExperience@tradestation.com** requesting an API key.
      Per the official FAQ, this is the only channel — there is no
      self-service developer portal.
- [ ] Wait for the key to be issued. Lead time varies; start this
      **before** anything else — everything depends on it.
- [ ] When the key arrives, note which **type** it is:
  - **Auth0** key — mixed case, no dashes (`8P07Yx8KLvYAgYWpVy7Mns7wN2mkgvH4`)
  - **OAuth2** key — all-caps with dashes (`EAC7BF97-B3HE-4EGD-9D94-7686C542A8B3`)
  - Most newly issued keys are Auth0 today. See [`faq.md`](faq.md) for
    the distinction and [`decisions.md`](decisions.md) D-10 for the
    project's stance on which to target.

## Step 1 — Confirm key configuration

The key ships with TradeStation-set defaults (see [`auth-fundamentals.md`](auth-fundamentals.md)):

- App type: **Regular Web App** → uses **Authorization Code Flow**.
- Refresh tokens: **enabled, non-expiring** by default. (Optionally
  rotated every 40 min on request.)
- Default scopes: `MarketData`, `ReadAccount`, `Trade`.
- Allowed callback URLs default to localhost on ports
  `80 / 3000 / 3001 / 8080 / 31022`.

Decide what (if anything) needs to be changed from defaults — all
changes go via **ClientExperience@tradestation.com**:

- [ ] Confirm `MarketData` scope is enabled (the only one we strictly need).
- [ ] Decide whether to **drop** `Trade` and `ReadAccount` scopes for a
      data-only connector (principle of least privilege). Optional.
- [ ] Confirm at least one allowed callback URL works for our prototype.
      `http://localhost:8080` is on the default list and is what
      [`auth-code-flow.md`](auth-code-flow.md) uses in examples — no
      change needed for local dev.
- [ ] If running from a non-localhost server later, request a custom
      callback URL to be added (production deployment concern, not
      prototype).

## Step 2 — Choose environment(s)

TradeStation provides separate **sim** and **live** environments.

- [ ] Decide whether to register in **sim**, **live**, or both.
      Recommendation: **register both** — develop against sim, validate
      against live before any production cutover.
- [ ] Capture both sets of `client_id` / `client_secret` if applicable.
- [ ] **[verify]** Confirm sim base URL. The official Welcome Overview
      (see [`reference/welcome-overview.md`](reference/welcome-overview.md))
      only documents `https://api.tradestation.com/v3` (production). The
      Auth Code Flow docs use `https://signin.tradestation.com` for the
      OAuth endpoints regardless of env. The sim API base URL is still
      open — tracked as **D-3** in [`decisions.md`](decisions.md).

## Step 3 — Place secrets in `.env`

The backend already uses `python-dotenv`. Add to `backend/.env`
(never commit this file — `.gitignore` it):

```
TRADESTATION_ENV=sim                          # or "live"
TRADESTATION_CLIENT_ID=...                    # from step 1
TRADESTATION_CLIENT_SECRET=...                # from step 1
TRADESTATION_REDIRECT_URI=http://localhost:8080
TRADESTATION_REFRESH_TOKEN=                   # filled in by step 4
```

> The redirect URI **must exactly match** the value used in both the
> authorization request and the token exchange. `http://localhost:8080`
> is on TS's default allowlist (see [`auth-code-flow.md`](auth-code-flow.md)),
> so no Client Experience request is needed for local dev.

## Step 4 — Bootstrap OAuth (one-time, manual)

Once `auth.py` exists (post-prototype-start):

```
python -m backend.services.brokers.tradestation.auth bootstrap
```

This will (per [`auth-code-flow.md`](auth-code-flow.md)):
1. Build an authorization URL pointing at
   `https://signin.tradestation.com/authorize` with these params:
   - `response_type=code`
   - `client_id=<TRADESTATION_CLIENT_ID>`
   - `audience=https://api.tradestation.com`
   - `redirect_uri=http://localhost:8080`
   - `scope=openid offline_access MarketData` (minimum for data-only)
   - `state=<random>` for CSRF protection
2. Open it in your browser.
3. You log in to TradeStation and approve the consent dialog.
   (On localhost, a second consent dialog may appear on first login.)
4. TS redirects to `http://localhost:8080?code=...&state=...`. The
   bootstrap script runs a tiny local HTTP listener to capture this.
5. The script POSTs to `https://signin.tradestation.com/oauth/token`
   with form fields:
   - `grant_type=authorization_code`
   - `client_id`, `client_secret`, `code`
   - `redirect_uri=http://localhost:8080` (must match step 1 exactly)
   and receives `{access_token, refresh_token, id_token, token_type,
   scope, expires_in}`. `expires_in` is **1200 seconds = 20 minutes**.
6. Writes the `refresh_token` back into `.env` under
   `TRADESTATION_REFRESH_TOKEN`. (Per [`auth-fundamentals.md`](auth-fundamentals.md),
   default refresh tokens are **non-expiring** — one bootstrap should
   last indefinitely unless the user changes their TS password, the
   key is rotated/disabled, or access is revoked.)

## Step 5 — Verify the refresh path

```
python -m backend.services.brokers.tradestation.auth refresh
```

Should print a fresh access token + expiry. If this works without
re-opening a browser, the credential setup is complete.

## Step 6 — Smoke-test a data call

```
python -m backend.services.brokers.tradestation.client fetch_bars @NQ 60m 100
```

Should print the last 100 hourly bars for the continuous NQ contract.
If this prints valid OHLCV, **prototype step 2 is unblocked** and
implementation can begin.

---

## Troubleshooting checklist

When the inevitable happens:

- **401 Unauthorized on every call** → access token wrong / expired
  (`expires_in: 1200` = 20 min). Run `auth refresh`. If that also 401s,
  refresh token was revoked (password change, key rotated/disabled by
  Client Experience). Re-run `auth bootstrap` — and check whether
  Client Experience changed the key config.
- **403 Forbidden on `/v3/marketdata/*`** → app doesn't have the
  `MarketData` scope. Email Client Experience to add it; you cannot
  self-serve scope changes.
- **`access_denied` error on the redirect URL** → user declined the
  consent dialog. Try again.
- **`redirect_uri_mismatch` error from the token endpoint** → the
  `redirect_uri` sent at exchange time doesn't byte-match the one
  used in the authorize request. Both must be identical, port and all.
- **404 on the bars endpoint** → likely wrong base URL (used sim URL
  with live `client_id` or vice versa). Check `TRADESTATION_ENV`.
- **Streaming connects but no data** → market closed. Try during US
  futures session (Sun 6pm ET → Fri 5pm ET for `@NQ`).
- **Streaming disconnects every ~25 minutes** → TS-imposed connection
  cap. Reconnect logic (prototype step 5) handles this — it's not a bug.

## Don't do these

- ❌ Commit `.env` to git.
- ❌ Paste `client_secret` or `refresh_token` into chat / Slack / tickets
  / screenshots.
- ❌ Use the same `refresh_token` from multiple machines — TS may
  invalidate one when the other refreshes. If you need parallel
  environments, register separate apps.
- ❌ Hammer the API while debugging — rate limits exist and you can
  get your app throttled or temporarily banned. Cache responses
  during dev.
