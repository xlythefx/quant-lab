import Panel from "./Panel.jsx";
import { useTape } from "./hooks.js";
import { fmtNum } from "../../services/format.js";

/** Time & Sales — streaming prints, newest on top. SIMULATED (labeled). */
export default function TapePanel({ symbol, lastPrice }) {
  const { prints, simulated } = useTape(symbol, lastPrice);

  return (
    <Panel title="Time & Sales" simulated={simulated}>
      <div
        className="lt-mono lt-muted"
        style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 1fr", gap: 4, padding: "4px 10px", fontSize: 8.5, letterSpacing: "0.08em", borderBottom: "1px solid var(--lt-row)" }}
      >
        <span>TIME</span><span style={{ textAlign: "right" }}>PRICE</span><span style={{ textAlign: "right" }}>SIZE</span>
      </div>
      {prints.length === 0 && <div className="lt-empty">Waiting for prints…</div>}
      {prints.map((p, i) => {
        const big = p.size > 2.2;
        const color = p.side === "BUY" ? "var(--lt-green)" : "var(--lt-red)";
        const tint = big ? (p.side === "BUY" ? "rgba(0,212,161,0.08)" : "rgba(255,77,109,0.08)") : "transparent";
        const d = new Date(p.t);
        const hh = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
        return (
          <div
            key={`${p.t}-${i}`}
            className={`lt-mono ${i === 0 ? "lt-slide-in" : ""}`}
            style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 1fr", gap: 4, padding: "1.5px 10px", fontSize: 10, background: tint }}
          >
            <span className="lt-muted">{hh}</span>
            <span style={{ color, textAlign: "right" }}>{fmtNum(p.price)}</span>
            <span style={{ textAlign: "right", fontWeight: big ? 700 : 400 }}>{p.size.toFixed(3)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
