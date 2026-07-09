import { useEffect, useMemo, useRef, useState } from "react";
import { computeIndicators, sessionFor } from "./indicators.js";
import { fmtNum } from "../../services/format.js";

/**
 * The terminal's own canvas candle chart (NOT the backtest TradingChart):
 * session-shaded background, gridlines + right axis, candlesticks,
 * amber VWMA(14), dashed cyan Z-bands (±1.5σ), signal markers, OHLCV
 * hover tooltip, progressive left→right draw-in via `progress`.
 */

const C = {
  bg: "transparent",
  grid: "#15151f",
  axis: "#6b6b8a",
  green: "#00d4a1",
  red: "#ff4d6d",
  amber: "#fbbf24",
  cyan: "#22d3ee",
  purple: "#8b5cf6",
};

const SESSION_TINT = {
  ASIA: "rgba(139, 92, 246, 0.055)",
  LONDON: "rgba(251, 191, 36, 0.05)",
  "NEW YORK": "rgba(34, 211, 238, 0.05)",
};

const PAD = { top: 54, right: 56, bottom: 20, left: 6 };

export default function LiveChart({ candles, markers = [], progress = 1 }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const geomRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState(null); // {x, y, candle}

  const ind = useMemo(() => computeIndicators(candles, 14, 1.5), [candles]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!candles.length) { geomRef.current = null; return; }

    const W = size.w, H = size.h;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const n = candles.length;

    // Visible fraction for the draw-in (frame is full, series reveal L→R).
    const lastIdx = Math.min(n - 1, Math.max(0, Math.floor(progress * (n - 1))));

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, candles[i].low);
      hi = Math.max(hi, candles[i].high);
      if (ind.upper[i] != null) hi = Math.max(hi, ind.upper[i]);
      if (ind.lower[i] != null) lo = Math.min(lo, ind.lower[i]);
    }
    const span = Math.max(1e-9, hi - lo);
    lo -= span * 0.04; hi += span * 0.04;

    const x = (i) => PAD.left + (plotW * i) / Math.max(1, n - 1);
    const y = (p) => PAD.top + plotH * (1 - (p - lo) / (hi - lo));
    geomRef.current = { x, y, n, lo, hi, plotW, plotH };

    // 1. Session shading (vertical bands by UTC hour)
    let bandStart = 0;
    let bandSess = sessionFor(candles[0].time);
    const flushBand = (endI) => {
      ctx.fillStyle = SESSION_TINT[bandSess] || "transparent";
      const x0 = bandStart === 0 ? PAD.left : x(bandStart) - plotW / (2 * (n - 1));
      const x1 = endI >= n - 1 ? PAD.left + plotW : x(endI) + plotW / (2 * (n - 1));
      ctx.fillRect(x0, PAD.top, x1 - x0, plotH);
    };
    for (let i = 1; i < n; i++) {
      const s = sessionFor(candles[i].time);
      if (s !== bandSess) { flushBand(i - 1); bandStart = i; bandSess = s; }
    }
    flushBand(n - 1);

    // 2. Grid + right-edge axis labels
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.axis;
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.lineWidth = 1;
    const rows = 6;
    for (let r = 0; r <= rows; r++) {
      const py = PAD.top + (plotH * r) / rows;
      ctx.beginPath(); ctx.moveTo(PAD.left, py); ctx.lineTo(PAD.left + plotW, py); ctx.stroke();
      const price = hi - ((hi - lo) * r) / rows;
      ctx.fillText(fmtNum(price), PAD.left + plotW + 5, py + 3);
    }
    // time labels
    ctx.textAlign = "center";
    const ticks = Math.max(2, Math.floor(plotW / 110));
    for (let t = 0; t <= ticks; t++) {
      const i = Math.round(((n - 1) * t) / ticks);
      const d = new Date(candles[i].time * 1000);
      const lbl = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      ctx.fillText(lbl, x(i), H - 6);
    }

    // 3. Z-bands (dashed cyan) up to lastIdx
    const strokeSeries = (arr, color, dash, width = 1) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= lastIdx; i++) {
        if (arr[i] == null) { started = false; continue; }
        const px = x(i), py = y(arr[i]);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    strokeSeries(ind.upper, C.cyan, [4, 4]);
    strokeSeries(ind.lower, C.cyan, [4, 4]);

    // 4. Candles up to lastIdx
    const cw = Math.max(1, Math.min(9, (plotW / n) * 0.62));
    for (let i = 0; i <= lastIdx; i++) {
      const c = candles[i];
      const up = c.close >= c.open;
      const col = up ? C.green : C.red;
      const px = x(i);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, y(c.high)); ctx.lineTo(px, y(c.low)); ctx.stroke();
      ctx.fillStyle = col;
      const yo = y(c.open), yc = y(c.close);
      ctx.fillRect(px - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    }

    // 5. VWMA (amber)
    strokeSeries(ind.vwma, C.amber, [], 1.4);

    // 6. Signal markers (entry/exit triangles)
    const timeToIdx = new Map(candles.map((c, i) => [c.time, i]));
    for (const m of markers) {
      let i = timeToIdx.get(m.time);
      if (i == null) {
        // snap to nearest bar within the visible range
        if (m.time < candles[0].time || m.time > candles[n - 1].time + (candles[1]?.time - candles[0]?.time || 60)) continue;
        i = n - 1;
        for (let k = 0; k < n; k++) if (candles[k].time >= m.time) { i = k; break; }
      }
      if (i > lastIdx) continue;
      const isBuy = m.action === "BUY" || (m.side === "long" && m.kind === "entry") || (m.side === "short" && m.kind === "exit");
      const px = x(i);
      const py = isBuy ? y(candles[i].low) + 14 : y(candles[i].high) - 14;
      ctx.fillStyle = isBuy ? C.green : C.red;
      ctx.beginPath();
      if (isBuy) { ctx.moveTo(px, py - 5); ctx.lineTo(px - 4.5, py + 3); ctx.lineTo(px + 4.5, py + 3); }
      else { ctx.moveTo(px, py + 5); ctx.lineTo(px - 4.5, py - 3); ctx.lineTo(px + 4.5, py - 3); }
      ctx.closePath();
      ctx.fill();
    }
  }, [candles, ind, markers, size, progress]);

  const onMove = (e) => {
    const g = geomRef.current;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!g || !rect || !candles.length) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const i = Math.round(((mx - PAD.left) / Math.max(1, g.plotW)) * (g.n - 1));
    if (i < 0 || i >= candles.length) { setHover(null); return; }
    setHover({ x: mx, y: my, candle: candles[i] });
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "absolute", inset: 0 }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      {hover && (
        <div
          className="lt-mono"
          style={{
            position: "absolute",
            left: Math.min(hover.x + 12, Math.max(0, size.w - 190)),
            top: Math.max(4, hover.y - 54),
            background: "var(--lt-chrome)",
            border: "1px solid var(--lt-border)",
            padding: "5px 8px",
            fontSize: 9.5,
            pointerEvents: "none",
            zIndex: 5,
            whiteSpace: "nowrap",
          }}
        >
          <div className="lt-muted">
            {new Date(hover.candle.time * 1000).toISOString().slice(5, 16).replace("T", " ")} UTC
          </div>
          <div>
            O <span className="lt-muted">{fmtNum(hover.candle.open)}</span>{" "}
            H <span className="lt-muted">{fmtNum(hover.candle.high)}</span>{" "}
            L <span className="lt-muted">{fmtNum(hover.candle.low)}</span>
          </div>
          <div>
            C <span className={hover.candle.close >= hover.candle.open ? "lt-green" : "lt-red"}>{fmtNum(hover.candle.close)}</span>{" "}
            V <span className="lt-muted">{fmtNum(hover.candle.volume)}</span>
          </div>
        </div>
      )}
      {/* legend (bottom-left) */}
      <div
        className="lt-mono"
        style={{ position: "absolute", left: 8, bottom: 22, fontSize: 8.5, display: "flex", gap: 10, pointerEvents: "none" }}
      >
        <span className="lt-amber">━ VWMA(14)</span>
        <span className="lt-cyan">⎓ Z-BAND ±1.5σ</span>
        <span>
          <span className="lt-purple">■ ASIA</span>{" "}
          <span className="lt-amber">■ LDN</span>{" "}
          <span className="lt-cyan">■ NY</span>
        </span>
      </div>
    </div>
  );
}
