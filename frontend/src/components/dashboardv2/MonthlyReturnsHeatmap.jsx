import { fmtPct } from "../../services/format.js";
import { MONTH_LABELS } from "./metrics.js";

const GREEN = "#22c55e";
const RED = "#ef4444";

function cellStyle(pct, maxAbs) {
  if (pct == null) return { backgroundColor: "rgba(26,27,40,0.4)" };
  const mag = maxAbs > 0 ? Math.min(1, Math.abs(pct) / maxAbs) : 0;
  const alpha = 0.12 + mag * 0.55;
  const color = pct >= 0 ? GREEN : RED;
  return { backgroundColor: hexA(color, alpha) };
}
function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * Monthly returns heatmap: year rows × 12 month columns + a YTD column.
 * `grid` is the output of metrics.monthlyReturnsGrid(): { rows, maxAbs }.
 */
export default function MonthlyReturnsHeatmap({ grid }) {
  const rows = grid?.rows || [];
  const maxAbs = grid?.maxAbs || 0;

  if (rows.length === 0) {
    return <div className="text-xs text-muted py-6 text-center">no monthly return data</div>;
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* header */}
        <div className="grid grid-cols-[48px_repeat(12,1fr)_64px] gap-1 mb-1">
          <div />
          {MONTH_LABELS.map((m) => (
            <div key={m} className="text-[10px] uppercase tracking-wider text-muted text-center">{m}</div>
          ))}
          <div className="text-[10px] uppercase tracking-wider text-muted text-center">YTD</div>
        </div>
        {/* rows */}
        {rows.map((row) => (
          <div key={row.year} className="grid grid-cols-[48px_repeat(12,1fr)_64px] gap-1 mb-1">
            <div className="text-xs font-mono text-muted flex items-center">{row.year}</div>
            {MONTH_LABELS.map((_, i) => {
              const pct = row.months[i + 1];
              return (
                <div
                  key={i}
                  style={cellStyle(pct, maxAbs)}
                  className="h-8 rounded flex items-center justify-center text-[10px] font-mono text-text/90"
                  title={pct != null ? `${row.year}-${String(i + 1).padStart(2, "0")}: ${fmtPct(pct)}` : ""}
                >
                  {pct != null ? fmtPct(pct, true, "") : ""}
                </div>
              );
            })}
            <div className={`h-8 rounded flex items-center justify-center text-[10px] font-mono border border-line ${
              row.ytdPct >= 0 ? "text-profit" : "text-loss"
            }`}>
              {fmtPct(row.ytdPct)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
