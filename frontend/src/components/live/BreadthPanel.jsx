import { useEffect, useState } from "react";
import Panel from "./Panel.jsx";
import * as sim from "./simFeed.js";
import { fmtInt, fmtNum, fmtPct } from "../../services/format.js";

/**
 * Market Breadth — advancers/decliners, % above moving averages, new highs/lows,
 * TRIN. SIMULATED: QuantLab has no breadth feed. Rendered for `index`-class
 * instruments via adaptPanels; wired for a real constituents source later.
 */
export default function BreadthPanel({ symbol }) {
  const [b, setB] = useState(null);
  useEffect(() => { setB(sim.mockBreadth(symbol)); }, [symbol]);

  if (!b) {
    return <Panel title="Breadth" simulated><div className="lt-empty">Loading…</div></Panel>;
  }

  const totalAD = Math.max(1, b.advancers + b.decliners);
  const advPct = (b.advancers / totalAD) * 100;

  const MA = ({ label, pct }) => (
    <div>
      <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", height: 5, background: "var(--lt-grid)" }}>
        <div style={{ width: `${pct}%`, background: "var(--lt-green)" }} />
        <div style={{ width: `${100 - pct}%`, background: "var(--lt-red)" }} />
      </div>
      <div className="lt-mono lt-green" style={{ fontSize: 9, marginTop: 2 }}>{fmtPct(pct, false)}</div>
    </div>
  );

  return (
    <Panel title="Breadth" simulated>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
        <div>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 3 }}>ADVANCERS / DECLINERS</div>
          <div style={{ display: "flex", height: 6, background: "var(--lt-grid)" }}>
            <div style={{ width: `${advPct}%`, background: "var(--lt-green)" }} />
            <div style={{ width: `${100 - advPct}%`, background: "var(--lt-red)" }} />
          </div>
          <div className="lt-mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginTop: 2 }}>
            <span className="lt-green">{fmtInt(b.advancers)} ADV</span>
            <span className="lt-dim">{fmtInt(b.unchanged)} unch</span>
            <span className="lt-red">{fmtInt(b.decliners)} DEC</span>
          </div>
        </div>

        <MA label="% ABOVE 50-DAY MA" pct={b.pctAbove50} />
        <MA label="% ABOVE 200-DAY MA" pct={b.pctAbove200} />

        <div style={{ marginTop: "auto", display: "flex", justifyContent: "space-between", fontSize: 10 }}>
          <span><span className="lt-muted">NEW HI </span><span className="lt-mono lt-green" style={{ fontWeight: 600 }}>{fmtInt(b.newHighs)}</span></span>
          <span><span className="lt-muted">NEW LO </span><span className="lt-mono lt-red" style={{ fontWeight: 600 }}>{fmtInt(b.newLows)}</span></span>
          <span><span className="lt-muted">TRIN </span><span className="lt-mono" style={{ fontWeight: 600 }}>{fmtNum(b.trin)}</span></span>
        </div>
      </div>
    </Panel>
  );
}
