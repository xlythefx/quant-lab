# quant-laptop documentation

Project documentation lives here. Code documentation (docstrings, type
hints, inline comments) stays in the source files; **`docs/` is for
material that doesn't fit in code** — architecture decisions, vendor
integrations, operational runbooks, planning specs.

## Folders

| Folder | Subject |
|---|---|
| [`tradestation/`](tradestation/) | TradeStation WebAPI ingestion connector — planning, architecture, credential setup, endpoint reference. Currently in pre-implementation phase (waiting on credentials). |

## Conventions used in this folder

- **One topic per subfolder.** Each integration / system / initiative
  gets its own subdirectory with a `README.md` that indexes the files
  inside it.
- **Verbatim third-party docs live under `<topic>/reference/`.** Our
  curated synthesis lives in sibling files. When the two disagree,
  the verbatim source wins — fix the synthesis.
- **Open questions live in `<topic>/decisions.md`** with `D-N` IDs.
  When a decision lands, update in-place rather than deleting — the
  history matters.
- **Status badges in READMEs:** `📋 Planned`, `⚙️ In progress`,
  `✅ Done`, `🕒 Deferred`, `⏸️ Blocked`, `❌ Cancelled`.
- **No code in `docs/`.** Scripts and helpers live in
  `backend/scripts/` or appropriate code folders, with `docs/` linking
  to them.
