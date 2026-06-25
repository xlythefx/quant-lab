import { TrashIcon } from "./ConfirmModal.jsx";
import { fmtPct, fmtUsd, fmtInt, fmtNum } from "../services/format.js";

export default function StrategyCard({
  strategy, color, stats, priority, canMoveUp, canMoveDown,
  onSettings, onRemove, onMoveUp, onMoveDown,
}) {
  const pnlPct = stats?.total_return_pct;
  const pnlUsd = stats?.total_return_dollars;
  const pnlColor = pnlUsd == null ? "text-muted" : pnlUsd >= 0 ? "text-profit" : "text-loss";

  return (
    <div className="rounded-lg border border-line bg-bg-panel/70 p-3 min-w-[200px] flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 truncate">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
          {priority != null && (
            <span title={`Priority ${priority} (lower wins same-bar cash conflicts)`}
                  className="text-[10px] font-mono text-muted bg-bg-elev rounded px-1 py-0.5 shrink-0">
              #{priority}
            </span>
          )}
          <span className="text-sm font-medium truncate">{strategy?.name || "—"}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {onMoveUp && (
            <button onClick={onMoveUp} disabled={!canMoveUp}
                    title="Increase priority"
                    className="text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1">▲</button>
          )}
          {onMoveDown && (
            <button onClick={onMoveDown} disabled={!canMoveDown}
                    title="Decrease priority"
                    className="text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed text-xs px-1">▼</button>
          )}
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
        <span title="Worst peak-to-trough drawdown (% of running peak equity — TradingView convention)">
          dd {stats?.max_drawdown_pct_peak != null
                ? `${fmtNum(stats.max_drawdown_pct_peak)}%`
                : stats?.max_drawdown_pct != null
                  ? `${fmtNum(stats.max_drawdown_pct)}%`
                  : "—"}
        </span>
        <span>PF {stats?.profit_factor != null ? fmtNum(stats.profit_factor) : "—"}</span>
      </div>
    </div>
  );
}
