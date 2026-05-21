import { useEffect, useMemo } from "react";

/**
 * Grid-search param editor.
 *
 * For each numeric ParamSpec (INT / FLOAT), the user toggles a "Grid"
 * checkbox. When ON, the param contributes {name, type, values:[...]} to
 * `gridParams`. When OFF, it contributes a fixed value to `baseParams`.
 *
 * Non-numeric params (BOOL / SESSIONS / SIDES) are fixed-value only.
 *
 * Props:
 *   schema:      array of ParamSpec
 *   baseParams:  { name: value, ... }                       (fixed values)
 *   gridParams:  [{ name, type, values: [num, ...] }, ...]
 *   onChange({ baseParams, gridParams })
 */
export default function GridSearchParamEditor({ schema, baseParams, gridParams, onChange }) {
  const gridByName = useMemo(() => {
    const m = {};
    for (const e of gridParams || []) m[e.name] = e;
    return m;
  }, [gridParams]);

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
    if (touched) onChange({ baseParams: next, gridParams: gridParams || [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const setBase = (name, value) => {
    onChange({ baseParams: { ...(baseParams || {}), [name]: value }, gridParams: gridParams || [] });
  };

  const toggleGrid = (spec, on) => {
    const next = [...(gridParams || [])].filter((e) => e.name !== spec.name);
    if (on) {
      // Seed with the current fixed value as a one-element grid.
      const seed = baseParams?.[spec.name] ?? spec.default;
      const seedNum = typeof seed === "number" && Number.isFinite(seed) ? seed : 0;
      next.push({ name: spec.name, type: spec.type, values: [seedNum] });
    }
    onChange({ baseParams: baseParams || {}, gridParams: next });
  };

  const setGridValues = (name, values) => {
    const next = (gridParams || []).map((e) =>
      e.name === name ? { ...e, values } : e
    );
    onChange({ baseParams: baseParams || {}, gridParams: next });
  };

  // Total combinations = product of per-param value counts.
  const totalCombos = useMemo(() => {
    let t = 1;
    for (const e of gridParams || []) {
      const n = (e.values || []).length;
      if (n === 0) return 0;
      t *= n;
    }
    return gridParams && gridParams.length > 0 ? t : 0;
  }, [gridParams]);

  return (
    <div className="space-y-4">
      <div className="text-[11px] text-muted space-y-1">
        <div>
          Toggle <span className="text-text">Grid</span> on a param and enter a comma-separated
          list of values to test. Every combination is backtested exhaustively.
          Position sizing (<span className="font-mono">risk_pct</span>) is per-strategy and
          not swept — edit it on the Strategies page.
        </div>
        {gridParams && gridParams.length > 0 ? (
          <div>
            Grid:&nbsp;
            <span className="font-mono text-text">
              {gridParams.map((p) => `${p.name}:${(p.values || []).length}`).join(" × ")}
            </span>
            &nbsp;= <span className="font-mono text-text">{totalCombos}</span> backtests.
          </div>
        ) : (
          <div className="italic text-muted/70">Nothing toggled — toggle Grid on a param to start.</div>
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
                gridEntry={gridByName[spec.name]}
                onSetBase={(v) => setBase(spec.name, v)}
                onToggleGrid={(on) => toggleGrid(spec, on)}
                onSetValues={(values) => setGridValues(spec.name, values)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ParamRow({ spec, baseValue, gridEntry, onSetBase, onToggleGrid, onSetValues }) {
  const numeric = spec.type === "int" || spec.type === "float";
  const gridding = !!gridEntry;

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
              checked={gridding}
              onChange={(e) => onToggleGrid(e.target.checked)}
              className="accent-accent-blue"
            />
            Grid
          </label>
        ) : (
          <span className="text-[10px] text-muted/60 italic shrink-0">fixed</span>
        )}
      </div>

      {numeric && gridding ? (
        <ValueListInput type={spec.type} values={gridEntry.values || []} onChange={onSetValues} />
      ) : numeric ? (
        <div className="mt-2 flex items-center gap-2 text-xs font-mono">
          <span className="text-muted text-[10px] uppercase">value</span>
          <NumField value={baseValue} onChange={onSetBase} />
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

function ValueListInput({ type, values, onChange }) {
  // Local controlled text mirrors the parent's value list, but we only
  // re-parse on blur so the user can freely edit between commas.
  const text = (values || []).join(", ");

  const handleBlur = (raw) => {
    const tokens = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const parsed = [];
    const errors = [];
    const seen = new Set();
    for (const tok of tokens) {
      const n = type === "int" ? parseInt(tok, 10) : parseFloat(tok);
      if (!Number.isFinite(n)) { errors.push(tok); continue; }
      if (seen.has(n)) continue;
      seen.add(n);
      parsed.push(n);
    }
    parsed.sort((a, b) => a - b);
    onChange(parsed);
    return errors;
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-muted text-[10px] uppercase shrink-0">values</span>
        <input
          type="text"
          defaultValue={text}
          key={text /* re-mount when parent sorts/dedupes the list */}
          placeholder="e.g. 10, 20, 50, 100"
          onBlur={(e) => handleBlur(e.target.value)}
          className="flex-1 px-2 py-1 rounded bg-bg border border-line font-mono text-xs focus:outline-none focus:border-accent-blue"
        />
        <span className="text-[10px] font-mono text-muted shrink-0">
          {values.length} value{values.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="text-[10px] text-muted/70 font-mono">
        Comma- or space-separated. Duplicates removed, sorted ascending on blur.
      </div>
    </div>
  );
}

function NumField({ value, onChange, placeholder }) {
  return (
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
      className="w-32 px-2 py-1 text-right rounded bg-bg border border-line font-mono text-xs focus:outline-none focus:border-accent-blue"
    />
  );
}
