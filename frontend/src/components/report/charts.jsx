// SVG chart primitives for the Report Import dashboard. Same hand-rolled idiom
// as components/marketlab/charts.jsx (fixed viewBox, manual xOf/yOf scaling, no
// chart library) so the look stays consistent across the app.
import { fmtUsd } from "../../services/format.js";

const AXIS = "#9ca3af";
const GRID = "rgba(148,163,184,0.15)";

function Empty({ height, label = "not enough data" }) {
  return (
    <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>
      {label}
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Compact USD for dense axes/heatmaps: 12500 -> "+12.5k", -980 -> "-980".
function fmtCompact(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "+";
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `${sign}${a.toFixed(0)}`;
}

function yearTicks(tMin, tMax) {
  const y0 = new Date(tMin * 1000).getUTCFullYear();
  const y1 = new Date(tMax * 1000).getUTCFullYear();
  const ticks = [];
  for (let y = y0; y <= y1; y++) {
    const t = Date.UTC(y, 0, 1) / 1000;
    if (t >= tMin && t <= tMax) ticks.push({ t, label: `'${String(y).slice(2)}` });
  }
  return ticks;
}

/**
 * EquityCurve — account equity over time, area + line, with an optional dashed
 * baseline at starting capital. `points` = [{time, value}] (epoch seconds, $).
 */
export function EquityCurve({ points = [], height = 300, baseline = null, color = "#22d3ee" }) {
  const W = 1000, H = height;
  const pad = { l: 70, r: 16, t: 16, b: 26 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const pts = points.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.time));
  if (pts.length < 2) return <Empty height={H} />;

  const ts = pts.map((p) => p.time);
  const tMin = Math.min(...ts), tMax = Math.max(...ts), tSpan = (tMax - tMin) || 1;
  const vs = pts.map((p) => p.value);
  let vMin = Math.min(...vs), vMax = Math.max(...vs);
  if (baseline != null) { vMin = Math.min(vMin, baseline); vMax = Math.max(vMax, baseline); }
  const padV = (vMax - vMin) * 0.06 || 1;
  vMin -= padV; vMax += padV;
  const vSpan = (vMax - vMin) || 1;
  const xOf = (t) => pad.l + ((t - tMin) / tSpan) * innerW;
  const yOf = (v) => pad.t + (1 - (v - vMin) / vSpan) * innerH;

  const line = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.time).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${xOf(tMax).toFixed(1)},${yOf(vMin).toFixed(1)} L${xOf(tMin).toFixed(1)},${yOf(vMin).toFixed(1)} Z`;
  const yt = [0, 0.25, 0.5, 0.75, 1].map((f) => vMin + f * vSpan);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      <defs>
        <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {yt.map((tv, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={yOf(tv)} y2={yOf(tv)} stroke={GRID} />
          <text x={pad.l - 8} y={yOf(tv) + 3} textAnchor="end" fontSize="11" fill={AXIS}>{fmtCompact(tv)}</text>
        </g>
      ))}
      {baseline != null && (
        <line x1={pad.l} x2={W - pad.r} y1={yOf(baseline)} y2={yOf(baseline)}
              stroke="#64748b" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={area} fill="url(#eqfill)" stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      {yearTicks(tMin, tMax).map((tk, i) => (
        <text key={i} x={xOf(tk.t)} y={H - 8} textAnchor="middle" fontSize="10" fill={AXIS}>{tk.label}</text>
      ))}
    </svg>
  );
}

/**
 * DrawdownCurve — underwater equity (all values <= 0), red area from zero down.
 * `points` = [{time, value}] in dollars (value <= 0).
 */
export function DrawdownCurve({ points = [], height = 160 }) {
  const W = 1000, H = height;
  const pad = { l: 70, r: 16, t: 12, b: 22 };
  const innerW = W - pad.l - pad.r, innerH = H - pad.t - pad.b;
  const pts = points.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.time));
  if (pts.length < 2) return <Empty height={H} />;

  const ts = pts.map((p) => p.time);
  const tMin = Math.min(...ts), tMax = Math.max(...ts), tSpan = (tMax - tMin) || 1;
  const vMin = Math.min(...pts.map((p) => p.value), 0);
  const vSpan = (0 - vMin) || 1;
  const xOf = (t) => pad.l + ((t - tMin) / tSpan) * innerW;
  const yOf = (v) => pad.t + (1 - (v - vMin) / vSpan) * innerH; // 0 at top, vMin at bottom

  const line = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.time).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${xOf(tMax).toFixed(1)},${yOf(0).toFixed(1)} L${xOf(tMin).toFixed(1)},${yOf(0).toFixed(1)} Z`;
  const yt = [0, vMin / 2, vMin];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      <defs>
        <linearGradient id="ddfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ef4444" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {yt.map((tv, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={yOf(tv)} y2={yOf(tv)} stroke={GRID} />
          <text x={pad.l - 8} y={yOf(tv) + 3} textAnchor="end" fontSize="11" fill={AXIS}>{fmtCompact(tv)}</text>
        </g>
      ))}
      <path d={area} fill="url(#ddfill)" stroke="none" />
      <path d={line} fill="none" stroke="#ef4444" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
      {yearTicks(tMin, tMax).map((tk, i) => (
        <text key={i} x={xOf(tk.t)} y={H - 6} textAnchor="middle" fontSize="10" fill={AXIS}>{tk.label}</text>
      ))}
    </svg>
  );
}

/**
 * MonthlyHeatmap — year rows × 12 month columns, cell colored green/red by net
 * P&L magnitude relative to the largest absolute month. `grid` =
 * [{year, months:[12 nullable $], total}].
 */
export function MonthlyHeatmap({ grid = [] }) {
  if (!grid.length) return <Empty height={120} />;
  const all = grid.flatMap((r) => r.months).filter((v) => Number.isFinite(v));
  const max = all.length ? Math.max(...all.map(Math.abs)) : 1;
  const colorOf = (v) => {
    if (!Number.isFinite(v)) return "transparent";
    const a = Math.min(1, Math.abs(v) / (max || 1));
    return v >= 0 ? `rgba(34,197,94,${0.10 + 0.62 * a})` : `rgba(239,68,68,${0.10 + 0.62 * a})`;
  };
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] font-mono border-separate" style={{ borderSpacing: "2px" }}>
        <thead>
          <tr>
            <th className="text-muted font-normal text-right pr-1">Year</th>
            {MONTHS.map((m) => <th key={m} className="text-muted font-normal text-center w-12">{m}</th>)}
            <th className="text-muted font-normal text-center w-16 pl-1">Year</th>
          </tr>
        </thead>
        <tbody>
          {grid.map((row) => (
            <tr key={row.year}>
              <td className="text-muted text-right pr-1">{row.year}</td>
              {row.months.map((v, mi) => (
                <td key={mi} className="w-12 h-7 text-center rounded-sm text-text/90"
                    style={{ background: colorOf(v) }}
                    title={Number.isFinite(v) ? `${MONTHS[mi]} ${row.year}: ${fmtUsd(v)}` : `${MONTHS[mi]} ${row.year}: no trades`}>
                  {Number.isFinite(v) ? fmtCompact(v) : ""}
                </td>
              ))}
              <td className={`w-16 text-right pr-1 font-semibold ${row.total >= 0 ? "text-profit" : "text-loss"}`}>
                {fmtCompact(row.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
