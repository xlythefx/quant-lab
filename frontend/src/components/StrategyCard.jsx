import { TrashIcon } from "./ConfirmModal.jsx";
import { fmtPct, fmtUsd, fmtInt, fmtNum } from "../services/format.js";

export default function StrategyCard({ strategy, color, stats, onSettings, onRemove }) {
  const pnlPct = stats?.total_return_pct;
  const pnlUsd = stats?.total_return_dollars;
  const pnlColor = pnlUsd == null ? "text-muted" : pnlUsd >= 0 ? "text-profit" : "text-loss";

  return (
    <div className="rounded-lg border border-line bg-bg-panel/70 p-3 min-w-[200px] flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 truncate">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-sm font-medium truncate">{strategy?.name || "—"}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onSettings} title="Settings"
                  className="text-muted hover:text-text text-xs px-1.5 py-0.5">⚙</button>
          <button onClick={onRemove} title="Remove"
                  className="text-muted hover:text-loss p-1">
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted font-mono">
        <span>{fmtInt(stats?.trades)} trades</span>
        <span>{stats?.win_rate != null ? `${fmtNum(stats.win_rate * 100)}% win` : "—"}</span>
      </div>
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className={pnlColor}>{fmtUsd(pnlUsd)}</span>
        <span className={pnlColor}>{fmtPct(pnlPct)}</span>
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted font-mono">
        <span>dd {stats?.max_drawdown_pct != null ? `${fmtNum(stats.max_drawdown_pct)}%` : "—"}</span>
        <span>PF {stats?.profit_factor != null ? fmtNum(stats.profit_factor) : "—"}</span>
      </div>
    </div>
  );
}
