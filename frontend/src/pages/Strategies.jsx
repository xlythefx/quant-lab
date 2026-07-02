import { useEffect, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { getStrategies } from "../services/api.js";
import {
  useActiveStrategies, isActive, addStrategy, removeStrategy,
} from "../services/strategiesStore.js";

function defaultsFromSchema(schema) {
  const out = {};
  for (const s of schema || []) out[s.name] = s.default;
  return out;
}

const KIND_FILTERS = [
  { key: "available", label: "Available" },
  { key: "all", label: "All" },
  { key: "ohlc", label: "OHLC" },
  { key: "hlc", label: "HLC" },
  { key: "archived", label: "Archived" },
];

// UI-only hide list: these strategies stay registered and runnable in the
// backend, but are hidden from this picker for now. Remove an id to show it.
const HIDDEN_IDS = new Set(["pivot_breakout", "rsi2_reversion"]);

export default function Strategies() {
  const [strategies, setStrategies] = useState([]);
  const [error, setError] = useState(null);
  // Default to "Available" so archived strategies are hidden on first load.
  const [kindFilter, setKindFilter] = useState("available");
  const active = useActiveStrategies();

  useEffect(() => {
    getStrategies()
      .then(setStrategies)
      .catch((e) => setError(e?.response?.data?.error || e.message));
  }, []);

  // "Available" (default) and the OHLC/HLC kind filters hide archived strategies;
  // "Archived" lists only archived; "All" shows everything including archived.
  const shown = strategies.filter((s) => {
    if (HIDDEN_IDS.has(s.id)) return false;
    const archived = !!s.archived;
    if (kindFilter === "archived") return archived;
    if (kindFilter === "all") return true;
    if (kindFilter === "available") return !archived;
    if (archived) return false;
    return (s.kind || "ohlc") === kindFilter;
  });

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="strategies" />

      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Strategies</h1>
          <p className="text-sm text-muted mt-1">
            Browse registered strategies. Add one or more to the dashboard
            to see them run live or in backtest with editable params.
          </p>
          <div className="flex gap-2 mt-3">
            {KIND_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setKindFilter(f.key)}
                className={`px-3 py-1.5 text-xs uppercase tracking-wider rounded-md font-medium border ${
                  kindFilter === f.key
                    ? "bg-accent-grad text-white border-transparent"
                    : "border-line text-muted hover:text-text"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </header>

        <a
          href="#strategysandbox"
          className="flex items-center justify-between rounded-xl border border-accent-violet/30
                     bg-accent-violet/5 px-5 py-4 hover:bg-accent-violet/10 transition group"
        >
          <div>
            <div className="text-base font-semibold flex items-center gap-2">
              <span>✨</span> Design a strategy with AI
            </div>
            <div className="text-sm text-muted mt-0.5">
              Describe an idea in plain English — the AI Builder writes, back-tests, and tweaks a
              real strategy with you (BTCUSDT &amp; ES).
            </div>
          </div>
          <span className="text-accent-violet group-hover:translate-x-0.5 transition">Open Sandbox →</span>
        </a>

        {error && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {shown.length === 0 && !error && (
            <div className="text-sm text-muted">no strategies registered</div>
          )}
          {shown.map((s) => {
            const on = isActive(s.id);
            return (
              <div key={s.id} className="rounded-xl border border-line bg-bg-panel/60 p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold">{s.name}</div>
                    <div className="text-xs text-muted font-mono mt-0.5">{s.id}</div>
                  </div>
                  <button
                    onClick={() => on ? removeStrategy(s.id) : addStrategy(s.id, defaultsFromSchema(s.schema))}
                    className={`px-3 py-1.5 text-xs uppercase tracking-wider rounded-md font-medium ${
                      on ? "bg-loss/15 text-loss border border-loss/40" : "bg-accent-grad text-white"
                    }`}
                  >
                    {on ? "Remove" : "Add to Dashboard"}
                  </button>
                </div>
                <p className="text-sm text-muted">{s.description}</p>
                <details className="text-xs">
                  <summary className="text-muted cursor-pointer hover:text-text">Default params</summary>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
                    {s.schema.map((p) => (
                      <div key={p.name} className="flex justify-between">
                        <span className="text-muted truncate">{p.name}</span>
                        <span className="text-text truncate ml-2">{formatDefault(p.default)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            );
          })}
        </div>

        {active.length > 0 && (
          <div className="text-xs text-muted text-center">
            {active.length} strategy{active.length === 1 ? "" : "ies"} active —
            {" "}<a href="#dashboard" className="text-accent-blue hover:underline">go to Dashboard →</a>
          </div>
        )}
      </main>
    </div>
  );
}

function formatDefault(v) {
  if (typeof v === "object" && v !== null) {
    return Object.entries(v).map(([k, val]) => `${k}:${val ? "✓" : "·"}`).join(" ");
  }
  return String(v);
}
