import { useMemo, useRef, useState, useEffect } from "react";

/**
 * Filled underwater / drawdown chart. `points` is [{time, value}] where value
 * is drawdown % (≤ 0). Draws a red area hanging from the 0% line.
 */
export default function UnderwaterChart({ points, color = "#ef4444" }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 140 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(90, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const padding = { l: 60, r: 14, t: 14, b: 22 };
  const innerW = Math.max(1, size.w - padding.l - padding.r);
  const innerH = Math.max(1, size.h - padding.t - padding.b);

  const { area, line, tMin, tMax, vMin, maxDD, hasData } = useMemo(() => {
    if (!points || points.length === 0) {
      return { area: "", line: "", tMin: 0, tMax: 1, vMin: -1, maxDD: 0, hasData: false };
    }
    let tMin = Infinity, tMax = -Infinity, vMin = 0;
    for (const p of points) {
      if (p.time < tMin) tMin = p.time;
      if (p.time > tMax) tMax = p.time;
      if (p.value < vMin) vMin = p.value;
    }
    if (tMin === tMax) tMax = tMin + 1;
    const lo = Math.min(vMin * 1.08, -0.0001);
    const xOf = (t) => padding.l + ((t - tMin) / (tMax - tMin)) * innerW;
    const yOf = (v) => padding.t + (1 - (v - lo) / (0 - lo)) * innerH;
    const n = points.length;
    const step = Math.max(1, Math.floor(n / Math.max(800, innerW * 2)));
    let line = "";
    let started = false;
    for (let i = 0; i < n; i += step) {
      const p = points[i];
      line += (started ? "L" : "M") + xOf(p.time).toFixed(1) + "," + yOf(p.value).toFixed(1);
      started = true;
    }
    const last = points[n - 1];
    line += "L" + xOf(last.time).toFixed(1) + "," + yOf(last.value).toFixed(1);
    const y0 = yOf(0);
    const area = `M${xOf(points[0].time).toFixed(1)},${y0.toFixed(1)} ` +
      line.replace(/^M/, "L") + ` L${xOf(last.time).toFixed(1)},${y0.toFixed(1)} Z`;
    return { area, line, tMin, tMax, vMin: lo, maxDD: vMin, hasData: true };
  }, [points, innerW, innerH]);

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      <div className="absolute top-2 left-3 text-[10px] uppercase tracking-widest text-muted z-10 pointer-events-none">
        Underwater / Drawdown
      </div>
      {hasData && (
        <div className="absolute top-2 right-3 text-[10px] font-mono text-loss z-10 pointer-events-none">
          max {maxDD.toFixed(1)}%
        </div>
      )}
      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">no drawdown data</div>
      )}
      <svg width={size.w} height={size.h} className="block">
        <line x1={padding.l} x2={size.w - padding.r} y1={padding.t} y2={padding.t}
              stroke="rgba(31,32,48,0.8)" strokeWidth={0.8} />
        {hasData && (
          <>
            <defs>
              <linearGradient id="uwgrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.05" />
                <stop offset="100%" stopColor={color} stopOpacity="0.35" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#uwgrad)" stroke="none" />
            <path d={line} fill="none" stroke={color} strokeWidth={1.2} />
          </>
        )}
      </svg>
    </div>
  );
}
