import { useMemo } from "react";

/**
 * Tiny inline equity sparkline. `points` is [{time, value}] (value = % of
 * starting capital, 100 = breakeven). Colored by net result vs the baseline.
 */
export default function Sparkline({ points, color, width = 96, height = 28 }) {
  const d = useMemo(() => {
    if (!points || points.length < 2) return "";
    let vMin = Infinity, vMax = -Infinity;
    for (const p of points) {
      if (p.value < vMin) vMin = p.value;
      if (p.value > vMax) vMax = p.value;
    }
    if (vMin === vMax) { vMin -= 1; vMax += 1; }
    const n = points.length;
    const pad = 2;
    const iw = width - pad * 2;
    const ih = height - pad * 2;
    // Downsample to keep the path light.
    const step = Math.max(1, Math.floor(n / 120));
    let out = "";
    let started = false;
    for (let i = 0; i < n; i += step) {
      const x = pad + (i / (n - 1)) * iw;
      const y = pad + (1 - (points[i].value - vMin) / (vMax - vMin)) * ih;
      out += (started ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
      started = true;
    }
    const last = points[n - 1];
    const lx = pad + iw;
    const ly = pad + (1 - (last.value - vMin) / (vMax - vMin)) * ih;
    out += "L" + lx.toFixed(1) + "," + ly.toFixed(1);
    return out;
  }, [points, width, height]);

  if (!d) {
    return <div style={{ width, height }} className="rounded bg-bg-elev/40" />;
  }
  return (
    <svg width={width} height={height} className="block">
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}
