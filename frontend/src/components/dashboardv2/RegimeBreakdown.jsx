import { useState } from "react";
import { REGIME_COLORS, ADX_REGIME_COLORS } from "../marketlab/charts.jsx";
import { fmtInt, fmtNum, fmtPct } from "../../services/format.js";

// "Did the regime matter for THIS strategy?" — trades grouped by the regime on
// the last closed candle before each entry (what a regime filter would see),
// against the all-trades baseline. The whisker is ±2 standard errors: a group
// whose difference from the baseline stays inside it is most likely luck.
export default function RegimeBreakdown({ data }) {
  const [lens, setLens] = useState("five");
  if (!data?.all) return null;
  const rows = (lens === "adx" ? data.adx : data.five) || [];
  const colors = lens === "adx" ? ADX_REGIME_COLORS : REGIME_COLORS;
  const base = data.all;
  // Shared scale: the widest |avg ± 2·se| across rows (and the baseline).
  const reach = Math.max(
    Math.abs(base.avg_pnl_pct),
    ...rows.map((r) => Math.abs(r.avg_pnl_pct) + 2 * (r.se_pct || 0)),
    0.01,
  );
  const pos = (v) => 50 + (v / reach) * 50;   // % from the left, 0 at the middle

  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-[11px] text-muted font-mono">
          All trades: {fmtInt(base.trades)} · avg {fmtPct(base.avg_pnl_pct)} per trade · {fmtNum(base.win_rate * 100)}% win
        </div>
        <div className="flex items-center gap-1 p-0.5 rounded-md border border-line bg-bg-elev">
          {[["five", "5-Regime"], ["adx", `ADX ${fmtInt(data.meta?.adx_period)}/${fmtInt(data.meta?.adx_trend_thresh)}`]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setLens(k)}
              className={`px-2 py-0.5 text-[11px] rounded transition ${lens === k ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {rows.map((r) => {
          const diff = r.avg_pnl_pct - base.avg_pnl_pct;
          const verdict = r.trades < 30 ? { t: "too few trades", c: "text-muted" }
            : r.se_pct != null && Math.abs(diff) > 2 * r.se_pct
              ? (diff > 0 ? { t: "better than baseline", c: "text-profit" } : { t: "worse than baseline", c: "text-loss" })
              : { t: "within noise", c: "text-muted" };
          const lo = pos(r.avg_pnl_pct - 2 * (r.se_pct || 0));
          const hi = pos(r.avg_pnl_pct + 2 * (r.se_pct || 0));
          return (
            <div key={r.regime} className="grid grid-cols-[150px_1fr_220px] items-center gap-3 text-[11px]">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colors[r.regime] || "#64748b" }} />
                <span className="text-text truncate">{r.regime}</span>
                <span className="text-muted">{fmtInt(r.trades)}</span>
              </div>
              <div className="relative h-4 rounded bg-bg-elev/60">
                <div className="absolute top-0 bottom-0 w-px bg-line" style={{ left: "50%" }} />
                <div className="absolute top-0 bottom-0 w-px bg-accent-cyan/60" style={{ left: `${pos(base.avg_pnl_pct)}%` }} title="all-trades baseline" />
                <div className="absolute top-1/2 h-px bg-muted/60" style={{ left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` }} />
                <div
                  className={`absolute top-1 bottom-1 w-1.5 rounded-sm ${r.avg_pnl_pct >= 0 ? "bg-profit" : "bg-loss"}`}
                  style={{ left: `calc(${pos(r.avg_pnl_pct)}% - 3px)` }}
                />
              </div>
              <div className="font-mono flex items-center justify-between gap-2">
                <span className={r.avg_pnl_pct >= 0 ? "text-profit" : "text-loss"}>{fmtPct(r.avg_pnl_pct)}</span>
                <span className="text-muted">{fmtNum(r.win_rate * 100)}% win</span>
                <span className={verdict.c}>{verdict.t}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-muted/80 mt-3 leading-snug">
        Regime = the label on the last closed candle before each entry — what a regime filter would have seen.
        Avg = price move per trade, before fees. Dot = the group's average; line = ±2 standard errors; cyan tick = all trades.
        If the cyan tick sits inside a group's line, that group isn't really different — the gap is most likely luck.
      </div>
    </div>
  );
}
