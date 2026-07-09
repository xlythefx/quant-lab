import { useEffect, useState } from "react";
import Panel from "./Panel.jsx";
import * as sim from "./simFeed.js";
import { fmtNum, fmtPct } from "../../services/format.js";

/**
 * Carry — interest-rate differential + swap points for an FX pair. SIMULATED:
 * QuantLab has no rates feed. Rendered for `fx`-class instruments via
 * adaptPanels; wired for a real rates source later.
 */
export default function CarryPanel({ symbol }) {
  const [c, setC] = useState(null);
  useEffect(() => { setC(sim.mockCarry(symbol)); }, [symbol]);

  if (!c) {
    return <Panel title="Carry" simulated><div className="lt-empty">Loading…</div></Panel>;
  }

  const longIsPositive = c.swapLong >= 0;

  const Row = ({ k, v, cls }) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "2px 0" }}>
      <span className="lt-muted" style={{ letterSpacing: "0.05em" }}>{k}</span>
      <span className={`lt-mono ${cls || ""}`} style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );

  return (
    <Panel title="Carry" simulated>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3, height: "100%" }}>
        <Row k={`${c.baseCcy} RATE`} v={fmtPct(c.baseRate, false)} />
        <Row k={`${c.quoteCcy} RATE`} v={fmtPct(c.quoteRate, false)} />

        <div style={{ margin: "6px 0" }}>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em" }}>RATE DIFFERENTIAL</div>
          <div className={`lt-mono ${c.differential >= 0 ? "lt-green" : "lt-red"}`} style={{ fontSize: 20, fontWeight: 700 }}>
            {fmtPct(c.differential)}
          </div>
          <div className="lt-dim" style={{ fontSize: 8 }}>
            {c.differential >= 0 ? `long ${c.baseCcy} earns carry` : `short ${c.baseCcy} earns carry`}
          </div>
        </div>

        <div style={{ marginTop: "auto" }}>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 3 }}>SWAP POINTS / DAY</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
            <span><span className="lt-muted">LONG </span><span className={`lt-mono ${longIsPositive ? "lt-green" : "lt-red"}`} style={{ fontWeight: 600 }}>{fmtNum(c.swapLong)}</span></span>
            <span><span className="lt-muted">SHORT </span><span className={`lt-mono ${c.swapShort >= 0 ? "lt-green" : "lt-red"}`} style={{ fontWeight: 600 }}>{fmtNum(c.swapShort)}</span></span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
