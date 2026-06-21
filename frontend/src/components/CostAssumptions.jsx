import { useEffect, useState } from "react";
import { getRiskConfig } from "../services/api.js";
import { fmtUsd } from "../services/format.js";

/**
 * Read-only cost assumptions line (fees / slippage / starting capital).
 *
 * Two modes:
 *   - live (default): fetches the current global risk config, so setup pages
 *     always show what the next run will be charged. Editable on Risk Settings.
 *   - snapshot: pass `rc` (e.g. the risk_config recorded inside a grid-search
 *     result) to show the costs a PAST run actually used, with the edit link
 *     hidden — historical results must not display the current config.
 */

function CostStat({ label, value, warn }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono text-sm ${warn ? "text-amber-400" : "text-text"}`}>{value}</div>
    </div>
  );
}

export default function CostAssumptions({
  rc: rcProp = null,
  title = "Cost assumptions",
  showEditLink = true,
  warnOnZero = true,
  className = "flex flex-wrap items-center gap-x-6 gap-y-2 pt-2 border-t border-line/40",
}) {
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (rcProp) return;
    getRiskConfig().then(setFetched).catch(() => {});
  }, [rcProp]);

  const rc = rcProp || fetched;
  if (!rc) return null;

  const feePct = Number(rc.fee_pct) || 0;
  const feeFlat = Number(rc.fee_flat) || 0;
  const slipBps = Number(rc.slippage_bps) || 0;
  const futCom = Number(rc.futures_commission) || 0;
  const allZero = feePct === 0 && feeFlat === 0 && slipBps === 0 && futCom === 0;

  return (
    <div className={className}>
      <div className="text-[11px] uppercase tracking-wider text-muted">{title}</div>
      <CostStat label="Fee / side" value={`${feePct}%`} warn={warnOnZero && allZero} />
      <CostStat label="Flat fee / side" value={`$${feeFlat}`} />
      <CostStat label="Slippage" value={`${slipBps} bps`} warn={warnOnZero && allZero} />
      <CostStat label="Futures comm. / contract" value={`$${futCom}`} />
      <CostStat label="Starting capital" value={fmtUsd(Number(rc.starting_capital) || 0)} />
      {showEditLink && (
        <a href="#settings" className="text-[11px] text-accent-blue hover:underline">Edit in Risk Settings →</a>
      )}
      {warnOnZero && allZero && (
        <span className="text-[11px] text-amber-400 w-full">
          {rcProp
            ? "⚠ All costs were zero — this run was frictionless (too optimistic)."
            : "⚠ All costs are zero — the result will be frictionless (too optimistic). Set a realistic fee % and slippage, then run."}
        </span>
      )}
    </div>
  );
}
