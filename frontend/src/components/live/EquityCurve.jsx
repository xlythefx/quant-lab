import { useEffect, useRef, useState } from "react";
import { fmtUsd } from "../../services/format.js";

/**
 * Cumulative equity curve canvas (area + line): green when ending above the
 * baseline, red otherwise; dashed baseline; progressive left→right draw via
 * `progress` (see animations.js — replay only on entry/filter change).
 */
export default function EquityCurve({ curve = [], baseline = 0, progress = 1, height = 170 }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: height });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setSize({ w: Math.floor(es[0].contentRect.width), h: Math.floor(es[0].contentRect.height) }));
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

    const PAD = { top: 10, right: 64, bottom: 12, left: 8 };
    const W = size.w - PAD.left - PAD.right;
    const H = size.h - PAD.top - PAD.bottom;

    const pts = curve.map((p) => p.eq);
    if (!pts.length) {
      ctx.fillStyle = "#3a3a4e";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("No realized live trades yet", size.w / 2, size.h / 2);
      return;
    }

    const all = [...pts, baseline];
    let lo = Math.min(...all), hi = Math.max(...all);
    const span = Math.max(1e-9, hi - lo);
    lo -= span * 0.08; hi += span * 0.08;

    const n = pts.length;
    const frac = Math.max(1e-9, progress) * (n - 1 || 1);
    const lastIdx = Math.min(n - 1, Math.floor(frac));
    const x = (i) => PAD.left + (n === 1 ? W / 2 : (W * i) / (n - 1));
    const y = (v) => PAD.top + H * (1 - (v - lo) / (hi - lo));

    // dashed baseline (starting capital)
    ctx.strokeStyle = "#3a3a4e";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y(baseline));
    ctx.lineTo(PAD.left + W, y(baseline));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#6b6b8a";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(fmtUsd(baseline), PAD.left + W + 5, y(baseline) + 3);

    const ending = pts[Math.max(0, lastIdx)];
    const up = ending >= baseline;
    const line = up ? "#00d4a1" : "#ff4d6d";
    const fill = up ? "rgba(0,212,161,0.13)" : "rgba(255,77,109,0.13)";

    // interpolate the leading edge so the reveal moves smoothly
    const leadX = n === 1 ? x(0) : x(lastIdx) + (x(Math.min(n - 1, lastIdx + 1)) - x(lastIdx)) * (frac - lastIdx);
    const leadV = lastIdx >= n - 1 ? pts[n - 1] : pts[lastIdx] + (pts[lastIdx + 1] - pts[lastIdx]) * (frac - lastIdx);

    ctx.beginPath();
    ctx.moveTo(x(0), y(baseline));
    ctx.lineTo(x(0), y(pts[0]));
    for (let i = 1; i <= lastIdx; i++) ctx.lineTo(x(i), y(pts[i]));
    ctx.lineTo(leadX, y(leadV));
    ctx.lineTo(leadX, y(baseline));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x(0), y(pts[0]));
    for (let i = 1; i <= lastIdx; i++) ctx.lineTo(x(i), y(pts[i]));
    ctx.lineTo(leadX, y(leadV));
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // end label
    ctx.fillStyle = line;
    ctx.fillText(fmtUsd(ending), PAD.left + W + 5, y(leadV) + 3);
  }, [curve, baseline, progress, size]);

  return (
    <div ref={wrapRef} style={{ width: "100%", height }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}
