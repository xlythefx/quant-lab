# Open Decisions — Resolve Before Coding

Each question below blocks at least one component. Lock them with
Christian before the credential-arrival sprint begins; updating them
after code is written is more expensive than answering now.

When a decision lands, update the entry in-place: keep the question for
context, add a **Decided:** block with the answer, the date, and who
decided.

---

## D-1 — Storage backend

**Question:** Where do bars actually live?

**Context:**
- You wrote (2026-05-22): "Database soon will be WAMP MySQL."
- Christian wrote (same day): "Save into SQLite/Postgres."

**Options:**
1. **SQLite for prototype, swap to WAMP MySQL when ready.** Same
   SQLAlchemy code, just a different connection string. Lowest friction.
2. **WAMP MySQL from day 1.** Means installing WAMP before any prototype
   code runs. Higher upfront cost; no SQLite throwaway.
3. **Postgres.** Best technical choice long-term, but adds install
   complexity vs. WAMP which is already on the roadmap.

**Recommendation:** Option 1. Reasoning in `storage.md` — SQLAlchemy
hides the dialect, so we get prototype-velocity now and zero rewrite later.

**Decided:** —

---

## D-2 — Symbol form for NQ in the prototype

**Question:** When Christian wrote "request NQ bars", does he mean
`@NQ` (continuous) or `NQM26` (front-month June 2026 contract)?

**Context:**
- The Sinegual sample exports were run on **contract-specific** symbols
  (`@ESM26`, etc.), per their embedded "Settings" section.
- For Sinegual Lab parity-checking, ingestion must match what
  TradeStation actually used → contract-specific.
- For long-horizon strategy backtests, continuous is more natural.
- See `symbol-map.md` for the full tradeoff.

**Options:**
1. **Continuous only (`@NQ`).** Simpler. Strategy backtests work
   "out of the box". Sinegual parity will not match.
2. **Front-month contract only (e.g. `NQM26`).** Matches Sinegual.
   Requires rollover code or manual contract selection.
3. **Both.** Different canonical symbols (`NQ_CONT` and `NQ_M26`).
   More storage, but no downstream coupling. Matches the schema
   in `storage.md` (the `contract` column).

**Recommendation:** Option 3 for the eventual system. For the **prototype
specifically**, Option 1 (`@NQ` only) is enough — the prototype's job is
to prove the pipe works, not to match Sinegual yet. Sinegual parity is
the next slice.

**Decided:** —

---

## D-3 — Sim vs live environment

**Question:** Do we build and bootstrap against sim, live, or both?

**Context:**
- TS has separate sim and live environments with different base URLs
  and likely different `client_id`s.
- Sim is for paper trading + market-data-only dev. Live is real.
- For a data-only connector, sim is sufficient — same market data,
  separate auth scope.

**Recommendation:** Develop the prototype against **sim only.** Once it
works, register a parallel live app and validate the same code paths
against live before any production use. The base-URL switch is config,
not code.

**Decided:** —

---

## D-4 — Session template for NQ historical fetch

**Question:** Which TS `sessiontemplate` value does the prototype use
for the historical bars call?

**Context:**
- The Sinegual folder name "Fixed session hours" implies session-bound
  data, not 24h.
- US equity futures (NQ, ES) trade nearly 24h. Different session
  templates (`Default`, `USEQPreAndPost`, `USEQ`, custom) produce
  different bar sets.
- The Sinegual sample CSV's Settings section showed `Look-Inside-Bar
  Back-Testing: Disabled`, but doesn't explicitly name the session
  template — need to verify by spot-checking bar counts and timestamps.

**Recommendation:** For the prototype, request `sessiontemplate=Default`
(24h trading) and verify the bar count matches `barsback`. Once that's
proven, replicate one of the Sinegual sample symbols using the
session template TS shows for that symbol — that's the parity baseline.

**Decided:** —

---

## D-5 — Where the OAuth bootstrap script runs

**Question:** Is the OAuth bootstrap (`auth bootstrap` command) run on
the dev machine, on the backend server, or both?

**Context:**
- OAuth bootstrap requires a browser to complete the consent flow.
- It produces a long-lived refresh token, which can then be used
  headlessly elsewhere.
- If we use one refresh token across multiple machines, TS may
  invalidate one when another refreshes (depends on TS server policy).

**Recommendation:** Bootstrap on the developer machine, then copy the
refresh token to the server's `.env`. Never run the bootstrap from the
server. If parallel dev environments are needed (laptop + server doing
real work at once), register **separate apps** and bootstrap each
independently.

**Decided:** —

---

## D-6 — Token storage location

**Question:** Where does the refresh token live in production?

**Options:**
1. `.env` file (current pattern for other secrets in this repo).
2. OS keyring (cross-platform via `keyring` lib).
3. Encrypted file (custom).
4. A secrets manager (Vault, AWS SSM, etc.).

**Recommendation:** `.env` for now (option 1) — matches existing
pattern, simple, gitignored. Revisit if/when this code runs in a
shared multi-tenant deployment.

**Decided:** —

---

## D-7 — How aggressive is the prototype's reconnect test?

**Question:** Step 5 of the prototype is "test stability/reconnections".
What's the bar to clear?

**Options:**
1. **Minimal:** verify the connector reconnects after a 30-second
   manual network drop, once. Single-pass.
2. **Standard:** all four failure modes in `prototype-plan.md` (network
   drop, token expiry, server disconnect, dedup verification).
3. **Production-ready:** standard + multi-hour soak test + automated
   chaos injection + alerting.

**Recommendation:** Option 2 for the prototype. Option 3 is a follow-up
hardening pass.

**Decided:** —

---

## D-8 — Naming: "broker" vs "feed" vs "provider"

**Question:** The existing repo uses **`brokers/`** for data sources
(yahoo, dukascopy). The new abstraction is conceptually a **feed**
(market data, not execution). Pick one name and use it consistently.

**Options:**
1. Call TradeStation a **broker** (keep existing `brokers/` namespace).
   New TS package lives at `backend/services/brokers/tradestation/`.
   Abstraction lives at `backend/services/feed/`. Some semantic
   awkwardness: a "feed" interface implemented by a "broker" module.
2. Rename `brokers/` → `feeds/`. Cleaner conceptually, but a real refactor
   that touches imports throughout the codebase.
3. Leave `brokers/` as-is; put new code in `feeds/`; tolerate the
   semantic mismatch as historical drift.

**Recommendation:** Option 1 for the prototype (minimal disruption).
Plan a rename in a separate dedicated PR later if it becomes annoying.

**Decided:** —

---

## D-9 — Does the prototype write to the existing parquet too?

**Question:** Bars come in via TS stream → SQL DB. Should the same
ingestion also write parquet, so the existing backtest engine sees
the data without a separate exporter?

**Options:**
1. **No.** Prototype writes SQL only. Parquet export is a separate slice.
   Cleaner. Backtest engine doesn't see TS data until the exporter is built.
2. **Yes, dual-write.** Write each bar to both SQL and the parquet cache.
   Backtest engine immediately works against TS data. More plumbing,
   risk of divergence.

**Recommendation:** Option 1. The prototype is about proving the pipe;
making the data downstream-usable is the next slice. Dual-write
invites bugs (which view is canonical when they disagree?).

**Decided:** —

---

## D-10 — Auth0 key vs OAuth2 key reconciliation

**Question:** TradeStation issues two API key formats. Which one does
this project target, and does the auth flow differ between them?

**Context:**
- [`faq.md`](faq.md) describes two key formats:
  - **Auth0** — mixed case, no dashes (e.g. `8P07Yx...`).
  - **OAuth2** — all-caps with dashes (e.g. `EAC7BF97-B3HE-...`).
- The FAQ's AI usage notes (added by Christian) state: *"The credential
  type expected here is OAuth2 (all-caps + dashes format)."*
- But [`auth-code-flow.md`](auth-code-flow.md) is labelled *"For Auth0
  API keys only. For OAuth2 keys see faq.md for key format differences."*
- We have not yet captured the OAuth2-specific flow doc — it likely
  describes a different authorize URL or different parameters.
- Most newly issued keys today appear to be Auth0.

**Options:**
1. **Build against Auth0 first.** Use the flow in `auth-code-flow.md`
   verbatim. When/if an OAuth2 key arrives, add a second code path.
2. **Build against OAuth2 first.** Wait for that flow doc, then build.
   Delays the prototype.
3. **Build a single abstraction that handles both** from day 1. More
   work; only valuable if both key types are in active use across our
   environments.

**Recommendation:** Option 1. Whatever key TS issues us first is the
one we develop against. The Auth Code Grant pattern is fundamentally
the same in both cases — only the URLs / param vocabulary differ —
so the second variant is a small adapter, not a rewrite.

**Decided:** —

---

## How to use this file

- Bring it to the conversation with Christian. Walk through each item.
- For each `**Decided:** —`, replace with `**Decided:** <answer> — <date> — <who>`.
- If a new question surfaces during implementation that affects design,
  add it here rather than answering it silently in code.
- Once everything is **Decided** and the prototype ships, this file
  becomes historical — leave it for context.
