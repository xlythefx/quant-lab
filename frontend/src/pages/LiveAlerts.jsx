import { useEffect, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import Navbar from "../components/Navbar.jsx";
import StrategyEditor from "../components/StrategyEditor.jsx";
import { socket } from "../services/socket.js";
import {
  getLiveAlerts, saveLiveAlerts, testLiveAlert,
  getStrategies, getSymbols,
} from "../services/api.js";

const WEBHOOK_PRESETS = [
  { label: "andrea-orcelinvest · binance_bot", url: "https://api.andrea-orcelinvest.com/binance_webhook?secret=binance_bot" },
  { label: "andrea-orcelinvest · staging", url: "https://api.andrea-orcelinvest.com/webhook" },
  { label: "ngrok · local test", url: "https://shakira-adducible-roentgenographically.ngrok-free.dev" },
];

const SECRET_PRESETS = ["binance_bot", "sinegual_test1"];

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
  params: {},
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
  const [firings, setFirings] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ql.live_firings") || "[]"); } catch { return []; }
  });
  const [paramsEditorOpen, setParamsEditorOpen] = useState(false);
  const [viewRule, setViewRule] = useState(null);
  const [openDropdown, setOpenDropdown] = useState(null); // { name, rule, x, y }
  const [firingDetail, setFiringDetail] = useState(null);
  const [showRead, setShowRead] = useState(false);

  const saveFirings = (next) => {
    try { localStorage.setItem("ql.live_firings", JSON.stringify(next)); } catch {}
    return next;
  };
  const markRead = (id) => setFirings((prev) => saveFirings(prev.map((f) => f._id === id ? { ...f, read: true } : f)));
  const markAllRead = () => setFirings((prev) => saveFirings(prev.map((f) => ({ ...f, read: true }))));
  const clearAll = () => setFirings(saveFirings([]));

  const catalogById = useMemo(() => {
    const m = {};
    for (const s of strategies) m[s.id] = s;
    return m;
  }, [strategies]);

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
      setFirings((prev) => {
        const next = [{ ...payload, _id: Math.random(), read: false }, ...prev].slice(0, 100);
        try { localStorage.setItem("ql.live_firings", JSON.stringify(next)); } catch {}
        return next;
      });
    };
    socket.on("live_alert_dispatched", onFire);
    return () => socket.off("live_alert_dispatched", onFire);
  }, []);

  useEffect(() => {
    if (!openDropdown) return;
    const close = (e) => {
      if (!e.target.closest("[data-test-dropdown]")) setOpenDropdown(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openDropdown]);

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
                  <th className="text-left px-3 py-2 font-medium">Params</th>
                  <th className="text-right px-3 py-2 font-medium">Lev</th>
                  <th className="text-left px-3 py-2 font-medium">Webhook URL</th>
                  <th className="text-center px-3 py-2 font-medium">Enabled</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {rules.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-4 text-center text-muted text-sm">no rules — add one below</td></tr>
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
                    <td className="px-3 py-2">
                      {(() => {
                        const schema = catalogById[r.strategy_id]?.schema || [];
                        const n = schema.filter((spec) => {
                          const v = (r.params || {})[spec.name];
                          return v !== undefined && v !== null && JSON.stringify(v) !== JSON.stringify(spec.default);
                        }).length;
                        return n > 0
                          ? <span className="text-[10px] text-accent-cyan font-medium">{n} custom</span>
                          : <span className="text-[10px] text-muted">default</span>;
                      })()}
                    </td>
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
                      <div className="flex justify-end items-center gap-1">
                        {/* Test fire dropdown */}
                        <button
                          disabled={busy || !r.enabled}
                          onClick={(e) => {
                            if (openDropdown?.name === r.name) { setOpenDropdown(null); return; }
                            const rect = e.currentTarget.getBoundingClientRect();
                            setOpenDropdown({ name: r.name, rule: r, x: rect.right, y: rect.bottom + 4 });
                          }}
                          className="px-2.5 py-1.5 text-xs rounded-md border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-40 font-medium flex items-center gap-1"
                        >
                          Test
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                            <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setViewRule(r)}
                          title="View rule details"
                          className="p-1.5 rounded-md border border-line text-muted hover:text-text hover:border-accent-cyan/60 hover:bg-accent-cyan/10 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
                            <path d="M1.38 8a6.97 6.97 0 0 1 1.966-3.336C4.42 3.585 6.138 2.75 8 2.75c1.862 0 3.58.835 4.654 1.914A6.97 6.97 0 0 1 14.62 8a6.97 6.97 0 0 1-1.966 3.336C11.58 12.415 9.862 13.25 8 13.25c-1.862 0-3.58-.835-4.654-1.914A6.97 6.97 0 0 1 1.38 8Zm6.62 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                          </svg>
                        </button>
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
                    params: {},
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

            {/* Strategy params row — always visible once strategy is selected */}
            <div className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-muted">Strategy Params</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={!draft.strategy_id}
                  onClick={() => setParamsEditorOpen(true)}
                  className="px-3 py-1.5 rounded-md border border-accent-blue/50 text-accent-blue text-xs font-medium hover:bg-accent-blue/10 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
                  </svg>
                  Configure params
                </button>
                {draft.strategy_id && (() => {
                  const schema = catalogById[draft.strategy_id]?.schema || [];
                  const n = schema.filter((spec) => {
                    const v = (draft.params || {})[spec.name];
                    return v !== undefined && v !== null && JSON.stringify(v) !== JSON.stringify(spec.default);
                  }).length;
                  return n > 0 ? (
                    <>
                      <span className="text-xs text-accent-cyan font-medium">{n} customized</span>
                      <button
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, params: {} }))}
                        className="text-xs text-muted hover:text-loss underline"
                      >
                        reset
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-muted">using defaults</span>
                  );
                })()}
              </div>
            </div>

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
              <div className="flex gap-2 items-center mb-1.5">
                <select
                  value={SECRET_PRESETS.includes(draft.secret) ? draft.secret : ""}
                  onChange={(e) => { if (e.target.value) setDraft({ ...draft, secret: e.target.value }); }}
                  className="flex-1 px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue text-text"
                >
                  <option value="">— select preset —</option>
                  {SECRET_PRESETS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <span className="text-xs text-muted shrink-0">or type↓</span>
              </div>
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
          {(() => {
            const unread = firings.filter((f) => !f.read);
            const visible = showRead ? firings : unread;
            return (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-sm uppercase tracking-wider text-muted">
                    Recent firings
                  </h2>
                  {unread.length > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-accent-blue/20 text-accent-blue font-semibold">
                      {unread.length} unread
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={() => setShowRead((v) => !v)}
                    className="text-xs text-muted hover:text-text"
                  >
                    {showRead ? "hide read" : `show all (${firings.length})`}
                  </button>
                  {unread.length > 0 && (
                    <button onClick={markAllRead} className="text-xs text-muted hover:text-text">
                      mark all read
                    </button>
                  )}
                  {firings.length > 0 && (
                    <button onClick={clearAll} className="text-xs text-loss/70 hover:text-loss">
                      clear all
                    </button>
                  )}
                </div>

                <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
                  {visible.length === 0 ? (
                    <div className="px-4 py-6 text-center text-sm text-muted">
                      {firings.length > 0
                        ? <span>All caught up — <button onClick={() => setShowRead(true)} className="text-accent-blue hover:underline">show {firings.length} read</button></span>
                        : "Nothing yet. Click a test-fire button on a rule, or start a live strategy."}
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
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/40">
                        {visible.map((f) => (
                          <tr key={f._id} className={`${!f.ok ? "bg-loss/5" : ""} ${f.read ? "opacity-50" : ""}`}>
                            <td className="px-3 py-1.5 font-mono text-xs text-muted whitespace-nowrap">
                              {new Date(f.time * 1000).toLocaleTimeString()}
                            </td>
                            <td className="px-3 py-1.5 text-xs font-semibold text-text">
                              {f.rule_name || f.strategy_id}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs">{f.symbol}</td>
                            <td className="px-3 py-1.5 font-mono text-xs">{f.action}</td>
                            <td className="px-3 py-1.5 text-center">
                              <span className={`px-1.5 py-0.5 text-xs rounded-md uppercase tracking-wider font-medium ${
                                f.ok ? "bg-accent-cyan/15 text-accent-cyan" : "bg-loss/15 text-loss"
                              }`}>
                                {f.ok ? "ok" : "fail"}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-xs text-muted font-mono truncate max-w-[280px]">
                              {f.ok ? `${f.status_code} → ${f.url}` : (f.error || "unknown error")}
                            </td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <button onClick={() => setFiringDetail(f)} className="text-[10px] text-accent-blue hover:underline whitespace-nowrap">
                                  detail
                                </button>
                                {!f.read && (
                                  <button onClick={() => markRead(f._id)} className="text-[10px] text-muted hover:text-text whitespace-nowrap">
                                    ✓ read
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            );
          })()}
        </section>
      </main>

      {openDropdown && createPortal(
        <div
          data-test-dropdown
          className="fixed z-50 bg-bg-panel border border-line rounded-lg shadow-xl overflow-hidden min-w-[140px]"
          style={{ top: openDropdown.y, left: openDropdown.x, transform: "translateX(-100%)" }}
        >
          {[
            { action: "BUY",        label: "BUY",        color: "text-accent-cyan" },
            { action: "EXIT_LONG",  label: "EXIT LONG",  color: "text-accent-blue" },
            { action: "SELL",       label: "SELL",       color: "text-accent-yellow" },
            { action: "EXIT_SHORT", label: "EXIT SHORT", color: "text-accent-purple" },
          ].map(({ action, label, color }) => (
            <button
              key={action}
              onMouseDown={(e) => { e.stopPropagation(); fire(openDropdown.rule, action); setOpenDropdown(null); }}
              className={`w-full text-left px-4 py-2.5 text-xs font-mono font-medium hover:bg-bg-elev border-b border-line/30 last:border-0 ${color}`}
            >
              {label}
            </button>
          ))}
        </div>,
        document.body
      )}

      {viewRule && (
        <RuleDetailModal
          rule={viewRule}
          stratName={stratName(viewRule.strategy_id)}
          schema={catalogById[viewRule.strategy_id]?.schema || []}
          firings={firings.filter((f) => (f.rule_name || f.strategy_id) === viewRule.name)}
          onClose={() => setViewRule(null)}
          onViewFiring={setFiringDetail}
        />
      )}

      {firingDetail && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setFiringDetail(null)}>
          <div className="bg-bg-panel border border-line rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
              <div className="flex items-center gap-3">
                <span className={`px-2 py-0.5 text-xs rounded-md font-medium uppercase ${firingDetail.ok ? "bg-accent-cyan/15 text-accent-cyan" : "bg-loss/15 text-loss"}`}>
                  {firingDetail.ok ? "ok" : "fail"}
                </span>
                <span className="font-semibold">{firingDetail.rule_name || firingDetail.strategy_id}</span>
                <span className="font-mono text-sm text-muted">{firingDetail.action}</span>
                <span className="text-xs text-muted">{new Date(firingDetail.time * 1000).toLocaleTimeString()}</span>
              </div>
              <button onClick={() => setFiringDetail(null)} className="p-1.5 rounded-md text-muted hover:text-text hover:bg-bg-elev">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted mb-1">Webhook URL</div>
                <div className="font-mono text-xs text-muted break-all">{firingDetail.url}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted mb-1">
                  {firingDetail.ok ? "Response" : "Error"}
                </div>
                <pre className="px-3 py-3 rounded-lg bg-bg-elev border border-line font-mono text-xs leading-relaxed overflow-auto whitespace-pre-wrap break-all max-h-[400px]">
                  {firingDetail.error || (firingDetail.ok ? `HTTP ${firingDetail.status_code} — OK` : "no detail")}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      <StrategyEditor
        open={paramsEditorOpen}
        schema={catalogById[draft.strategy_id]?.schema || []}
        params={draft.params || {}}
        onClose={() => setParamsEditorOpen(false)}
        onApply={(p) => { setDraft((d) => ({ ...d, params: p })); setParamsEditorOpen(false); }}
        onResetDefaults={() => setDraft((d) => ({ ...d, params: {} }))}
        onChange={() => {}}
      />
    </div>
  );
}

function RuleDetailModal({ rule, stratName, schema, firings = [], onClose, onViewFiring }) {
  const [tab, setTab] = useState("overview");
  const [secretVisible, setSecretVisible] = useState(false);

  const customCount = schema.filter((spec) => {
    const v = (rule.params || {})[spec.name];
    return v !== undefined && v !== null && JSON.stringify(v) !== JSON.stringify(spec.default);
  }).length;

  const TABS = [
    { id: "overview",  label: "Overview" },
    { id: "params",    label: `Params${customCount > 0 ? ` (${customCount})` : ""}` },
    { id: "firings",   label: `Firings${firings.length > 0 ? ` (${firings.length})` : ""}` },
  ];

  const Row = ({ label, children }) => (
    <div className="flex gap-3 py-2.5 border-b border-line/40 last:border-0">
      <span className="text-xs text-muted w-28 shrink-0 pt-0.5 uppercase tracking-wider">{label}</span>
      <div className="flex-1 min-w-0 text-sm">{children}</div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-bg-panel border border-line rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{rule.name}</h2>
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${
              rule.enabled ? "text-accent-cyan bg-accent-cyan/10" : "text-muted bg-bg-elev"
            }`}>{rule.enabled ? "enabled" : "disabled"}</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-muted hover:text-text hover:bg-bg-elev transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-line shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
                tab === t.id
                  ? "border-accent-blue text-accent-blue"
                  : "border-transparent text-muted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="overflow-y-auto flex-1 px-5 py-4">

          {/* Overview tab */}
          {tab === "overview" && (
            <div>
              <Row label="Strategy">
                <div className="font-medium">{stratName}</div>
                <div className="text-xs text-muted font-mono">{rule.strategy_id}</div>
              </Row>
              <Row label="Symbol"><span className="font-mono">{rule.symbol}</span></Row>
              <Row label="Timeframe"><span className="font-mono">{rule.timeframe || "—"}</span></Row>
              <Row label="Alias"><span className="font-mono text-xs">{rule.strategy_alias}</span></Row>
              <Row label="Leverage"><span className="font-mono">{rule.leverage}x</span></Row>
              <Row label="Broker"><span className="font-mono text-xs capitalize">{rule.broker || "auto"}</span></Row>
              <Row label="Webhook URL">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs break-all text-muted">{rule.webhook_url}</span>
                  <CopyButton text={rule.webhook_url} className="shrink-0" />
                </div>
              </Row>
              <Row label="Secret">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">
                    {secretVisible ? rule.secret : "•".repeat(Math.min(rule.secret?.length || 8, 20))}
                  </span>
                  <button onClick={() => setSecretVisible((v) => !v)} className="text-[10px] text-accent-blue hover:underline shrink-0">
                    {secretVisible ? "hide" : "reveal"}
                  </button>
                  <CopyButton text={rule.secret} className="shrink-0" />
                </div>
              </Row>
              {rule.payload_template && (
                <div className="mt-3">
                  <div className="text-xs uppercase tracking-wider text-muted mb-2">Custom Payload Template</div>
                  <pre className="px-3 py-2 rounded-lg bg-bg-elev border border-line font-mono text-xs text-muted leading-relaxed overflow-x-auto">{rule.payload_template}</pre>
                </div>
              )}
            </div>
          )}

          {/* Params tab */}
          {tab === "params" && (
            <div>
              {schema.length === 0 ? (
                <p className="text-sm text-muted">No schema available.</p>
              ) : (
                <div className="rounded-lg border border-line overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-bg-elev/60 text-muted">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Param</th>
                        <th className="text-left px-3 py-2 font-medium">Value</th>
                        <th className="text-left px-3 py-2 font-medium">Default</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/30">
                      {schema.map((spec) => {
                        const overrideVal = (rule.params || {})[spec.name];
                        const isCustom = overrideVal !== undefined && overrideVal !== null && JSON.stringify(overrideVal) !== JSON.stringify(spec.default);
                        const displayVal = isCustom ? overrideVal : spec.default;
                        const fmt = (v) => typeof v === "object" ? JSON.stringify(v) : String(v);
                        return (
                          <tr key={spec.name} className={isCustom ? "bg-accent-cyan/5" : ""}>
                            <td className={`px-3 py-2 font-mono ${isCustom ? "text-accent-cyan font-medium" : "text-muted"}`}>{spec.name}</td>
                            <td className={`px-3 py-2 font-mono ${isCustom ? "text-text" : "text-muted"}`}>{fmt(displayVal)}</td>
                            <td className="px-3 py-2 font-mono text-muted/50">{isCustom ? fmt(spec.default) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {customCount === 0 && schema.length > 0 && (
                <p className="text-xs text-muted mt-2">All params are at their defaults.</p>
              )}
            </div>
          )}

          {/* Firings tab */}
          {tab === "firings" && (
            <div>
              {firings.length === 0 ? (
                <p className="text-sm text-muted py-2">No firings yet for this rule.</p>
              ) : (
                <div className="rounded-lg border border-line overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-bg-elev/60 text-muted">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Time</th>
                        <th className="text-left px-3 py-2 font-medium">Action</th>
                        <th className="text-center px-3 py-2 font-medium">Status</th>
                        <th className="text-left px-3 py-2 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/30">
                      {firings.map((f) => (
                        <tr key={f._id}>
                          <td className="px-3 py-2 font-mono text-muted whitespace-nowrap">
                            {new Date(f.time * 1000).toLocaleTimeString()}
                          </td>
                          <td className="px-3 py-2 font-mono font-medium text-text">{f.action}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`px-1.5 py-0.5 rounded font-medium uppercase tracking-wider ${
                              f.ok ? "bg-accent-cyan/15 text-accent-cyan" : "bg-loss/15 text-loss"
                            }`}>{f.ok ? "ok" : "fail"}</span>
                          </td>
                          <td className="px-3 py-2 text-muted font-mono truncate max-w-[160px]">
                            {f.ok ? `${f.status_code} → ${f.url}` : (f.error || "unknown error")}
                          </td>
                          <td className="px-3 py-2">
                            <button onClick={() => onViewFiring?.(f)} className="text-[10px] text-accent-blue hover:underline whitespace-nowrap">
                              detail
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
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
