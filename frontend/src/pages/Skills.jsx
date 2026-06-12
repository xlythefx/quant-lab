import { useEffect, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import Markdown from "../components/Markdown.jsx";
import { getSkills, runSkill, listResearch, getResearch } from "../services/api.js";

const CATEGORIES = [
  { v: "any", label: "Any category" },
  { v: "MR", label: "MR · Mean Reversion" },
  { v: "TF", label: "TF · Trend Following" },
  { v: "BK", label: "BK · Breakout" },
  { v: "BS", label: "BS · Bias / Cycle" },
];
const HORIZONS = [
  { v: "any", label: "Any horizon" },
  { v: "ID", label: "ID · Intraday" },
  { v: "MD", label: "MD · Multiday" },
];
const INSTRUMENTS = ["any", "ES", "NQ", "CL", "GC", "BTCUSDT", "FETUSDT"];
const TIMEFRAMES = ["any", "5m", "15m", "30m", "1h", "4h", "1d"];

function fmtDate(epochSec) {
  if (!epochSec) return "";
  try {
    return new Date(epochSec * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function errText(e) {
  return e?.response?.data?.error || e?.message || "Something went wrong";
}

export default function Skills() {
  const [skills, setSkills] = useState([]);
  const [activeSkill, setActiveSkill] = useState(null); // skill id whose run panel is open
  const [theories, setTheories] = useState([]);
  const [open, setOpen] = useState(null); // {name, title, markdown}

  const [form, setForm] = useState({
    category: "any",
    horizon: "any",
    instrument: "any",
    timeframe: "any",
    notes: "",
  });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [lastUsage, setLastUsage] = useState(null);

  useEffect(() => {
    getSkills().then(setSkills).catch((e) => setError(errText(e)));
    refreshTheories();
  }, []);

  function refreshTheories() {
    listResearch().then(setTheories).catch(() => {});
  }

  async function onGenerate(skillId) {
    setGenerating(true);
    setError(null);
    try {
      const res = await runSkill(skillId, form);
      setLastUsage(res.usage || null);
      setOpen({ name: res.name, title: res.title, markdown: res.markdown });
      refreshTheories();
    } catch (e) {
      setError(errText(e));
    } finally {
      setGenerating(false);
    }
  }

  async function openTheory(name) {
    setError(null);
    try {
      const res = await getResearch(name);
      const title = theories.find((t) => t.name === name)?.title || name;
      setOpen({ name, title, markdown: res.markdown });
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="skills" />
      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="text-sm text-muted mt-1">
            AI research agents. Run a skill to generate new work — the Quant Researcher invents
            testable trading theories and saves them as strategy specs under{" "}
            <code className="px-1 py-0.5 rounded bg-bg-elev text-accent-cyan text-xs font-mono">docs/research</code>.
          </p>
        </header>

        {error && (
          <div className="rounded-xl border border-loss/40 bg-loss/10 p-4 text-sm text-loss">
            {error}
            {/api key|ANTHROPIC/i.test(error) && (
              <span className="block text-muted mt-1">
                Add <code className="font-mono">ANTHROPIC_API_KEY</code> to{" "}
                <code className="font-mono">backend/.env</code> and restart the backend.
              </span>
            )}
          </div>
        )}

        {/* Skill cards */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {skills.map((s) => {
            const runnable = s.kind === "generator";
            const isOpen = activeSkill === s.id;
            return (
              <div key={s.id} className="rounded-xl border border-line bg-bg-panel/60 p-4 flex flex-col">
                <div className="flex items-start gap-3">
                  <div className="text-2xl leading-none">{s.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tracking-tight">{s.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted border border-line rounded px-1.5 py-0.5">
                        {s.category}
                      </span>
                    </div>
                    <p className="text-sm text-muted mt-1">{s.summary}</p>
                  </div>
                  {runnable ? (
                    <button
                      onClick={() => setActiveSkill(isOpen ? null : s.id)}
                      className="shrink-0 px-3 py-1.5 rounded-md bg-accent-grad text-white text-sm font-medium"
                    >
                      {isOpen ? "Close" : "Run"}
                    </button>
                  ) : (
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted border border-line rounded px-2 py-1">
                      info
                    </span>
                  )}
                </div>

                {runnable && isOpen && (
                  <div className="mt-4 pt-4 border-t border-line/60 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Select label="Category" value={form.category}
                        onChange={(v) => setForm({ ...form, category: v })}
                        options={CATEGORIES.map((c) => [c.v, c.label])} />
                      <Select label="Horizon" value={form.horizon}
                        onChange={(v) => setForm({ ...form, horizon: v })}
                        options={HORIZONS.map((c) => [c.v, c.label])} />
                      <Select label="Instrument" value={form.instrument}
                        onChange={(v) => setForm({ ...form, instrument: v })}
                        options={INSTRUMENTS.map((c) => [c, c === "any" ? "Any instrument" : c])} />
                      <Select label="Timeframe" value={form.timeframe}
                        onChange={(v) => setForm({ ...form, timeframe: v })}
                        options={TIMEFRAMES.map((c) => [c, c === "any" ? "Any timeframe" : c])} />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-muted">Seed idea / notes (optional)</label>
                      <textarea
                        value={form.notes}
                        onChange={(e) => setForm({ ...form, notes: e.target.value })}
                        rows={2}
                        placeholder="e.g. fade overnight gaps after high-volatility days"
                        className="mt-1 w-full rounded-md border border-line bg-bg-elev/60 px-3 py-2 text-sm outline-none focus:border-accent-blue/60 resize-y"
                      />
                    </div>
                    <button
                      onClick={() => onGenerate(s.id)}
                      disabled={generating}
                      className="w-full px-3 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50"
                    >
                      {generating ? "Researching…" : "Generate theory"}
                    </button>
                    {lastUsage && (
                      <p className="text-[11px] text-muted font-mono text-center">
                        {lastUsage.input_tokens} in · {lastUsage.output_tokens} out tokens
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {skills.length === 0 && !error && (
            <div className="text-sm text-muted">Loading skills…</div>
          )}
        </section>

        {/* Theory viewer */}
        {open && (
          <section className="rounded-xl border border-line bg-bg-panel/60 p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-muted font-mono">{open.name}</div>
              <button
                onClick={() => setOpen(null)}
                className="text-xs text-muted hover:text-text border border-line rounded px-2 py-1"
              >
                Close
              </button>
            </div>
            <Markdown source={open.markdown} />
          </section>
        )}

        {/* Generated theories list */}
        <section className="rounded-xl border border-line bg-bg-panel/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Generated theories</h2>
            <span className="text-xs text-muted">{theories.length}</span>
          </div>
          {theories.length === 0 ? (
            <p className="text-sm text-muted">No theories yet — run the Quant Researcher above.</p>
          ) : (
            <div className="divide-y divide-line/60">
              {theories.map((t) => (
                <button
                  key={t.name}
                  onClick={() => openTheory(t.name)}
                  className="w-full text-left py-2.5 flex items-center justify-between hover:bg-bg-elev/30 px-2 rounded transition"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-text truncate">{t.title}</div>
                    <div className="text-xs text-muted font-mono truncate">{t.name}</div>
                  </div>
                  <div className="text-xs text-muted shrink-0 ml-3">{fmtDate(t.created)}</div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-muted">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-line bg-bg-elev/60 px-2 py-2 text-sm outline-none focus:border-accent-blue/60"
      >
        {options.map(([v, lbl]) => (
          <option key={v} value={v}>{lbl}</option>
        ))}
      </select>
    </div>
  );
}
