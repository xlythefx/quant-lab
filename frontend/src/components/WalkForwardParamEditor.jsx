import { useEffect, useMemo } from "react";

/**
 * Walk-forward search-space editor.
 *
 * For each numeric ParamSpec (INT / FLOAT), the user toggles a "Search"
 * checkbox. When ON, the param contributes {name, type, low, high, step}
 * to `searchSpace`. When OFF, it contributes a fixed value to `baseParams`.
 *
 * Non-numeric params (BOOL / SESSIONS / SIDES) are fixed-value only — they
 * always go into `baseParams`.
 *
 * Props:
 *   schema:       array of ParamSpec
 *   baseParams:   { name: value, ... }       (fixed values)
 *   searchSpace:  [{ name, type, low, high, step }, ...]
 *   onChange({ baseParams, searchSpace })
 */
export default function WalkForwardParamEditor({ schema, baseParams, searchSpace, onChange }) {
  // Map for quick lookup.
  const searchByName = useMemo(() => {
    const m = {};
    for (const e of searchSpace || []) m[e.name] = e;
    return m;
  }, [searchSpace]);

  const groups = useMemo(() => {
    const g = {};
    for (const s of schema || []) {
      if (s.name === "risk_pct") continue;
      (g[s.group] ||= []).push(s);
    }
    return g;
  }, [schema]);

  // Seed base params for schema entries that aren't yet in baseParams.
  useEffect(() => {
    if (!schema) return;
    let touched = false;
    const next = { ...(baseParams || {}) };
    for (const s of schema) {
      if (s.name === "risk_pct") continue;
      if (next[s.name] === undefined) {
        next[s.name] = s.default;
        touched = true;
      }
    }
    if (touched) onChange({ baseParams: next, searchSpace: searchSpace || [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const setBase = (name, value) => {
    onChange({ baseParams: { ...(baseParams || {}), [name]: value }, searchSpace: searchSpace || [] });
  };

  const toggleSearch = (spec, on) => {
    const next = [...(searchSpace || [])].filter((e) => e.name !== spec.name);
    if (on) {
      next.push({
        name: spec.name,
        type: spec.type,
        low: spec.min ?? spec.default,
        high: spec.max ?? spec.default,
        step: spec.step ?? (spec.type === "int" ? 1 : null),
      });
    }
    onChange({ baseParams: baseParams || {}, searchSpace: next });
  };

  const setSearchField = (name, field, value) => {
    const next = (searchSpace || []).map((e) =>
      e.name === name ? { ...e, [field]: value } : e
    );
    onChange({ baseParams: baseParams || {}, searchSpace: next });
  };

  // ---- per-param value counts (for the search-space hint) ----
  const perParam = useMemo(() => {
    const out = [];
    let totalLog = 0;
    for (const e of searchSpace || []) {
      const step = e.step || (e.type === "int" ? 1 : (e.high - e.low) / 10);
      if (!step || step <= 0) continue;
      const k = Math.max(1, Math.floor((e.high - e.low) / step) + 1);
      out.push({ name: e.name, k, low: e.low, high: e.high, step });
      totalLog += Math.log10(k);
    }
    return { entries: out, totalLog };
  }, [searchSpace]);

  // Compact format: 1.2K, 3.4M, 5.6B, 7.8T — exact for small numbers.
  const fmtCompact = (n) => {
    if (n < 1000) return String(n);
    if (n < 1e6)  return `${(n / 1e3).toFixed(1)}K`;
    if (n < 1e9)  return `${(n / 1e6).toFixed(1)}M`;
    if (n < 1e12) return `${(n / 1e9).toFixed(1)}B`;
    return `${(n / 1e12).toFixed(1)}T`;
  };
  const gridApprox = perParam.totalLog >= 12
    ? `10^${perParam.totalLog.toFixed(1)}`
    : fmtCompact(Math.round(Math.pow(10, perParam.totalLog)));

  return (
    <div className="space-y-4">
      <div className="text-[11px] text-muted space-y-1">
        <div>
          Toggle <span className="text-text">Search</span> on a param to sweep it over IS windows.
          Untoggled params use the fixed value below.
        </div>
        {perParam.entries.length > 0 ? (
          <div>
            Search space:&nbsp;
            <span className="font-mono text-text">
              {perParam.entries.map((p) => `${p.name}:${p.k}`).join(" × ")}
            </span>
            &nbsp;= <span className="font-mono text-text">{gridApprox}</span> combinations.
            Optuna samples <span className="text-text">n_trials</span> per window via Bayesian search —
            it does <span className="text-text">not</span> enumerate the grid.
          </div>
        ) : (
          <div className="italic text-muted/70">Nothing toggled — every window will use the same fixed params.</div>
        )}
      </div>

      {Object.entries(groups).map(([group, specs]) => (
        <section key={group}>
          <h4 className="text-[11px] uppercase tracking-wider text-muted mb-2">{group}</h4>
          <div className="space-y-2">
            {specs.map((spec) => (
              <ParamRow
                key={spec.name}
                spec={spec}
                baseValue={baseParams?.[spec.name] ?? spec.default}
                searchEntry={searchByName[spec.name]}
                onSetBase={(v) => setBase(spec.name, v)}
                onToggleSearch={(on) => toggleSearch(spec, on)}
                onSearchField={(field, v) => setSearchField(spec.name, field, v)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ParamRow({ spec, baseValue, searchEntry, onSetBase, onToggleSearch, onSearchField }) {
  const numeric = spec.type === "int" || spec.type === "float";
  const searching = !!searchEntry;

  return (
    <div className="rounded-md border border-line/60 bg-bg-elev/30 px-3 py-2">
      <div className="flex items-center gap-3 justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-text truncate">{spec.name}</span>
            <span className="text-[9px] uppercase tracking-wider text-muted">{spec.type}</span>
          </div>
          {spec.description && (
            <div className="text-[11px] text-muted/70 mt-0.5 truncate">{spec.description}</div>
          )}
        </div>

        {numeric ? (
          <label className="flex items-center gap-2 text-[11px] text-muted shrink-0">
            <input
              type="checkbox"
              checked={searching}
              onChange={(e) => onToggleSearch(e.target.checked)}
              className="accent-accent-blue"
            />
            Search
          </label>
        ) : (
          <span className="text-[10px] text-muted/60 italic shrink-0">fixed</span>
        )}
      </div>

      {numeric && searching ? (
        <div className="mt-2 space-y-1">
          <div className="grid grid-cols-3 gap-2 text-xs font-mono">
            <NumField label="low"  value={searchEntry.low}  onChange={(v) => onSearchField("low", v)} />
            <NumField label="high" value={searchEntry.high} onChange={(v) => onSearchField("high", v)} />
            <NumField label="step" value={searchEntry.step ?? ""} onChange={(v) => onSearchField("step", v)} placeholder="auto"
              title="Granularity: Optuna picks values from {low, low+step, low+2·step, …, high}. Smaller step = finer resolution but slower convergence." />
          </div>
          <div className="text-[10px] text-muted/70">
            Optuna samples values from <span className="font-mono">[{searchEntry.low}, {searchEntry.high}]</span>
            {searchEntry.step ? <> in increments of <span className="font-mono">{searchEntry.step}</span></> : <> (continuous)</>}.
          </div>
        </div>
      ) : numeric ? (
        <div className="mt-2 flex items-center gap-2 text-xs font-mono">
          <span className="text-muted text-[10px] uppercase">value</span>
          <NumField label="" value={baseValue} onChange={onSetBase} />
        </div>
      ) : spec.type === "bool" ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={!!baseValue}
            onChange={(e) => onSetBase(e.target.checked)}
            className="accent-accent-blue"
          />
          <span className="text-muted">{baseValue ? "true" : "false"}</span>
        </div>
      ) : spec.type === "sides" ? (
        <div className="mt-2 flex gap-3 text-xs">
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!(baseValue && baseValue.long)} className="accent-profit"
              onChange={(e) => onSetBase({ ...(baseValue || {}), long: e.target.checked })} />
            long
          </label>
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!(baseValue && baseValue.short)} className="accent-loss"
              onChange={(e) => onSetBase({ ...(baseValue || {}), short: e.target.checked })} />
            short
          </label>
        </div>
      ) : spec.type === "sessions" ? (
        <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] font-mono">
          {Object.entries(baseValue || {}).map(([name, cfg]) => (
            <label key={name} className="flex items-center gap-2 text-muted">
              <input
                type="checkbox"
                checked={!!cfg?.enabled}
                onChange={(e) =>
                  onSetBase({ ...(baseValue || {}), [name]: { ...(cfg || {}), enabled: e.target.checked } })
                }
                className="accent-accent-blue"
              />
              <span className={cfg?.enabled ? "text-text" : ""}>{name}</span>
              <span className="text-muted/60">{cfg?.start}–{cfg?.end}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NumField({ label, value, onChange, placeholder }) {
  return (
    <div className="flex items-center gap-1">
      {label && <span className="text-muted text-[10px] uppercase">{label}</span>}
      <input
        type="number"
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          const n = parseFloat(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-full px-2 py-1 text-right rounded bg-bg border border-line font-mono text-xs focus:outline-none focus:border-accent-blue"
      />
    </div>
  );
}
