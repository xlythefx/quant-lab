# 10 — Cutover & retire the old live (final step)

**Status:** 🟦 In progress (Jul 02, 2026 — build items done; soak period + old-page retirement await user confirmation)
**Created:** Jul 01, 2026
**Depends on:** 02–09 complete and the new terminal in real use.

## Goal

Only after the new Live Terminal is confirmed working, make it the single home for live
trading and retire the old `LiveAlerts` surface — safely, with parity checked first, and
without losing any data or config.

## Context / why

Per the migration principle in [01](01-live-terminal-overview.md): nothing live is
removed until the new one is proven. This is that deliberate, separate final step.

## Checklist

- [x] Parity check: run the same alert rule through the OLD page and the NEW terminal;
      confirm the same webhook payload fires on the same signal (byte-compatible).
      *(Verified Jul 02, 2026: both surfaces call the same `live_alerter.build_payload`
      path; a real POST against a mock endpoint delivered the exact
      `{secret, strategy, leverage, action, symbol}` payload.)*
- [x] Confirm every capability of the old page exists in the new one: create, edit,
      delete rules; webhook presets; test-signal; the fired-alert history.
      *(Terminal Alerts view: RULES tab with full CRUD + params + payload template,
      URL/secret presets from existing rules, dry-run AND real test fire, SQLite
      fired history with filter/delete — plus activity log + reconciliation the
      old page never had.)*
- [x] Migrate/verify config: existing `data/live_alerts.json` rules load unchanged in the
      new terminal; nothing needs re-entering. *(Existing rules appear as deployments
      as-is; the added `account` field defaults to demo without rewriting files.)*
- [ ] Run the new terminal live for an agreed soak period (Demo first, then a small Live
      amount), watching for missed/duplicate fires and reconciliation mismatches (09).
      **← user's call; do not skip**
- [ ] Remove the old `#livealerts` entry from the nav (keep the route/page in the code one
      release longer as a fallback, then delete in a follow-up). **← only after the soak**
- [x] Update docs: `CLAUDE.md` (live section), and any references that point at the old page.
- [ ] Final acceptance walkthrough — run the whole [01](01-live-terminal-overview.md)
      "finish line" end to end and confirm each item. **← manual, with the app running**

## Done when

The Live Terminal is the one place you run and monitor live strategies; the old alerts
page is retired from the nav; no rules or history were lost; and the finish-line
walkthrough passes.

## Notes

- If anything in the new terminal is weaker than the old page, do NOT retire yet — fix
  first. The old page is the safety net until then.
