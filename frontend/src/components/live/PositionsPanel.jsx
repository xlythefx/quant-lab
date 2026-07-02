import Panel from "./Panel.jsx";
import { usePositionsRisk } from "./hooks.js";
import { fmtNum, fmtUsd, fmtPct } from "../../services/format.js";

/**
 * Positions & PnL — REAL broker positions (read-only from the sinegu-api
 * WAMP tables, phase 09). Falls back to a labeled SIMULATED placeholder when
 * WAMP is unreachable, so the terminal never hard-breaks.
 */
export default function PositionsPanel({ account = "demo" }) {
  const { positions, simulated, loading } = usePositionsRisk(account);
  const total = positions.reduce((s, p) => s + (p.upnl || 0), 0);

  return (
    <Panel
      title={`Positions & PnL · ${String(account).toUpperCase()}`}
      simulated={simulated && !loading}
      live={!simulated}
      foot={
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em" }}>TOTAL UNREALIZED</span>
          <span className={total >= 0 ? "lt-green" : "lt-red"} style={{ fontWeight: 700 }}>
            {total >= 0 ? "+" : ""}{fmtUsd(total)}
          </span>
        </div>
      }
    >
      {loading ? (
        <div className="lt-empty">Loading…</div>
      ) : positions.length === 0 ? (
        <div className="lt-empty">No open positions</div>
      ) : (
        <table className="lt-table">
          <thead>
            <tr><th>SYMBOL</th><th>SIDE</th><th className="num">SIZE</th><th className="num">ENTRY</th><th className="num">MARK</th><th className="num">uPNL</th></tr>
          </thead>
          <tbody>
            {positions.map((p, i) => {
              const long = p.side === "LONG" || p.side === "BUY";
              const pct = p.entry ? ((p.mark - p.entry) / p.entry) * 100 * (long ? 1 : -1) : null;
              return (
                <tr key={`${p.symbol}${i}`}>
                  <td style={{ fontWeight: 600 }}>{p.symbol}<span className="lt-dim" style={{ fontSize: 8, marginLeft: 4 }}>{p.broker}</span></td>
                  <td className={long ? "lt-green" : "lt-red"} style={{ fontWeight: 700 }}>{p.side}</td>
                  <td className="num">{fmtNum(p.size)}</td>
                  <td className="num lt-muted">{fmtNum(p.entry)}</td>
                  <td className="num">{fmtNum(p.mark)}</td>
                  <td className={`num ${p.upnl >= 0 ? "lt-green" : "lt-red"}`}>
                    <div>{p.upnl >= 0 ? "+" : ""}{fmtUsd(p.upnl)}</div>
                    {pct != null && <div style={{ fontSize: 8.5, opacity: 0.75 }}>{fmtPct(pct)}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
