import { fmtNum, fmtInt, fmtPct } from "./format.js";

/**
 * The walk-forward validation gauntlet — computed ONCE, rendered in two places.
 *
 * Why this module exists: the Overview banner and the Verdict tab used to score
 * the same run with two independent systems. The banner summed Sharpe / green
 * rate / Calmar / profit-factor into a 0–8 tier and labelled >= 6 as
 * "🟢 Deploy candidate"; the Verdict tab ran eleven gates. They could disagree
 * on the same result — and worse, the banner's label was the exact category
 * error `_build_deploy_candidate` warns about two tabs over: the stitched curve
 * is evidence about a PROCEDURE ("re-optimize every N bars"), not about any
 * single deployable parameter set.
 *
 * So there is now one computation. The banner renders a compact view of it, the
 * Verdict tab renders the full gate cards, and they cannot drift apart.
 *
 * Every gate reads numbers already present in the walk-forward result — no new
 * backend work. Lights are pass / warn / fail / na. Two gates (locked holdout,
 * cross-strategy honesty) cannot be judged from a single run at all and are
 * rendered as grey reminders by the panel, never auto-greened here.
 *
 * Full methodology: docs/plans/validation-checklist.md
 */

// Reading order. The first two can invalidate everything below them: if the
// search found nothing, a green plateau or a green OOS rate is describing noise.
export const GATE_ORDER = [
  "Tuning beat not-tuning",
  "Windows agree on the params",
  "Picks rest on a real sample",
  "Parameter plateau",
  "Holds out-of-sample",
  "Enough trades",
  "Distinguishable from zero",
  "Beats buy-and-hold",
  "Survives trial-count penalty",
  "Not carried by a few trades",
  "No recent decay",
];

export const DECISIVE = new Set(GATE_ORDER.slice(0, 2));

/**
 * Every verdict the page can reach, with what triggers it and what to do about it.
 *
 * This is a catalog rather than strings inlined at each branch so the Verdict
 * panel (which shows the steps for YOUR run) and the Walk-Forward Guide (which
 * lists all of them) cannot drift apart. `computeWFGates` returns `verdictId`;
 * both renderers look the rest up here.
 *
 * `steps` is a function of a small context so a verdict can name the specific
 * culprit in the panel while the guide, calling it with no context, still reads
 * as generic advice.
 */
export const VERDICTS = [
  {
    id: "tuning_veto",
    tone: "loss",
    label: "The search found nothing",
    when: "The control arm failed: the same windows traded with the UNTUNED base params did better than re-optimizing every window.",
    why: "This is a finding about the optimizer, not necessarily about the strategy. Everything else in the report — stitched curve, WFE, green rate — is measured only on the tuned arm, so it looks identical whether the search found a real optimum or sampled noise. That is why this one vetoes.",
    steps: () => [
      "Do not deploy the consensus set. On this data the untouched defaults beat it.",
      "Shrink the search space. Every extra dimension is another chance to fit noise — 2 or 3 params behaves far better than 6.",
      "Raise Min IS trades (Rigor row). At a low floor a window can be won by a config picked on a handful of lucky trades, which is exactly how a search ends up worse than not searching.",
      "Raise IS bars so each window tunes on a bigger sample, or raise Trials so the search actually converges.",
      "Consider that the base params working better IS the result. A strategy that doesn't need tuning is the most robust kind there is — run the gauntlet on the defaults instead.",
    ],
  },
  {
    id: "agree_veto",
    tone: "loss",
    label: "No agreement, and tuning didn't earn its keep",
    when: "Both decisive gates failed: the windows' parameter picks are spread as widely as random guessing, AND re-optimizing did not beat leaving the base params alone.",
    why: "The clearest negative the page can give. Two independent checks agree that the optimization step is not measuring a real effect, so no gate below them can be trusted to mean anything.",
    steps: () => [
      "Stop tuning this configuration — nothing in the report is measuring a real effect.",
      "Check the search space for parameters this strategy ignores. Preflight flags the classic case: risk_pct is inert on futures and contracts is inert on crypto.",
      "Check the strategy actually fires enough trades per IS window. Look at best_trades in the exported JSON — if the median is under ~30, every pick is noise.",
      "Try a different timeframe or symbol, or a different idea entirely.",
      "Count this run as one of the distinct ideas you've tested. Gate 6 (cross-strategy honesty) is manual, and the more you try, the higher a future winner has to clear.",
    ],
  },
  {
    id: "mixed_signal",
    tone: "amber",
    label: "Mixed signal — one param disagrees",
    when: "Re-optimizing DID beat the untuned params, but the windows never agreed on at least one parameter.",
    why: "Those two are hard to hold at once, and the usual explanation is boring: the agreement gate reports the WORST parameter, not the average. A knob the strategy is insensitive to has an arbitrary winner every window and sits at the random level by construction — while your other params do the real work the control arm detected. One dead dimension, one red gate.",
    steps: (ctx = {}) => {
      const p = ctx.worstParam ? `\`${ctx.worstParam}\`` : "the parameter named in the headline";
      return [
        `Open the Parameters tab. On the drift chart ${p} will swing while the others hug zero — that's the picture of an insensitive knob.`,
        `Decide whether ${p} actually affects this strategy. Hold everything else fixed and sweep just that one; if the score barely moves, it's inert.`,
        `Re-run with ${p} removed from the search space and fixed at a sensible constant. If the results barely move but the gate goes green, that was the culprit and your real verdict is whatever comes back.`,
        `If removing it DOES change the out-of-sample result, it wasn't inert — you have a parameter that matters and that your windows cannot agree on. That's a genuine instability, and a much worse finding than a dead knob.`,
        "Until you've resolved which it is, treat the consensus set as unproven — its median for that param is an average of noise.",
      ];
    },
  },
  {
    id: "insufficient",
    tone: "amber",
    label: "Not enough to judge",
    when: "Fewer than 5 of the gates could be measured on this run.",
    why: "A pass ratio is not evidence when the denominator is tiny. Older results, or runs with no search space, score too few gates for any verdict to mean something.",
    steps: () => [
      "Check a search space is actually set. With nothing marked Search, the run is a rolling backtest of fixed params, not a walk-forward — and most gates have nothing to read.",
      "Re-run on the current build. Several gates are computed during the run and cannot be backfilled onto an old result.",
      "Use enough data for at least 30 windows. Below that the per-window rates carry too much standard error to read.",
    ],
  },
  {
    id: "unverified",
    tone: "amber",
    label: "Unverified — a decisive gate is unmeasured",
    when: "One of the two decisive gates could not be measured, most often because the result predates the control arm.",
    why: "The page will never show green while a gate that can invalidate everything else is blank. Absence of evidence is not a pass.",
    steps: () => [
      "Re-run. The control arm is computed during the run (each window traded a second time with the untuned base params) and cannot be added to a stored result afterwards.",
      "If it stays unmeasured after a re-run, check you have at least two windows with numeric parameter picks — the agreement gate needs something to compare.",
    ],
  },
  {
    id: "looks_real",
    tone: "profit",
    label: "Looks Real",
    when: "At least 75% of measurable gates passed, with no failures and no warnings on the two decisive gates.",
    why: "The strongest verdict a single run can produce — which is still not proof. Every number here comes from data you have now looked at.",
    steps: () => [
      "Click See Equity Curve on the deploy candidate. The stitched curve re-tunes every window and is not deployable; you need to see what one fixed set does.",
      "Run the Cost Sweep at pessimistic fees and slippage. If the edge only exists at 1bp, it doesn't exist.",
      "Run Monte Carlo to check the edge isn't an artifact of trade ordering.",
      "Then, and only once, run the locked holdout — the most recent 6-12 months you have never touched. Use the Live-Test Holdout or Pre-Deploy Gauntlet preset so the optimizer never sees it.",
      "Be honest about gate 6: count how many distinct ideas, symbols and timeframes you've tried. Deflated Sharpe only penalizes trials inside this one run.",
      "If you deploy, size small. Live uses fixed-lot sizing from the acceptor while the backtest models fixed-fraction, so the drawdown numbers here do not describe your real account.",
    ],
  },
  {
    id: "fragile",
    tone: "amber",
    label: "Fragile — has an edge but leans on something",
    when: "At least half the measurable gates passed, but some failed or the decisive gates warned.",
    why: "There is something here, but it depends on a condition you should identify before risking money on it.",
    steps: () => [
      "Read the Failing and Watch lists in the headline — they name exactly which gates are the problem, and each gate card explains itself in plain words.",
      "If the plateau gate is the weak one, try Selection = plateau in the Rigor row. It picks the broadest region rather than the highest spike, at no extra cost.",
      "If embargo and purge were 0, re-run with them set to about one trade's length. Training running right up against testing flatters a result.",
      "If the weak gate is trade count, raise Min IS trades and accept that some windows will report no eligible config — that's the truth rather than a manufactured winner.",
      "Size small and keep watching. Fragile is not a no, it's a not-yet.",
    ],
  },
  {
    id: "overfit",
    tone: "loss",
    label: "Likely Overfit / Luck",
    when: "Fewer than half the measurable gates passed.",
    why: "The result is far more consistent with curve-fitting or good luck than with a real, repeatable edge.",
    steps: () => [
      "Resist re-tuning until it turns green. Every extra attempt is more multiple testing, and the page cannot see how many you've run.",
      "Make exactly one structural change — a smaller search space, a higher trade floor, or more IS bars — and re-run once.",
      "If it's still red, kill it. Record it as an idea you tried, which raises the bar for whatever you test next.",
    ],
  },
];

const VERDICT_BY_ID = new Map(VERDICTS.map((v) => [v.id, v]));

/** Look up a verdict's catalog entry. Returns null for unknown ids. */
export function verdictById(id) {
  return VERDICT_BY_ID.get(id) || null;
}

/**
 * What one out-of-sample window actually did: "green" | "red" | "flat".
 *
 * "flat" means the strategy never fired in that window. It is NOT a losing
 * window, and counting it as one (the old `(sharpe ?? 0) > 0`) conflates "lost
 * money" with "didn't trade" — the backend deliberately preserves a null Sharpe
 * for exactly this reason (walkforward.py, window_pairs). Flat windows leave the
 * green-rate denominator and are reported separately.
 */
export function windowOutcome(w) {
  const st = w?.oos_stats || {};
  if (Number(st.trades || 0) === 0) return "flat";
  const sh = st.sharpe;
  if (sh == null || !Number.isFinite(Number(sh))) return "flat";
  return Number(sh) > 0 ? "green" : "red";
}

/**
 * Stitch each window's buy-and-hold return into one benchmark series.
 *
 * `contractSized` picks the convention, and it has to match how the STRATEGY's
 * equity was stitched or the comparison is unfair. Fixed-contract futures don't
 * compound — `contracts` is constant regardless of equity, so walkforward.py
 * stitches those windows additively. Compounding the benchmark against a
 * non-compounding strategy quietly hands buy-and-hold the win over a long span.
 * Summing the per-window percentages is the additive analogue: a fixed notional
 * held each window, which is what a fixed contract count is.
 *
 * Returns { pts: [{time, value}], returnPct, additive } — `pts` starts at 100.
 */
export function stitchBuyHold(windows, contractSized) {
  const pts = [];
  let value = 100;
  let any = false;
  for (const w of windows || []) {
    if (w.bh_return_pct == null || w.oos_start == null || w.oos_end == null) continue;
    any = true;
    pts.push({ time: w.oos_start, value });
    value = contractSized ? value + w.bh_return_pct : value * (1 + w.bh_return_pct / 100);
    pts.push({ time: w.oos_end, value });
  }
  return { pts, returnPct: any ? value - 100 : null, additive: !!contractSized };
}

/**
 * Build every gate and the overall verdict for one walk-forward result.
 *
 * → { gates, tone, headline, fails, warns, ratio, stability,
 *     greens, reds, flats, pctPositive, bh }
 */
export function computeWFGates(result) {
  const s = result?.stats || {};
  const windows = result?.windows || [];
  const adv = result?.analytics?.advanced || {};
  const rob = adv.robustness || {};
  const dist = adv.distribution || {};
  const tstats = adv.trade_stats || {};
  const hasSearchSpace = (result?.wf_spec?.search_space || []).length > 0;

  // --- Per-window outcomes (flat windows excluded from the rate) ---
  const outcomes = windows.map(windowOutcome);
  const greens = outcomes.filter((o) => o === "green").length;
  const reds = outcomes.filter((o) => o === "red").length;
  const flats = outcomes.filter((o) => o === "flat").length;
  const traded = greens + reds;
  const pctPositive = traded ? greens / traded : 0;

  // --- Buy-and-hold, in the same stitching convention as the strategy ---
  const bh = stitchBuyHold(windows, result?.wf_spec?.contract_sized);
  const bhReturnPct = bh.returnPct;
  const stratReturnPct = s.total_return_pct ?? 0;

  const nTrades = s.trades ?? 0;
  const stability = rob.parameter_stability_score;   // 0..1 or null
  const deflated = rob.deflated_sharpe_probability;  // 0..1 or null (only when metric=sharpe)
  const sig = dist.significance;                     // 'significant'|'marginal'|'not_significant'
  const pval = dist.t_pvalue;
  const top10 = tstats.top10_winners_share;          // 0..1 or null
  const luckWins = tstats.luck_dependent_wins;

  const gates = [];

  // 1 — Parameter plateau. Measured in PARAMETER space: for each window, how
  // well the configs within a small nudge of that window's winner hold up
  // against it (median across windows). The old score was the stdev of the top
  // decile of trial SCORES — it never looked at a parameter value, so it read
  // "stable" whenever many unrelated configs scored alike, which actually means
  // the metric can't tell them apart and the argmax is a coin flip.
  if (!hasSearchSpace) {
    gates.push({ light: "na", title: "Parameter plateau", value: "—",
      plain: "No parameters were optimized in this run, so there's nothing to be robust to. Add a search space to test plateau vs. spike." });
  } else if (stability == null) {
    gates.push({ light: "na", title: "Parameter plateau", value: "—",
      plain: "Not enough trials clustered near each window's winner to judge flatness. Run more trials per window." });
  } else {
    const light = stability >= 0.7 ? "pass" : stability >= 0.4 ? "warn" : "fail";
    const nw = rob.parameter_stability_windows;
    gates.push({ light, title: "Parameter plateau",
      value: `${fmtNum(stability)}${nw ? ` · ${fmtInt(nw)}w` : ""}`,
      plain: light === "pass"
        ? "Nudge the winning params and the score barely moves — neighbours perform similarly. That's a structural edge, not one lucky setting."
        : light === "warn"
        ? "Nudging the params costs real performance. The edge partly depends on the exact numbers — treat with caution."
        : "The winning params are a lone spike — nudge them and the score collapses. Classic curve-fit warning." });
  }

  // 1b — Did the windows agree on anything? Uniform-random draws over a search
  // range have std = 1/sqrt(12) = 0.289 of that range. At or above that, the
  // per-window "best" values are indistinguishable from guessing.
  {
    const disp = rob.param_pick_dispersion;
    const randomLevel = rob.param_pick_dispersion_random_level ?? 1 / Math.sqrt(12);
    const worstParam = rob.param_pick_dispersion_worst_param;
    const byParam = rob.param_pick_dispersion_by_param || {};
    if (!hasSearchSpace || disp == null) {
      gates.push({ light: "na", title: "Windows agree on the params", value: "—",
        plain: "Needs at least two windows with numeric parameter picks to compare." });
    } else {
      const ratio = disp / randomLevel;
      const light = ratio <= 0.5 ? "pass" : ratio < 0.9 ? "warn" : "fail";
      // This is a WORST-CASE across params, so name the culprit and say how the
      // others did. One parameter the strategy is insensitive to has an
      // arbitrary winner every window and sits at the random level by
      // construction — that reads identically to "the search found nothing"
      // unless the reader can see it was only that one.
      const named = worstParam ? ` Widest: \`${worstParam}\`.` : "";
      const others = Object.entries(byParam).filter(([n]) => n !== worstParam);
      const tight = others.filter(([, v]) => typeof v === "number" && v / randomLevel <= 0.5).length;
      const agreeNote = others.length
        ? ` The other ${fmtInt(others.length)} tuned param${others.length === 1 ? "" : "s"}: ${fmtInt(tight)} agreed tightly.`
        : "";
      const culpritHint = light === "fail" && others.length && tight === others.length
        ? ` Every other param agreed — check whether \`${worstParam}\` actually affects this strategy before believing the search failed.`
        : "";
      gates.push({ light, title: "Windows agree on the params",
        value: `${fmtNum(disp * 100)}% vs ${fmtNum(randomLevel * 100)}% random${worstParam ? ` · ${worstParam}` : ""}`,
        plain: (light === "pass"
          ? "Independent windows keep landing on similar values. The search is finding something real and repeatable."
          : light === "warn"
          ? "Windows land on fairly different values from window to window — the optimum drifts, so any single set is shaky."
          : "The windows' picks are spread as widely as random guessing over the search range — for at least one param the optimizer is sampling noise, and a median built from those picks is an average of noise."
        ) + named + agreeNote + culpritHint });
    }
  }

  // 1c — Did tuning beat NOT tuning? The control arm: the same OOS windows
  // traded with the untuned base params. Every other gate is measured only on
  // the tuned arm, so all of them look identical whether the search found a real
  // optimum or not. This is the only gate that can tell the difference.
  {
    const tv = result?.tuning_value;
    if (!tv || !tv.control) {
      gates.push({ light: "na", title: "Tuning beat not-tuning", value: "—",
        plain: "This run has no control arm. Re-run to compare the tuned picks against the untuned base params on the same windows." });
    } else {
      const edge = tv.tuning_edge_pct ?? 0;
      const corr = tv.is_oos_correlation;
      const light = edge > 0 && (corr == null || corr > 0.1) ? "pass"
        : edge > 0 ? "warn" : "fail";
      gates.push({ light, title: "Tuning beat not-tuning",
        value: `${fmtPct(tv.tuned.compounded_return_pct)} vs ${fmtPct(tv.control.compounded_return_pct)}`,
        plain: light === "pass"
          ? `Re-optimizing each window beat leaving the base params alone by ${fmtPct(edge)} compounded, and a good in-sample score does predict the next window (correlation ${fmtNum(corr)}). The search is earning its keep.`
          : light === "warn"
          ? `Tuning came out ${fmtPct(edge)} ahead of doing nothing, but a good in-sample score barely predicts the next window (correlation ${fmtNum(corr)}). The gain may be luck rather than skill.`
          : `Leaving the base params ALONE beat re-optimizing every window (${fmtPct(tv.control.compounded_return_pct)} vs ${fmtPct(tv.tuned.compounded_return_pct)}). The optimization step is costing you money — correlation between in-sample score and out-of-sample Sharpe is ${fmtNum(corr)}.` });
    }
  }

  // 1d — How thin a sample each window's winner was chosen on. A great
  // annualized Sharpe on 9 trades is noise wearing a good number.
  {
    const tv = result?.tuning_value;
    const med = tv?.median_is_trades_behind_pick;
    if (med == null) {
      gates.push({ light: "na", title: "Picks rest on a real sample", value: "—",
        plain: "This run didn't record how many in-sample trades each winning config was chosen on. Re-run to capture it." });
    } else {
      const thin = tv.windows_picked_on_thin_sample ?? 0;
      const known = tv.n_picked_on_known || 1;
      const light = med >= 30 ? "pass" : med >= 15 ? "warn" : "fail";
      gates.push({ light, title: "Picks rest on a real sample",
        value: `median ${fmtInt(med)} trades`,
        plain: light === "pass"
          ? `Each window's winner was chosen on a median of ${fmtInt(med)} in-sample trades — enough for the score to mean something.`
          : light === "warn"
          ? `Each window's winner was chosen on a median of only ${fmtInt(med)} in-sample trades (${fmtInt(thin)} of ${fmtInt(known)} windows picked on under 20). Raise "Min IS trades" so picks rest on a real sample.`
          : `Each window's winner was chosen on a median of just ${fmtInt(med)} in-sample trades, and ${fmtInt(thin)} of ${fmtInt(known)} windows picked on under 20. At that sample size the winning Sharpe is noise — raise "Min IS trades".` });
    }
  }

  // 2 — Out-of-sample holds. Windows where the strategy never fired are NOT
  // counted as losses; they leave the denominator and are reported separately.
  {
    const wfe = rob.walk_forward_efficiency;
    const flatNote = flats > 0
      ? ` ${fmtInt(flats)} of ${fmtInt(windows.length)} windows never traded at all — they're excluded from this rate, not counted as losses.`
      : "";
    if (traded === 0) {
      gates.push({ light: "na", title: "Holds out-of-sample", value: `0/${fmtInt(windows.length)}`,
        plain: "The strategy never traded in any out-of-sample window, so there is nothing to judge. Check the entry conditions and the warm-up." });
    } else {
      const light = pctPositive >= 0.7 ? "pass" : pctPositive >= 0.5 ? "warn" : "fail";
      gates.push({ light, title: "Holds out-of-sample",
        value: `${fmtInt(greens)}/${fmtInt(traded)}${wfe != null ? ` · WFE ${fmtNum(wfe)}` : ""}`,
        plain: (light === "pass"
          ? `${fmtNum(pctPositive * 100)}% of unseen windows that traded made money. The edge generalizes past the data it was tuned on.`
          : light === "warn"
          ? `Only ${fmtNum(pctPositive * 100)}% of unseen windows that traded were profitable — a coin-flip edge, not a reliable one.`
          : `Most unseen windows lost money (${fmtNum(pctPositive * 100)}% positive). The in-sample promise didn't survive out-of-sample.`) + flatNote });
    }
  }

  // 3 — Enough trades
  {
    const light = nTrades >= 100 ? "pass" : nTrades >= 30 ? "warn" : "fail";
    gates.push({ light, title: "Enough trades", value: fmtInt(nTrades),
      plain: light === "pass"
        ? `${fmtInt(nTrades)} trades is a healthy sample — the stats above mean something.`
        : light === "warn"
        ? `${fmtInt(nTrades)} trades is a thin sample. Metrics can swing on a few trades — don't over-trust them yet.`
        : `Only ${fmtInt(nTrades)} trades. Any great-looking number here is likely noise, not skill.` });
  }

  // 4 — Statistically significant (average trade ≠ 0)
  if (sig == null) {
    gates.push({ light: "na", title: "Distinguishable from zero", value: "—",
      plain: "Not enough trades to run the significance test." });
  } else {
    const light = sig === "significant" ? "pass" : sig === "marginal" ? "warn" : "fail";
    gates.push({ light, title: "Distinguishable from zero",
      value: pval != null ? `p=${fmtNum(pval)}` : sig,
      plain: light === "pass"
        ? "The average trade is statistically different from zero — unlikely to be pure luck."
        : light === "warn"
        ? "Borderline significance. The edge might be real, might be chance — more data would settle it."
        : "The average trade is NOT statistically different from zero. This could easily be luck." });
  }

  // 5 — Beats buy-and-hold. `bh` follows the strategy's own stitching
  // convention, so a fixed-contract futures run isn't measured against a
  // compounding benchmark it structurally cannot match.
  if (bhReturnPct == null) {
    gates.push({ light: "na", title: "Beats buy-and-hold", value: "—",
      plain: "No buy-and-hold benchmark available for these windows." });
  } else {
    const edge = stratReturnPct - bhReturnPct;
    const light = edge > Math.abs(bhReturnPct) * 0.1 && edge > 0 ? "pass" : edge >= 0 ? "warn" : "fail";
    const conv = bh.additive
      ? " Both sides are summed, not compounded — fixed-contract sizing doesn't compound, so compounding only the benchmark would be an unfair comparison."
      : "";
    gates.push({ light, title: "Beats buy-and-hold",
      value: `${fmtPct(stratReturnPct)} vs ${fmtPct(bhReturnPct)}`,
      plain: (light === "pass"
        ? "The strategy beat simply holding the asset — the complexity earned its keep."
        : light === "warn"
        ? "Roughly ties buy-and-hold. All that machinery bought you little over just holding."
        : "Underperforms buy-and-hold. You'd have done better doing nothing — rethink or shelve it.") + conv });
  }

  // 6 — Survives the many-trials penalty (deflated Sharpe)
  if (deflated == null) {
    gates.push({ light: "na", title: "Survives trial-count penalty", value: "—",
      plain: "Deflated Sharpe only applies when optimizing on Sharpe. Switch the metric to Sharpe to judge this." });
  } else {
    const light = deflated >= 0.9 ? "pass" : deflated >= 0.6 ? "warn" : "fail";
    gates.push({ light, title: "Survives trial-count penalty", value: `${fmtNum(deflated * 100)}%`,
      plain: light === "pass"
        ? "Even after penalizing for how many parameter combos were tried, the Sharpe holds up as real."
        : light === "warn"
        ? "The Sharpe partly survives the many-trials penalty, but some of it may be luck-of-search."
        : "Once you account for how many combos were tested, this Sharpe is probably a lucky draw." });
  }

  // 7 — Not luck-dependent (P&L concentration)
  if (top10 == null) {
    gates.push({ light: "na", title: "Not carried by a few trades", value: "—",
      plain: "Not enough winning trades to measure concentration." });
  } else {
    const light = !luckWins && top10 <= 0.5 ? "pass" : top10 <= 0.7 ? "warn" : "fail";
    gates.push({ light, title: "Not carried by a few trades", value: `top10 = ${fmtNum(top10 * 100)}%`,
      plain: light === "pass"
        ? "Profit is spread across many trades, not a couple of jackpots. Repeatable, not lucky."
        : light === "warn"
        ? `The top 10 winners are ${fmtNum(top10 * 100)}% of all profit — leans a bit on a few big trades.`
        : `The top 10 winners are ${fmtNum(top10 * 100)}% of all profit. Remove those and the edge may vanish.` });
  }

  // 8 — Recent decay: are the LATEST windows as good as the earlier ones?
  // Distinct from "holds out-of-sample" (overall green rate): this compares the
  // most recent third of windows against the rest, to catch an edge that worked
  // for years but is fading now — the thing that kills a strategy live.
  if (windows.length < 6) {
    gates.push({ light: "na", title: "No recent decay", value: "—",
      plain: "Too few windows to compare recent vs. earlier performance — run over a longer range." });
  } else {
    const recentN = Math.max(4, Math.round(windows.length * 0.33));
    const earlier = windows.slice(0, windows.length - recentN);
    const recent = windows.slice(windows.length - recentN);
    // Same convention as the green rate above: no-trade windows leave the
    // denominator rather than counting against the half they fall in.
    const rate = (arr) => {
      const o = arr.map(windowOutcome);
      const g = o.filter((x) => x === "green").length;
      const t = g + o.filter((x) => x === "red").length;
      return { g, t, rate: t ? g / t : null };
    };
    const r = rate(recent), e = rate(earlier);
    if (r.rate == null || e.rate == null) {
      gates.push({ light: "na", title: "No recent decay", value: "—",
        plain: "One half of the run has no windows that actually traded, so recent and earlier performance can't be compared." });
    } else {
      const drop = e.rate - r.rate;
      const light = drop <= 0.1 ? "pass" : drop <= 0.25 ? "warn" : "fail";
      gates.push({ light, title: "No recent decay",
        value: `recent ${fmtNum(r.rate * 100)}% vs ${fmtNum(e.rate * 100)}%`,
        plain: light === "pass"
          ? `The most recent ${fmtInt(r.t)} traded windows (${fmtInt(r.g)} green) hold up against the earlier ones. No sign the edge is fading.`
          : light === "warn"
          ? `The recent ${fmtInt(r.t)} traded windows (${fmtInt(r.g)} green) are softer than the earlier stretch (${fmtNum(e.rate * 100)}% green). The edge may be starting to fade — watch it.`
          : `The recent ${fmtInt(r.t)} traded windows (only ${fmtInt(r.g)} green) are much weaker than the earlier ${fmtNum(e.rate * 100)}%. The edge looks like it's decaying — a real red flag for trading it now.` });
    }
  }

  // --- Overall verdict ---
  // Sorting here rather than moving the blocks keeps each gate's logic where it
  // was written.
  gates.sort((a, b) => {
    const ia = GATE_ORDER.indexOf(a.title), ib = GATE_ORDER.indexOf(b.title);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const scored = gates.filter((g) => g.light !== "na");
  const val = { pass: 1, warn: 0.5, fail: 0 };
  const ratio = scored.length ? scored.reduce((a, g) => a + val[g.light], 0) / scored.length : 0;
  const fails = scored.filter((g) => g.light === "fail").map((g) => g.title);
  const warns = scored.filter((g) => g.light === "warn").map((g) => g.title);

  // The two decisive gates get a VETO, not a vote. They were already rendered
  // under "read these first — they can invalidate everything below", but the
  // headline used to be a flat mean, so failing both while passing the other
  // eight still landed on "🟡 Fragile — has an edge". If the search demonstrably
  // found nothing, the gates below it are describing noise and cannot rescue it.
  const decisiveWarns = gates.filter((g) => DECISIVE.has(g.title) && g.light === "warn");

  const tuningGate = gates.find((g) => g.title === "Tuning beat not-tuning");
  const agreeGate  = gates.find((g) => g.title === "Windows agree on the params");
  const tuningHelped = tuningGate?.light === "pass";
  const worstParam = rob.param_pick_dispersion_worst_param;

  // A failed CONTROL ARM is unambiguous: the same windows traded with the
  // untuned base params did better. That vetoes outright.
  const tuningVeto = tuningGate?.light === "fail";

  // Wide dispersion is NOT unambiguous, and treating it as an outright veto was
  // too blunt. It only condemns a run whose edge DEPENDS on tuning. When the
  // control arm says tuning genuinely helped, a random-level spread is far more
  // likely to be one insensitive parameter dragging the worst-case number down
  // (the gate reports the worst param, not the average) than proof the search
  // found nothing. And if the untuned baseline works fine, "the windows
  // disagreed" means "any setting works" — robustness, not noise. Same number,
  // opposite conclusions, so it warns rather than vetoes in that case.
  const agreeVeto = agreeGate?.light === "fail" && !tuningHelped;
  const agreeContradiction = agreeGate?.light === "fail" && tuningHelped;

  // A verdict is only as good as how much of it could actually be measured. An
  // older result with no control arm and no advanced analytics scores just two
  // gates — and a flat mean over two gates used to return "🟢 Looks Real". A
  // ratio is not evidence when the denominator is that small, so below the floor
  // the page says it cannot judge rather than guessing.
  const MIN_SCORED = 5;
  const decisiveUnknown = gates.filter((g) => DECISIVE.has(g.title) && g.light === "na");

  // Each branch names its catalog entry (VERDICTS above) so the panel can show
  // the matching "what to do next" and the guide can list every outcome.
  let tone, headline, verdictId;
  if (tuningVeto) {
    // Evidence of failure beats absence of evidence — this fires even on a
    // sparse result, because a failed decisive gate is itself a measurement.
    tone = "loss"; verdictId = "tuning_veto";
    headline = "🔴 The search found nothing — leaving the base params alone did better than re-optimizing";
  } else if (agreeVeto) {
    tone = "loss"; verdictId = "agree_veto";
    headline = "🔴 The windows never agreed on a parameter set, and tuning did not prove it was worth it";
  } else if (agreeContradiction) {
    // Tuning helped, yet one param's picks look random. Usually an insensitive
    // knob rather than a failed search — worth investigating, not condemning.
    tone = "amber"; verdictId = "mixed_signal";
    headline = `🟡 Mixed signal — re-optimizing did beat the untuned params, but the windows never agreed on ${worstParam ? `\`${worstParam}\`` : "at least one param"}. Check whether that knob does anything before trusting the consensus set.`;
  } else if (scored.length < MIN_SCORED) {
    tone = "amber"; verdictId = "insufficient";
    headline = `🟡 Not enough to judge — only ${fmtInt(scored.length)} of ${fmtInt(gates.length)} gates could be measured on this run`;
  } else if (decisiveUnknown.length) {
    // Never green while the two gates that can invalidate everything else are
    // unmeasured — most often an older result with no control arm.
    tone = "amber"; verdictId = "unverified";
    headline = `🟡 Unverified — ${decisiveUnknown.map((g) => `"${g.title}"`).join(" and ")} could not be measured, so the rest can't be trusted yet. Re-run to get a control arm.`;
  } else if (ratio >= 0.75 && fails.length === 0 && decisiveWarns.length === 0) {
    tone = "profit"; verdictId = "looks_real";
    headline = "🟢 Looks Real — a deploy candidate worth the locked-holdout test";
  } else if (ratio >= 0.5) {
    tone = "amber"; verdictId = "fragile";
    headline = "🟡 Fragile — has an edge but leans on something; size small and keep watching";
  } else {
    tone = "loss"; verdictId = "overfit";
    headline = "🔴 Likely Overfit / Luck — most gates failed; kill or rework before trusting it";
  }

  return {
    gates, tone, headline, verdictId, fails, warns, ratio, stability,
    decisiveFails: gates.filter((g) => DECISIVE.has(g.title) && g.light === "fail").map((g) => g.title),
    vetoed: !!(tuningVeto || agreeVeto),
    worstParam,
    greens, reds, flats, traded, pctPositive, bh,
  };
}
