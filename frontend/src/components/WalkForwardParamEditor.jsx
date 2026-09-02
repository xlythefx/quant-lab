import { useEffect, useMemo, useState } from "react";
import { convertUtcHHmm, getTz, tzShort } from "../services/timezone.js";
import TimePickerModal from "./TimePickerModal.jsx";

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

  // Seed base params for schema entries that aren't yet in baseParams, and
  // auto-enable Search on every tunable numeric param when the search space is
  // empty — so a freshly-picked strategy lands with its parameters already
  // checked instead of all-fixed. Runs per-strategy (keyed on schema); a saved
  // non-empty search space is left untouched.
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

    let nextSearch = searchSpace || [];
    if (nextSearch.length === 0) {
      const auto = [];
      for (const s of schema) {
        if (s.name === "risk_pct") continue;
        const numeric = s.type === "int" || s.type === "float";
        // Only params with a real [min, max] range are worth searching — a
        // missing/zero-width range would add a useless single-value "search".
        const hasRange = s.min != null && s.max != null && s.max > s.min;
        if (numeric && hasRange) {
          auto.push({
            name: s.name,
            type: s.type,
            low: s.min,
            high: s.max,
            step: s.step ?? (s.type === "int" ? 1 : null),
          });
        }
      }
      if (auto.length) {
        nextSearch = auto;
        touched = true;
      }
    }

    if (touched) onChange({ baseParams: next, searchSpace: nextSearch });
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
          Position sizing (<span className="font-mono">risk_pct</span>) is per-strategy and
          not searched — edit it on the Strategies page.
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
                tradeAllDay={!!baseParams?.trade_24_7}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ParamRow({ spec, baseValue, searchEntry, onSetBase, onToggleSearch, onSearchField, tradeAllDay }) {
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
            <NumField label="step" value={searchEntry.step ?? ""} onChange={(v) => {
              if (v !== null && v <= 0) return;  // block step <= 0; Optuna requires step > 0
              onSearchField("step", v);
            }} placeholder="auto"
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
      ) : spec.type === "sessions" && tradeAllDay ? (
        // trade_24_7 short-circuits the mask entirely (`in_session = True` for
        // every bar), so the windows below are dead. Say so instead of
        // rendering editable inputs that silently do nothing.
        <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/5 px-2.5 py-2 text-[11px]">
          <span className="text-amber-400">Ignored — <span className="font-mono">trade_24_7</span> is on.</span>
          <span className="text-muted"> The strategy trades every hour and these windows do nothing.
            Turn <span className="font-mono">trade_24_7</span> off to make them apply.</span>
          <div className="mt-1.5 grid grid-cols-2 gap-1 font-mono text-[10px] text-muted/50">
            {Object.entries(baseValue || {}).map(([name, cfg]) => (
              <span key={name}>{cfg?.enabled ? "☑" : "☐"} {name} {cfg?.start}–{cfg?.end}</span>
            ))}
          </div>
        </div>
      ) : spec.type === "sessions" ? (
        <SessionsField value={baseValue} onSetBase={onSetBase} />
      ) : null}
    </div>
  );
}

/**
 * Session windows — the REAL entry filter (the strategy masks entries with
 * session_mask(ts, p["sessions"])), not the page-level "Sessions (UTC)" panel,
 * which is report-labelling only.
 *
 * Same UX as the Dashboard's Settings panel: click a HH:MM chip to open the
 * 24-hour scroll-wheel picker. A native <input type="time"> was wrong here —
 * it renders 12-hour AM/PM in an en-US browser, which disagrees with the
 * 24-hour UTC value we actually store and send to the engine.
 */
function SessionsField({ value, onSetBase }) {
  const v = value || {};
  const [picker, setPicker] = useState(null);  // { key, field, label } | null
  const [tz, setTz] = useState(getTz());

  useEffect(() => {
    const onTz = () => setTz(getTz());
    window.addEventListener("quantlab:tz-change", onTz);
    window.addEventListener("storage", onTz);
    return () => {
      window.removeEventListener("quantlab:tz-change", onTz);
      window.removeEventListener("storage", onTz);
    };
  }, []);

  const userIsSpecial = tz === "Etc/UTC" || tz === "America/New_York" || tz === "Asia/Manila";
  const setSub = (key, patch) => onSetBase({ ...v, [key]: { ...(v[key] || {}), ...patch } });

  return (
    <div className="mt-2 space-y-1.5">
      {Object.entries(v).map(([key, cfg]) => (
        <div key={key} className="px-2 py-1.5 rounded-md border border-line/60 bg-bg-elev/40">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!cfg?.enabled}
              onChange={(e) => setSub(key, { enabled: e.target.checked })}
              className="accent-accent-blue shrink-0"
            />
            <span className={`text-xs font-mono w-20 shrink-0 truncate ${cfg?.enabled ? "text-text" : "text-muted"}`}
                  title={key}>{key}</span>
            <TimeChip value={cfg?.start} onClick={() => setPicker({ key, field: "start", label: `${key} · Start` })} />
            <span className="text-[10px] text-muted">→</span>
            <TimeChip value={cfg?.end}   onClick={() => setPicker({ key, field: "end",   label: `${key} · End`   })} />
            <span className="text-[9px] uppercase tracking-wider text-muted ml-auto">UTC</span>
          </div>
          <div className="mt-1 pl-6 font-mono text-[10px] text-muted flex flex-wrap gap-x-3">
            {!userIsSpecial && (
              <span>{tzShort(tz)}: {convertUtcHHmm(cfg?.start, tz)}–{convertUtcHHmm(cfg?.end, tz)}</span>
            )}
            <span>NY: {convertUtcHHmm(cfg?.start, "America/New_York")}–{convertUtcHHmm(cfg?.end, "America/New_York")}</span>
            <span>PH: {convertUtcHHmm(cfg?.start, "Asia/Manila")}–{convertUtcHHmm(cfg?.end, "Asia/Manila")}</span>
          </div>
        </div>
      ))}
      <div className="text-[10px] text-muted/70 pt-0.5">
        These windows gate entries — this is what the strategy actually trades. Times are 24-hour UTC
        (17:00 = 5 PM); NY / PH shown for reference.
      </div>

      <TimePickerModal
        open={!!picker}
        value={picker ? (v[picker.key]?.[picker.field] || "00:00") : "00:00"}
        label={picker?.label}
        onClose={() => setPicker(null)}
        onChange={(hhmm) => { if (picker) setSub(picker.key, { [picker.field]: hhmm }); }}
      />
    </div>
  );
}

function TimeChip({ value, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 text-xs font-mono rounded bg-bg border border-line text-text hover:border-accent-blue focus:outline-none focus:border-accent-blue w-16 text-center"
    >
      {value || "00:00"}
    </button>
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
