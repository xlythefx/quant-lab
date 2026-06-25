import { fmtPct, fmtUsd, fmtInt, fmtNum } from "../services/format.js";

/**
 * Aggregate portfolio panel — shown on the Dashboard when 2+ strategies
 * are active and a portfolio backtest has produced an aggregate result.
 * Surfaces total P&L, sharpe, max DD, plus a skipped-signals banner with
 * the counterfactual P&L (what the skipped entries would have made if
 * cash had been available — the diagnostic for tuning per-strategy risk).
 */
export default function PortfolioSummary({ result, symbol, timeframe }) {
  if (!result) return null;

  const stats = result.stats || {};
  const skipped = result.skipped_signals || [];
  const skipCount = skipped.length;

  let cfSum = 0;
  let cfWins = 0;
  let cfLosses = 0;
  const cfBySid = {};
  for (const sk of skipped) {
    const pnl = sk.would_be_pnl;
    if (pnl == null) continue;
    cfSum += pnl;
    if (pnl > 0) cfWins++;
    else if (pnl < 0) cfLosses++;
    cfBySid[sk.strategy_id] = (cfBySid[sk.strategy_id] || 0) + 1;
  }

  const pnlUsd = stats.total_return_dollars;
  const pnlColor = pnlUsd == null ? "text-muted"
                 : pnlUsd >= 0    ? "text-profit" : "text-loss";

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted">Portfolio</span>
          <span className="text-xs text-muted">
            {result.strategies?.length || 0} strategies · shared cash pool
          </span>
        </div>
        <a href={`#analytics?key=__portfolio__|${symbol}|${timeframe}`}
           className="text-xs text-accent-blue hover:underline">
          Portfolio Analytics →
        </a>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-x-4 gap-y-2 font-mono text-xs">
        <Kpi label="Final equity"  value={fmtUsd(stats.final_equity)} />
        <Kpi label="Total P&L"     value={fmtUsd(pnlUsd)}            valueClass={pnlColor} />
        <Kpi label="Return"        value={fmtPct(stats.total_return_pct)} valueClass={pnlColor} />
        <Kpi label="Sharpe"        value={fmtNum(stats.sharpe)} />
        <Kpi label="Max DD"        value={stats.max_drawdown_pct_peak != null
                                          ? `${fmtNum(stats.max_drawdown_pct_peak)}%`
                                          : stats.max_drawdown_pct != null
                                            ? `${fmtNum(stats.max_drawdown_pct)}%` : "—"}
             valueClass="text-loss" />
        <Kpi label="Trades"        value={fmtInt(stats.trades)} />
      </div>

      {skipCount > 0 && (
        <div className="mt-1 border-t border-line/60 pt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono">
          <span className="text-amber-400 uppercase tracking-wider text-[10px]">⚠ skipped</span>
          <span className="text-muted">
            <span className="text-text">{fmtInt(skipCount)}</span> entries dropped (insufficient cash)
          </span>
          {Object.keys(cfBySid).length > 0 && (
            <span className="text-muted">
              by strategy: {Object.entries(cfBySid)
                .map(([sid, n]) => `${sid}=${n}`).join(", ")}
            </span>
          )}
          <span className={cfSum >= 0 ? "text-profit" : "text-loss"}>
            counterfactual P&L {fmtUsd(cfSum)} ({cfWins}W / {cfLosses}L)
          </span>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, valueClass }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted text-[10px] uppercase tracking-wider">{label}</span>
      <span className={`text-sm ${valueClass || "text-text"}`}>{value ?? "—"}</span>
    </div>
  );
}
