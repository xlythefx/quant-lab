import { useEffect, useMemo, useState } from "react";
import TimePickerModal from "./TimePickerModal.jsx";
import { getTz, convertUtcHHmm, tzShort } from "../services/timezone.js";

const SESSION_LABELS = {
  tokyo:  "Tokyo",
  london: "London",
  ny_am:  "NY morning",
  ny_pm:  "NY afternoon",
};

export default function StrategyEditor({
  open, schema, params, onChange, onClose, onApply, onResetDefaults, onSaveAsDefault, color,
}) {
  const [draft, setDraft] = useState(params || {});
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(params || {}); }, [params, open]);

  const groups = useMemo(() => {
    const g = {};
    for (const spec of schema || []) {
      (g[spec.group] ||= []).push(spec);
    }
    return g;
  }, [schema]);

  if (!open) return null;

  const setField = (name, value) => {
    const next = { ...draft, [name]: value };
    setDraft(next);
    onChange?.(next);
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

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {Object.entries(groups).map(([group, specs]) => (
          <section key={group}>
            <h4 className="text-[11px] uppercase tracking-wider text-muted mb-2">{group}</h4>
            <div className="space-y-3">
              {specs.map((spec) => (
                <ParamInput key={spec.name} spec={spec} value={draft[spec.name]} onChange={setField} />
              ))}
            </div>
          </section>
        ))}
      </div>

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

  return (
    <div>
      {spec.description && <div className="text-[11px] text-muted mb-2">{spec.description}</div>}
      <div className="space-y-2">
        {Object.entries(SESSION_LABELS).map(([key, label]) => {
          const cfg = v[key] || { enabled: false, start: "00:00", end: "00:00" };
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
        value={picker ? (v[picker.key]?.[picker.field] || "00:00") : "00:00"}
        label={picker?.label}
        onClose={() => setPicker(null)}
        onChange={(hhmm) => {
          if (!picker) return;
          const cur = v[picker.key] || { enabled: false, start: "00:00", end: "00:00" };
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

/**
 * 24-hour HH:MM input. <input type="time"> respects the browser's locale
 * (en-US shows 12-hour with AM/PM), which we don't want for UTC sessions.
 * This is a plain text input that:
 *   - shows whatever the user typed while focused
 *   - normalizes to "HH:MM" 0-padded on blur / Enter
 *   - clamps to 0–23 hours, 0–59 minutes
 */
function TimeInput({ value, onChange }) {
  const [draft, setDraft] = useState(value || "00:00");
  useEffect(() => { setDraft(value || "00:00"); }, [value]);

  const normalize = (s) => {
    const m = /^\s*(\d{1,2})(?::?(\d{0,2}))?\s*$/.exec(s || "");
    if (!m) return value || "00:00";
    const hh = String(Math.min(23, Math.max(0, parseInt(m[1] || "0", 10)))).padStart(2, "0");
    const mm = String(Math.min(59, Math.max(0, parseInt(m[2] || "0", 10)))).padStart(2, "0");
    return `${hh}:${mm}`;
  };

  const commit = (raw) => {
    const next = normalize(raw);
    setDraft(next);
    if (next !== value) onChange(next);
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      placeholder="HH:MM"
      maxLength={5}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className="px-1.5 py-0.5 text-xs font-mono text-center rounded bg-bg border border-line focus:outline-none focus:border-accent-blue w-16"
    />
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
