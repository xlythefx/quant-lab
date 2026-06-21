import { useEffect } from "react";
import { fmtUsd, fmtNum } from "../services/format.js";
import CostAssumptions from "./CostAssumptions.jsx";

/**
 * Execution-cost breakdown for the last dashboard backtest.
 *
 * Shows the actual dollars that fees and slippage subtracted from the run,
 * a per-strategy split, and the cost assumptions (fee model) that produced
 * them. Driven entirely off the portfolio result the dashboard already holds:
 *   - result.risk_config            — the rc this run was charged under
 *   - result.analytics.commission_dollars / slippage_dollars — aggregate cost
 *   - result.per_strategy[sid].analytics / .stats — per-strategy split
 *
 * Slippage dollars are baked into each fill price (they don't show up as a
 * separate line in equity) — surfacing them here makes the friction explicit.
 */
export default function CostBreakdownModal({
  open,
  onClose,
  result,
  catalogById = {},
  isContractSized = false,
}) {
  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !result) return null;

  const rc = result.risk_config || {};
  const agg = result.analytics || {};
  const stats = result.stats || {};

  const totalFees = Number(agg.commission_dollars) || 0;
  const totalSlip = Number(agg.slippage_dollars) || 0;
  const totalCost = totalFees + totalSlip;
  const netPnl = Number(stats.total_return_dollars) || 0;
  const grossPnl = netPnl + totalCost;     // estimated frictionless P&L
  const startCap = Number(rc.starting_capital) || 0;
  const costPctCap = startCap ? (totalCost / startCap) * 100 : 0;

  // Per-strategy split. Falls back to a single aggregate row if an older
  // cached result has no per_strategy block.
  const perStrategy = result.per_strategy || {};
  const rows = Object.entries(perStrategy).map(([sid, psd]) => ({
    sid,
    name: catalogById[sid]?.name || sid,
    trades: psd.stats?.trades || 0,
    fees: Number(psd.analytics?.commission_dollars) || 0,
    slippage: Number(psd.analytics?.slippage_dollars) || 0,
  }));
  const showRows = rows.length > 1;

  const feePct = Number(rc.fee_pct) || 0;
  const feeFlat = Number(rc.fee_flat) || 0;
  const futCom = Number(rc.futures_commission) || 0;
  const slipBps = Number(rc.slippage_bps) || 0;

  const feeModelText = isContractSized
    ? `Futures model — $${fmtNum(feeFlat)} flat + $${fmtNum(futCom)} commission per contract, per side. The % fee is ignored for contract-sized instruments.`
    : `Crypto / spot model — $${fmtNum(feeFlat)} flat + ${fmtNum(feePct)}% of notional, per side.`;

  const Stat = ({ label, value, cls = "text-text", sub }) => (
    <div className="flex-1 min-w-[120px]">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono text-lg ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70 font-mono">{sub}</div>}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl border border-line bg-bg-panel shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-line sticky top-0 bg-bg-panel z-10">
          <div>
            <div className="text-sm font-semibold text-text">Execution Costs</div>
            <div className="text-[11px] text-muted">Fees & slippage subtracted from this backtest</div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text text-lg leading-none px-2"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Headline cost numbers */}
          <div className="flex flex-wrap gap-4 rounded-xl border border-line/60 bg-bg-elev/30 p-4">
            <Stat label="Fees" value={fmtUsd(totalFees)} cls="text-loss" />
            <Stat label="Slippage" value={fmtUsd(totalSlip)} cls="text-loss" />
            <Stat
              label="Total cost drag"
              value={fmtUsd(totalCost)}
              cls="text-amber-400"
              sub={`${fmtNum(costPctCap)}% of starting capital`}
            />
          </div>

          {/* P&L context */}
          <div className="flex flex-wrap gap-4 rounded-xl border border-line/40 p-4">
            <Stat
              label="P&L before costs (est.)"
              value={fmtUsd(grossPnl)}
              cls={grossPnl >= 0 ? "text-profit" : "text-loss"}
            />
            <Stat
              label="Net P&L (after costs)"
              value={fmtUsd(netPnl)}
              cls={netPnl >= 0 ? "text-profit" : "text-loss"}
            />
          </div>

          {/* Per-strategy split */}
          {showRows && (
            <div className="rounded-xl border border-line/60 overflow-hidden">
              <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-muted border-b border-line/60">
                Per strategy
              </div>
              <table className="w-full text-xs font-mono">
                <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elev/40">
                  <tr>
                    <th className="text-left px-3 py-2">Strategy</th>
                    <th className="text-right px-3 py-2">Trades</th>
                    <th className="text-right px-3 py-2">Fees</th>
                    <th className="text-right px-3 py-2">Slippage</th>
                    <th className="text-right px-3 py-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.sid} className="border-t border-line/40">
                      <td className="px-3 py-2 truncate">{r.name}</td>
                      <td className="px-3 py-2 text-right">{r.trades}</td>
                      <td className="px-3 py-2 text-right text-loss">{fmtUsd(r.fees)}</td>
                      <td className="px-3 py-2 text-right text-loss">{fmtUsd(r.slippage)}</td>
                      <td className="px-3 py-2 text-right text-amber-400">{fmtUsd(r.fees + r.slippage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* What fees were used */}
          <div className="rounded-xl border border-line/60 bg-bg-elev/30 p-4 flex flex-col gap-3">
            <div className="text-[11px] uppercase tracking-widest text-muted">Fee model applied</div>
            <p className="text-xs text-text/90 leading-relaxed">{feeModelText}</p>
            <p className="text-xs text-text/90 leading-relaxed">
              Slippage — {fmtNum(slipBps)} bps applied adversely to every fill (entry and exit).
            </p>
            <CostAssumptions rc={rc} title="Run cost assumptions" showEditLink={false} />
            <a href="#settings" className="text-[11px] text-accent-blue hover:underline self-start">
              Edit fees & slippage in Risk Settings →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
