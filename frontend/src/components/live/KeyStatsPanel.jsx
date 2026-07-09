import { useEffect, useState } from "react";
import Panel from "./Panel.jsx";
import * as sim from "./simFeed.js";
import { fmtNum, fmtPct, fmtDateLong } from "../../services/format.js";

/**
 * Key Stats — equity fundamentals (market cap, P/E, 52-week range, earnings).
 * SIMULATED: QuantLab has no fundamentals feed. Rendered for `stock`-class
 * instruments via adaptPanels; wired for a real data source later.
 */
export default function KeyStatsPanel({ symbol }) {
  const [s, setS] = useState(null);
  useEffect(() => { setS(sim.mockKeyStats(symbol)); }, [symbol]);

  if (!s) {
    return <Panel title="Key Stats" simulated><div className="lt-empty">Loading…</div></Panel>;
  }

  const rangePct = Math.max(0, Math.min(100,
    ((s.price - s.low52) / Math.max(1e-9, s.high52 - s.low52)) * 100));

  const Row = ({ k, v, cls }) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, padding: "2px 0" }}>
      <span className="lt-muted" style={{ letterSpacing: "0.05em" }}>{k}</span>
      <span className={`lt-mono ${cls || ""}`} style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );

  return (
    <Panel title="Key Stats" simulated>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2, height: "100%" }}>
        <Row k="MARKET CAP" v={`$${fmtNum(s.marketCapB)}B`} />
        <Row k="P / E" v={fmtNum(s.peRatio)} />
        <Row k="EPS (TTM)" v={`$${fmtNum(s.eps)}`} />
        <Row k="DIV YIELD" v={fmtPct(s.divYieldPct, false)} />
        <Row k="BETA" v={fmtNum(s.beta)} />
        <Row k="AVG VOL" v={`${fmtNum(s.avgVolM)}M`} />

        <div style={{ marginTop: 8 }}>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 4 }}>52-WEEK RANGE</div>
          <div style={{ position: "relative", height: 5, background: "var(--lt-grid)" }}>
            <div style={{ position: "absolute", left: `${rangePct}%`, top: -2, width: 2, height: 9, background: "var(--lt-cyan)" }} />
          </div>
          <div className="lt-mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 2 }}>
            <span className="lt-dim">{fmtNum(s.low52)}</span>
            <span className="lt-dim">{fmtNum(s.high52)}</span>
          </div>
        </div>

        <div style={{ marginTop: "auto" }}>
          <Row k="NEXT EARNINGS" v={fmtDateLong(s.nextEarningsSec)} cls="lt-amber" />
        </div>
      </div>
    </Panel>
  );
}
