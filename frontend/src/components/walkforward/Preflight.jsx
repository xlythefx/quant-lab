import { useEffect, useState } from "react";
import { getRiskConfig } from "../../services/api.js";
import { fmtInt, fmtNum } from "../../services/format.js";

/**
 * Pre-flight checks — the mistakes that are only obvious AFTER a 40-minute run.
 *
 * Every item here corresponds to something that has actually produced a
 * misleading walk-forward result in this project:
 *
 *  - zero costs      : a frictionless book on thousands of trades
 *  - trade_24_7 on   : session windows silently ignored (in_session = all True),
 *                      so a session idea is never tested at all
 *  - min_trades = 1  : only blocks configs that never fire; a winner can still
 *                      rest on a handful of lucky trades
 *  - no leak guard   : embargo and purge both 0
 *  - no search space : nothing to optimize, so the run is just a backtest
 *
 * Warnings, never blocks. Each one is a legitimate choice if made deliberately.
 */
export default function Preflight({ baseParams, searchSpace, minTrades, embargoBars, purgeRadius }) {
  // Same source CostAssumptions reads, so the two can never disagree about
  // whether this run will be charged anything.
  const [rc, setRc] = useState(null);
  useEffect(() => { getRiskConfig().then(setRc).catch(() => {}); }, []);

  const items = [];
  if (!rc) return null;
  const feePct = Number(rc.fee_pct ?? 0);
  const feeFlat = Number(rc.fee_flat ?? 0);
  const slip = Number(rc.slippage_bps ?? 0);
  const futComm = Number(rc.futures_commission ?? 0);
  if (!feePct && !feeFlat && !slip && !futComm) {
    items.push({
      key: "costs",
      text: <>All trading costs are <span className="font-mono">0</span> in Risk Settings — this run will be
        frictionless. On a strategy that trades often, fees and slippage are usually the difference between
        an edge and no edge.</>,
      fix: "Risk Settings → set a realistic fee % and slippage (bps)",
    });
  }

  if (baseParams?.trade_24_7) {
    const enabled = Object.entries(baseParams?.sessions || {}).filter(([, c]) => c?.enabled);
    items.push({
      key: "247",
      text: <><span className="font-mono">trade_24_7</span> is on, so the strategy trades every hour and the
        session windows are ignored entirely
        {enabled.length > 0 && <> — including the {fmtInt(enabled.length)} you have switched on</>}.
        If you meant to test a session idea, this run will not test it.</>,
      fix: "Parameter editor → turn trade_24_7 off",
    });
  }

  if (Number(minTrades) <= 1) {
    items.push({
      key: "mintrades",
      text: <><span className="font-mono">Min IS trades</span> is {fmtInt(minTrades || 0)} — that only rules out
        configs which never trade. A window can still be won by a config picked on two or three lucky trades,
        and its annualized Sharpe will look spectacular.</>,
      fix: "Set Min IS trades to ~30",
    });
  }

  if (!Number(embargoBars) && !Number(purgeRadius)) {
    items.push({
      key: "leak",
      text: <>Embargo and purge are both <span className="font-mono">0</span>, so training runs right up against
        testing with no gap. Trades straddling that boundary can leak.</>,
      fix: "Rigor → set embargo to about one trade's length in bars",
    });
  }

  if (!(searchSpace || []).length) {
    items.push({
      key: "nosearch",
      text: <>No parameters are marked <span className="text-text">Search</span>, so nothing gets optimized —
        this run is a rolling backtest of fixed params, not a walk-forward.</>,
      fix: "Toggle Search on the params you want tuned",
    });
  }

  if (!items.length) {
    return (
      <div className="rounded-md border border-profit/30 bg-profit/5 px-3 py-2 text-[11px] text-profit">
        Pre-flight clear — costs set, leak guards on, and every pick will rest on a real sample.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-amber-400">
        Before you run · {fmtInt(items.length)} thing{items.length > 1 ? "s" : ""} to know
      </div>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.key} className="text-[11px] text-muted flex gap-2">
            <span className="text-amber-400/70 shrink-0">•</span>
            <span>
              {it.text}
              <span className="block text-[10px] text-muted/60 mt-0.5">→ {it.fix}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="text-[10px] text-muted/60">
        None of these stop the run — they are only wrong if you did not mean them.
      </div>
    </div>
  );
}

/**
 * What this run will actually cost: window count × trials, plus one control-arm
 * backtest per window, plus the deploy-candidate evaluations at the end.
 * Throughput is measured from observed runs (~11 backtests/sec/worker on a
 * 2k-bar window); treat the clock as an order of magnitude, not a promise.
 */
export function RunCost({ dataset, isBars, oosBars, embargoBars, nTrials, nWorkers, searchSpaceLen }) {
  const rows = dataset?.rows;
  if (!rows || !isBars || !oosBars) return null;
  const nWindows = Math.max(2, Math.floor((rows - isBars - (embargoBars || 0)) / oosBars));
  const trials = searchSpaceLen > 0 ? Math.max(1, nTrials || 0) : 0;
  const backtests = nWindows * (trials + 1) + 3;    // +1 control arm, +3 deploy candidate
  const perSec = 11 * Math.max(1, nWorkers || 1);
  const sec = backtests / perSec;
  const clock = sec < 90 ? `~${Math.round(sec)}s`
    : sec < 5400 ? `~${Math.round(sec / 60)} min`
    : `~${fmtNum(sec / 3600)} h`;

  return (
    <div className="text-[11px] text-muted">
      <span className="text-text font-mono">{fmtInt(nWindows)}</span> windows ×{" "}
      <span className="text-text font-mono">{fmtInt(trials)}</span> trials
      {" "}+ {fmtInt(nWindows)} control runs ={" "}
      <span className="text-text font-mono">{fmtInt(backtests)}</span> backtests ·{" "}
      <span className="text-text font-mono">{clock}</span> at {fmtInt(nWorkers || 1)} worker
      {(nWorkers || 1) > 1 ? "s" : ""}
      <span className="text-muted/60"> (rough — depends on strategy and window size)</span>
    </div>
  );
}
