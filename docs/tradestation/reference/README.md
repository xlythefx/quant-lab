# `reference/` — verbatim TradeStation documentation

This folder holds **verbatim copies** of TradeStation's official
documentation pages, as forwarded by Christian or pulled from
<https://api.tradestation.com/docs/>.

## Rules for this folder

1. **Verbatim only.** Don't paraphrase, don't shorten, don't add
   commentary inline. If you want to comment, do it in
   `../endpoints.md` (or another curated doc) and link back here.
2. **One TS doc page = one markdown file.** Filename matches the page
   slug (e.g. `welcome-overview.md`, `auth-oauth.md`).
3. **Capture the source URL** in the first line of each file so the
   provenance is obvious.
4. **Date the capture.** Docs change. The date at the top tells future
   readers how fresh this content is.

## Why this exists separately from `endpoints.md`

`endpoints.md` is our **interpretation** — what fields we'll read, what
edge cases to expect, what params to send. It's lossy by design.

`reference/` is the **source of truth**. If `endpoints.md` ever
disagrees with the verbatim docs here, the docs win — fix the
interpretation.

## Index

| File | TS doc page | Date captured |
|---|---|---|
| [`welcome-overview.md`](welcome-overview.md) | API Welcome Overview | 2026-05-22 |
| _(more to come as Christian forwards them)_ | | |
