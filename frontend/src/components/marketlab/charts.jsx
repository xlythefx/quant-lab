// Self-contained SVG chart primitives for the Market Lab page.
// Modeled on the hand-rolled SVG idiom used in Analytics.jsx / WalkForward.jsx
// (fixed viewBox, width="100%", manual xOf/yOf scaling). No chart library.

// Regime → color. Mirrors the app's semantic palette (profit/loss/accent tokens).
export const REGIME_COLORS = {
  "Trending Up":     "#22c55e",
  "Trending Down":   "#ef4444",
  "High-Volatility": "#f59e0b",
  "Quiet":           "#3b82f6",
  "Choppy-Range":    "#94a3b8",
};

// Palette for HMM regimes (dynamic auto-named states). Ordered bear→bull to match
// the backend's canonical state order (ascending mean trend).
export const HMM_PALETTE = ["#ef4444", "#f59e0b", "#a78bfa", "#38bdf8", "#22c55e", "#14b8a6"];

/**
 * Build a {label -> color} map for a regime label set. Known deterministic labels
 * keep their semantic color; unknown (HMM) labels are assigned from HMM_PALETTE in
 * order; "Warmup" is always slate grey. Pass the result as RegimeRibbon's `colors`.
 */
export function buildRegimeColors(labels = []) {
  const map = {};
  let pi = 0;
  for (const lab of labels) {
    if (REGIME_COLORS[lab]) map[lab] = REGIME_COLORS[lab];
    else map[lab] = HMM_PALETTE[pi++ % HMM_PALETTE.length];
  }
  map["Warmup"] = "#475569";
  return map;
}

const AXIS = "#9ca3af";
const GRID = "rgba(148,163,184,0.15)";

function niceNum(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toExponential(1);
}

/**
 * RegimeRibbon — a price line with a colored regime strip beneath it.
 * Props: segments [{regime,start_time,end_time}], price [{time,value}].
 * Sub-pixel segments are merged into their neighbor so a multi-year 15m
 * series doesn't emit tens of thousands of invisible <rect>s.
 */
export function RegimeRibbon({ segments = [], price = [], height = 200, colors = REGIME_COLORS }) {
  const W = 1000;
  const H = height;
  const pad = { l: 8, r: 8, t: 8, b: 8 };
  const ribbonH = 26;
  const lineBottom = H - pad.b - ribbonH - 6;
  const lineTop = pad.t;

  const times = price.length ? price.map((p) => p.time) : segments.flatMap((s) => [s.start_time, s.end_time]);
  if (!times.length) return null;
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const span = tMax - tMin || 1;
  const xOf = (t) => pad.l + ((t - tMin) / span) * (W - pad.l - pad.r);

  // Price line (scaled to [lineTop, lineBottom]).
  const vals = price.map((p) => p.value).filter((v) => Number.isFinite(v));
  const vMin = vals.length ? Math.min(...vals) : 0;
  const vMax = vals.length ? Math.max(...vals) : 1;
  const vSpan = vMax - vMin || 1;
  const yOf = (v) => lineBottom - ((v - vMin) / vSpan) * (lineBottom - lineTop);
  const path = price.length
    ? price.map((p, i) => `${i ? "L" : "M"}${xOf(p.time).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ")
    : "";

  // Merge sub-pixel segments (< 0.7 viewBox units ≈ <1px at 1000px wide).
  const MIN_W = 0.7;
  const rects = [];
  for (const s of segments) {
    const x0 = xOf(s.start_time);
    const x1 = xOf(s.end_time);
    const last = rects[rects.length - 1];
    if (last && (x1 - x0) < MIN_W && last.regime === s.regime) {
      last.x1 = x1;
    } else if (last && (x1 - x0) < MIN_W) {
      last.x1 = x1; // tiny flicker → absorb into neighbor, keep neighbor's color
    } else {
      rects.push({ regime: s.regime, x0, x1 });
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none"
         style={{ display: "block" }}>
      {path && <path d={path} fill="none" stroke="#cbd5e1" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      <g>
        {rects.map((r, i) => (
          <rect key={i} x={r.x0} y={H - pad.b - ribbonH} width={Math.max(0.5, r.x1 - r.x0)}
                height={ribbonH} fill={colors[r.regime] || REGIME_COLORS[r.regime] || "#64748b"} shapeRendering="crispEdges">
            <title>{r.regime}</title>
          </rect>
        ))}
      </g>
    </svg>
  );
}

/**
 * VBarChart — vertical bars with a zero baseline. Generic; used for DOW / hour /
 * autocorrelation. `bars` = [{label, value, n?}]. value is plotted; null skipped.
 * colorMode "sign" → profit/loss; else fixed `color`.
 */
export function VBarChart({ bars = [], height = 200, colorMode = "sign", color = "#3b82f6",
                            yLabel = "", labelEvery = 1, fmt = (v) => niceNum(v) }) {
  const W = 1000;
  const H = height;
  const pad = { l: 54, r: 12, t: 14, b: 30 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const vals = bars.map((b) => b.value).filter((v) => Number.isFinite(v));
  if (!vals.length) return <Empty height={H} />;
  let yMax = Math.max(0, ...vals);
  let yMin = Math.min(0, ...vals);
  if (yMax === yMin) { yMax += 1; yMin -= 1; }
  const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const zeroY = yOf(0);
  const groupW = innerW / bars.length;
  const barW = Math.max(1, groupW * 0.7);

  const ticks = [yMin, (yMin + yMax) / 2, yMax];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={yOf(tv)} y2={yOf(tv)} stroke={GRID} />
          <text x={pad.l - 6} y={yOf(tv) + 3} textAnchor="end" fontSize="11" fill={AXIS}>{fmt(tv)}</text>
        </g>
      ))}
      {yLabel && <text x={12} y={pad.t + 4} fontSize="10" fill={AXIS}>{yLabel}</text>}
      {bars.map((b, i) => {
        const gx = pad.l + i * groupW + (groupW - barW) / 2;
        const v = Number.isFinite(b.value) ? b.value : 0;
        const top = Math.min(yOf(v), zeroY);
        const h = Math.abs(yOf(v) - zeroY);
        const fill = colorMode === "sign" ? (v >= 0 ? "#22c55e" : "#ef4444") : color;
        const showLabel = i % labelEvery === 0;
        return (
          <g key={i}>
            <rect x={gx} y={top} width={barW} height={Math.max(0.5, h)} fill={fill} rx="1">
              <title>{b.label}: {fmt(b.value)}{b.n != null ? ` (n=${b.n})` : ""}</title>
            </rect>
            {showLabel && (
              <text x={gx + barW / 2} y={H - pad.b + 14} textAnchor="middle" fontSize="10" fill={AXIS}>
                {b.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * LineChart — single series line for the realized-vol timeline. `points` =
 * [{time, value}]. An optional `forecast` value is drawn as a dashed flat line
 * at the right edge.
 */
export function LineChart({ points = [], height = 200, color = "#f59e0b",
                            forecast = null, yLabel = "", fmt = (v) => niceNum(v) }) {
  const W = 1000;
  const H = height;
  const pad = { l: 54, r: 12, t: 14, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const pts = points.filter((p) => Number.isFinite(p.value));
  if (pts.length < 2) return <Empty height={H} />;
  const ts = pts.map((p) => p.time);
  const tMin = Math.min(...ts), tMax = Math.max(...ts), tSpan = tMax - tMin || 1;
  const vs = pts.map((p) => p.value);
  let vMin = Math.min(...vs), vMax = Math.max(...vs);
  if (forecast != null && Number.isFinite(forecast)) { vMin = Math.min(vMin, forecast); vMax = Math.max(vMax, forecast); }
  const vSpan = (vMax - vMin) || 1;
  const xOf = (t) => pad.l + ((t - tMin) / tSpan) * innerW;
  const yOf = (v) => pad.t + (1 - (v - vMin) / vSpan) * innerH;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.time).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
  const ticks = [vMin, (vMin + vMax) / 2, vMax];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={yOf(tv)} y2={yOf(tv)} stroke={GRID} />
          <text x={pad.l - 6} y={yOf(tv) + 3} textAnchor="end" fontSize="11" fill={AXIS}>{fmt(tv)}</text>
        </g>
      ))}
      {yLabel && <text x={12} y={pad.t + 4} fontSize="10" fill={AXIS}>{yLabel}</text>}
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {forecast != null && Number.isFinite(forecast) && (
        <g>
          <line x1={xOf(tMax) - innerW * 0.06} x2={W - pad.r} y1={yOf(forecast)} y2={yOf(forecast)}
                stroke="#e879f9" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          <circle cx={W - pad.r} cy={yOf(forecast)} r="3" fill="#e879f9" />
        </g>
      )}
    </svg>
  );
}

/**
 * HistogramChart — return distribution bars + a fitted normal-curve overlay.
 * counts/bin_edges from numpy.histogram; mean/std for the bell.
 */
export function HistogramChart({ counts = [], binEdges = [], mean = 0, std = 0, height = 220 }) {
  const W = 1000;
  const H = height;
  const pad = { l: 48, r: 12, t: 14, b: 24 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  if (!counts.length || binEdges.length < 2) return <Empty height={H} />;
  const xMin = binEdges[0], xMax = binEdges[binEdges.length - 1];
  const xSpan = (xMax - xMin) || 1;
  const xOf = (v) => pad.l + ((v - xMin) / xSpan) * innerW;
  const cMax = Math.max(...counts) || 1;
  const yOf = (c) => pad.t + (1 - c / cMax) * innerH;

  // Normal overlay scaled to histogram area (count-equivalent).
  const binW = (xMax - xMin) / counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const normPath = std > 0
    ? Array.from({ length: 80 }, (_, i) => {
        const x = xMin + (i / 79) * xSpan;
        const pdf = Math.exp(-0.5 * ((x - mean) / std) ** 2) / (std * Math.sqrt(2 * Math.PI));
        const expectedCount = pdf * binW * total;
        return `${i ? "L" : "M"}${xOf(x).toFixed(1)},${yOf(expectedCount).toFixed(1)}`;
      }).join(" ")
    : "";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      <line x1={pad.l} x2={W - pad.r} y1={yOf(0)} y2={yOf(0)} stroke={GRID} />
      {counts.map((c, i) => {
        const x0 = xOf(binEdges[i]);
        const x1 = xOf(binEdges[i + 1]);
        const w = Math.max(0.5, x1 - x0 - 0.5);
        return (
          <rect key={i} x={x0} y={yOf(c)} width={w} height={Math.max(0, yOf(0) - yOf(c))}
                fill="#3b82f6" opacity="0.7">
            <title>{niceNum(binEdges[i])} … {niceNum(binEdges[i + 1])}: {c}</title>
          </rect>
        );
      })}
      {normPath && <path d={normPath} fill="none" stroke="#e879f9" strokeWidth="1.5"
                         vectorEffect="non-scaling-stroke" />}
      {/* x ticks: min, 0, max */}
      {[xMin, 0, xMax].filter((t) => t >= xMin && t <= xMax).map((t, i) => (
        <text key={i} x={xOf(t)} y={H - 8} textAnchor="middle" fontSize="10" fill={AXIS}>{niceNum(t)}</text>
      ))}
    </svg>
  );
}

/**
 * CentroidShape — a tiny normalized-shape sparkline (no axes). Used for cluster
 * centroids and similarity windows. `shape` is an array of z-normalized values.
 */
export function CentroidShape({ shape = [], height = 64, color = "#60a5fa", overlay = null }) {
  const W = 200, H = height, pad = 6;
  const pts = shape.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return <Empty height={H} />;
  const all = overlay ? pts.concat(overlay.filter((v) => Number.isFinite(v))) : pts;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const xOf = (i, arr) => pad + (i / (arr.length - 1)) * (W - 2 * pad);
  const yOf = (v) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
  const path = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${xOf(i, arr).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
      {overlay && <path d={path(overlay)} fill="none" stroke="#64748b" strokeWidth="1" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />}
      <path d={path(pts)} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * EdgeHeatmap — (z × RSI) grid colored by signed edge %, greyed where the sample
 * is thin. `grid` is rows=z_axis × cols=rsi_axis of {edge_pct, n}.
 */
export function EdgeHeatmap({ grid = [], zAxis = [], rsiAxis = [], minN = 50 }) {
  if (!grid.length) return <Empty height={160} />;
  const vals = grid.flat().filter((c) => c.edge_pct != null && c.n >= minN).map((c) => Math.abs(c.edge_pct));
  const max = vals.length ? Math.max(...vals) : 1;
  const colorOf = (c) => {
    if (c.edge_pct == null || c.n < minN) return "rgba(148,163,184,0.06)";
    const a = Math.min(1, Math.abs(c.edge_pct) / (max || 1));
    return c.edge_pct >= 0 ? `rgba(34,197,94,${0.12 + 0.6 * a})` : `rgba(239,68,68,${0.12 + 0.6 * a})`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] font-mono border-separate" style={{ borderSpacing: "2px" }}>
        <thead>
          <tr>
            <th className="text-muted text-right pr-1 font-normal">z＼RSI</th>
            {rsiAxis.map((rt) => <th key={rt} className="text-muted text-center font-normal w-12">{rt}</th>)}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, zi) => (
            <tr key={zi}>
              <td className="text-muted text-right pr-1">{zAxis[zi]}</td>
              {row.map((c, ri) => (
                <td key={ri} className="w-12 h-7 text-center rounded-sm text-text/90"
                    style={{ background: colorOf(c) }}
                    title={`z=${zAxis[zi]} · RSI ${rsiAxis[ri]}\nedge ${c.edge_pct == null ? "—" : c.edge_pct.toFixed(3) + "%"} · n=${c.n}`}>
                  {c.edge_pct == null || c.n < minN ? "·" : c.edge_pct.toFixed(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ height }) {
  return (
    <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>
      not enough data
    </div>
  );
}
