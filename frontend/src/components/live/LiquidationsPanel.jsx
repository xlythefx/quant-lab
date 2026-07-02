import { useEffect, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import * as sim from "./simFeed.js";
import { fmtNum } from "../../services/format.js";

/**
 * Liquidations — streaming feed + long/short pressure bar. SIMULATED
 * (QuantLab has no liquidation feed yet); kept as a real component with a
 * clean seam so a real @forceOrder stream is a drop-in later.
 */
export default function LiquidationsPanel({ symbol, lastPrice }) {
  const [liqs, setLiqs] = useState([]);
  const priceRef = useRef(lastPrice);
  priceRef.current = lastPrice;

  useEffect(() => {
    setLiqs([]);
    const t = setInterval(() => {
      setLiqs((prev) => [sim.mockLiquidation(symbol, priceRef.current), ...prev].slice(0, 14));
    }, 3800);
    return () => clearInterval(t);
  }, [symbol]);

  const longUsd = liqs.filter((l) => l.side === "LONG").reduce((s, l) => s + l.usd, 0);
  const shortUsd = liqs.filter((l) => l.side === "SHORT").reduce((s, l) => s + l.usd, 0);
  const total = Math.max(1, longUsd + shortUsd);

  return (
    <Panel
      title="Liquidations"
      simulated
      foot={
        <div>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 3 }}>LIQUIDATION PRESSURE</div>
          <div style={{ display: "flex", height: 5, background: "var(--lt-grid)" }}>
            <div style={{ width: `${(longUsd / total) * 100}%`, background: "var(--lt-red)" }} />
            <div style={{ width: `${(shortUsd / total) * 100}%`, background: "var(--lt-green)" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 9 }}>
            <span className="lt-red">LONG ${fmtNum(longUsd / 1000)}K</span>
            <span className="lt-green">${fmtNum(shortUsd / 1000)}K SHORT</span>
          </div>
        </div>
      }
    >
      {liqs.length === 0 && <div className="lt-empty">Waiting for liquidations…</div>}
      {liqs.map((l, i) => {
        const d = new Date(l.t);
        const hh = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
        return (
          <div key={l.t + "" + i} className={`lt-mono ${i === 0 ? "lt-slide-in" : ""}`}
               style={{ display: "flex", gap: 8, padding: "2px 10px", fontSize: 10, alignItems: "baseline" }}>
            <span className="lt-dim">{hh}</span>
            <span className={l.side === "LONG" ? "lt-red" : "lt-green"} style={{ fontWeight: 700, fontSize: 9 }}>
              [{l.side}]
            </span>
            <span style={{ fontWeight: 600 }}>${fmtNum(l.usd / 1000)}K</span>
            <span className="lt-muted" style={{ marginLeft: "auto" }}>{fmtNum(l.price)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
