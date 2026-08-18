import { useEffect, useMemo, useState } from "react";

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
          Toggle <span className="text-text">Grid</span> on a param, then enter a{" "}
          <span className="text-text">List</span> of values — or switch to{" "}
          <span className="text-text">Range</span> and type <span className="font-mono">from</span> /{" "}
          <span className="font-mono">to</span> / <span className="font-mono">jump</span>{" "}
          (e.g. 0.5 – 1.0 jump 0.1) to auto-fill them. Every combination is backtested
          exhaustively. Position sizing (<span className="font-mono">risk_pct</span>) is
          a fixed single value here — it's applied to every combo but never swept, since
          it scales size, not the edge.
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
  // risk_pct is numeric but sizing-only — editable as a fixed value, never swept
  // (see the note in GridSearchParamEditor's header text for the why).
  const gridable = numeric && spec.name !== "risk_pct";
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

        {gridable ? (
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

      {gridable && gridding ? (
        <ValueListInput spec={spec} values={gridEntry.values || []} onChange={onSetValues} />
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

function ValueListInput({ spec, values, onChange }) {
  const [mode, setMode] = useState("list"); // "list" | "range"

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-muted text-[10px] uppercase">values</span>
        <div className="flex rounded border border-line overflow-hidden">
          {["list", "range"].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 text-[10px] capitalize ${
                mode === m ? "bg-accent-blue/20 text-text" : "text-muted hover:text-text"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === "list" ? (
        <ListRow type={spec.type} values={values} onChange={onChange} />
      ) : (
        <RangeRow spec={spec} values={values} onChange={onChange} />
      )}
    </div>
  );
}

// Comma / space separated list — re-parsed on blur so mid-edit typing is free.
function ListRow({ type, values, onChange }) {
  const text = (values || []).join(", ");

  const handleBlur = (raw) => {
    const tokens = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const parsed = [];
    const seen = new Set();
    for (const tok of tokens) {
      const n = type === "int" ? parseInt(tok, 10) : parseFloat(tok);
      if (!Number.isFinite(n)) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      parsed.push(n);
    }
    parsed.sort((a, b) => a - b);
    onChange(parsed);
  };

  return (
    <>
      <div className="flex items-center gap-2">
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
    </>
  );
}

// from / to / jump → expands to a value list. e.g. 0.5–1.0 jump 0.1 → 0.5..1.0.
const RANGE_MAX = 1000; // guard against a runaway list freezing the browser

function stepDecimals(stepStr) {
  const s = String(stepStr).trim();
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

function genRange(type, fromStr, toStr, stepStr) {
  const f = parseFloat(fromStr), t = parseFloat(toStr), s = parseFloat(stepStr);
  if (![f, t, s].every(Number.isFinite)) return { values: [], error: null };
  if (s <= 0) return { values: [], error: "jump must be > 0" };
  if (t < f) return { values: [], error: "to must be ≥ from" };
  // Round each step to the jump's decimal places so float drift (0.7000001) is
  // cleaned up; ints just round to whole numbers.
  const dec = type === "int" ? 0 : stepDecimals(stepStr);
  const pow = Math.pow(10, dec);
  const seen = new Set();
  const out = [];
  let clamped = false;
  // +s*1e-9 tolerance so the endpoint (e.g. 1.0) is included despite drift.
  for (let v = f; v <= t + s * 1e-9; v += s) {
    const val = type === "int" ? Math.round(v) : Math.round(v * pow) / pow;
    if (!seen.has(val)) { seen.add(val); out.push(val); }
    if (out.length >= RANGE_MAX) { clamped = true; break; }
  }
  return { values: out, error: clamped ? `capped at ${RANGE_MAX} values` : null };
}

function rangePreview(arr) {
  if (arr.length <= 6) return arr.join(", ");
  return `${arr.slice(0, 4).join(", ")}, …, ${arr[arr.length - 1]}`;
}

// Round a raw step up to a "nice" 1/2/5 × 10^k value, so suggested jumps read
// cleanly (0.5, 2, 20…) instead of 0.583 or 32.5.
function niceStep(raw) {
  if (!(raw > 0)) return 0.1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag; // in [1, 10)
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

// Suggest a COARSE from/to/jump for Range mode from the schema bounds — aim for
// ~6-8 values across [min, max] (coarse-to-fine: map the terrain first, refine
// later). Mirrors WalkForwardParamEditor's schema seeding but chooses a wider
// jump because a grid expands to an explicit list. Falls back to a default-
// centered span when the schema has no min/max.
function suggestRange(spec) {
  const isInt = spec?.type === "int";
  let min = spec?.min, max = spec?.max;
  const def = Number.isFinite(spec?.default) ? spec.default : null;
  if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) {
    if (def == null) return { from: "", to: "", step: isInt ? "1" : "" };
    const half = Math.abs(def) * 0.5 || (isInt ? 3 : 1);
    min = def - half; max = def + half;
    if (isInt) { min = Math.max(0, Math.round(min)); max = Math.round(max); if (max <= min) max = min + 1; }
  }
  const schemaStep = Number.isFinite(spec?.step) ? spec.step : null;
  let jump = niceStep((max - min) / 6);
  if (isInt) jump = Math.max(1, Math.round(jump));
  else if (schemaStep && jump < schemaStep) jump = schemaStep;
  const fmt = (x) => (isInt ? String(Math.round(x)) : String(parseFloat(x.toFixed(6))));
  return { from: fmt(min), to: fmt(max), step: String(jump) };
}

function RangeRow({ spec, values, onChange }) {
  const type = spec.type;
  // Pre-fill from/to/jump with a coarse schema-derived suggestion the moment
  // Range mode is opened (this component remounts on the List↔Range switch).
  const seed = useMemo(() => suggestRange(spec), [spec]);
  const [from, setFrom] = useState(seed.from);
  const [to, setTo] = useState(seed.to);
  const [step, setStep] = useState(seed.step);

  const { values: preview, error } = useMemo(
    () => genRange(type, from, to, step),
    [type, from, to, step]
  );
  const ready = preview.length > 0;
  const apply = () => { if (ready) onChange(preview); };
  const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } };

  const numCls =
    "w-16 px-2 py-1 rounded bg-bg border border-line font-mono text-xs text-right focus:outline-none focus:border-accent-blue";

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap">
        <input type="number" value={from} onChange={(e) => setFrom(e.target.value)} onKeyDown={onKey}
               placeholder="from" className={numCls} />
        <span className="text-muted text-xs">–</span>
        <input type="number" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={onKey}
               placeholder="to" className={numCls} />
        <span className="text-muted text-[10px] uppercase ml-1">jump</span>
        <input type="number" value={step} onChange={(e) => setStep(e.target.value)} onKeyDown={onKey}
               placeholder={type === "int" ? "1" : "0.1"} className={numCls} />
        <button
          type="button"
          onClick={apply}
          disabled={!ready}
          className="px-2 py-1 rounded text-[11px] bg-accent-blue/20 text-text hover:bg-accent-blue/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Generate →
        </button>
        <span className="text-[10px] font-mono text-muted shrink-0">
          {values.length} value{values.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="text-[10px] text-muted/70 font-mono">
        {error ? (
          <span className="text-loss">{error}</span>
        ) : ready ? (
          <>→ {preview.length} value{preview.length === 1 ? "" : "s"}: {rangePreview(preview)}</>
        ) : (
          "Enter from, to & jump — e.g. 0.5 – 1.0 jump 0.1 → 0.5, 0.6, … 1.0"
        )}
      </div>
    </>
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
