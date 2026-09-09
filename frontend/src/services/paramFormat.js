import { fmtNum } from "./format.js";

/**
 * Render one strategy param the way a human reads it — "on"/"off" for booleans,
 * "long + short" for a dict of flags, a comma'd number for numbers.
 *
 * Lives here (not in a component) because both the walk-forward param grids and
 * the preset diff modal show the same values and must agree on how they look.
 */
export function fmtParamValue(v) {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return fmtNum(v);
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  if (typeof v === "object") {
    const vals = Object.values(v);
    if (vals.length && vals.every((x) => typeof x === "boolean")) {
      const on = Object.entries(v).filter(([, x]) => x).map(([k]) => k);
      return on.length ? on.join(" + ") : "none";
    }
    return "custom";   // nested config (e.g. sessions) — too much to inline
  }
  return String(v);
}

/**
 * Which params actually change going from `before` to `after`.
 *
 * Only keys present in `after` are considered — a preset is the thing being
 * applied, so a key it doesn't mention isn't a change, it's untouched. Returns
 * [{name, from, to, added}] where `added` marks a param the current set has no
 * value for yet (a preset saved before a schema change, say).
 */
export function diffParams(before, after) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = [];
  for (const [name, to] of Object.entries(after || {})) {
    const from = (before || {})[name];
    if (same(from, to)) continue;
    out.push({ name, from, to, added: from === undefined });
  }
  return out;
}
