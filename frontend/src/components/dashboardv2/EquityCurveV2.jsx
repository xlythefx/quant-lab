import { useMemo, useRef, useState, useEffect } from "react";
import { fmtUsd, fmtNum } from "../../services/format.js";

/**
 * Multi-line equity chart with an honest linear/log y-axis toggle.
 *
 * Modeled on CustomEquityChart (which is linear-only and left untouched), this
 * adds a `scale` prop. In log mode points are POSITIONED by log10(value) but
 * the y-axis ticks are LABELLED with the real % values, so the toggle is not
 * misleading.
 *
 * props:
 *   strategies:        [{id, color, label}]
 *   pointsByStrategy:  {id: [{time, value}, ...]}   // value = % of starting (100 baseline)
 *   startingCapital:   number (USD) — used for $ tooltip + axis caption
 *   scale:             "linear" | "log"
 */
export default function EquityCurveV2({ strategies, pointsByStrategy, startingCapital = 100000, scale = "linear" }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 280 });
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(160, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isLog = scale === "log";
  const padding = { l: 60, r: 14, t: 18, b: 26 };
  const innerW = Math.max(1, size.w - padding.l - padding.r);
  const innerH = Math.max(1, size.h - padding.t - padding.b);

  // Domain across all series. In log mode we operate on log10(value) and clamp
  // non-positive values out (a blown-up curve can't be drawn on a log axis).
  const { tMin, tMax, dMin, dMax, hasData } = useMemo(() => {
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    let hasData = false;
    for (const s of strategies) {
      const pts = pointsByStrategy[s.id];
      if (!pts || pts.length === 0) continue;
      for (const p of pts) {
        if (isLog && !(p.value > 0)) continue;
        hasData = true;
        if (p.time < tMin) tMin = p.time;
        if (p.time > tMax) tMax = p.time;
        if (p.value < vMin) vMin = p.value;
        if (p.value > vMax) vMax = p.value;
      }
    }
    if (!hasData) return { tMin: 0, tMax: 1, dMin: isLog ? 1.9 : 99, dMax: isLog ? 2.1 : 101, hasData: false };
    if (tMin === tMax) tMax = tMin + 1;
    // Always include the 100 baseline in the visible range.
    vMin = Math.min(vMin, 100);
    vMax = Math.max(vMax, 100);
    let dMin, dMax;
    if (isLog) {
      dMin = Math.log10(Math.max(vMin, 1e-6));
      dMax = Math.log10(Math.max(vMax, 1e-6));
      if (dMin === dMax) { dMin -= 0.05; dMax += 0.05; }
      const pad = (dMax - dMin) * 0.08;
      dMin -= pad; dMax += pad;
    } else {
      dMin = vMin; dMax = vMax;
      const pad = (dMax - dMin) * 0.08 || 1;
      dMin -= pad; dMax += pad;
    }
    return { tMin, tMax, dMin, dMax, hasData };
  }, [strategies, pointsByStrategy, isLog]);

  // value -> "domain coordinate" used for plotting.
  const dOf = (v) => (isLog ? Math.log10(Math.max(v, 1e-6)) : v);
  const xOf = (t) => padding.l + ((t - tMin) / (tMax - tMin)) * innerW;
  const yOf = (v) => padding.t + (1 - (dOf(v) - dMin) / (dMax - dMin)) * innerH;
  const yOfD = (d) => padding.t + (1 - (d - dMin) / (dMax - dMin)) * innerH;

  const paths = useMemo(() => {
    return strategies.map((s) => {
      const pts = pointsByStrategy[s.id];
      if (!pts || pts.length === 0) return { id: s.id, color: s.color, d: "" };
      const max = Math.min(pts.length, Math.max(800, innerW * 2));
      const step = Math.max(1, Math.floor(pts.length / max));
      let d = "";
      let started = false;
      for (let i = 0; i < pts.length; i += step) {
        const p = pts[i];
        if (isLog && !(p.value > 0)) continue;
        const x = xOf(p.time).toFixed(1);
        const y = yOf(p.value).toFixed(1);
        d += (started ? "L" : "M") + x + "," + y;
        started = true;
      }
      const last = pts[pts.length - 1];
      if (!isLog || last.value > 0) d += "L" + xOf(last.time).toFixed(1) + "," + yOf(last.value).toFixed(1);
      return { id: s.id, color: s.color, d, dash: s.dash || "" };
    });
  }, [strategies, pointsByStrategy, tMin, tMax, dMin, dMax, innerW, innerH, isLog]);

  // Y ticks — even spacing in domain space; labels show the real % value.
  const yTicks = useMemo(() => {
    const n = 5;
    const out = [];
    for (let i = 0; i <= n; i++) {
      const d = dMin + ((dMax - dMin) * i) / n;
      const v = isLog ? 10 ** d : d;
      out.push({ v, y: yOfD(d), dollars: (v / 100) * startingCapital });
    }
    return out;
  }, [dMin, dMax, innerH, padding.t, startingCapital, isLog]);

  const xTicks = useMemo(() => {
    const n = 6;
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = tMin + ((tMax - tMin) * i) / n;
      out.push({ t, x: xOf(t) });
    }
    return out;
  }, [tMin, tMax, innerW, padding.l]);

  const baselineY = yOf(100);

  const onMouseMove = (e) => {
    if (!hasData) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < padding.l || x > size.w - padding.r) { setHover(null); return; }
    const t = tMin + ((x - padding.l) / innerW) * (tMax - tMin);
    const valuesByStrategy = {};
    for (const s of strategies) {
      const pts = pointsByStrategy[s.id];
      if (!pts || !pts.length) continue;
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].time < t) lo = mid + 1;
        else hi = mid;
      }
      valuesByStrategy[s.id] = pts[lo];
    }
    setHover({ x, t, valuesByStrategy });
  };
  const onMouseLeave = () => setHover(null);

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      <div className="absolute top-2 left-3 text-[10px] uppercase tracking-widest text-muted z-10 pointer-events-none">
        Equity (% of {fmtUsd(startingCapital)}){isLog ? " · log" : ""}
      </div>

      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
          run a backtest to see equity
        </div>
      )}

      <svg width={size.w} height={size.h} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} className="block">
        {yTicks.map((tk, i) => (
          <g key={i}>
            <line
              x1={padding.l} x2={size.w - padding.r}
              y1={tk.y} y2={tk.y}
              stroke={Math.abs(tk.v - 100) < 0.001 ? "rgba(139,92,246,0.35)" : "rgba(31,32,48,0.6)"}
              strokeDasharray={Math.abs(tk.v - 100) < 0.001 ? "" : "2 4"}
              strokeWidth={Math.abs(tk.v - 100) < 0.001 ? 1 : 0.6}
            />
            <text x={padding.l - 6} y={tk.y + 3} textAnchor="end"
                  className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {fmtNum(tk.v)}%
            </text>
          </g>
        ))}

        {xTicks.map((tk, i) => (
          <g key={i}>
            <line x1={tk.x} x2={tk.x} y1={size.h - padding.b} y2={size.h - padding.b + 4}
                  stroke="rgba(107,114,128,0.6)" strokeWidth={0.6} />
            <text x={tk.x} y={size.h - 8} textAnchor="middle"
                  className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {hasData ? new Date(tk.t * 1000).toISOString().slice(0, 10) : ""}
            </text>
          </g>
        ))}

        <text x={size.w - padding.r - 4} y={baselineY - 4} textAnchor="end"
              fill="rgba(139,92,246,0.7)" fontSize="9" fontFamily="JetBrains Mono, monospace">
          start
        </text>

        {paths.map((p) => (
          <path key={p.id} d={p.d} fill="none" stroke={p.color} strokeWidth={1.5} strokeDasharray={p.dash} />
        ))}

        {hover && hasData && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={padding.t} y2={size.h - padding.b}
                  stroke="rgba(229,231,235,0.25)" strokeDasharray="2 3" />
            {strategies.map((s) => {
              const pt = hover.valuesByStrategy[s.id];
              if (!pt || (isLog && !(pt.value > 0))) return null;
              return <circle key={s.id} cx={xOf(pt.time)} cy={yOf(pt.value)} r={3} fill={s.color} />;
            })}
          </g>
        )}
      </svg>

      {hover && hasData && Object.keys(hover.valuesByStrategy).length > 0 && (
        <div
          className="absolute z-20 px-2 py-1 rounded-md border border-line bg-bg-panel/95 text-[11px] font-mono whitespace-nowrap pointer-events-none"
          style={{ left: Math.min(hover.x + 10, size.w - 170), top: padding.t + 4 }}
        >
          <div className="text-muted mb-1">{new Date(hover.t * 1000).toISOString().slice(0, 16).replace("T", " ")}Z</div>
          {strategies.map((s) => {
            const pt = hover.valuesByStrategy[s.id];
            if (!pt) return null;
            const dollars = (pt.value / 100) * startingCapital;
            const pnl = dollars - startingCapital;
            return (
              <div key={s.id} className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                <span className="text-text">{fmtNum(pt.value)}%</span>
                <span className={pnl >= 0 ? "text-profit" : "text-loss"}>{fmtUsd(pnl)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
