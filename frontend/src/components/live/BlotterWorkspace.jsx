import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import { useEnterStagger } from "./animations.js";
import { getLiveJournal } from "./liveApi.js";
import { onLiveSignal } from "./liveChannels.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtRatio } from "../../services/format.js";

function ts(t) {
  if (!t) return "—";
  const d = new Date(t * 1000);
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${mo} ${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function holdLabel(min) {
  if (min == null) return "—";
  if (min < 90) return `${Math.round(min)}m`;
  if (min < 60 * 36) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

/**
 * BLOTTER workspace — ORDER ENTRY (built in 08; webhook-only by design) |
 * TRADE LOG / JOURNAL (live realized round-trips from SQLite).
 */
export default function BlotterWorkspace({ orderEntry = null }) {
  const ref = useRef(null);
  useEnterStagger("blotter", ref);
  const [tab, setTab] = useState("log");
  const [rows, setRows] = useState([]);
  const [fStrat, setFStrat] = useState("");
  const [fSymbol, setFSymbol] = useState("");
  const [fAccount, setFAccount] = useState("");

  const refresh = useCallback(() => {
    getLiveJournal({}).then(setRows).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const off = onLiveSignal(refresh);
    return () => off();
  }, [refresh]);

  const strategies = useMemo(() => [...new Set(rows.map((r) => r.strategy || r.strategy_id))], [rows]);
  const symbols = useMemo(() => [...new Set(rows.map((r) => r.symbol))], [rows]);

  const visible = rows.filter((r) =>
    (!fStrat || (r.strategy || r.strategy_id) === fStrat) &&
    (!fSymbol || r.symbol === fSymbol) &&
    (!fAccount || (r.account || "demo") === fAccount));

  const net = visible.reduce((s, r) => s + (r.pnl_usd || 0), 0);
  const wins = visible.filter((r) => (r.pnl_usd || 0) > 0).length;
  const gp = visible.reduce((s, r) => s + Math.max(0, r.pnl_usd || 0), 0);
  const gl = -visible.reduce((s, r) => s + Math.min(0, r.pnl_usd || 0), 0);
  const pf = gl > 0 ? gp / gl : null;

  return (
    <div ref={ref} className="lt-ws grid" style={{ gridTemplateRows: "1fr" }}>
      <Panel
        title="Blotter"
        right={
          <div style={{ display: "flex", gap: 2 }}>
            {[["entry", "ORDER ENTRY"], ["log", "TRADE LOG / JOURNAL"]].map(([id, label]) => (
              <button key={id} className="lt-mono" onClick={() => setTab(id)}
                style={{ background: "none", border: "none", cursor: "pointer", borderBottom: `2px solid ${tab === id ? "var(--lt-amber)" : "transparent"}`, color: tab === id ? "#fff" : "var(--lt-muted)", fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", padding: "2px 6px" }}>
                {label}
              </button>
            ))}
          </div>
        }
      >
        {tab === "entry" ? (
          orderEntry || <div className="lt-empty">Order entry ticket — built in phase 08 (webhook-only by design; QuantLab has no in-app OMS)</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--lt-row)", alignItems: "center", flexWrap: "wrap" }}>
              <select className="lt-select" style={{ maxWidth: 170 }} value={fStrat} onChange={(e) => setFStrat(e.target.value)}>
                <option value="">all strategies</option>
                {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="lt-select" style={{ maxWidth: 130 }} value={fSymbol} onChange={(e) => setFSymbol(e.target.value)}>
                <option value="">all assets</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="lt-select" style={{ maxWidth: 110 }} value={fAccount} onChange={(e) => setFAccount(e.target.value)}>
                <option value="">all accounts</option>
                <option value="demo">DEMO</option>
                <option value="live">LIVE</option>
              </select>

              {/* summary strip */}
              <div className="lt-mono" style={{ marginLeft: "auto", display: "flex", gap: 16, fontSize: 10 }}>
                <span>NET <b className={net >= 0 ? "lt-green" : "lt-red"}>{net >= 0 ? "+" : ""}{fmtUsd(net)}</b></span>
                <span>WIN% <b>{visible.length ? fmtPct((wins / visible.length) * 100, false) : "—"}</b></span>
                <span>PF <b>{pf == null ? (gp > 0 ? "∞" : "—") : fmtRatio(pf)}</b></span>
                <span>EXP <b className={net >= 0 ? "lt-green" : "lt-red"}>{visible.length ? fmtUsd(net / visible.length) : "—"}</b></span>
                <span>N <b>{fmtInt(visible.length)}</b></span>
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="lt-empty">No realized live trades yet — the journal fills as deployments close round-trips</div>
            ) : (
              <table className="lt-table">
                <thead>
                  <tr>
                    <th>TIME (UTC)</th><th>STRATEGY</th><th>ASSET</th><th>SIDE</th><th>ACCT</th><th>VENUE</th>
                    <th className="num">ENTRY</th><th className="num">EXIT</th><th className="num">%</th>
                    <th className="num">P&L (EST)</th><th className="num">HOLD</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id}>
                      <td className="lt-muted">{ts(r.ts)}</td>
                      <td style={{ fontWeight: 600 }}>{r.strategy || r.strategy_id}</td>
                      <td>{r.symbol} · {r.timeframe}</td>
                      <td className={r.side === "LONG" ? "lt-green" : "lt-red"}>{r.side}</td>
                      <td><span className={(r.account || "demo") === "live" ? "lt-red" : "lt-cyan"} style={{ fontSize: 9, fontWeight: 700 }}>{(r.account || "demo").toUpperCase()}</span></td>
                      <td className="lt-muted">{r.venue}</td>
                      <td className="num">{fmtNum(r.entry)}</td>
                      <td className="num">{fmtNum(r.exit)}</td>
                      <td className={`num ${r.pnl_pct >= 0 ? "lt-green" : "lt-red"}`}>{fmtPct(r.pnl_pct)}</td>
                      <td className={`num ${r.pnl_usd >= 0 ? "lt-green" : "lt-red"}`}>{r.pnl_usd >= 0 ? "+" : ""}{fmtUsd(r.pnl_usd)}</td>
                      <td className="num lt-muted">{holdLabel(r.hold_min)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
