import { useEffect, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import * as sim from "./simFeed.js";
import { fmtNum } from "../../services/format.js";

/**
 * Funding & Open Interest — funding rate + countdown, OI area mini-chart,
 * long/short ratio bar. SIMULATED (spot Binance has no funding; wired for a
 * real fapi feed later via the same seam).
 */
export default function FundingPanel({ symbol }) {
  const [funding, setFunding] = useState(null);
  const [oi, setOi] = useState([]);
  const [countdown, setCountdown] = useState("--:--:--");
  const canvasRef = useRef(null);

  useEffect(() => {
    setFunding(sim.mockFunding(symbol));
    setOi(sim.mockOiSeries(symbol));
    const t = setInterval(() => {
      setOi((prev) => {
        const next = [...prev.slice(1), Math.max(4, prev[prev.length - 1] + (Math.random() - 0.5) * 0.3)];
        return next;
      });
    }, 5000);
    return () => clearInterval(t);
  }, [symbol]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!funding?.nextFundingTs) return;
      let ms = Math.max(0, funding.nextFundingTs - Date.now());
      const h = Math.floor(ms / 3600000); ms -= h * 3600000;
      const m = Math.floor(ms / 60000); ms -= m * 60000;
      const s = Math.floor(ms / 1000);
      setCountdown(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(t);
  }, [funding]);

  // OI mini area chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !oi.length) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lo = Math.min(...oi), hi = Math.max(...oi);
    const span = Math.max(1e-9, hi - lo);
    const x = (i) => (w * i) / (oi.length - 1);
    const y = (v) => 3 + (h - 6) * (1 - (v - lo) / span);
    ctx.beginPath();
    ctx.moveTo(0, h);
    oi.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(34,211,238,0.14)";
    ctx.fill();
    ctx.beginPath();
    oi.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }, [oi]);

  const rate = funding?.rate ?? 0;
  const ratio = funding?.longShortRatio ?? 1;
  const longPct = (ratio / (1 + ratio)) * 100;

  return (
    <Panel title="Funding & Open Interest" simulated>
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div>
            <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em" }}>FUNDING / 8H</div>
            <div className={`lt-mono ${rate >= 0 ? "lt-red" : "lt-green"}`} style={{ fontSize: 20, fontWeight: 700 }}>
              {rate >= 0 ? "+" : ""}{(rate).toFixed(4)}%
            </div>
            <div className="lt-dim" style={{ fontSize: 8 }}>{rate >= 0 ? "longs pay shorts" : "shorts pay longs"}</div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em" }}>NEXT FUNDING</div>
            <div className="lt-mono" style={{ fontSize: 13, fontWeight: 600 }}>{countdown}</div>
            <div className="lt-dim lt-mono" style={{ fontSize: 8 }}>
              pred {funding ? `${funding.predicted >= 0 ? "+" : ""}${funding.predicted.toFixed(4)}%` : "—"}
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 30 }}>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 2 }}>
            OPEN INTEREST 24H · <span className="lt-cyan">${oi.length ? fmtNum(oi[oi.length - 1]) : "—"}B</span>
          </div>
          <canvas ref={canvasRef} style={{ width: "100%", height: "calc(100% - 14px)", display: "block" }} />
        </div>

        <div>
          <div className="lt-muted" style={{ fontSize: 8.5, letterSpacing: "0.08em", marginBottom: 3 }}>LONG / SHORT RATIO</div>
          <div style={{ display: "flex", height: 5, background: "var(--lt-grid)" }}>
            <div style={{ width: `${longPct}%`, background: "var(--lt-green)" }} />
            <div style={{ width: `${100 - longPct}%`, background: "var(--lt-red)" }} />
          </div>
          <div className="lt-mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 2 }}>
            <span className="lt-green">{fmtNum(longPct)}% LONG</span>
            <span className="lt-red">SHORT {fmtNum(100 - longPct)}%</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
