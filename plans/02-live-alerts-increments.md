# 02 — Live alerts with increments (repeated entries) · PRIORITY

**Status:** 🟩 Core done Jul 07, 2026 (clamp lifted, builds pass) — live validation pending
**Created:** Jul 07, 2026 · **Updated:** Jul 07, 2026 (correct model; Flask owns computation)
**Depends on:** [01](01-production-overview.md). QuantLab-side only.

## Goal

Let a live deployment **take multiple trades on the same signal** — one full trade
each time the entry condition fires again, up to the increment (`pyramiding`) cap —
**exactly as the backtest does.** QuantLab just throws one webhook per trigger; the
Flask receiver does all the real work.

## The correct model (how the backtest treats increments)

An "increment" is **not** splitting one entry into small chunks. It's **another full
trade**, opened each time the entry condition triggers again, capped at a number.

The backtest ([backtest_engine.py](../backend/services/backtest_engine.py)):
- `pyramiding` → `max_tranches` = the cap on how many trades can be open at once
  ([:242](../backend/services/backtest_engine.py#L242)).
- On **every bar**, if the entry **condition** is true AND open trades < cap, it
  opens **another full trade** ([:514](../backend/services/backtest_engine.py#L514)),
  each sized at full equity × risk% ([:525](../backend/services/backtest_engine.py#L525))
  — never a fraction.
- It uses the raw per-bar `cond_long`/`cond_short` (which can fire repeatedly), not
  the one-shot `entry_long`/`entry_short` ([:291-301](../backend/services/backtest_engine.py#L291)).

So: **condition fires → stack another full trade, up to N.** Live must mirror this.

## Division of labor (the key simplification)

- **QuantLab just throws JSON.** One webhook (`{secret, strategy, action:BUY/SELL/
  EXIT_*, symbol, leverage}`) per condition trigger, and it writes the fire to its
  local log. That's the whole job.
- **The Flask receiver owns ALL computation** — increment sizing (`base_size`),
  counting tranches, enforcing `max_increments`/`max_sizing`, placing the order,
  tracking the real position and P&L. No change needed there; it already does this.

So QuantLab does **not** compute size, track tranches, or estimate P&L. It fires and
logs; the receiver executes and the dashboard reports.

## Where it's blocked today

- `pyramiding` forced to 1 on deploy: [live_terminal_routes.py:198-199](../backend/routes/live_terminal_routes.py#L198)
  (create) and [:246-247](../backend/routes/live_terminal_routes.py#L246) (patch).
- Live engine **suppresses repeated entries**: an add while a position is open is
  ignored ([live_engine.py:171](../backend/services/live/live_engine.py#L171)), so
  the 2nd/3rd trigger never fires a webhook.
- Idempotency key is `rule|bar_time|action` ([live_engine.py:119](../backend/services/live/live_engine.py#L119))
  — fine for one trigger per bar; needs a tranche index only if a strategy emits
  several entries on the SAME bar.
- The reference multi-entry strategy is `vwap_deviation` (its `on_candle` returns one
  entry per trigger up to `pyramiding`, [vwap_deviation.py:330-438](../backend/services/strategies/vwap_deviation.py#L330)).
  `vwma_*` are single-entry live and stay that way for now.

## Checklist

- [x] **Lift the clamp.** Removed the `pyramiding=1` force in THREE places — the two
      routes (`deployments_create` / `deployments_patch`), the frontend `DeployModal`
      (hard-coded params), AND `ParamForm` (which hard-*disabled* the field, the real
      lock). `pyramiding` now flows through, bounded by the strategy's own PARAM_SCHEMA
      max; default stays 1 via the schema. *(No asset-cap lookup: QuantLab can't read
      the remote SaaS config across envs; the strategy schema bounds it and the receiver
      caps execution.)*
- [x] **Fire one webhook per trigger — already the behavior.** The daemon fires one
      webhook per signal ([alerts_daemon.py:82-83](../backend/services/alerts_daemon.py#L82));
      the `on_signals` suppression only touched the (now-deprecated) local journal, NOT
      dispatch — so it never blocked firing and was left as-is. Payload unchanged
      (`BUY`/`SELL`, no `ADD`, no `quantity`).
- [x] **Deploy modal allows `pyramiding > 1`** — the field is editable and no longer
      reset to 1.
- [ ] **Robust idempotency — deferred (not needed yet).** `vwap_deviation` emits one
      entry per bar → distinct `bar_time` → each already fires. Only a strategy emitting
      several entries on ONE bar would need a tranche ordinal in the dedup key.
- [ ] **Log each fire with destination** — phase 03 (the fire log).
- [ ] **Throw to 156 first** — operational: set the deployment's `webhook_url` to the
      156 endpoint and eyeball the fire log vs the dashboard before any 167 deploy.

## Safety

Lifting the clamp removes the single-position parity guard. Guardrails:
1. Default deployments stay `pyramiding=1`; increments are opt-in per deployment.
2. Only pyramiding-capable strategies (start: `vwap_deviation`) should run >1.
3. Keep `pyramiding ≤ asset max_increments/max_sizing`, else the receiver silently
   drops the extra trades (guaranteed divergence from the backtest).
4. Validate on **156** manually (fire log vs dashboard) before any 167 deployment.

## Done when

You can deploy `vwap_deviation` live with `pyramiding = N`, and each time its entry
condition fires QuantLab throws one `BUY`/`SELL` webhook (up to N open) to 156, each
one logged with its destination — matching the count/direction of the backtest's
tranches for the same window. (Per-trade *size* is the receiver's `base_size`, not
expected to match the backtest exactly.)

## Notes

- No SaaS/Flask changes — execution, sizing, counting, and caps already live there.
- Once this lands, update the `live-vs-backtest-parity` memory: parity is now about
  matching increment **count/timing**, not per-trade dollar size.
