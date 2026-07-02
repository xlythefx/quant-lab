import { useMemo, useState } from "react";
import { fmtUsd, fmtNum } from "../../services/format.js";

/**
 * Blotter order ticket — design-faithful, but INTENTIONALLY not an OMS:
 * QuantLab's execution model is alerts + webhook to the broker (plan 01).
 * The ticket computes notional/margin; SUBMIT stays disabled with a clear
 * webhook-only note. Manual signals go through a deployment's TEST menu.
 */
export default function OrderTicket({ symbol = "BTCUSDT", lastPrice = null }) {
  const [side, setSide] = useState("BUY");
  const [type, setType] = useState("MARKET");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("0.10");
  const [lev, setLev] = useState(10);
  const [postOnly, setPostOnly] = useState(false);

  const effPrice = type === "MARKET" ? (lastPrice || 0) : (parseFloat(price) || 0);
  const notional = useMemo(() => (parseFloat(size) || 0) * effPrice, [size, effPrice]);
  const margin = notional / Math.max(1, lev);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 1, background: "var(--lt-border)", height: "100%" }}>
      {/* Ticket */}
      <div style={{ background: "var(--lt-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 1 }}>
          {["BUY", "SELL"].map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className="lt-mono"
              style={{
                flex: 1, padding: "7px 0", fontWeight: 700, fontSize: 11, cursor: "pointer",
                border: "1px solid var(--lt-border)",
                background: side === s ? (s === "BUY" ? "var(--lt-green)" : "var(--lt-red)") : "none",
                color: side === s ? (s === "BUY" ? "#04120d" : "#fff") : "var(--lt-muted)",
              }}>
              {s}
            </button>
          ))}
        </div>

        <label>
          <span className="lt-field-label">Order type</span>
          <select className="lt-select" value={type} onChange={(e) => setType(e.target.value)}>
            {["MARKET", "LIMIT", "STOP", "STOP-LIMIT"].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>

        {type !== "MARKET" && (
          <label>
            <span className="lt-field-label">Price</span>
            <input className="lt-input" type="number" value={price} onChange={(e) => setPrice(e.target.value)}
                   placeholder={lastPrice ? fmtNum(lastPrice) : "0.00"} />
          </label>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>
            <span className="lt-field-label">Size ({symbol.replace("USDT", "")})</span>
            <input className="lt-input" type="number" step="0.01" value={size} onChange={(e) => setSize(e.target.value)} />
          </label>
          <label>
            <span className="lt-field-label">Leverage</span>
            <select className="lt-select" value={lev} onChange={(e) => setLev(Number(e.target.value))}>
              {[1, 3, 5, 10, 20, 25, 50].map((l) => <option key={l} value={l}>{l}x</option>)}
            </select>
          </label>
        </div>

        <label className="lt-mono lt-muted" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} />
          Post-Only
        </label>

        <div className="lt-mono" style={{ fontSize: 10, borderTop: "1px solid var(--lt-border)", paddingTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="lt-muted">NOTIONAL</span><span>{fmtUsd(notional)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span className="lt-muted">MARGIN ({lev}x)</span><span>{fmtUsd(margin)}</span>
          </div>
        </div>

        <button className={`lt-btn ${side === "BUY" ? "buy" : "sell"}`} disabled
                title="Disabled by design — QuantLab routes execution through alert webhooks, not an in-app OMS"
                style={{ padding: "9px 0", fontSize: 11, opacity: 0.45, cursor: "not-allowed" }}>
          SUBMIT {side}
        </button>
        <div className="lt-mono lt-amber" style={{ fontSize: 8.5, lineHeight: 1.5 }}>
          ⚠ WEBHOOK-ONLY — QuantLab has no in-app order engine (scope decision, plan 01).
          To fire a manual signal, use a deployment's TEST menu (Strategies workspace),
          which POSTs the broker webhook.
        </div>
      </div>

      {/* Working orders + fills — empty states (no OMS) */}
      <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: 1 }}>
        <div style={{ background: "var(--lt-panel)", display: "flex", flexDirection: "column" }}>
          <div className="lt-panel-head"><span className="lt-panel-title">Working Orders</span></div>
          <div className="lt-empty">No working orders — execution lives at the broker (webhook model)</div>
        </div>
        <div style={{ background: "var(--lt-panel)", display: "flex", flexDirection: "column" }}>
          <div className="lt-panel-head"><span className="lt-panel-title">Fills</span></div>
          <div className="lt-empty">Broker fills appear as positions (Trading / Risk) via the WAMP read (phase 09)</div>
        </div>
      </div>
    </div>
  );
}
