import { useEffect, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { socket } from "../services/socket.js";
import {
  getLiveAlerts, saveLiveAlerts, testLiveAlert,
  getStrategies, getSymbols,
} from "../services/api.js";

const BLANK_RULE = {
  strategy_id: "",
  symbol: "",
  enabled: true,
  webhook_url: "http://localhost:5051/binance_webhook",
  secret: "",
  strategy_alias: "",
  leverage: 25,
};

export default function LiveAlerts() {
  const [rules, setRules] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [draft, setDraft] = useState({ ...BLANK_RULE });
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
    if (!draft.strategy_id || !draft.symbol || !draft.webhook_url || !draft.secret || !draft.strategy_alias) {
      setErr("strategy, symbol, webhook URL, secret, and alias are required");
      return;
    }
    const others = rules.filter(
      (r) => !(r.strategy_id === draft.strategy_id && r.symbol === draft.symbol),
    );
    const next = [...others, { ...draft, leverage: Number(draft.leverage) || 1 }];
    await persist(next);
    setDraft({ ...BLANK_RULE });
  };

  const updateRule = (idx, patch) => {
    const next = rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    persist(next);
  };

  const deleteRule = (idx) => {
    persist(rules.filter((_, i) => i !== idx));
  };

  const fire = async (r) => {
    try {
      const res = await testLiveAlert({ strategy_id: r.strategy_id, symbol: r.symbol });
      if (!res?.ok) setErr(`test fire failed: ${res?.error || "unknown"}`);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const stratName = (id) => strategies.find((s) => s.id === id)?.name || id;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="livealerts" />
      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Live Alerts</h1>
          <p className="text-sm text-muted mt-1">
            POST a TradingView-style JSON payload to your Binance acceptor whenever a
            live strategy fires an entry/exit. One rule per <span className="font-mono">(strategy, symbol)</span>.
            Backtest mode never dispatches.
          </p>
        </header>

        {err && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{err}</div>
        )}

        {/* Rules table */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm uppercase tracking-wider text-muted">Rules ({rules.length})</h2>
            {savedAt && <span className="text-xs text-muted">saved {savedAt.toLocaleTimeString()}</span>}
          </div>
          <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-elev/50 text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Strategy</th>
                  <th className="text-left px-3 py-2 font-medium">Symbol</th>
                  <th className="text-left px-3 py-2 font-medium">Alias</th>
                  <th className="text-right px-3 py-2 font-medium">Lev</th>
                  <th className="text-left px-3 py-2 font-medium">Webhook URL</th>
                  <th className="text-center px-3 py-2 font-medium">Enabled</th>
                  <th className="text-right px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {rules.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-4 text-center text-muted text-sm">no rules — add one below</td></tr>
                )}
                {rules.map((r, idx) => (
                  <tr key={`${r.strategy_id}-${r.symbol}`} className="hover:bg-bg-elev/30">
                    <td className="px-3 py-2">
                      <div className="text-text">{stratName(r.strategy_id)}</div>
                      <div className="text-xs text-muted font-mono">{r.strategy_id}</div>
                    </td>
                    <td className="px-3 py-2 font-mono">{r.symbol}</td>
                    <td className="px-3 py-2 font-mono">{r.strategy_alias}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.leverage}x</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted truncate max-w-[280px]" title={r.webhook_url}>
                      {r.webhook_url}
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
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => fire(r)}
                          disabled={busy || !r.enabled}
                          className="px-2 py-1 text-xs rounded-md border border-line text-muted hover:text-text hover:border-accent-blue disabled:opacity-40"
                        >
                          Test fire
                        </button>
                        <button
                          onClick={() => deleteRule(idx)}
                          disabled={busy}
                          className="px-2 py-1 text-xs rounded-md border border-loss/40 text-loss hover:bg-loss/10 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Add rule form */}
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Add rule</h2>
          <div className="rounded-xl border border-line bg-bg-panel/60 p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <input
                type="text" value={draft.webhook_url}
                onChange={(e) => setDraft({ ...draft, webhook_url: e.target.value })}
                placeholder="http://localhost:5051/binance_webhook"
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
            </Field>

            <Field label="Secret" full>
              <input
                type="password" value={draft.secret}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                placeholder="shared token your acceptor validates"
                className="w-full px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              />
            </Field>

            <div className="md:col-span-2 flex items-center gap-3 pt-1">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                enabled on save
              </label>
              <div className="flex-1" />
              <button
                onClick={addRule}
                disabled={busy}
                className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50"
              >
                {busy ? "Saving…" : "Add rule"}
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
                Nothing yet. Click <span className="font-mono">Test fire</span> on a rule, or start a live strategy.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg-elev/50 text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Time</th>
                    <th className="text-left px-3 py-2 font-medium">Strategy</th>
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
                      <td className="px-3 py-1.5 font-mono text-xs">{f.strategy_id}</td>
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
