import { useEffect, useMemo, useState } from "react";
import IconNavRail from "../components/dashboardv2/IconNavRail.jsx";
import { getStrategies } from "../services/api.js";
import { fmtInt, fmtNum } from "../services/format.js";
import { usePersistentState } from "../services/usePersistentState.js";
import {
  useActiveStrategies, isActive, addStrategy, removeStrategy,
} from "../services/strategiesStore.js";

/*
 * Strategies — a guide to every registered strategy.
 *
 * Left: search + filters + the list. Right: the selected strategy in plain words
 * (META.description, META.guide) and every setting with its default, range and
 * explanation. All text comes from the strategy's own Python file, so the page
 * can't drift from the code. "Add to Dashboard" lives in the detail header.
 */

// UI-only hide list: these strategies stay registered and runnable in the
// backend, but only show under the "All" status filter.
const HIDDEN_IDS = new Set(["pivot_breakout", "rsi2_reversion"]);

// Family = id prefix. First match wins, so the longer prefixes come first.
const FAMILY_RULES = [
  ["ann_", "ANN"],
  ["vwma_reversion", "VWMA Reversion"],
  ["vwma_momentum", "VWMA Momentum"],
  ["donchian_", "Donchian"],
  ["lunar", "Lunar"],
  ["asia_range", "Range Breakout"],
  ["opening_range", "Range Breakout"],
  ["orb_", "Range Breakout"],
  ["weekday_", "Weekday"],
];
const familyOf = (id) => (FAMILY_RULES.find(([p]) => id.startsWith(p)) || [null, "Other"])[1];

const STATUS = [
  { key: "available", label: "Available" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All" },
];
const BASIS = [
  { key: "any", label: "Any" },
  { key: "ohlc", label: "OHLC" },
  { key: "hlc", label: "HLC" },
];

const TYPE_LABELS = {
  int: "Whole number",
  float: "Number",
  bool: "On / Off",
  select: "Choice",
  sessions: "Time windows (UTC)",
  sides: "Long / Short",
  regimes: "Market moods",
};

const SESSION_LABELS = { tokyo: "Tokyo", london: "London", ny_am: "NY morning", ny_pm: "NY afternoon" };
const titleCase = (k) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const hasSides = (s) => (s.schema || []).some((p) => p.type === "sides");

function defaultsFromSchema(schema) {
  const out = {};
  for (const s of schema || []) out[s.name] = s.default;
  return out;
}

// Everything a search can match: names, descriptions, guide, every setting.
function haystack(s) {
  const params = (s.schema || []).map((p) => `${p.name} ${p.description || ""} ${p.group || ""}`).join(" ");
  return `${s.name} ${s.id} ${s.description} ${s.guide || ""} ${familyOf(s.id)} ${params}`.toLowerCase();
}

export default function Strategies() {
  const [strategies, setStrategies] = useState([]);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = usePersistentState("ql.strategies.status", "available");
  const [family, setFamily] = usePersistentState("ql.strategies.family", "all");
  const [basis, setBasis] = usePersistentState("ql.strategies.basis", "any");
  const [sidesOnly, setSidesOnly] = usePersistentState("ql.strategies.sidesOnly", false);
  const [activeOnly, setActiveOnly] = usePersistentState("ql.strategies.activeOnly", false);
  const [selectedId, setSelectedId] = usePersistentState("ql.strategies.selected", "");
  const active = useActiveStrategies();

  useEffect(() => {
    getStrategies()
      .then(setStrategies)
      .catch((e) => setError(e?.response?.data?.error || e.message));
  }, []);

  const families = useMemo(
    () => [...new Set(strategies.map((s) => familyOf(s.id)))].sort(),
    [strategies],
  );

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => strategies.filter((s) => {
    const archived = !!s.archived;
    if (status === "available" && (archived || HIDDEN_IDS.has(s.id))) return false;
    if (status === "archived" && !archived) return false;
    if (family !== "all" && familyOf(s.id) !== family) return false;
    if (basis !== "any" && (s.kind || "ohlc") !== basis) return false;
    if (sidesOnly && !hasSides(s)) return false;
    if (activeOnly && !active.some((a) => a.id === s.id)) return false;
    if (words.length) {
      const h = haystack(s);
      if (!words.every((w) => h.includes(w))) return false;
    }
    return true;
  }), [strategies, status, family, basis, sidesOnly, activeOnly, active, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selection on something visible.
  useEffect(() => {
    if (shown.length && !shown.some((s) => s.id === selectedId)) setSelectedId(shown[0].id);
  }, [shown, selectedId, setSelectedId]);

  const selected = shown.find((s) => s.id === selectedId) || null;
  const filtersOn = query || status !== "available" || family !== "all" || basis !== "any" || sidesOnly || activeOnly;
  const clearFilters = () => {
    setQuery(""); setStatus("available"); setFamily("all"); setBasis("any");
    setSidesOnly(false); setActiveOnly(false);
  };

  return (
    <div className="flex h-screen">
      <IconNavRail view="strategies" />

      <div className="flex flex-1 min-h-0">
        {/* ---- list ---- */}
        <aside className="w-80 shrink-0 border-r border-line bg-bg-panel/40 flex flex-col h-full">
          <div className="px-4 py-3 border-b border-line space-y-3">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] uppercase tracking-widest text-muted">Strategies</div>
              <div className="text-[10px] font-mono text-muted">{fmtInt(shown.length)} / {fmtInt(strategies.length)}</div>
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search names, ideas, settings… (rsi, stop, asia)"
              className="w-full px-3 h-9 text-sm rounded-lg bg-bg-panel border border-line text-text placeholder:text-muted/60 focus:outline-none focus:border-accent-blue"
            />
            <FilterRow label="Status" options={STATUS} value={status} onChange={setStatus} />
            <FilterRow label="Price" options={BASIS} value={basis} onChange={setBasis} />
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-muted/70">Family</span>
              <select
                value={family}
                onChange={(e) => setFamily(e.target.value)}
                className="flex-1 h-7 px-2 text-xs rounded-md bg-bg-panel border border-line text-text focus:outline-none focus:border-accent-blue"
              >
                <option value="all">All families</option>
                {families.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Chip on={sidesOnly} onClick={() => setSidesOnly(!sidesOnly)}>Long / Short switch</Chip>
              <Chip on={activeOnly} onClick={() => setActiveOnly(!activeOnly)}>On dashboard</Chip>
              {filtersOn && (
                <button onClick={clearFilters} className="px-2 py-1 text-[11px] text-accent-blue hover:underline">
                  Clear
                </button>
              )}
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {error && (
              <div className="m-2 rounded-md border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">{error}</div>
            )}
            {!error && strategies.length > 0 && shown.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted">
                No strategy matches.{" "}
                <button onClick={clearFilters} className="text-accent-blue hover:underline">Clear filters</button>
              </div>
            )}
            {shown.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left px-3 py-2 rounded-lg transition ${
                  s.id === selectedId ? "bg-bg-elev text-text" : "text-muted hover:text-text hover:bg-bg-elev/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate">{s.name}</span>
                  {isActive(s.id) && <span className="w-1.5 h-1.5 rounded-full bg-accent-blue shrink-0" title="On dashboard" />}
                </div>
                <div className="text-[11px] text-muted/80 truncate">
                  {familyOf(s.id)} · {(s.kind || "ohlc").toUpperCase()} · {fmtInt(s.schema.length)} settings
                  {s.archived ? " · archived" : ""}
                </div>
              </button>
            ))}
          </nav>

          <div className="px-4 py-3 border-t border-line text-xs space-y-1">
            {active.length > 0 && (
              <div className="text-muted">
                {fmtInt(active.length)} on the dashboard ·{" "}
                <a href="#dashboardv2" className="text-accent-blue hover:underline">open Dashboard →</a>
              </div>
            )}
            <a href="#strategysandbox" className="text-accent-violet hover:underline">✨ Design a strategy with AI →</a>
          </div>
        </aside>

        {/* ---- detail ---- */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          {selected ? <StrategyDetail s={selected} /> : (
            <div className="h-full flex items-center justify-center text-sm text-muted">
              {strategies.length ? "Pick a strategy on the left." : (error ? "" : "Loading strategies…")}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function FilterRow({ label, options, value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-muted/70">{label}</span>
      <div className="flex gap-1">
        {options.map((o) => (
          <Chip key={o.key} on={value === o.key} onClick={() => onChange(o.key)}>{o.label}</Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 text-[11px] rounded-md border transition ${
        on ? "bg-accent-blue/15 border-accent-blue/50 text-text" : "border-line text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function Badge({ children, tone = "muted" }) {
  const tones = {
    muted: "border-line text-muted",
    blue: "border-accent-blue/40 text-accent-blue bg-accent-blue/10",
    violet: "border-accent-violet/40 text-accent-violet bg-accent-violet/10",
    loss: "border-loss/40 text-loss bg-loss/10",
  };
  return <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider rounded border ${tones[tone]}`}>{children}</span>;
}

function StrategyDetail({ s }) {
  const on = isActive(s.id);
  // Settings grouped in schema order.
  const groups = [];
  for (const p of s.schema || []) {
    let g = groups.find((x) => x.name === (p.group || "General"));
    if (!g) groups.push(g = { name: p.group || "General", params: [] });
    g.params.push(p);
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{s.name}</h1>
          <div className="text-xs text-muted font-mono mt-0.5">{s.id}</div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            <Badge tone="violet">{familyOf(s.id)}</Badge>
            <Badge>{(s.kind || "ohlc").toUpperCase()}</Badge>
            {hasSides(s) && <Badge>Long / Short switch</Badge>}
            {s.archived && <Badge tone="loss">Archived</Badge>}
            {HIDDEN_IDS.has(s.id) && <Badge>Hidden from list</Badge>}
            {on && <Badge tone="blue">On dashboard</Badge>}
          </div>
        </div>
        <button
          onClick={() => on ? removeStrategy(s.id) : addStrategy(s.id, defaultsFromSchema(s.schema))}
          className={`shrink-0 px-3 py-1.5 text-xs uppercase tracking-wider rounded-md font-medium ${
            on ? "bg-loss/15 text-loss border border-loss/40" : "bg-accent-grad text-white"
          }`}
        >
          {on ? "Remove" : "Add to Dashboard"}
        </button>
      </header>

      <Section title="In short">
        <p className="text-sm text-text/90 leading-relaxed">{s.description}</p>
      </Section>

      <Section title="How it works">
        <Guide text={s.guide} />
      </Section>

      <Section title={`Settings (${fmtInt(s.schema.length)})`}>
        <p className="text-xs text-muted mb-3">
          The values a new copy starts with. Change them in the Dashboard's Settings panel.
        </p>
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="text-[10px] uppercase tracking-widest text-accent-blue/80 mb-1">{g.name}</div>
              <div className="rounded-xl border border-line bg-bg-panel/60 divide-y divide-line/70">
                {g.params.map((p) => <ParamRow key={p.name} p={p} />)}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section>
      <h2 className="text-xs uppercase tracking-widest text-muted mb-2">{title}</h2>
      {children}
    </section>
  );
}

// "Label: rest" → bold label. Used for guide bullets ("Buys (long) when: …").
function withLabel(line) {
  const i = line.indexOf(": ");
  if (i < 1 || i > 40) return line;
  return <><span className="font-semibold text-text">{line.slice(0, i + 1)}</span>{line.slice(i + 1)}</>;
}

// Guide text: paragraphs split by blank lines; "- " lines render as bullets.
function Guide({ text }) {
  if (!text) return <p className="text-sm text-muted italic">No plain-language guide written yet.</p>;
  const blocks = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) { blocks.push(null); continue; }
    const bullet = line.startsWith("- ");
    const last = blocks[blocks.length - 1];
    if (bullet && last?.type === "ul") last.lines.push(line.slice(2));
    else if (!bullet && last?.type === "p") last.lines.push(line);
    else blocks.push({ type: bullet ? "ul" : "p", lines: [bullet ? line.slice(2) : line] });
  }
  return (
    <div className="space-y-3 text-sm text-text/90 leading-relaxed">
      {blocks.filter(Boolean).map((b, i) => b.type === "ul" ? (
        <ul key={i} className="list-disc pl-5 space-y-1 marker:text-muted">
          {b.lines.map((l, j) => <li key={j}>{withLabel(l)}</li>)}
        </ul>
      ) : <p key={i}>{withLabel(b.lines.join(" "))}</p>)}
    </div>
  );
}

const decimalsOf = (v) => {
  const s = String(v ?? "");
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
};

// Ints grouped, floats with 2 decimals — or more when the step is finer (0.0005).
function fmtParamNum(v, p) {
  if (typeof v !== "number") return String(v);
  if (p.type === "int") return fmtInt(v);
  const d = Math.max(decimalsOf(p.step), decimalsOf(v));
  if (d <= 2) return fmtNum(v);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.min(d, 6) }).format(v);
}

function ParamRow({ p }) {
  const hasRange = p.min != null && p.max != null && (p.type === "int" || p.type === "float");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 px-4 py-2.5">
      <div className="min-w-0">
        <div className="font-mono text-sm text-text">{p.name}</div>
        <div className={`text-xs mt-0.5 ${p.description ? "text-muted" : "text-muted/50 italic"}`}>
          {p.description || "No explanation yet."}
        </div>
        {hasRange && (
          <div className="text-[11px] text-muted/70 mt-1">
            Range {fmtParamNum(p.min, p)} – {fmtParamNum(p.max, p)}
            {p.step != null && <> · step {fmtParamNum(p.step, p)}</>}
          </div>
        )}
        {p.type === "select" && p.options && (
          <div className="text-[11px] text-muted/70 mt-1">
            Options: {p.options.map((o) => o.label).join(" · ")}
          </div>
        )}
      </div>
      <div className="text-right">
        <DefaultValue p={p} />
        <div className="text-[10px] text-muted/60 mt-0.5">{TYPE_LABELS[p.type] || p.type}</div>
      </div>
    </div>
  );
}

function OnOff({ on, children }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${on ? "bg-accent-blue/15 text-accent-blue" : "bg-bg-elev text-muted line-through"}`}>
      {children}
    </span>
  );
}

function DefaultValue({ p }) {
  const v = p.default;
  if (p.type === "bool") return <OnOff on={!!v}>{v ? "On" : "Off"}</OnOff>;
  if (p.type === "int" || p.type === "float") return <span className="font-mono text-sm text-text">{fmtParamNum(v, p)}</span>;
  if (p.type === "select") {
    const opt = (p.options || []).find((o) => String(o.value) === String(v));
    return <span className="text-sm text-text">{opt ? opt.label : String(v)}</span>;
  }
  if (p.type === "sides" || p.type === "regimes") {
    return (
      <div className="flex flex-wrap justify-end gap-1 max-w-[16rem]">
        {Object.entries(v || {}).map(([k, b]) => <OnOff key={k} on={!!b}>{titleCase(k)}</OnOff>)}
      </div>
    );
  }
  if (p.type === "sessions") {
    return (
      <div className="space-y-0.5">
        {Object.entries(v || {}).map(([k, cfg]) => (
          <div key={k} className="flex justify-end items-center gap-2 text-[11px]">
            <OnOff on={!!cfg?.enabled}>{SESSION_LABELS[k] || titleCase(k)}</OnOff>
            <span className="font-mono text-muted">{cfg?.start}–{cfg?.end}</span>
          </div>
        ))}
      </div>
    );
  }
  return <span className="font-mono text-sm text-text">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>;
}
