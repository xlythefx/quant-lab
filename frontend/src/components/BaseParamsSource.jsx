import { useEffect, useMemo, useState } from "react";
import { getPresets } from "../services/api.js";
import { resolveDefaultParams } from "./dashboardv2/metrics.js";
import { getUserDefaults } from "../services/strategiesStore.js";

/**
 * "Load base params from …" — seeds a walk-forward run's FIXED (untuned)
 * parameters from a source you already trust.
 *
 * Why this exists: a walk-forward only searches the params you put in the
 * search space. Everything else comes from `base_params`, which the WF page
 * seeded from bare schema defaults. So a strategy you had carefully configured
 * on the Dashboard — different sessions, sides, stop settings — was being
 * walk-forwarded in a DIFFERENT configuration than the one you actually run,
 * and the params it recommended were tuned for that other configuration.
 *
 * Three sources, all resolved exactly the way their own page resolves them:
 *   - Dashboard defaults — resolveDefaultParams(schema → timeframe/symbol
 *     presets → your saved overrides), i.e. literally what Dashboard V2 runs.
 *   - Built-in presets   — meta.presets, merged over schema defaults the same
 *     way StrategyEditor.applyPreset does (sparse dicts deep-merged one level).
 *   - Saved presets      — your server-side presets from data/presets.json,
 *     the ones in the Settings panel's "load preset" dropdown.
 *
 * Props:
 *   meta:       strategy meta ({id, schema, presets, timeframe_defaults, symbol_defaults})
 *   symbol / timeframe: the run's instrument, for Dashboard-default resolution
 *   onLoad:     (params) => void — receives a COMPLETE param dict
 *   disabled:   bool — true while a job is running
 */
export default function BaseParamsSource({ meta, symbol, timeframe, onLoad, disabled }) {
  const [saved, setSaved] = useState([]);   // [{name, params}]
  const [choice, setChoice] = useState("");
  const [note, setNote] = useState(null);

  const strategyId = meta?.id;
  const builtins = meta?.presets || {};

  useEffect(() => {
    if (!strategyId) { setSaved([]); return; }
    let alive = true;
    getPresets(strategyId)
      .then((obj) => { if (alive) setSaved(Object.entries(obj || {}).map(([name, params]) => ({ name, params }))); })
      .catch(() => { if (alive) setSaved([]); });
    return () => { alive = false; };
  }, [strategyId]);

  // Reset the picker when the strategy changes — a preset from the previous
  // strategy would be meaningless here.
  useEffect(() => { setChoice(""); setNote(null); }, [strategyId]);

  const dashboardParams = useMemo(
    () => (meta ? resolveDefaultParams(meta, symbol, timeframe, getUserDefaults(strategyId)) : null),
    [meta, symbol, timeframe, strategyId],
  );

  // Merge a sparse built-in preset over schema defaults — same one-level deep
  // merge StrategyEditor uses, so a preset that overrides only `ny_am` keeps
  // the other sessions instead of wiping them.
  const mergeBuiltin = (sparse) => {
    const merged = {};
    for (const spec of meta?.schema || []) merged[spec.name] = spec.default;
    for (const [k, v] of Object.entries(sparse || {})) {
      const base = merged[k];
      merged[k] =
        v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object" && !Array.isArray(base)
          ? { ...base, ...v }
          : v;
    }
    return merged;
  };

  const apply = (val) => {
    setChoice(val);
    if (!val || !meta) return;
    let params = null;
    let label = "";
    if (val === "__dashboard__") {
      params = dashboardParams;
      label = `Dashboard defaults · ${symbol} ${timeframe}`;
    } else if (val.startsWith("builtin:")) {
      const name = val.slice("builtin:".length);
      params = mergeBuiltin(builtins[name]);
      label = `built-in preset "${name}"`;
    } else if (val.startsWith("saved:")) {
      const name = val.slice("saved:".length);
      const hit = saved.find((p) => p.name === name);
      // A saved preset may be sparse if it predates a schema change — fill any
      // missing key from the schema default so the run never sends undefined.
      if (hit) {
        const filled = {};
        for (const spec of meta?.schema || []) filled[spec.name] = spec.default;
        params = { ...filled, ...hit.params };
      }
      label = `saved preset "${name}"`;
    }
    if (!params) return;
    onLoad(params);
    setNote(label);
  };

  if (!meta) return null;

  const hasAny = !!dashboardParams || Object.keys(builtins).length > 0 || saved.length > 0;
  if (!hasAny) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted">Load base params from</span>
        <select
          value={choice}
          onChange={(e) => apply(e.target.value)}
          disabled={disabled}
          className="px-2 py-1 rounded-md bg-bg-elev border border-line font-mono text-xs focus:outline-none focus:border-accent-blue disabled:opacity-50"
        >
          <option value="">— pick a source —</option>
          {dashboardParams && (
            <option value="__dashboard__">Dashboard defaults · {symbol} {timeframe}</option>
          )}
          {Object.keys(builtins).length > 0 && (
            <optgroup label="Built-in presets">
              {Object.keys(builtins).map((n) => (
                <option key={n} value={`builtin:${n}`}>★ {n}</option>
              ))}
            </optgroup>
          )}
          {saved.length > 0 && (
            <optgroup label="Your saved presets">
              {saved.map((p) => (
                <option key={p.name} value={`saved:${p.name}`}>{p.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        {note && <span className="text-[11px] text-profit font-mono">loaded {note}</span>}
      </div>
      <div className="text-[10px] text-muted/60">
        Overwrites the fixed values below (sessions, sides, stops, sizing). Params you have toggled
        to <span className="text-text">Search</span> keep their ranges — only the fixed side is replaced.
      </div>
    </div>
  );
}
