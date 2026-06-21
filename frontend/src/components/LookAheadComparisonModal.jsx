import { useEffect, useState } from "react";
import CustomEquityChart from "./CustomEquityChart.jsx";
import { runBacktest } from "../services/api.js";
import { fmtUsd, fmtPct } from "../services/format.js";

/**
 * Look-Ahead vs Reality — runs the SAME strategy twice over the same window,
 * once honestly (look_ahead OFF) and once with look-ahead perfect fills ON,
 * and overlays both equity curves. The point is pedagogical and honest: the
 * look-ahead curve is the "matches TradeStation" fantasy, the honest curve is
 * what's actually tradeable, and the labeled gap between them is the inflation
 * you'd be hiding if you ever showed the look-ahead number as real.
 *
 * props: open, onClose, strategyId, symbol, timeframe, broker, params,
 *        startTime, endTime (epoch secs | undefined), startingCapital, color
 */
const HONEST_COLOR = "#22c55e";   // green — the real, tradeable curve
const AHEAD_COLOR  = "#ef4444";   // red — fictitious look-ahead ceiling

export default function LookAheadComparisonModal({
  open, onClose, strategyId, symbol, timeframe, broker, params,
  startTime, endTime, startingCapital = 100000,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [honest, setHonest] = useState(null);
  const [ahead, setAhead] = useState(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true); setError(null); setHonest(null); setAhead(null);

    const call = (look_ahead) => runBacktest({
      strategy_id: strategyId, symbol, timeframe, broker,
      params: { ...params, look_ahead },
      start_time: startTime, end_time: endTime,
    });

    Promise.all([call(false), call(true)])
      .then(([h, a]) => { if (alive) { setHonest(h); setAhead(a); } })
      .catch((e) => { if (alive) setError(e?.message || "backtest failed"); })
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; };
  }, [open, strategyId, symbol, timeframe, broker, startTime, endTime, JSON.stringify(params)]);

  if (!open) return null;

  const toPoints = (r) => (r?.equity || []).map((p) => ({ time: p.time, value: p.value }));
  const series = [
    { id: "honest", color: HONEST_COLOR, label: "Reality (tradeable)" },
    { id: "ahead",  color: AHEAD_COLOR,  label: "Look-ahead (fictitious)" },
  ];
  const pointsByStrategy = { honest: toPoints(honest), ahead: toPoints(ahead) };

  const hPnl = honest?.stats?.total_return_dollars;
  const aPnl = ahead?.stats?.total_return_dollars;
  const gap  = (hPnl != null && aPnl != null) ? aPnl - hPnl : null;
  // How much of the look-ahead number is pure fantasy (gap as % of the inflated total).
  const inflationPct = (gap != null && aPnl) ? (gap / Math.abs(aPnl)) * 100 : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
         onClick={onClose}>
      <div className="bg-bg-panel border border-line rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="px-6 py-4 border-b border-line flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2">
              Look-Ahead vs Reality
              <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-loss/15 text-loss border border-loss/30">
                ⚠ exhibit
              </span>
            </h3>
            <p className="text-xs text-muted mt-1 max-w-2xl">
              The same strategy, same window — run honestly and with look-ahead "perfect" fills.
              The red curve is the unrealistic version that lines up with TradeStation; the green
              curve is what you could actually trade. The gap is the lie.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-2xl leading-none shrink-0">×</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {loading && (
            <div className="h-[320px] flex items-center justify-center text-sm text-muted">
              Running both backtests…
            </div>
          )}
          {error && !loading && (
            <div className="h-[120px] flex items-center justify-center text-sm text-loss">{error}</div>
          )}

          {!loading && !error && honest && ahead && (
            <>
              {/* headline numbers */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-profit/30 bg-profit/5 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted">Reality · tradeable</div>
                  <div className="text-xl font-semibold text-profit mt-1">{fmtUsd(hPnl)}</div>
                  <div className="text-[11px] text-muted mt-0.5">look-ahead OFF — this is the number to show</div>
                </div>
                <div className="rounded-xl border border-loss/30 bg-loss/5 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted">Look-ahead · fictitious</div>
                  <div className="text-xl font-semibold text-loss mt-1">{fmtUsd(aPnl)}</div>
                  <div className="text-[11px] text-muted mt-0.5">≈ TradeStation — not achievable live</div>
                </div>
                <div className="rounded-xl border border-line bg-bg-elev/40 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted">Inflation gap</div>
                  <div className="text-xl font-semibold text-accent-yellow mt-1">{fmtUsd(gap)}</div>
                  <div className="text-[11px] text-muted mt-0.5">
                    {inflationPct != null ? `${fmtPct(inflationPct, false)} of the look-ahead total is fantasy` : ""}
                  </div>
                </div>
              </div>

              {/* overlay chart */}
              <div className="h-[320px] rounded-xl border border-line bg-bg/40 overflow-hidden">
                <CustomEquityChart
                  strategies={series}
                  pointsByStrategy={pointsByStrategy}
                  startingCapital={startingCapital}
                />
              </div>

              {/* legend + reading */}
              <div className="flex flex-wrap items-center gap-4 text-[11px]">
                {series.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5">
                    <span className="w-3 h-[2px] rounded-sm" style={{ background: s.color }} />
                    <span className="text-muted">{s.label}</span>
                  </div>
                ))}
                <span className="text-muted/70 font-mono">
                  {honest?.stats?.trades ?? 0} trades · {symbol} {timeframe}
                </span>
              </div>

              <div className="rounded-xl border border-line/60 bg-bg-elev/30 px-4 py-3 text-xs text-muted leading-relaxed">
                <span className="text-text font-medium">How to read this:</span> the look-ahead run fills every
                entry at the bar's most favorable price — information you can't have until the bar is over. It can
                only help, so it inflates monotonically. The fact that it lands near the TradeStation figure is the
                finding: <span className="text-text">TradeStation's number is carrying the same optimism.</span>{" "}
                The realistic, defensible result is the green curve.
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-line flex justify-end">
          <button onClick={onClose}
                  className="px-4 py-1.5 rounded-md border border-line text-muted text-sm hover:text-text">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
