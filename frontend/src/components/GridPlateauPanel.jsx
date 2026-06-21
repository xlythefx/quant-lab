import { useMemo } from "react";
import { fmtNum, fmtInt, fmtPct } from "../services/format.js";
import { METRIC_COLUMNS, metricColor, statValue } from "./gridMetrics.js";

/**
 * Parameter plateau view — works for ANY grid dimensionality (the 1D chart
 * and 2D heatmap stop at two swept params; this marginalizes instead).
 *
 * For each swept param, every value gets one text tile showing the MEDIAN of
 * the selected metric across all combos sharing that value (the marginal
 * distribution over the other params). A flat, evenly-colored row = a robust
 * plateau; one bright tile in a red row = a spike you probably overfit to.
 *
 * Each param also gets a verdict:
 *   ✓ plateau / · moderate / ⚠ sensitive — spread of cell medians relative to
 *     the full result range;
 *   ∅ no effect — every combo's result is IDENTICAL across this param's
 *     values (compared via a stats fingerprint, not just the shown metric),
 *     i.e. the param never binds for this config — e.g. an RSI band the
 *     signal never reaches, or a long-only filter with shorts disabled.
 */

// Identical-run fingerprint. Same code + same data + same effective params
// produce bit-identical floats, so exact string equality is the right test —
// any real param effect changes at least one of these.
function statsFingerprint(stats) {
  const s = stats || {};
  return `${s.trades}|${s.final_equity}|${s.wins}|${s.gross_profit}|${s.gross_loss}|${s.max_drawdown_dollars}`;
}

function median(sortedFinite) {
  const n = sortedFinite.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 ? sortedFinite[mid] : (sortedFinite[mid - 1] + sortedFinite[mid]) / 2;
}

/**
 * Pure aggregation — exported for sanity checks.
 * Returns {
 *   params: [{ name, type, single, fixedValue, cells, verdict, spreadFrac, bestValue }],
 *   medMin, medMax,   // finite-median range across ALL cells (color scale)
 * }
 * cells: [{ value, count, finiteCount, infCount, missingCount, median, mean, min, max }]
 */
export function buildPlateau(rows, gridParams, metricId) {
  const names = gridParams.map((gp) => gp.name);

  // Normalize the metric once per row (profit_factor null -> Infinity / 0).
  const vals = rows.map((r) => statValue(r.stats, metricId));

  const globalFinite = vals.filter((v) => v != null && Number.isFinite(v));
  const globalRange =
    globalFinite.length >= 2 ? Math.max(...globalFinite) - Math.min(...globalFinite) : 0;

  // Global best combo (null counts as -Infinity; Infinity wins; ties -> first).
  let bestRow = null;
  let bestVal = -Infinity;
  rows.forEach((r, i) => {
    const v = vals[i] == null ? -Infinity : vals[i];
    if (v > bestVal) { bestVal = v; bestRow = r; }
  });

  const params = [];
  const allMedians = [];

  for (const gp of gridParams) {
    if ((gp.values || []).length < 2) {
      params.push({
        name: gp.name, type: gp.type, single: true,
        fixedValue: gp.values?.[0], cells: [], verdict: "single",
        spreadFrac: null, bestValue: bestRow?.params?.[gp.name],
      });
      continue;
    }

    // ---- marginal cells, one per param value (preserve list order)
    const byValue = new Map();
    rows.forEach((r, i) => {
      const k = r.params[gp.name];
      if (!byValue.has(k)) byValue.set(k, []);
      byValue.get(k).push(vals[i]);
    });

    const cells = gp.values.map((value) => {
      const group = byValue.get(value) || [];
      const finite = group.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
      const infCount = group.filter((v) => v === Infinity).length;
      const missingCount = group.filter((v) => v == null).length;
      const med = median(finite);
      if (med != null) allMedians.push(med);
      return {
        value,
        count: group.length,
        finiteCount: finite.length,
        infCount,
        missingCount,
        median: med,
        mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null,
        min: finite.length ? finite[0] : null,
        max: finite.length ? finite[finite.length - 1] : null,
      };
    });

    // ---- "no effect": within every other-params group, all results identical
    const otherNames = names.filter((n) => n !== gp.name);
    const groups = new Map(); // other-params key -> { fingerprints: Set, count }
    for (const r of rows) {
      const key = JSON.stringify(otherNames.map((n) => r.params[n]));
      let g = groups.get(key);
      if (!g) { g = { fingerprints: new Set(), count: 0 }; groups.set(key, g); }
      g.fingerprints.add(statsFingerprint(r.stats));
      g.count += 1;
    }
    let noEffect = false;
    if (groups.size > 0) {
      let allIdentical = true;
      let anyMultiRowGroup = false; // partial runs can leave only 1-row groups
      for (const g of groups.values()) {
        if (g.count >= 2) anyMultiRowGroup = true;
        if (g.fingerprints.size > 1) { allIdentical = false; break; }
      }
      noEffect = allIdentical && anyMultiRowGroup;
    }

    // ---- verdict
    const finiteMedians = cells.map((c) => c.median).filter((m) => m != null);
    let verdict;
    let spreadFrac = null;
    if (noEffect) {
      verdict = "noeffect";
    } else if (finiteMedians.length < 2) {
      verdict = "insufficient";
    } else {
      spreadFrac =
        (Math.max(...finiteMedians) - Math.min(...finiteMedians)) / (globalRange || 1);
      verdict = spreadFrac < 0.15 ? "plateau" : spreadFrac > 0.5 ? "sensitive" : "moderate";
    }

    params.push({
      name: gp.name, type: gp.type, single: false,
      cells, verdict, spreadFrac,
      bestValue: bestRow?.params?.[gp.name],
    });
  }

  return {
    params,
    medMin: allMedians.length ? Math.min(...allMedians) : 0,
    medMax: allMedians.length ? Math.max(...allMedians) : 0,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const VERDICT_BADGE = {
  plateau:      { text: "✓ plateau",          cls: "text-profit" },
  moderate:     { text: "· moderate",          cls: "text-muted" },
  sensitive:    { text: "⚠ sensitive",         cls: "text-amber-400" },
  noeffect:     { text: "∅ no effect",         cls: "text-muted" },
  insufficient: { text: "— insufficient data", cls: "text-muted" },
};

function fmtVal(v, type) {
  return type === "int" ? fmtInt(v) : fmtNum(v);
}

function Tile({ cell, type, isBest, medMin, medMax }) {
  const allInf = cell.infCount > 0 && cell.finiteCount === 0;
  const empty = cell.count === 0 || (cell.finiteCount === 0 && cell.infCount === 0);
  const display = allInf ? "∞" : empty ? "—" : fmtNum(cell.median);
  // ∞-only cells are "best possible" — give them the top-of-scale green.
  const bg = allInf
    ? metricColor(medMax, medMin, medMax)
    : metricColor(cell.median, medMin, medMax);

  const tipParts = [
    `n=${cell.count}`,
    `median ${display}`,
    cell.mean != null ? `mean ${fmtNum(cell.mean)}` : null,
    cell.min != null ? `min ${fmtNum(cell.min)}` : null,
    cell.max != null ? `max ${fmtNum(cell.max)}` : null,
    cell.infCount ? `∞×${cell.infCount}` : null,
    cell.missingCount ? `missing×${cell.missingCount}` : null,
    isBest ? "★ best combo" : null,
  ].filter(Boolean);

  return (
    <div
      className={`rounded border px-2 py-1 text-[11px] font-mono text-center min-w-[56px] ${
        isBest ? "border-accent-blue ring-1 ring-accent-blue" : "border-line/30"
      }`}
      style={{ background: bg }}
      title={tipParts.join(" · ")}
    >
      <div className="text-muted">{fmtVal(cell.value, type)}</div>
      <div className="text-text">{display}</div>
    </div>
  );
}

function ParamRow({ p, medMin, medMax }) {
  const badge = VERDICT_BADGE[p.verdict];
  if (p.single) {
    return (
      <div className="text-[11px] font-mono text-muted/70">
        <span className="text-muted">{p.name}</span> — fixed at {fmtVal(p.fixedValue, p.type)} for this run
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] font-mono">
        <span className="text-text">{p.name}</span>
        {badge && <span className={badge.cls}>{badge.text}</span>}
        {p.spreadFrac != null && (
          <span className="text-muted/70">
            spread {fmtPct(p.spreadFrac * 100, false)} of result range
          </span>
        )}
        {p.verdict === "noeffect" && (
          <span className="text-muted/70">
            identical results for every value — this param never binds for this config
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {p.cells.map((cell) => (
          <Tile
            key={cell.value}
            cell={cell}
            type={p.type}
            isBest={cell.value === p.bestValue}
            medMin={medMin}
            medMax={medMax}
          />
        ))}
      </div>
    </div>
  );
}

export default function GridPlateauPanel({ rows, gridParams, metricId }) {
  const plateau = useMemo(
    () => buildPlateau(rows || [], gridParams || [], metricId),
    [rows, gridParams, metricId],
  );

  if (!rows?.length || !gridParams?.length) return null;
  const metricLabel = METRIC_COLUMNS.find((m) => m.id === metricId)?.label || metricId;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-4">
      <div className="text-sm font-semibold text-text">
        Parameter plateaus
        &nbsp;<span className="text-muted text-xs font-normal">marginal {metricLabel} per value</span>
      </div>

      {plateau.params.map((p) => (
        <ParamRow key={p.name} p={p} medMin={plateau.medMin} medMax={plateau.medMax} />
      ))}

      <div className="text-[10px] text-muted/70 font-mono">
        Color: <span className="text-loss">red</span> = worst, <span className="text-profit">green</span> = best
        &nbsp;· each tile is the median across all combos sharing that value
        &nbsp;· <span className="text-accent-blue">outlined</span> = value of the best combo
        &nbsp;· flat color across a row = robust plateau; a single bright tile = likely overfit
      </div>
    </div>
  );
}
