import Sparkline from "./Sparkline.jsx";
import { fmtRatio } from "../../services/format.js";

/**
 * One selectable entry in the V2 strategy sidebar. Works for both a real
 * strategy and the synthetic "Portfolio" aggregate.
 *
 * props:
 *   title, subtitle, color, selected, onSelect
 *   sharpe:    number | null            (shown top-right)
 *   points:    [{time, value}] | null   (mini equity sparkline; null pre-run)
 *   onRemove:  () => void  (optional; omitted for the Portfolio row)
 *   onEdit:    () => void  (optional; opens the param editor — strategy rows only)
 */
export default function SidebarStrategyCard({
  title, subtitle, color, selected, onSelect, sharpe, points, onRemove, onEdit,
}) {
  return (
    <button
      onClick={onSelect}
      className={`group w-full text-left rounded-xl border px-3 py-3 transition ${
        selected
          ? "border-accent-blue/60 bg-bg-elev shadow-[0_0_0_1px_rgba(59,130,246,0.25)]"
          : "border-line bg-bg-panel/50 hover:bg-bg-elev/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
            <span className="text-sm font-medium text-text truncate">{title}</span>
          </div>
          {subtitle && <div className="text-[11px] text-muted mt-0.5 truncate">{subtitle}</div>}
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-mono text-text">{fmtRatio(sharpe)}</div>
          <div className="text-[9px] uppercase tracking-wider text-muted">Sharpe</div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <Sparkline points={points} color={color} />
        <div className="flex items-center gap-0.5">
          {onEdit && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onEdit(); } }}
              className="opacity-0 group-hover:opacity-100 text-muted hover:text-accent-blue p-1 rounded transition cursor-pointer"
              title="Edit parameters"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </span>
          )}
          {onRemove && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onRemove(); } }}
              className="opacity-0 group-hover:opacity-100 text-muted hover:text-loss text-xs px-1.5 py-0.5 rounded transition cursor-pointer"
              title="Remove from portfolio"
            >
              ✕
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
