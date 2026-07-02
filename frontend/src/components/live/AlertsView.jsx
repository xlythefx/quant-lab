import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import ParamForm from "./ParamForm.jsx";
import { useEnterStagger } from "./animations.js";
import { getAlertsHistory, deleteAlertsHistory, getActivityLog, getLiveReconciliation } from "./liveApi.js";
import { getLiveAlerts, saveLiveAlerts, testLiveAlert, getStrategies, getSymbols } from "../../services/api.js";
import { onAlertDispatched, onLiveSignal } from "./liveChannels.js";
import { fmtNum } from "../../services/format.js";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];
const ACTIONS = ["BUY", "EXIT_LONG", "SELL", "EXIT_SHORT"];

const DEFAULT_PAYLOAD_TEMPLATE = `{
  "secret": "{{secret}}",
  "strategy": "{{strategy}}",
  "leverage": "{{leverage}}",
  "action": "{{action}}",
  "symbol": "{{symbol}}"
}`;

const BLANK = {
  name: "", strategy_id: "", symbol: "", timeframe: "1h", enabled: true,
  webhook_url: "", secret: "", strategy_alias: "", leverage: 25,
  payload_template: "", params: {}, account: "demo",
};

function ts(t) {
  if (!t) return "—";
  const d = new Date(t * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

/**
 * The Live Terminal's home for alerts (bell → here). Three tabs:
 *   RULES    — create/edit/delete alert rules + webhooks, exactly like the
 *              old page (same /api/live-alerts backend, terminal-native UI)
 *   HISTORY  — every fired alert (SQLite, filterable, deletable)
 *   ACTIVITY — the black box: armed/paused/killed/fired/sent/blocked
 * The old #livealerts page keeps working untouched until cutover (10).
 */
export default function AlertsView({ account = "demo" }) {
  const ref = useRef(null);
  useEnterStagger("alerts", ref);
  const [tab, setTab] = useState("rules");
  const [recon, setRecon] = useState(null);
  const [rules, setRules] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [history, setHistory] = useState([]);
  const [activity, setActivity] = useState([]);
  const [histFilter, setHistFilter] = useState("");
  const [histStatus, setHistStatus] = useState("all");
  const [modal, setModal] = useState(null); // {draft, editName|null}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [testMenu, setTestMenu] = useState(null);

  const refreshRules = useCallback(() => {
    getLiveAlerts().then((r) => setRules(r || [])).catch((e) => setErr(e.message));
  }, []);
  const refreshLogs = useCallback(() => {
    getAlertsHistory({ limit: 300 }).then(setHistory).catch(() => {});
    getActivityLog({ limit: 300 }).then(setActivity).catch(() => {});
  }, []);

  useEffect(() => {
    refreshRules();
    refreshLogs();
    getStrategies().then((s) => setStrategies(s || [])).catch(() => {});
    getSymbols().then((d) => setSymbols(Array.isArray(d) ? d : d?.symbols || [])).catch(() => {});
    const offs = [onAlertDispatched(refreshLogs), onLiveSignal(refreshLogs)];
    return () => offs.forEach((f) => f());
  }, [refreshRules, refreshLogs]);

  const persist = async (next) => {
    setBusy(true); setErr(null);
    try {
      const saved = await saveLiveAlerts(next);
      setRules(saved);
      return true;
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      return false;
    } finally { setBusy(false); }
  };

  const stratName = (id) => strategies.find((s) => s.id === id)?.name || id;
  const schemaFor = (id) => strategies.find((s) => s.id === id)?.schema || [];

  const openAdd = () => setModal({ draft: { ...BLANK }, editName: null });
  const openEdit = (r) => setModal({ draft: { ...BLANK, ...r }, editName: r.name });

  const saveModal = async () => {
    const d = modal.draft;
    for (const [k, label] of [["name", "name"], ["strategy_id", "strategy"], ["symbol", "symbol"],
      ["timeframe", "timeframe"], ["webhook_url", "webhook URL"], ["secret", "secret"], ["strategy_alias", "alias"]]) {
      if (!String(d[k] || "").trim()) { setErr(`${label} is required`); return; }
    }
    if (modal.editName === null && rules.some((r) => r.name === d.name)) {
      setErr(`a rule named "${d.name}" already exists`); return;
    }
    const normalized = { ...d, leverage: Number(d.leverage) || 1 };
    const next = modal.editName !== null
      ? rules.map((r) => (r.name === modal.editName ? normalized : r))
      : [...rules, normalized];
    if (await persist(next)) setModal(null);
  };

  const fire = async (rule, action, dryRun) => {
    setTestMenu(null);
    try {
      const res = await testLiveAlert({ rule_name: rule.name, action, dry_run: dryRun });
      if (!res?.ok) setErr(res?.error || "test failed");
      refreshLogs();
    } catch (e) { setErr(e?.response?.data?.error || e.message); }
  };

  const visibleHistory = useMemo(() => history.filter((h) => {
    if (histStatus === "ok" && !h.ok) return false;
    if (histStatus === "fail" && h.ok) return false;
    if (histFilter && !`${h.rule_name} ${h.symbol} ${h.action}`.toLowerCase().includes(histFilter.toLowerCase())) return false;
    return true;
  }), [history, histFilter, histStatus]);

  useEffect(() => {
    if (tab !== "recon") return;
    getLiveReconciliation(account).then(setRecon).catch(() => setRecon({ ok: false, alerts: [] }));
  }, [tab, account]);

  const TABS = [
    ["rules", `RULES (${rules.length})`],
    ["history", `FIRED HISTORY (${history.length})`],
    ["activity", "ACTIVITY LOG"],
    ["recon", "RECONCILIATION"],
  ];

  return (
    <div ref={ref} className="lt-ws grid" style={{ gridTemplateRows: "1fr" }}>
      <Panel
        title="Alerts & Webhooks"
        right={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {TABS.map(([id, label]) => (
              <button
                key={id}
                className="lt-mono"
                onClick={() => setTab(id)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  borderBottom: `2px solid ${tab === id ? "var(--lt-amber)" : "transparent"}`,
                  color: tab === id ? "#fff" : "var(--lt-muted)",
                  fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", padding: "2px 4px",
                }}
              >
                {label}
              </button>
            ))}
            {tab === "rules" && <button className="lt-btn primary small" onClick={openAdd}>+ ADD ALERT</button>}
          </div>
        }
      >
        {err && (
          <div className="lt-warn-banner" style={{ position: "static" }}>
            ⚠ {err}
            <button className="lt-btn small" style={{ marginLeft: "auto" }} onClick={() => setErr(null)}>DISMISS</button>
          </div>
        )}

        {/* ---- RULES ---- */}
        {tab === "rules" && (
          rules.length === 0 ? (
            <div className="lt-empty">No alert rules — add one, or deploy a strategy (Strategies workspace)</div>
          ) : (
            <table className="lt-table">
              <thead>
                <tr>
                  <th>NAME</th><th>STRATEGY</th><th>SYMBOL</th><th>TF</th><th>ACCT</th><th>ALIAS</th>
                  <th className="num">LEV</th><th>WEBHOOK</th><th>ENABLED</th><th className="num">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.name}>
                    <td style={{ fontWeight: 700 }}>{r.name}</td>
                    <td className="lt-muted" title={r.strategy_id}>{stratName(r.strategy_id)}</td>
                    <td>{r.symbol}</td>
                    <td className="lt-muted">{r.timeframe || "—"}</td>
                    <td>
                      <span className={(r.account || "demo") === "live" ? "lt-red" : "lt-cyan"} style={{ fontWeight: 700, fontSize: 9 }}>
                        {(r.account || "demo").toUpperCase()}
                      </span>
                    </td>
                    <td className="lt-muted">{r.strategy_alias}</td>
                    <td className="num">{r.leverage}x</td>
                    <td className="lt-muted" style={{ maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis" }} title={r.webhook_url}>
                      {r.webhook_url}
                    </td>
                    <td>
                      <button
                        className={`lt-btn small ${r.enabled ? "cyan" : ""}`}
                        disabled={busy}
                        onClick={() => persist(rules.map((x) => (x.name === r.name ? { ...x, enabled: !x.enabled } : x)))}
                      >
                        {r.enabled ? "ON" : "OFF"}
                      </button>
                    </td>
                    <td className="num" style={{ position: "relative" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button className="lt-btn small cyan" disabled={busy || !r.enabled}
                                onClick={() => setTestMenu(testMenu === r.name ? null : r.name)}>TEST ▾</button>
                        <button className="lt-btn small" disabled={busy} onClick={() => openEdit(r)}>EDIT</button>
                        <button className="lt-btn small danger" disabled={busy}
                                onClick={() => persist(rules.filter((x) => x.name !== r.name))}>DEL</button>
                      </div>
                      {testMenu === r.name && (
                        <div style={{ position: "absolute", right: 8, top: "100%", zIndex: 20, background: "var(--lt-chrome)", border: "1px solid var(--lt-border)", minWidth: 180 }}>
                          <div className="lt-cmdk-kind">DRY-RUN (no POST)</div>
                          {ACTIONS.map((a) => (
                            <button key={`d${a}`} className="lt-cmdk-item" onClick={() => fire(r, a, true)}>
                              <span>{a}</span><span className="lt-dim">dry</span>
                            </button>
                          ))}
                          <div className="lt-cmdk-kind lt-red">REAL POST</div>
                          {ACTIONS.map((a) => (
                            <button key={`r${a}`} className="lt-cmdk-item" onClick={() => fire(r, a, false)}>
                              <span className="lt-red">{a}</span><span className="lt-dim">send</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {/* ---- FIRED HISTORY ---- */}
        {tab === "history" && (
          <>
            <div style={{ display: "flex", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--lt-row)", alignItems: "center" }}>
              <input className="lt-input" style={{ maxWidth: 220 }} placeholder="filter rule / symbol / action…"
                     value={histFilter} onChange={(e) => setHistFilter(e.target.value)} />
              <select className="lt-select" style={{ maxWidth: 110 }} value={histStatus} onChange={(e) => setHistStatus(e.target.value)}>
                <option value="all">all</option><option value="ok">ok</option><option value="fail">failed</option>
              </select>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button className="lt-btn small" onClick={refreshLogs}>REFRESH</button>
                <button
                  className="lt-btn small danger"
                  disabled={!history.length}
                  onClick={async () => {
                    if (!window.confirm("Delete ALL fired-alert history?")) return;
                    await deleteAlertsHistory(null).catch(() => {});
                    refreshLogs();
                  }}
                >
                  CLEAR ALL
                </button>
              </div>
            </div>
            {visibleHistory.length === 0 ? (
              <div className="lt-empty">No fired alerts yet — they appear here the moment a signal dispatches</div>
            ) : (
              <table className="lt-table">
                <thead>
                  <tr>
                    <th>TIME (UTC)</th><th>RULE</th><th>SYMBOL</th><th>ACTION</th><th className="num">PRICE</th>
                    <th>STATUS</th><th>DETAIL</th><th className="num" />
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map((h) => (
                    <tr key={h.id}>
                      <td className="lt-muted">{ts(h.ts)}</td>
                      <td style={{ fontWeight: 600 }}>{h.rule_name}{h.test ? <span className="lt-amber" style={{ fontSize: 8, marginLeft: 4 }}>TEST</span> : null}</td>
                      <td>{h.symbol}</td>
                      <td className={h.action === "BUY" || h.action === "EXIT_SHORT" ? "lt-green" : "lt-red"}>{h.action}</td>
                      <td className="num lt-muted">{h.price != null ? fmtNum(h.price) : "—"}</td>
                      <td>
                        <span className={h.dry_run ? "lt-amber" : h.ok ? "lt-green" : "lt-red"} style={{ fontWeight: 700 }}>
                          {h.dry_run ? "DRY-RUN" : h.ok ? `OK ${h.status_code || ""}` : "FAIL"}
                        </span>
                      </td>
                      <td className="lt-muted" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }} title={h.error || h.url}>
                        {h.error || h.url}
                      </td>
                      <td className="num">
                        <button className="lt-btn small danger" onClick={async () => { await deleteAlertsHistory([h.id]).catch(() => {}); refreshLogs(); }}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* ---- RECONCILIATION (fired alerts vs real broker positions) ---- */}
        {tab === "recon" && (
          !recon ? (
            <div className="lt-empty">Checking fired alerts against the broker's real positions (WAMP)…</div>
          ) : !recon.ok ? (
            <div className="lt-warn-banner" style={{ position: "static" }}>
              ⚠ WAMP unreachable — reconciliation unavailable. {recon.error || ""}
            </div>
          ) : (
            <>
              <div className="lt-mono" style={{ display: "flex", gap: 16, padding: "8px 10px", fontSize: 10, borderBottom: "1px solid var(--lt-row)" }}>
                <span>ACCOUNT <b className={account === "live" ? "lt-red" : "lt-cyan"}>{account.toUpperCase()}</b></span>
                <span className="lt-green">MATCHED {recon.counts?.matched ?? 0}</span>
                <span className={recon.counts?.flagged ? "lt-red" : "lt-muted"}>FLAGGED {recon.counts?.flagged ?? 0}</span>
                <span className={recon.counts?.orphans ? "lt-amber" : "lt-muted"}>POSITIONS W/O SIGNAL {recon.counts?.orphans ?? 0}</span>
                <button className="lt-btn small" style={{ marginLeft: "auto" }}
                        onClick={() => getLiveReconciliation(account).then(setRecon).catch(() => {})}>
                  REFRESH
                </button>
              </div>
              {(recon.alerts || []).length === 0 ? (
                <div className="lt-empty">No fired alerts to reconcile yet</div>
              ) : (
                <table className="lt-table">
                  <thead>
                    <tr><th>TIME (UTC)</th><th>RULE</th><th>SYMBOL</th><th>ACTION</th><th>WEBHOOK</th><th>BROKER RESULT</th></tr>
                  </thead>
                  <tbody>
                    {recon.alerts.map((a) => {
                      const label = {
                        matched: ["MATCHED — position confirmed", "lt-green"],
                        fired_no_position: ["⚠ FIRED BUT NO POSITION", "lt-red"],
                        webhook_failed: ["⚠ WEBHOOK FAILED — never reached broker", "lt-red"],
                        dry_run: ["dry-run (not sent)", "lt-dim"],
                        unknown_action: ["unknown action", "lt-muted"],
                        wamp_down: ["WAMP down", "lt-muted"],
                      }[a.recon] || [a.recon, "lt-muted"];
                      return (
                        <tr key={a.id} style={a.recon === "fired_no_position" ? { background: "rgba(255,77,109,0.06)" } : {}}>
                          <td className="lt-muted">{ts(a.ts)}</td>
                          <td style={{ fontWeight: 600 }}>{a.rule_name}</td>
                          <td>{a.symbol}</td>
                          <td className={a.action === "BUY" || a.action === "EXIT_SHORT" ? "lt-green" : "lt-red"}>{a.action}</td>
                          <td className={a.ok ? "lt-green" : "lt-red"}>{a.ok ? "sent" : "failed"}</td>
                          <td className={label[1]} style={{ fontWeight: 600 }}>{label[0]}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {(recon.positions_without_signal || []).length > 0 && (
                <>
                  <div className="lt-panel-title" style={{ padding: "8px 10px", borderTop: "1px solid var(--lt-border)" }}>
                    Open positions with no matching signal (opened outside QuantLab?)
                  </div>
                  <table className="lt-table">
                    <thead><tr><th>BROKER</th><th>SYMBOL</th><th>SIDE</th><th className="num">SIZE</th><th className="num">ENTRY</th><th className="num">uPNL</th></tr></thead>
                    <tbody>
                      {recon.positions_without_signal.map((p, i) => (
                        <tr key={i}>
                          <td className="lt-muted">{p.broker}</td>
                          <td style={{ fontWeight: 600 }}>{p.symbol}</td>
                          <td className={p.side === "LONG" ? "lt-green" : "lt-red"}>{p.side}</td>
                          <td className="num">{fmtNum(p.size)}</td>
                          <td className="num lt-muted">{fmtNum(p.entry)}</td>
                          <td className={`num ${p.upnl >= 0 ? "lt-green" : "lt-red"}`}>{fmtNum(p.upnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )
        )}

        {/* ---- ACTIVITY LOG ---- */}
        {tab === "activity" && (
          activity.length === 0 ? (
            <div className="lt-empty">Nothing logged yet — every arm/pause/kill/signal/webhook lands here</div>
          ) : (
            <table className="lt-table">
              <thead>
                <tr><th>TIME (UTC)</th><th>EVENT</th><th>RULE</th><th>SYMBOL</th><th>ACTION</th><th>DETAIL</th></tr>
              </thead>
              <tbody>
                {activity.map((a) => {
                  const color = {
                    signal: "lt-cyan", webhook_ok: "lt-green", webhook_fail: "lt-red",
                    webhook_blocked: "lt-amber", killswitch: "lt-red", killed: "lt-red",
                    armed: "lt-green", paused: "lt-muted", deployed: "lt-green", test_signal: "lt-amber",
                  }[a.kind] || "lt-muted";
                  return (
                    <tr key={a.id}>
                      <td className="lt-muted">{ts(a.ts)}</td>
                      <td className={color} style={{ fontWeight: 700 }}>{a.kind.toUpperCase()}</td>
                      <td>{a.rule_name || "—"}</td>
                      <td className="lt-muted">{a.symbol || "—"}</td>
                      <td className="lt-muted">{a.action || "—"}</td>
                      <td className="lt-muted" style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis" }} title={a.detail}>
                        {a.detail || ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
      </Panel>

      {/* ---- Add / Edit rule modal (same fields as the old page) ---- */}
      {modal && (
        <div className="lt-modal-overlay" onMouseDown={() => setModal(null)}>
          <div className="lt-modal" style={{ maxWidth: 700 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="lt-modal-head">
              <span className="lt-modal-title">{modal.editName ? `Edit rule · ${modal.editName}` : "Add alert"}</span>
              <button className="lt-btn small" onClick={() => setModal(null)}>ESC</button>
            </div>
            <div className="lt-modal-body">
              <RuleForm
                draft={modal.draft}
                onChange={(d) => setModal((m) => ({ ...m, draft: d }))}
                strategies={strategies}
                symbols={symbols}
                schema={schemaFor(modal.draft.strategy_id)}
                editing={modal.editName !== null}
                urlPresets={[...new Set(rules.map((r) => r.webhook_url).filter(Boolean))]}
                secretPresets={[...new Set(rules.map((r) => r.secret).filter(Boolean))]}
              />
            </div>
            <div className="lt-modal-foot">
              <label className="lt-mono lt-muted" style={{ fontSize: 10, display: "flex", gap: 6, alignItems: "center", marginRight: "auto" }}>
                <input type="checkbox" checked={modal.draft.enabled}
                       onChange={(e) => setModal((m) => ({ ...m, draft: { ...m.draft, enabled: e.target.checked } }))} />
                enabled on save
              </label>
              <button className="lt-btn" onClick={() => setModal(null)} disabled={busy}>CANCEL</button>
              <button className="lt-btn primary" onClick={saveModal} disabled={busy}>
                {busy ? "SAVING…" : modal.editName ? "SAVE CHANGES" : "ADD ALERT"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleForm({ draft, onChange, strategies, symbols, schema, editing, urlPresets, secretPresets }) {
  const upd = (patch) => onChange({ ...draft, ...patch });
  const [showParams, setShowParams] = useState(false);
  const customCount = schema.filter((spec) => {
    const v = (draft.params || {})[spec.name];
    return v !== undefined && v !== null && JSON.stringify(v) !== JSON.stringify(spec.default);
  }).length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" }}>
      <label style={{ gridColumn: "1 / -1" }}>
        <span className="lt-field-label">Alert name (unique)</span>
        <input className="lt-input" value={draft.name} disabled={editing}
               onChange={(e) => upd({ name: e.target.value })} placeholder="VWMA BTC → VPS1" />
      </label>

      <label>
        <span className="lt-field-label">Strategy</span>
        <select
          className="lt-select"
          value={draft.strategy_id}
          onChange={(e) => {
            const s = strategies.find((x) => x.id === e.target.value);
            upd({ strategy_id: e.target.value, strategy_alias: draft.strategy_alias || s?.name || "", params: {} });
          }}
        >
          <option value="">— select —</option>
          {strategies.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
        </select>
      </label>

      <label>
        <span className="lt-field-label">Symbol</span>
        <select className="lt-select" value={draft.symbol} onChange={(e) => upd({ symbol: e.target.value })}>
          <option value="">— select —</option>
          {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>

      <label>
        <span className="lt-field-label">Timeframe</span>
        <select className="lt-select" value={draft.timeframe} onChange={(e) => upd({ timeframe: e.target.value })}>
          {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
        </select>
      </label>

      <label>
        <span className="lt-field-label">Account (Demo = fake money)</span>
        <select className="lt-select" value={draft.account || "demo"}
                style={(draft.account || "demo") === "live" ? { borderColor: "var(--lt-red)", color: "var(--lt-red)" } : {}}
                onChange={(e) => upd({ account: e.target.value })}>
          <option value="demo">DEMO</option>
          <option value="live">LIVE (real funds)</option>
        </select>
      </label>

      <label>
        <span className="lt-field-label">Strategy alias (payload `strategy`)</span>
        <input className="lt-input" value={draft.strategy_alias}
               onChange={(e) => upd({ strategy_alias: e.target.value })} placeholder="VWMA-Reversion" />
      </label>

      <label>
        <span className="lt-field-label">Leverage</span>
        <input className="lt-input" type="number" min={1} max={125} value={draft.leverage}
               onChange={(e) => upd({ leverage: e.target.value })} />
      </label>

      <label style={{ gridColumn: "1 / -1" }}>
        <span className="lt-field-label">Webhook URL</span>
        {urlPresets.length > 0 && (
          <select className="lt-select" style={{ marginBottom: 4 }} value=""
                  onChange={(e) => { if (e.target.value) upd({ webhook_url: e.target.value }); }}>
            <option value="">— pick existing target —</option>
            {urlPresets.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
        <input className="lt-input" value={draft.webhook_url}
               onChange={(e) => upd({ webhook_url: e.target.value })}
               placeholder="https://api.yourdomain.com/binance_webhook" />
      </label>

      <label style={{ gridColumn: "1 / -1" }}>
        <span className="lt-field-label">Secret (shared token your acceptor validates)</span>
        {secretPresets.length > 0 && (
          <select className="lt-select" style={{ marginBottom: 4 }} value=""
                  onChange={(e) => { if (e.target.value) upd({ secret: e.target.value }); }}>
            <option value="">— pick existing —</option>
            {secretPresets.map((s) => <option key={s} value={s}>{s.slice(0, 3)}…{s.slice(-2)}</option>)}
          </select>
        )}
        <input className="lt-input" value={draft.secret} onChange={(e) => upd({ secret: e.target.value })} />
      </label>

      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span className="lt-field-label" style={{ margin: 0 }}>JSON payload template</span>
          <button
            type="button" className="lt-btn small"
            onClick={() => upd({ payload_template: draft.payload_template ? "" : DEFAULT_PAYLOAD_TEMPLATE })}
          >
            {draft.payload_template ? "RESET TO DEFAULT" : "CUSTOMIZE"}
          </button>
          <span className="lt-dim lt-mono" style={{ fontSize: 8.5 }}>
            tokens: {"{{action}} {{symbol}} {{secret}} {{strategy}} {{leverage}}"}
          </span>
        </div>
        {draft.payload_template ? (
          <textarea className="lt-textarea lt-mono" rows={7} spellCheck={false}
                    value={draft.payload_template}
                    onChange={(e) => upd({ payload_template: e.target.value })} />
        ) : (
          <pre className="lt-mono lt-dim" style={{ fontSize: 9.5, background: "var(--lt-bg)", border: "1px solid var(--lt-border)", padding: 8, margin: 0 }}>
            {DEFAULT_PAYLOAD_TEMPLATE}
          </pre>
        )}
      </div>

      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" className="lt-btn small cyan" disabled={!draft.strategy_id}
                  onClick={() => setShowParams((v) => !v)}>
            {showParams ? "HIDE PARAMS" : "CONFIGURE PARAMS"}
          </button>
          <span className="lt-mono lt-muted" style={{ fontSize: 9 }}>
            {customCount > 0 ? `${customCount} customized` : "using defaults"}
          </span>
          {customCount > 0 && (
            <button type="button" className="lt-btn small" onClick={() => upd({ params: {} })}>RESET</button>
          )}
        </div>
        {showParams && draft.strategy_id && (
          <div style={{ marginTop: 8, borderTop: "1px solid var(--lt-border)", paddingTop: 8 }}>
            <ParamForm schema={schema} params={draft.params || {}} onChange={(p) => upd({ params: p })} />
          </div>
        )}
      </div>
    </div>
  );
}
