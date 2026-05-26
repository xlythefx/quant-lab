import { useEffect, useState, useCallback } from "react";
import Navbar from "../components/Navbar.jsx";
import { socket } from "../services/socket.js";
import {
  getLiveAlerts, saveLiveAlerts, testLiveAlert,
  getStrategies, getSymbols,
} from "../services/api.js";

const WEBHOOK_PRESETS = [
  { label: "ngrok · local test", url: "https://shakira-adducible-roentgenographically.ngrok-free.dev" },
];

const DEFAULT_PAYLOAD_TEMPLATE = `{
  "secret": "{{secret}}",
  "strategy": "{{strategy}}",
  "leverage": "{{leverage}}",
  "action": "{{action}}",
  "symbol": "{{symbol}}"
}`;

const TIMEFRAME_OPTIONS = ["1m", "5m", "15m", "1h"];

const BLANK_RULE = {
  name: "",
  strategy_id: "",
  symbol: "",
  timeframe: "1h",
  enabled: true,
  webhook_url: "",
  secret: "",
  strategy_alias: "",
  leverage: 25,
  payload_template: "",
};

export default function LiveAlerts() {
  const [rules, setRules] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [draft, setDraft] = useState({ ...BLANK_RULE });
  const [editIdx, setEditIdx] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [firings, setFirings] = useState([]);

  useEffect(() => {
    Promise.all([getLiveAlerts(), getStrategies(), getSymbols()])
      .then(([r, s, syms]) => {
        setRules(r || []);
        setStrategies(s || []);
        const list = Array.isArray(syms) ? syms : (syms?.symbols || []);
        setSymbols(list);
      })
      .catch((e) => setErr(e?.response?.data?.error || e.message));
  }, []);

  useEffect(() => {
    const onFire = (payload) => {
      setFirings((prev) => [{ ...payload, _id: Math.random() }, ...prev].slice(0, 30));
    };
    socket.on("live_alert_dispatched", onFire);
    return () => socket.off("live_alert_dispatched", onFire);
  }, []);

  const persist = async (next) => {
    setBusy(true); setErr(null);
    try {
      const saved = await saveLiveAlerts(next);
      setRules(saved);
      setSavedAt(new Date());
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "save failed");
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    if (!draft.name || !draft.strategy_id || !draft.symbol || !draft.timeframe || !draft.webhook_url || !draft.secret || !draft.strategy_alias) {
      setErr("name, strategy, symbol, timeframe, webhook URL, secret, and alias are required");
      return;
    }
    if (editIdx === null && rules.some((r) => r.name === draft.name)) {
      setErr(`a rule named "${draft.name}" already exists — use a unique name`);
      return;
    }
    const normalized = { ...draft, leverage: Number(draft.leverage) || 1 };
    const next = editIdx !== null
      ? rules.map((r, i) => (i === editIdx ? normalized : r))
      : [...rules, normalized];
    await persist(next);
    setDraft({ ...BLANK_RULE });
    setEditIdx(null);
  };

  const startEdit = (idx) => {
    setEditIdx(idx);
    setDraft({ ...rules[idx] });
    setErr(null);
    document.getElementById("rule-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cancelEdit = () => {
    setEditIdx(null);
    setDraft({ ...BLANK_RULE });
    setErr(null);
  };

  const updateRule = (idx, patch) => {
    const next = rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    persist(next);
  };

  const deleteRule = (idx) => {
    persist(rules.filter((_, i) => i !== idx));
  };

  const fire = async (r, action) => {
    try {
      const res = await testLiveAlert({ rule_name: r.name, action });
      if (!res?.ok) setErr(`test fire failed (${action}): ${res?.error || "unknown"}`);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const urlPresets = Array.from(new Set(rules.map((r) => r.webhook_url))).filter(Boolean);

  const stratName = (id) => strategies.find((s) => s.id === id)?.name || id;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="livealerts" />
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Live Alerts</h1>
          <p className="text-sm text-muted mt-1">
            POST a TradingView-style JSON payload to your acceptor whenever a live strategy
            fires an entry/exit. Create one named rule per target — e.g. one per VPS — for
            the same strategy/symbol. Backtest mode never dispatches.
          </p>
        </header>

        {err && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss flex items-center justify-between gap-3">
            <span>{err}</span>
            <button onClick={() => setErr(null)} className="text-loss/60 hover:text-loss text-xs shrink-0">dismiss</button>
          </div>
        )}

        {/* Rules table */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm uppercase tracking-wider text-muted">Rules ({rules.length})</h2>
            {savedAt && <span className="text-xs text-muted">saved {savedAt.toLocaleTimeString()}</span>}
          </div>
          <div className="rounded-xl border border-line bg-bg-panel/60 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-elev/50 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Strategy</th>
                  <th className="text-left px-3 py-2 font-medium">Symbol</th>
                  <th className="text-left px-3 py-2 font-medium">TF</th>
                  <th className="text-left px-3 py-2 font-medium">Alias</th>
                  <th className="text-right px-3 py-2 font-medium">Lev</th>
                  <th className="text-left px-3 py-2 font-medium">Webhook URL</th>
                  <th className="text-center px-3 py-2 font-medium">Enabled</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {rules.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-4 text-center text-muted text-sm">no rules — add one below</td></tr>
                )}
                {rules.map((r, idx) => (
                  <tr key={r.name} className="hover:bg-bg-elev/30">
                    <td className="px-3 py-2 font-semibold text-text max-w-[160px]">
                      <div className="truncate" title={r.name}>{r.name}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-text">{stratName(r.strategy_id)}</div>
                      <div className="text-xs text-muted font-mono">{r.strategy_id}</div>
                    </td>
                    <td className="px-3 py-2 font-mono">{r.symbol}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.timeframe || "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.strategy_alias}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.leverage}x</td>
                    <td className="px-3 py-2 max-w-[240px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-xs text-muted truncate" title={r.webhook_url}>{r.webhook_url}</span>
                        <CopyButton text={r.webhook_url} className="shrink-0" />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => updateRule(idx, { enabled: !r.enabled })}
                        disabled={busy}
                        className={`px-2 py-1 text-xs rounded-md uppercase tracking-wider font-medium ${
                          r.enabled
                            ? "bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40"
                            : "bg-bg-elev text-muted border border-line"
                        }`}
                      >
                        {r.enabled ? "on" : "off"}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end flex-wrap gap-1">
                        {[
                          { action: "BUY",        label: "BUY",    color: "accent-cyan" },
                          { action: "EXIT_LONG",  label: "EXIT_L", color: "accent-blue" },
                          { action: "SELL",       label: "SELL",   color: "accent-yellow" },
                          { action: "EXIT_SHORT", label: "EXIT_S", color: "accent-purple" },
                        ].map(({ action, label, color }) => (
                          <button
                            key={action}
                            onClick={() => fire(r, action)}
                            disabled={busy || !r.enabled}
                            title={`Test fire ${action}`}
                            className={`px-2 py-1 text-xs rounded-md border border-${color}/40 text-${color} hover:bg-${color}/10 disabled:opacity-40 font-mono`}
                          >
                            {label}
                          </button>
                        ))}
                        <button
                          onClick={() => startEdit(idx)}
                          disabled={busy}
                          title="Edit rule"
                          className="p-1.5 rounded-md border border-line text-muted hover:text-text hover:border-accent-blue/60 hover:bg-accent-blue/10 disabled:opacity-40 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => deleteRule(idx)}
                          disabled={busy}
                          title="Delete rule"
                          className="p-1.5 rounded-md border border-loss/40 text-loss hover:bg-loss/10 disabled:opacity-40 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M5.75 3a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 0 1.5h-3A.75.75 0 0 1 5.75 3ZM3 5.75A.75.75 0 0 1 3.75 5h8.5a.75.75 0 0 1 0 1.5H12v5A1.5 1.5 0 0 1 10.5 13h-5A1.5 1.5 0 0 1 4 11.5v-5h-.25A.75.75 0 0 1 3 5.75ZM5.5 6.5v5h5v-5h-5Z" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Add / Edit rule form */}
        <section id="rule-form">
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">
            {editIdx !== null ? `Edit rule · ${rules[editIdx]?.name}` : "Add rule"}
          </h2>
          <div className={`rounded-xl border p-5 grid grid-cols-1 md:grid-cols-2 gap-4 ${
            editIdx !== null ? "border-accent-blue/40 bg-accent-blue/5" : "border-line bg-bg-panel/60"
          }`}>

            <Field label="Alert name" full>
              <input
                type="text" value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="VWMA BTC → VPS1"
                disabled={editIdx !== null}
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <span className="text-[10px] text-muted mt-0.5">Unique label — use the same strategy/symbol with different names for multiple targets.</span>
            </Field>

            <Field label="Strategy">
              <select
                value={draft.strategy_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const s = strategies.find((x) => x.id === id);
                  setDraft({
                    ...draft,
                    strategy_id: id,
                    strategy_alias: draft.strategy_alias || (s?.name || ""),
                  });
                }}
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              >
                <option value="">— select —</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
                ))}
              </select>
            </Field>

            <Field label="Symbol">
              <select
                value={draft.symbol}
                onChange={(e) => setDraft({ ...draft, symbol: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              >
                <option value="">— select —</option>
                {symbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>

            <Field label="Timeframe">
              <select
                value={draft.timeframe}
                onChange={(e) => setDraft({ ...draft, timeframe: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              >
                {TIMEFRAME_OPTIONS.map((tf) => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
            </Field>

            <Field label="Strategy alias (sent as `strategy` field)">
              <input
                type="text" value={draft.strategy_alias}
                onChange={(e) => setDraft({ ...draft, strategy_alias: e.target.value })}
                placeholder="VWMA-Reversion"
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
            </Field>

            <Field label="Leverage">
              <input
                type="number" min={1} max={125} step={1}
                value={draft.leverage}
                onChange={(e) => setDraft({ ...draft, leverage: e.target.value })}
                className="w-32 px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
            </Field>

            <Field label="Webhook URL" full>
              <div className="flex gap-2 items-center mb-1.5">
                <select
                  value={[...WEBHOOK_PRESETS.map(p => p.url), ...urlPresets].includes(draft.webhook_url) ? draft.webhook_url : ""}
                  onChange={(e) => { if (e.target.value) setDraft({ ...draft, webhook_url: e.target.value }); }}
                  className="flex-1 px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue text-text"
                >
                  <option value="">— select preset —</option>
                  {WEBHOOK_PRESETS.map((p) => (
                    <option key={p.url} value={p.url}>{p.label} · {p.url.replace(/^https?:\/\//, "")}</option>
                  ))}
                  {urlPresets.filter((u) => !WEBHOOK_PRESETS.some((p) => p.url === u)).map((u) => (
                    <option key={u} value={u}>{u.replace(/^https?:\/\//, "")}</option>
                  ))}
                </select>
                <span className="text-xs text-muted shrink-0">or type↓</span>
              </div>
              <div className="flex gap-2 items-center">
                <input
                  type="text" value={draft.webhook_url}
                  onChange={(e) => setDraft({ ...draft, webhook_url: e.target.value })}
                  placeholder="https://api1.yourdomain.com/binance_webhook"
                  className="flex-1 px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
                />
                <CopyButton text={draft.webhook_url} />
              </div>
            </Field>

            <Field label="Secret" full>
              <input
                type="text" value={draft.secret}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                placeholder="shared token your acceptor validates"
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
            </Field>

            <div className="md:col-span-2 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wider text-muted">JSON Payload</span>
                <span className="text-[10px] text-muted/60">sent to webhook on each signal</span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, payload_template: draft.payload_template ? "" : DEFAULT_PAYLOAD_TEMPLATE })}
                  className="text-[10px] text-accent-blue hover:underline"
                >
                  {draft.payload_template ? "reset to default" : "customize"}
                </button>
              </div>
              {draft.payload_template ? (
                <textarea
                  value={draft.payload_template}
                  onChange={(e) => setDraft({ ...draft, payload_template: e.target.value })}
                  rows={8}
                  spellCheck={false}
                  className="w-full px-3 py-2 rounded-md bg-bg-elev border border-accent-blue/40 font-mono text-xs focus:outline-none focus:border-accent-blue resize-y"
                />
              ) : (
                <pre className="px-3 py-2 rounded-md bg-bg-elev/50 border border-line font-mono text-xs text-muted leading-relaxed select-none">{DEFAULT_PAYLOAD_TEMPLATE}</pre>
              )}
              <span className="text-[10px] text-muted/60">
                Tokens: <code className="text-accent-cyan">{"{{action}}"}</code> <code className="text-accent-cyan">{"{{symbol}}"}</code> <code className="text-accent-cyan">{"{{secret}}"}</code> <code className="text-accent-cyan">{"{{strategy}}"}</code> <code className="text-accent-cyan">{"{{leverage}}"}</code>
              </span>
            </div>

            <div className="md:col-span-2 flex items-center gap-3 pt-1">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                enabled on save
              </label>
              <div className="flex-1" />
              {editIdx !== null && (
                <button
                  onClick={cancelEdit}
                  disabled={busy}
                  className="px-4 py-2 rounded-md border border-line text-muted text-sm hover:text-text disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={addRule}
                disabled={busy}
                className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50"
              >
                {busy ? "Saving…" : editIdx !== null ? "Save changes" : "Add rule"}
              </button>
            </div>
          </div>
        </section>

        {/* Recent firings */}
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">
            Recent firings ({firings.length})
          </h2>
          <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
            {firings.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted">
                Nothing yet. Click a test-fire button on a rule, or start a live strategy.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg-elev/50 text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Time</th>
                    <th className="text-left px-3 py-2 font-medium">Rule</th>
                    <th className="text-left px-3 py-2 font-medium">Symbol</th>
                    <th className="text-left px-3 py-2 font-medium">Action</th>
                    <th className="text-center px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {firings.map((f) => (
                    <tr key={f._id}>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted">
                        {new Date(f.time * 1000).toLocaleTimeString()}
                      </td>
                      <td className="px-3 py-1.5 text-xs font-semibold text-text">
                        {f.rule_name || f.strategy_id}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">{f.symbol}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{f.action}</td>
                      <td className="px-3 py-1.5 text-center">
                        <span className={`px-1.5 py-0.5 text-xs rounded-md uppercase tracking-wider font-medium ${
                          f.ok
                            ? "bg-accent-cyan/15 text-accent-cyan"
                            : "bg-loss/15 text-loss"
                        }`}>
                          {f.ok ? "ok" : "fail"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted font-mono truncate max-w-[320px]">
                        {f.ok
                          ? `${f.status_code} → ${f.url}`
                          : (f.error || "unknown error")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Field({ label, full, children }) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "md:col-span-2" : ""}`}>
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}

function CopyButton({ text, className = "" }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy to clipboard"
      disabled={!text}
      className={`p-1.5 rounded-md border transition-colors disabled:opacity-30 ${
        copied
          ? "border-accent-cyan/60 text-accent-cyan bg-accent-cyan/10"
          : "border-line text-muted hover:text-text hover:border-line/80"
      } ${className}`}
    >
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
          <path d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h5.793A1.5 1.5 0 0 0 10.5 13V9.621a1.5 1.5 0 0 0-.44-1.06L6.439 4.94A1.5 1.5 0 0 0 5.379 4.5H3.5ZM11 7.5V13a3 3 0 0 1-3 3H3.5A3 3 0 0 1 .5 13v-9A3 3 0 0 1 3.5 1h2a.5.5 0 0 1 0 1H3.5A2 2 0 0 0 1.5 4v9A2 2 0 0 0 3.5 15h4.5a2 2 0 0 0 2-2V7.5h1Z" />
          <path d="M11.5 1a.5.5 0 0 1 .5.5v2h2a.5.5 0 0 1 0 1h-2v2a.5.5 0 0 1-1 0v-2h-2a.5.5 0 0 1 0-1h2v-2a.5.5 0 0 1 .5-.5Z" />
        </svg>
      )}
    </button>
  );
}
