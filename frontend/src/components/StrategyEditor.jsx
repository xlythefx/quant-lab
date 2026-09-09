import { useEffect, useMemo, useState } from "react";
import TimePickerModal from "./TimePickerModal.jsx";
import { getTz, convertUtcHHmm, tzShort } from "../services/timezone.js";
import { getPresetsFull, savePresets as apiSavePresets } from "../services/api.js";
import PresetDiffModal from "./PresetDiffModal.jsx";

// Friendly labels for the canonical trading sessions. Strategies may declare
// their own session keys (e.g. a single "asia" / "entry" window) — those render
// with a title-cased fallback label via `sessionLabel()` below.
const SESSION_LABELS = {
  tokyo:  "Tokyo",
  london: "London",
  ny_am:  "NY morning",
  ny_pm:  "NY afternoon",
};

// Label for a session key: canonical name if known, else title-cased key
// (e.g. "asia" → "Asia", "ny_am" → "Ny am").
const sessionLabel = (key) =>
  SESSION_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function StrategyEditor({
  open, schema, params, onChange, onClose, onApply, onResetDefaults, onSaveAsDefault, color,
  strategyId, builtinPresets = {}, hiddenParams = [], onCompareLookAhead,
  symbol, timeframe,
}) {
  const [draft, setDraft] = useState(params || {});
  const [saved, setSaved] = useState(false);
  // Server-side user presets, kept as [{name, params, meta}] for the UI.
  // `meta` is provenance (which symbol/timeframe the set was tuned on) — see
  // backend/services/presets_config.py.
  const [presets, setPresets] = useState([]);
  const [savingName, setSavingName] = useState("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  // A preset chosen but not yet applied — the diff modal shows what it changes
  // before it overwrites the draft. {name, params, meta}
  const [pending, setPending] = useState(null);
  // The preset being renamed / re-pointed at the current params. {orig, name}
  const [editing, setEditing] = useState(null);

  useEffect(() => { setDraft(params || {}); }, [params, open]);
  useEffect(() => {
    if (!open || !strategyId) { setPresets([]); return; }
    let alive = true;
    getPresetsFull(strategyId)
      .then(({ presets: obj, meta }) => {
        if (!alive) return;
        setPresets(Object.entries(obj || {}).map(([name, p]) => ({
          name, params: p, meta: (meta || {})[name] || {},
        })));
      })
      .catch(() => { if (alive) setPresets([]); });
    return () => { alive = false; };
  }, [open, strategyId]);

  // Persist the current preset list to the server. Provenance is sent alongside
  // the params so a rename or a delete carries (or drops) it with the preset.
  const persist = (list) => {
    const obj = {};
    const meta = {};
    for (const p of list) { obj[p.name] = p.params; meta[p.name] = p.meta || {}; }
    apiSavePresets(strategyId, obj, meta).catch(() => {});
  };

  // Hide sizing params that don't apply to the selected instrument: futures
  // size by `contracts` (risk_pct is inert in the engine), crypto/spot sizes by
  // `risk_pct` (contracts is inert). The backtest engine ignores the inert one
  // either way — this just stops the panel from showing a dead control.
  const groups = useMemo(() => {
    const hide = new Set(hiddenParams || []);
    const g = {};
    for (const spec of schema || []) {
      if (hide.has(spec.name)) continue;
      // look_ahead is rendered ONLY as the dedicated ⚠ checkbox below (with its
      // warning + compare button), never as a plain toggle in its schema group.
      if (spec.name === "look_ahead") continue;
      (g[spec.group] ||= []).push(spec);
    }
    return g;
  }, [schema, hiddenParams]);

  if (!open) return null;

  // The look-ahead checkbox reflects the strategy's schema default when the card
  // has no explicit value yet (e.g. donchian_breakout defaults it ON to match the
  // TradeStation figure; the backend uses the same default, so this keeps the box
  // in sync with what actually runs). An explicit false stays false.
  const _laSpec = (schema || []).find((s) => s.name === "look_ahead");
  const _laChecked = draft.look_ahead ?? !!(_laSpec && _laSpec.default);

  const setField = (name, value) => {
    const next = { ...draft, [name]: value };
    setDraft(next);
    onChange?.(next);
  };

  // Regime group: "use_regime" is the master switch; the method (adx/five/hmm)
  // decides which "allowed ..." set is relevant. Grey out the knobs when the
  // master is off, and hide the allowed-set that doesn't match the method.
  const regimeOff = (schema || []).some((s) => s.name === "use_regime") && !draft.use_regime;
  const regimeMethod = draft.regime_method ?? (draft.use_five_regime ? "five" : "adx");
  const REGIME_DEP = ["regime_method", "regime_adx_period", "regime_adx_threshold", "allowed_regimes", "allowed_hmm_moods"];
  const regimeDisabled = (name) => regimeOff && REGIME_DEP.includes(name);
  const regimeHidden = (name) =>
    (name === "allowed_regimes" && regimeMethod !== "five") ||
    (name === "allowed_hmm_moods" && regimeMethod !== "hmm");

  // Resolve a preset name to the COMPLETE param set it would install, without
  // applying it. Both kinds start from schema defaults so a preset saved before
  // a param existed can't leave that param undefined.
  const resolvePreset = (name) => {
    const merged = {};
    for (const spec of schema || []) merged[spec.name] = spec.default;

    const userPreset = presets.find((x) => x.name === name);
    const sparse = userPreset ? userPreset.params : builtinPresets[name];
    if (!sparse) return null;

    for (const [k, v] of Object.entries(sparse)) {
      const base = merged[k];
      // One-level deep merge for dict params (e.g. sessions), so a preset that
      // overrides only `ny_am` keeps the other windows instead of wiping them.
      if (v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object" && !Array.isArray(base)) {
        merged[k] = { ...base, ...v };
      } else {
        merged[k] = v;
      }
    }
    return { params: merged, meta: userPreset?.meta || {} };
  };

  // Selecting a preset no longer overwrites the draft on the spot — it stages
  // the change so the diff modal can show what moves (and warn if the preset was
  // tuned on a different instrument) before you commit.
  const requestPreset = (name) => {
    const resolved = resolvePreset(name);
    if (!resolved) return;
    setPending({ name, ...resolved });
  };

  const confirmPending = () => {
    if (!pending) return;
    setDraft(pending.params);
    onChange?.(pending.params);
    setPending(null);
  };

  const savePreset = () => {
    const name = savingName.trim();
    if (!name) return;
    const prev = presets.find((x) => x.name === name);
    const meta = {
      // Keep the original provenance when overwriting a walk-forward preset in
      // place; otherwise record where this set is being saved from.
      ...(prev?.meta || {}),
      ...(symbol ? { symbol } : {}),
      ...(timeframe ? { timeframe } : {}),
      source: prev?.meta?.source || "manual",
      created: Math.floor(Date.now() / 1000),
    };
    const next = [...presets.filter((x) => x.name !== name), { name, params: { ...draft }, meta }];
    setPresets(next);
    persist(next);
    setSavingName("");
    setShowSaveModal(false);
  };

  const deletePreset = (name) => {
    const next = presets.filter((x) => x.name !== name);
    setPresets(next);
    persist(next);
  };

  // Rename, and optionally re-point the preset at whatever is in the panel now.
  const commitEdit = ({ takeCurrentParams }) => {
    if (!editing) return;
    const newName = editing.name.trim();
    const orig = presets.find((x) => x.name === editing.orig);
    if (!newName || !orig) { setEditing(null); return; }
    const updated = {
      name: newName,
      params: takeCurrentParams ? { ...draft } : orig.params,
      meta: takeCurrentParams
        // Re-pointing at the current params invalidates the old provenance —
        // these numbers were not the ones the walk-forward validated.
        ? { ...(symbol ? { symbol } : {}), ...(timeframe ? { timeframe } : {}),
            source: "manual", created: Math.floor(Date.now() / 1000) }
        : orig.meta,
    };
    const next = [...presets.filter((x) => x.name !== editing.orig && x.name !== newName), updated];
    setPresets(next);
    persist(next);
    setEditing(null);
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[400px] max-w-[92vw] bg-bg-panel border-l border-line shadow-2xl flex flex-col">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full" style={{ background: color || "#3b82f6" }} />
          <h3 className="text-base font-semibold">Settings</h3>
        </div>
        <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">×</button>
      </div>

      {/* Presets bar */}
      <div className="px-5 py-2.5 border-b border-line/60 bg-bg-elev/30 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted shrink-0">Presets</span>
          <select
            className="flex-1 px-2 py-1 rounded-md bg-bg-elev border border-line font-mono text-xs focus:outline-none focus:border-accent-blue text-text min-w-0"
            defaultValue=""
            onChange={(e) => { if (e.target.value) requestPreset(e.target.value); e.target.value = ""; }}
          >
            <option value="">— load preset —</option>
            {Object.keys(builtinPresets).length > 0 && (
              <optgroup label="★ Built-in">
                {Object.keys(builtinPresets).map((name) => (
                  <option key={name} value={name}>★ {name}</option>
                ))}
              </optgroup>
            )}
            {presets.length > 0 && (
              <optgroup label="Saved">
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.meta?.symbol ? ` · ${p.meta.symbol}${p.meta.timeframe ? " " + p.meta.timeframe : ""}` : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            onClick={() => { setSavingName(""); setShowSaveModal(true); }}
            disabled={!strategyId}
            title="Save current params as a preset (stored server-side)"
            className="px-2.5 py-1 rounded-md border border-accent-blue/40 text-accent-blue text-xs hover:bg-accent-blue/10 disabled:opacity-40 shrink-0"
          >
            + Save
          </button>
        </div>

        {/* Chips row: built-ins (★, no delete) + user presets (edit / delete).
            A saved preset tuned on a DIFFERENT instrument than the one open here
            gets an amber ring — the numbers are evidence about where they were
            fitted, not about this symbol. */}
        {(Object.keys(builtinPresets).length > 0 || presets.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(builtinPresets).map((name) => (
              <div key={name} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent-blue/10 border border-accent-blue/30 text-[10px]">
                <span className="text-accent-blue/60">★</span>
                <button onClick={() => requestPreset(name)} className="text-accent-blue hover:text-accent-blue/80 font-mono">{name}</button>
              </div>
            ))}
            {presets.map((p) => {
              const origin = [p.meta?.symbol, p.meta?.timeframe].filter(Boolean).join(" ");
              const mismatch = (p.meta?.symbol && symbol && p.meta.symbol !== symbol)
                || (p.meta?.timeframe && timeframe && p.meta.timeframe !== timeframe);
              return (
                <div
                  key={p.name}
                  title={origin ? `Tuned on ${origin}${p.meta?.source === "walkforward" ? " · walk-forward" : ""}` : "No recorded origin"}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-elev border text-[10px] ${mismatch ? "border-amber-400/50" : "border-line"}`}
                >
                  <button onClick={() => requestPreset(p.name)} className="text-text hover:text-accent-blue font-mono">{p.name}</button>
                  {origin && <span className={`font-mono ${mismatch ? "text-amber-400/80" : "text-muted/60"}`}>{origin}</span>}
                  <button
                    onClick={() => setEditing({ orig: p.name, name: p.name })}
                    title="Rename or update this preset"
                    className="text-muted/60 hover:text-accent-blue leading-none ml-0.5"
                  >
                    ✎
                  </button>
                  <button onClick={() => deletePreset(p.name)} title="Delete this preset" className="text-muted/60 hover:text-loss leading-none">×</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {Object.entries(groups).map(([group, specs]) => (
          <section key={group}>
            <h4 className="text-[11px] uppercase tracking-wider text-muted mb-2">{group}</h4>
            {group === "Regime" && regimeOff && (
              <div className="text-[11px] text-amber-400/90 mb-2">Turn on “use regime” to enable the regime filter.</div>
            )}
            <div className="space-y-3">
              {specs.map((spec) => {
                if (regimeHidden(spec.name)) return null;       // hide the allowed-set that doesn't match the method
                const disabled = regimeDisabled(spec.name);     // grey out regime knobs when the master switch is off
                return (
                  <div key={spec.name} className={disabled ? "opacity-40 pointer-events-none" : ""}>
                    <ParamInput spec={spec} value={draft[spec.name]} onChange={setField} />
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {onCompareLookAhead && (
        <div className="px-5 py-3 border-t border-line/60 bg-loss/5 space-y-2">
          <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
            <span className="text-xs text-loss/90">
              ⚠ Look-ahead fills{" "}
              <span className="text-muted">(fictitious — inflates P&L; diagnostic only)</span>
            </span>
            <input
              type="checkbox"
              checked={_laChecked}
              onChange={(e) => setField("look_ahead", e.target.checked)}
              className="h-4 w-4 accent-loss shrink-0"
            />
          </label>
          <button
            onClick={() => onCompareLookAhead(draft)}
            title="Run honest vs look-ahead side by side"
            className="w-full text-xs text-loss/90 hover:text-loss border border-loss/30 hover:border-loss/60 px-3 py-1.5 rounded-md transition"
          >
            ⚠ Look-ahead vs Reality — compare
          </button>
        </div>
      )}

      <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-2">
        <button onClick={onResetDefaults} className="text-xs text-muted hover:text-text shrink-0">Reset Defaults</button>
        <div className="flex items-center gap-2">
          {onSaveAsDefault && (
            <button
              onClick={() => {
                onSaveAsDefault(draft);
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              }}
              className="text-xs text-accent-blue hover:text-accent-blue/80 border border-accent-blue/30 hover:border-accent-blue/60 px-3 py-1.5 rounded-md transition"
            >
              {saved ? "Saved ✓" : "Save as Default"}
            </button>
          )}
          <button
            onClick={() => onApply?.(draft)}
            className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold"
          >
            Apply &amp; Re-run
          </button>
        </div>
      </div>

      {/* Save-preset modal */}
      {showSaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowSaveModal(false)}>
          <div className="bg-bg-panel border border-line rounded-2xl shadow-2xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-line">
              <h3 className="text-base font-semibold">Save preset</h3>
              <p className="text-xs text-muted mt-0.5">
                Saves the current params server-side (persists across browsers; commit
                <span className="font-mono"> data/presets.json</span> to sync via git).
              </p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <input
                autoFocus
                type="text"
                value={savingName}
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") savePreset(); if (e.key === "Escape") setShowSaveModal(false); }}
                placeholder="Preset name (e.g. ZECUSDT)…"
                className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
              {presets.some((p) => p.name === savingName.trim()) && savingName.trim() && (
                <div className="text-[11px] text-accent-yellow">A preset named "{savingName.trim()}" exists — it will be overwritten.</div>
              )}
              <div className="rounded-md bg-bg-elev/50 border border-line/60 px-3 py-2 max-h-40 overflow-y-auto">
                <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Saving these values</div>
                <div className="font-mono text-[11px] text-muted/90 space-y-0.5">
                  {(schema || []).filter((s) => draft[s.name] !== undefined).map((s) => (
                    <div key={s.name} className="flex justify-between gap-3">
                      <span className="text-muted">{s.name}</span>
                      <span className="text-text">{typeof draft[s.name] === "object" ? JSON.stringify(draft[s.name]) : String(draft[s.name])}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
              <button onClick={() => setShowSaveModal(false)} className="px-3 py-1.5 rounded-md border border-line text-muted text-sm hover:text-text">Cancel</button>
              <button onClick={savePreset} disabled={!savingName.trim()} className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit-preset modal: rename, and optionally re-point at the live params */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setEditing(null)}>
          <div className="bg-bg-panel border border-line rounded-2xl shadow-2xl w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-line">
              <h3 className="text-base font-semibold">Edit preset</h3>
              <p className="text-xs text-muted mt-0.5">
                Rename it, or overwrite its params with whatever is in the panel right now.
              </p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <input
                autoFocus
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit({ takeCurrentParams: false });
                  if (e.key === "Escape") setEditing(null);
                }}
                className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
              {editing.name.trim() !== editing.orig && presets.some((p) => p.name === editing.name.trim()) && (
                <div className="text-[11px] text-accent-yellow">A preset named "{editing.name.trim()}" exists — it will be overwritten.</div>
              )}
              <div className="text-[11px] text-muted">
                Overwriting the params clears the recorded origin
                {presets.find((p) => p.name === editing.orig)?.meta?.source === "walkforward"
                  ? " — this one came from a walk-forward, and the current panel values are not the set that was validated."
                  : "."}
              </div>
            </div>
            <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-2">
              <button
                onClick={() => commitEdit({ takeCurrentParams: true })}
                disabled={!editing.name.trim()}
                className="px-3 py-1.5 rounded-md border border-amber-400/40 text-amber-400 text-xs hover:bg-amber-400/10 disabled:opacity-50"
              >
                Update to current params
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-md border border-line text-muted text-sm hover:text-text">Cancel</button>
                <button
                  onClick={() => commitEdit({ takeCurrentParams: false })}
                  disabled={!editing.name.trim()}
                  className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50"
                >
                  Rename
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* "vwma_length 30 → 45" — what loading this preset actually changes */}
      <PresetDiffModal
        open={!!pending}
        name={pending?.name}
        before={draft}
        after={pending?.params}
        meta={pending?.meta}
        symbol={symbol}
        timeframe={timeframe}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function ParamInput({ spec, value, onChange }) {
  const v = value ?? spec.default;

  if (spec.type === "int" || spec.type === "float") {
    return <NumberRow spec={spec} value={v} onChange={onChange} />;
  }
  if (spec.type === "bool") {
    return (
      <Row label={spec.name} hint={spec.description}>
        <Toggle checked={!!v} onChange={(b) => onChange(spec.name, b)} />
      </Row>
    );
  }
  if (spec.type === "select") {
    const opts = spec.options || [];
    return (
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">{spec.name}</span>
          <select
            value={v ?? spec.default}
            onChange={(e) => onChange(spec.name, e.target.value)}
            className="px-2 py-1 rounded-md bg-bg-elev border border-line font-mono text-xs focus:outline-none focus:border-accent-blue text-text"
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        {spec.description && <div className="text-[11px] text-muted mt-1">{spec.description}</div>}
      </div>
    );
  }
  if (spec.type === "sessions") {
    return <SessionsField spec={spec} value={v} onChange={onChange} />;
  }
  if (spec.type === "sides") {
    return (
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          <Toggle checked={!!(v && v.long)} onChange={(b) => onChange(spec.name, { ...v, long: b })} />
          Long
        </label>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Toggle checked={!!(v && v.short)} onChange={(b) => onChange(spec.name, { ...v, short: b })} />
          Short
        </label>
      </div>
    );
  }
  if (spec.type === "regimes") {
    const labels = Object.keys(spec.default || {});
    return (
      <div>
        {spec.description && <div className="text-[11px] text-muted mb-2">{spec.description}</div>}
        <div className="flex flex-col gap-1.5">
          {labels.map((lab) => (
            <label key={lab} className="flex items-center gap-2 text-xs text-muted">
              <Toggle checked={!!(v && v[lab])} onChange={(b) => onChange(spec.name, { ...v, [lab]: b })} />
              {lab}
            </label>
          ))}
        </div>
      </div>
    );
  }
  return null;
}

function NumberRow({ spec, value, onChange }) {
  const step = spec.step ?? (spec.type === "int" ? 1 : 0.1);
  const isPct = spec.name === "risk_pct";
  const min = spec.min ?? -Infinity;
  const max = spec.max ?? Infinity;
  const decimals = (String(step).split(".")[1] || "").length;

  const round = (x) => Math.round(x * 10 ** decimals) / 10 ** decimals;
  const clamp = (x) => Math.max(min, Math.min(max, x));
  const normalize = (x) => clamp(round(spec.type === "int" ? Math.round(x) : x));

  // Local string draft so the user can type intermediate values ("1" on the
  // way to "11", "0." on the way to "0.5") without per-keystroke clamping
  // jumping the cursor to min/max. Commit only on blur, Enter, or +/−.
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);

  const commit = () => {
    const parsed = spec.type === "int" ? parseInt(draft, 10) : parseFloat(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    const next = normalize(parsed);
    setDraft(String(next));
    if (next !== value) onChange(spec.name, next);
  };

  const bump = (delta) => {
    const base = Number.isFinite(parseFloat(draft)) ? parseFloat(draft) : Number(value || 0);
    const next = normalize(base + delta);
    setDraft(String(next));
    onChange(spec.name, next);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-mono text-muted">{spec.name}</label>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => bump(-step)}
            className="w-6 h-6 rounded-md bg-bg-elev border border-line text-muted hover:text-text hover:border-accent-blue text-xs leading-none">
            −
          </button>
          <div className="relative">
            <input
              type="number"
              value={draft}
              min={spec.min ?? undefined}
              max={spec.max ?? undefined}
              step={step}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  setDraft(value == null ? "" : String(value));
                  e.currentTarget.blur();
                }
              }}
              className={`w-24 px-2 py-1 text-right rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue ${isPct ? "pr-6" : ""}`}
            />
            {isPct && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none">%</span>
            )}
          </div>
          <button type="button" onClick={() => bump(step)}
            className="w-6 h-6 rounded-md bg-bg-elev border border-line text-muted hover:text-text hover:border-accent-blue text-xs leading-none">
            +
          </button>
        </div>
      </div>
      {spec.description && <div className="text-[11px] text-muted/70 mt-0.5">{spec.description}</div>}
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-mono text-muted">{label}</label>
        {children}
      </div>
      {hint && <div className="text-[11px] text-muted/70 mt-0.5">{hint}</div>}
    </div>
  );
}

/**
 * Sessions group: one row per session with a toggle, a label, and two
 * "HH:MM" chip-buttons that open the scroll-wheel TimePickerModal.
 * Times are stored as UTC; the row footer shows live conversions in the
 * user's selected display zone plus NY / PH for reference.
 */
function SessionsField({ spec, value, onChange }) {
  const v = value || {};
  // Mirror the backend's per-session merge (base.py _merge_with_defaults):
  // a stored session may carry only {enabled} (e.g. from a preset), so fall
  // back to the schema default for start/end instead of showing 00:00.
  const cfgFor = (key) => {
    const dflt = (spec.default && spec.default[key]) || { enabled: false, start: "00:00", end: "00:00" };
    return { ...dflt, ...(v[key] || {}) };
  };
  const [picker, setPicker] = useState(null);  // { key, field: 'start' | 'end' } | null
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

  // Render the session windows the strategy actually declares (spec.default's
  // keys — the same set the backend merges against), not a fixed list. A
  // single-window strategy shows one row; VWMA still shows its four.
  const sessionKeys = Object.keys(spec.default || {});
  const keys = sessionKeys.length ? sessionKeys : Object.keys(SESSION_LABELS);

  return (
    <div>
      {spec.description && <div className="text-[11px] text-muted mb-2">{spec.description}</div>}
      <div className="space-y-2">
        {keys.map((key) => {
          const label = sessionLabel(key);
          const cfg = cfgFor(key);
          const setSub = (patch) => onChange(spec.name, { ...v, [key]: { ...cfg, ...patch } });
          return (
            <div key={key} className="px-2 py-1.5 rounded-md border border-line/60 bg-bg-elev/30">
              <div className="flex items-center gap-2">
                <Toggle checked={!!cfg.enabled} onChange={(b) => setSub({ enabled: b })} />
                <span className="text-xs text-text w-24 truncate">{label}</span>
                <TimeChip value={cfg.start} onClick={() => setPicker({ key, field: "start", label: `${label} · Start` })} />
                <span className="text-[10px] text-muted">→</span>
                <TimeChip value={cfg.end}   onClick={() => setPicker({ key, field: "end",   label: `${label} · End`   })} />
                <span className="text-[9px] text-muted ml-auto">UTC</span>
              </div>
              <div className="mt-1 pl-12 font-mono text-[10px] text-muted/70 flex flex-wrap gap-x-3">
                {!userIsSpecial && (
                  <span>{tzShort(tz)}: {convertUtcHHmm(cfg.start, tz)}–{convertUtcHHmm(cfg.end, tz)}</span>
                )}
                <span>NY: {convertUtcHHmm(cfg.start, "America/New_York")}–{convertUtcHHmm(cfg.end, "America/New_York")}</span>
                <span>PH: {convertUtcHHmm(cfg.start, "Asia/Manila")}–{convertUtcHHmm(cfg.end, "Asia/Manila")}</span>
              </div>
            </div>
          );
        })}
      </div>

      <TimePickerModal
        open={!!picker}
        value={picker ? cfgFor(picker.key)[picker.field] : "00:00"}
        label={picker?.label}
        onClose={() => setPicker(null)}
        onChange={(hhmm) => {
          if (!picker) return;
          const cur = cfgFor(picker.key);
          onChange(spec.name, { ...v, [picker.key]: { ...cur, [picker.field]: hhmm } });
        }}
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

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full p-0.5 transition ${checked ? "bg-accent-blue" : "bg-bg-elev border border-line"}`}
    >
      <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}
