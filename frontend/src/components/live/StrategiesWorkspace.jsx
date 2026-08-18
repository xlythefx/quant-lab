import { useEffect, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import DeployModal from "./DeployModal.jsx";
import { useEnterStagger } from "./animations.js";
import { useInstruments } from "./hooks.js";
import { patchDeployment, deleteDeployment, testDeploymentSignal } from "./liveApi.js";
import { getStrategies } from "../../services/api.js";
import { fmtUsd, fmtInt } from "../../services/format.js";

const ACCENTS = ["var(--lt-cyan)", "var(--lt-green)", "var(--lt-amber)", "var(--lt-red)", "var(--lt-purple)"];
const ACTIONS = ["BUY", "EXIT_LONG", "SELL", "EXIT_SHORT"];

function fmtClock(epochSec) {
  if (!epochSec) return "—";
  const d = new Date(epochSec * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * STRATEGIES workspace: roster of real QuantLab strategies (registry) +
 * Deployments over the live alerter, with deploy / pause / resume / kill,
 * per-deployment "why did/didn't it fire", test signals (dry-run default),
 * and webhook delivery status.
 */
export default function StrategiesWorkspace({ deployments, killswitch, refresh, prefill, onPrefillConsumed }) {
  const ref = useRef(null);
  useEnterStagger("strategies", ref);
  const { instruments } = useInstruments();
  const [strategies, setStrategies] = useState([]);
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployPrefill, setDeployPrefill] = useState(null);
  const [editDeployment, setEditDeployment] = useState(null);
  const [testMenu, setTestMenu] = useState(null); // deployment name
  const [confirmKill, setConfirmKill] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    getStrategies().then((s) => setStrategies(s || [])).catch(() => setStrategies([]));
  }, []);

  // Backtest → live handoff: open the deploy modal pre-filled.
  useEffect(() => {
    if (prefill) {
      setDeployPrefill(prefill);
      setDeployOpen(true);
      onPrefillConsumed?.();
    }
  }, [prefill, onPrefillConsumed]);

  const flash = (msg, bad = false) => {
    setToast({ msg, bad });
    setTimeout(() => setToast(null), 3500);
  };

  const setStatus = async (d, status) => {
    setBusy(true);
    try {
      await patchDeployment(d.name, { status });
      refresh();
      flash(`${d.name} → ${status}`);
    } catch (e) {
      flash(e?.response?.data?.error || e.message, true);
    } finally { setBusy(false); }
  };

  const kill = async (d) => {
    setBusy(true);
    try {
      await deleteDeployment(d.name);
      refresh();
      flash(`${d.name} killed`);
    } catch (e) {
      flash(e?.response?.data?.error || e.message, true);
    } finally { setBusy(false); setConfirmKill(null); }
  };

  const fireTest = async (d, action, dryRun) => {
    setTestMenu(null);
    try {
      const res = await testDeploymentSignal(d.name, { action, dry_run: dryRun });
      if (res?.ok) flash(`${dryRun ? "dry-run" : "REAL"} ${action} test fired for ${d.name}`);
      else flash(res?.error || "test failed", true);
      refresh();
    } catch (e) {
      flash(e?.response?.data?.error || e.message, true);
    }
  };

  return (
    <div ref={ref} className="lt-ws grid" style={{ gridTemplateRows: "minmax(0, 5fr) minmax(0, 5fr)" }}>
      {/* Roster */}
      <Panel
        title={`Strategy Roster · QuantLab Registry · ${strategies.filter((s) => !s.archived).length}`}
        right={<button className="lt-btn primary small" onClick={() => { setDeployPrefill(null); setEditDeployment(null); setDeployOpen(true); }}>+ DEPLOY</button>}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 1, background: "var(--lt-border)" }}>
          {strategies.filter((s) => !s.archived).map((s, i) => {
            const accent = ACCENTS[i % ACCENTS.length];
            const running = deployments.filter((d) => d.strategy_id === s.id && d.status === "RUNNING").length;
            return (
              <div key={s.id} style={{ background: "var(--lt-panel)", padding: "11px 13px", borderTop: `2px solid ${accent}` }}>
                <div className="lt-mono" style={{ fontSize: 11.5, fontWeight: 700, color: accent }}>{s.name}</div>
                <div className="lt-mono lt-dim" style={{ fontSize: 9 }}>{s.id} · {s.kind}</div>
                <div className="lt-muted" style={{ fontSize: 9.5, margin: "6px 0 8px", minHeight: 24, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {s.description}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span className="lt-mono lt-muted" style={{ fontSize: 9 }}>
                    {s.schema?.length || 0} params{running > 0 ? ` · ${running} running` : ""}
                  </span>
                  <button
                    className="lt-btn small"
                    style={{ borderColor: accent, color: accent }}
                    onClick={() => { setEditDeployment(null); setDeployPrefill({ strategy_id: s.id }); setDeployOpen(true); }}
                  >
                    DEPLOY
                  </button>
                </div>
              </div>
            );
          })}
          {strategies.length === 0 && <div className="lt-empty" style={{ background: "var(--lt-panel)" }}>Loading registry…</div>}
        </div>
      </Panel>

      {/* Deployments */}
      <Panel
        title={`Deployments · ${deployments.filter((d) => d.status === "RUNNING").length} running / ${deployments.length}`}
        right={killswitch && <span className="lt-mono lt-red" style={{ fontSize: 9, fontWeight: 700 }}>⚠ DISARMED — ALL WEBHOOKS BLOCKED</span>}
      >
        {toast && (
          <div className={`lt-mono ${toast.bad ? "lt-red" : "lt-green"}`} style={{ padding: "4px 10px", fontSize: 10, borderBottom: "1px solid var(--lt-row)" }}>
            {toast.msg}
          </div>
        )}
        {deployments.length === 0 ? (
          <div className="lt-empty">No deployments — deploy a strategy from the roster above</div>
        ) : (
          <table className="lt-table">
            <thead>
              <tr>
                <th>NAME</th><th>STRATEGY</th><th>INSTRUMENT</th><th>ACCT</th><th>STATUS</th>
                <th className="num">P&L (EST)</th><th className="num">N</th><th>LAST EVAL</th><th>WEBHOOK</th><th className="num">ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => {
                const running = d.status === "RUNNING";
                const ev = d.last_eval;
                const disp = d.last_dispatch;
                const evalTxt = ev
                  ? (ev.fired?.length ? `${fmtClock(ev.bar_time)} → fired ${ev.fired.join("+")}` : `${fmtClock(ev.bar_time)} → no signal`)
                  : "no bars seen yet";
                return (
                  <tr key={d.name}>
                    <td style={{ fontWeight: 700 }}>
                      {d.name}
                      {d.open_position && (
                        <span className={d.open_position.side === "long" ? "lt-green" : "lt-red"} style={{ marginLeft: 6, fontSize: 8.5 }}>
                          ● {d.open_position.side.toUpperCase()} @{Number(d.open_position.entry).toFixed(2)}
                        </span>
                      )}
                    </td>
                    <td className="lt-muted">{d.strategy_alias}</td>
                    <td>{d.symbol} · {d.timeframe}</td>
                    <td>
                      <span className={d.account === "live" ? "lt-red" : "lt-cyan"} style={{ fontWeight: 700, fontSize: 9 }}>
                        {(d.account || "demo").toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <span className={running ? "lt-green" : "lt-muted"} style={{ fontWeight: 700 }}>
                        {killswitch && running ? "BLOCKED" : d.status}
                      </span>
                    </td>
                    <td className={`num ${d.pnl >= 0 ? "lt-green" : "lt-red"}`}>{d.pnl >= 0 ? "+" : ""}{fmtUsd(d.pnl)}</td>
                    <td className="num lt-muted">{fmtInt(d.n)}</td>
                    <td className="lt-muted" title="Last closed bar this deployment evaluated — quiet periods are explainable">{evalTxt}</td>
                    <td>
                      {disp ? (
                        <span className={disp.blocked ? "lt-amber" : disp.ok ? "lt-green" : "lt-red"} title={disp.error || "delivered"}>
                          ● {disp.blocked ? "blocked" : disp.ok ? (disp.dry_run ? "dry-run ok" : "delivered") : "FAILED"}
                        </span>
                      ) : (
                        <span className="lt-dim" title={d.webhook_hint}>— none yet</span>
                      )}
                    </td>
                    <td className="num" style={{ position: "relative" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button className="lt-btn small" disabled={busy} onClick={() => setStatus(d, running ? "PAUSED" : "RUNNING")}>
                          {running ? "PAUSE" : "RESUME"}
                        </button>
                        <button className="lt-btn small" disabled={busy} onClick={() => { setDeployPrefill(null); setEditDeployment(d); setDeployOpen(true); }}>
                          EDIT
                        </button>
                        <button className="lt-btn small cyan" disabled={busy} onClick={() => setTestMenu(testMenu === d.name ? null : d.name)}>
                          TEST ▾
                        </button>
                        <button className="lt-btn small danger" disabled={busy} onClick={() => setConfirmKill(d)}>KILL</button>
                      </div>
                      {testMenu === d.name && (
                        <div style={{ position: "absolute", right: 8, top: "100%", zIndex: 20, background: "var(--lt-chrome)", border: "1px solid var(--lt-border)", minWidth: 190 }}>
                          <div className="lt-cmdk-kind">DRY-RUN (no POST)</div>
                          {ACTIONS.map((a) => (
                            <button key={`d${a}`} className="lt-cmdk-item" onClick={() => fireTest(d, a, true)}>
                              <span>{a}</span><span className="lt-dim">dry</span>
                            </button>
                          ))}
                          <div className="lt-cmdk-kind lt-red">REAL POST → {d.webhook_hint || "webhook"}</div>
                          {ACTIONS.map((a) => (
                            <button key={`r${a}`} className="lt-cmdk-item" onClick={() => fireTest(d, a, false)}>
                              <span className="lt-red">{a}</span><span className="lt-dim">send</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <DeployModal
        open={deployOpen}
        onClose={() => { setDeployOpen(false); setEditDeployment(null); }}
        onDeployed={refresh}
        strategies={strategies}
        instruments={instruments}
        prefill={deployPrefill}
        editing={editDeployment}
      />

      {confirmKill && (
        <div className="lt-modal-overlay" onMouseDown={() => setConfirmKill(null)}>
          <div className="lt-modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="lt-modal-head"><span className="lt-modal-title lt-red">Kill deployment</span></div>
            <div className="lt-modal-body lt-mono" style={{ fontSize: 11 }}>
              Delete <b>{confirmKill.name}</b> ({confirmKill.symbol} · {confirmKill.timeframe})?
              The rule is removed and its runner stops. Journal history is kept.
            </div>
            <div className="lt-modal-foot">
              <button className="lt-btn" onClick={() => setConfirmKill(null)}>CANCEL</button>
              <button className="lt-btn sell" onClick={() => kill(confirmKill)} disabled={busy}>KILL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
