import { fmtNum, fmtPct, fmtRatio } from "../../services/format.js";

function Row({ label, value, sub, tone }) {
  const cls = tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-text";
  return (
    <div className="flex items-center justify-between py-2 border-b border-line/60 last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-right">
        <span className={`text-sm font-mono ${cls}`}>{value}</span>
        {sub && <span className="block text-[10px] text-muted font-mono">{sub}</span>}
      </span>
    </div>
  );
}

/**
 * Right-hand "Risk & Return" panel. `m` is a flat object of already-resolved
 * metric values (see DashboardV2's deriveMetrics); each row degrades to "—".
 */
export default function RiskReturnPanel({ m }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="text-sm font-semibold text-text">Risk &amp; Return</div>
      <div className="text-xs text-muted mb-2">Full-period statistics</div>
      <div>
        <Row label="Volatility (ann.)" value={m.vol == null ? "—" : `${fmtNum(m.vol)}%`} />
        <Row label="Calmar Ratio" value={fmtRatio(m.calmar)} />
        <Row label="Profit Factor" value={fmtRatio(m.profitFactor)} />
        <Row
          label="Best Month"
          value={m.best ? fmtPct(m.best.pct) : "—"}
          sub={m.best?.month}
          tone={m.best && m.best.pct >= 0 ? "profit" : m.best ? "loss" : "neutral"}
        />
        <Row
          label="Worst Month"
          value={m.worst ? fmtPct(m.worst.pct) : "—"}
          sub={m.worst?.month}
          tone={m.worst && m.worst.pct >= 0 ? "profit" : m.worst ? "loss" : "neutral"}
        />
        <Row label="Avg Exposure" value={m.exposure == null ? "—" : `${fmtNum(m.exposure)}%`} />
      </div>
    </div>
  );
}
