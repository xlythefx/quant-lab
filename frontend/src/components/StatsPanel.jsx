import { fmtUsd, fmtPct, fmtNum, fmtInt } from "../services/format.js";

function fmtDate(epochSec) {
  if (epochSec == null) return "—";
  return new Date(epochSec * 1000).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

/**
 * Insights table — one row per active strategy.
 */
export default function StatsPanel({ strategies, statsById }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
      <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-muted border-b border-line/60">
        Insights
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elev/40">
            <tr>
              <th className="text-left px-3 py-2">Strategy</th>
              <th className="text-right px-3 py-2">PnL $</th>
              <th className="text-right px-3 py-2">PnL %</th>
              <th className="text-right px-3 py-2">Trades</th>
              <th className="text-right px-3 py-2">Win %</th>
              <th className="text-right px-3 py-2">PF</th>
              <th className="text-right px-3 py-2">Sharpe</th>
              <th className="text-right px-3 py-2">Max DD</th>
              <th className="text-right px-3 py-2 border-l border-line/40">Long PnL</th>
              <th className="text-right px-3 py-2">Long #</th>
              <th className="text-right px-3 py-2">Long W%</th>
              <th className="text-right px-3 py-2 border-l border-line/40">Short PnL</th>
              <th className="text-right px-3 py-2">Short #</th>
              <th className="text-right px-3 py-2">Short W%</th>
              <th className="text-right px-3 py-2 border-l border-line/40">Data From</th>
              <th className="text-right px-3 py-2">Data To</th>
            </tr>
          </thead>
          <tbody>
            {strategies.length === 0 && (
              <tr><td colSpan={16} className="px-3 py-4 text-center text-muted">no active strategies</td></tr>
            )}
            {strategies.map((s) => {
              const st = statsById[s.id] || {};
              const pnl = st.total_return_dollars;
              const pnlClass = pnl == null ? "text-muted" : pnl >= 0 ? "text-profit" : "text-loss";
              const longPnl = st.long?.pnl_dollars;
              const shortPnl = st.short?.pnl_dollars;
              return (
                <tr key={s.id} className="border-t border-line/40 hover:bg-bg-elev/30 font-mono">
                  <td className="px-3 py-2 truncate">
                    <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: s.color }} />
                    {s.id}
                  </td>
                  <td className={`px-3 py-2 text-right ${pnlClass}`}>{fmtUsd(pnl)}</td>
                  <td className={`px-3 py-2 text-right ${pnlClass}`}>{fmtPct(st.total_return_pct)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(st.trades)}</td>
                  <td className="px-3 py-2 text-right">{st.win_rate != null ? `${fmtNum(st.win_rate * 100)}%` : "—"}</td>
                  <td className="px-3 py-2 text-right">{st.profit_factor != null ? fmtNum(st.profit_factor) : "∞"}</td>
                  <td className="px-3 py-2 text-right">{fmtNum(st.sharpe)}</td>
                  <td className="px-3 py-2 text-right text-loss" title="Top line: % of starting capital. Bottom line: % of running peak equity (TradingView convention).">
                    {st.max_drawdown_pct != null ? `${fmtNum(Math.abs(st.max_drawdown_pct))}%` : "—"}
                    {st.max_drawdown_pct_peak != null && (
                      <div className="text-[10px] text-muted/80 font-mono">peak {fmtNum(Math.abs(st.max_drawdown_pct_peak))}%</div>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right border-l border-line/40 ${longPnl == null ? "text-muted" : longPnl >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(longPnl)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(st.long?.trades)}</td>
                  <td className="px-3 py-2 text-right">{st.long?.win_rate != null ? `${fmtNum(st.long.win_rate * 100)}%` : "—"}</td>
                  <td className={`px-3 py-2 text-right border-l border-line/40 ${shortPnl == null ? "text-muted" : shortPnl >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(shortPnl)}</td>
                  <td className="px-3 py-2 text-right">{fmtInt(st.short?.trades)}</td>
                  <td className="px-3 py-2 text-right">{st.short?.win_rate != null ? `${fmtNum(st.short.win_rate * 100)}%` : "—"}</td>
                  <td className="px-3 py-2 text-right text-muted border-l border-line/40 whitespace-nowrap">{fmtDate(st.first_time)}</td>
                  <td className="px-3 py-2 text-right text-muted whitespace-nowrap">{fmtDate(st.last_time)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
