import { useEffect, useMemo, useState } from "react";
import CustomEquityChart from "../CustomEquityChart.jsx";
import { getWalkForwardCurves } from "../../services/api.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtDateLong } from "../../services/format.js";

/**
 * "See Equity Curve" — what the deploy candidate's numbers look like as curves.
 *
 * The walk-forward report validates a PROCEDURE: re-optimize every N bars and
 * trade whatever the search picked. Its stitched curve therefore changes params
 * mid-flight, which is not a thing you can deploy. This modal runs the opposite
 * experiment — hold one set fixed and never touch it — and draws two spans that
 * answer two different questions:
 *
 *   OOS span   — the consensus set, the last window's in-sample pick, and the
 *                untuned baseline, each held fixed across the combined
 *                out-of-sample stretch, plus the stitched procedure curve for
 *                reference. All four start at 100% on the same bar, so the
 *                vertical gaps between them are real and comparable. This is
 *                the evidence half.
 *
 *   Full data  — the consensus set over every bar in the cache. This crosses
 *                back into the windows the optimizer tuned on, so the left
 *                portion is shaded and labelled: it is a picture of the
 *                strategy's shape, NOT a result. Kept visually separate from
 *                the chart above precisely so the two can't be read as one.
 *
 * props: open, onClose, result (a walk-forward result with deploy_candidate)
 */

const C_CONSENSUS = "#3b82f6";   // the set you'd actually deploy
const C_STITCHED  = "#a855f7";   // the re-tune-every-window procedure
const C_LASTWIN   = "#f59e0b";   // last window's in-sample pick
const C_BASELINE  = "#94a3b8";   // untuned defaults

export default function FixedParamEquityModal({ open, onClose, result }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  const dc = result?.deploy_candidate || null;
  const startingCapital = result?.stats?.starting_capital ?? 100000;

  // Named param sets to hold fixed. The consensus set is always present; the
  // other two are the same contrasts the card already scores in text.
  const sets = useMemo(() => {
    if (!dc) return null;
    const out = { consensus: dc.params };
    if (dc.last_window?.params && Object.keys(dc.last_window.params).length) {
      out.last_window = dc.last_window.params;
    }
    if (dc.baseline?.params && Object.keys(dc.baseline.params).length) {
      out.baseline = dc.baseline.params;
    }
    return out;
  }, [dc]);

  useEffect(() => {
    if (!open || !dc || !sets) return;
    let alive = true;
    setLoading(true); setError(null); setData(null);

    getWalkForwardCurves({
      strategy_id: result.strategy_id,
      symbol:      result.symbol,
      timeframe:   result.timeframe,
      oos_start:   dc.oos_start,
      oos_end:     dc.oos_end,
      warmup_bars: result?.wf_spec?.warmup_bars,
      sets,
      full_history: "consensus",
    })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e?.response?.data?.error || e.message || "run failed"); })
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; };
  }, [open, dc, sets, result?.strategy_id, result?.symbol, result?.timeframe]);

  if (!open) return null;

  // ---- OOS-span chart: three fixed sets + the stitched procedure ----------
  // The stitched curve needs no backend call — it's already in the result, on
  // the same span and the same 100% baseline.
  const stitchedPts = (result?.equity || []).map((p) => ({ time: p.time, value: p.value }));
  const curves = data?.curves || {};

  const oosSeries = [
    { id: "consensus",  color: C_CONSENSUS, label: "Consensus set (fixed)", width: 2 },
    curves.last_window && { id: "last_window", color: C_LASTWIN,  label: `Last window's pick (fixed)`, width: 1.2 },
    curves.baseline    && { id: "baseline",    color: C_BASELINE, label: "Untuned defaults (fixed)",   width: 1.2 },
    stitchedPts.length >= 2 && { id: "stitched", color: C_STITCHED, label: "Walk-forward (re-tunes)", width: 1.2, dash: "4 3" },
  ].filter(Boolean);

  const oosPoints = {
    consensus:   curves.consensus?.points || [],
    last_window: curves.last_window?.points || [],
    baseline:    curves.baseline?.points || [],
    stitched:    stitchedPts,
  };

  // ---- Full-history chart -------------------------------------------------
  const full = data?.full || null;
  const fullSeries = [{ id: "full", color: C_CONSENSUS, label: "Consensus set, all data", width: 1.5 }];
  const fullPoints = { full: full?.points || [] };
  const oosStart = dc?.oos_start;

  // Split the full-history return into the half the optimizer had already seen
  // and the half it hadn't. Equity is % of starting capital, so the second leg
  // is (end / value_at_oos_start - 1).
  const vAtOos = full?.value_at_oos_start ?? null;
  const vEnd   = full?.points?.length ? full.points[full.points.length - 1].value : null;
  const tunedLegPct  = vAtOos != null ? vAtOos - 100 : null;
  const honestLegPct = (vAtOos != null && vEnd != null && vAtOos > 0)
    ? (vEnd / vAtOos - 1) * 100 : null;

  const cStats = curves.consensus?.stats || null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
         onClick={onClose}>
      <div className="bg-bg-panel border border-line rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>

        {/* header */}
        <div className="px-6 py-4 border-b border-line flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Equity curve — one set, held fixed</h3>
            <p className="text-xs text-muted mt-1 max-w-3xl">
              The walk-forward result above measures a <span className="text-text">procedure</span> that re-tunes
              every window. Deploying means the opposite: pick one set and leave it alone. These are the curves for
              that — {result?.strategy_id} on {result?.symbol} {result?.timeframe}.
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-2xl leading-none shrink-0">×</button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {loading && (
            <div className="h-[280px] flex flex-col items-center justify-center gap-2 text-sm text-muted">
              <div>Running the backtests…</div>
              <div className="text-[11px] text-muted/70">
                Four runs — three over the out-of-sample span, one over all cached data. On 1m data this takes a while.
              </div>
            </div>
          )}
          {error && !loading && (
            <div className="rounded-xl border border-loss/40 bg-loss/5 px-4 py-3 text-sm text-loss">{error}</div>
          )}

          {!loading && !error && data && (
            <>
              {/* ── Chart 1: the evidence half ─────────────────────────── */}
              <section className="space-y-3">
                <div>
                  <div className="text-sm font-semibold text-text">Held fixed across the out-of-sample span</div>
                  <div className="text-[11px] text-muted mt-0.5">
                    {fmtDateLong(dc.oos_start)} – {fmtDateLong(dc.oos_end)}. Every line starts at 100% on the same
                    bar, so the gaps between them are real. The dashed purple line is the walk-forward procedure
                    itself — it swaps params each window, which is why it isn&apos;t a deployable curve.
                  </div>
                </div>

                <div className="h-[320px] rounded-xl border border-line bg-bg/40 overflow-hidden">
                  <CustomEquityChart
                    strategies={oosSeries}
                    pointsByStrategy={oosPoints}
                    startingCapital={startingCapital}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-4 text-[11px]">
                  {oosSeries.map((s) => (
                    <div key={s.id} className="flex items-center gap-1.5">
                      <span className="w-3 h-[2px] rounded-sm" style={{ background: s.color }} />
                      <span className="text-muted">{s.label}</span>
                    </div>
                  ))}
                </div>

                {cStats && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <MiniStat title="Return" value={fmtPct(cStats.total_return_pct ?? 0)}
                              positive={(cStats.total_return_pct ?? 0) >= 0} />
                    <MiniStat title="Sharpe" value={fmtNum(cStats.sharpe ?? 0)} />
                    <MiniStat title="Max drawdown"
                              value={fmtPct(Math.abs(cStats.max_drawdown_pct ?? 0), false)} positive={false} />
                    <MiniStat title="Trades" value={fmtInt(cStats.trades ?? 0)} />
                  </div>
                )}
              </section>

              {/* ── Chart 2: illustrative only ─────────────────────────── */}
              {full && full.points?.length >= 2 && (
                <section className="space-y-3 pt-2 border-t border-line">
                  <div>
                    <div className="text-sm font-semibold text-text flex items-center gap-2">
                      The same set over all data we have
                      <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-400 border border-amber-400/30">
                        not evidence
                      </span>
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {fmtDateLong(full.first_time)} – {fmtDateLong(full.last_time)} · {fmtInt(full.bars)} bars.
                      Everything left of the amber line is data the optimizer already tuned on, so that stretch is
                      guaranteed to flatter the strategy. Read it for shape — where it stalls, whether it
                      compounds — never for a number.
                    </div>
                  </div>

                  <div className="h-[300px] rounded-xl border border-line bg-bg/40 overflow-hidden">
                    <CustomEquityChart
                      strategies={fullSeries}
                      pointsByStrategy={fullPoints}
                      startingCapital={startingCapital}
                      shades={[{ from: full.first_time, to: oosStart, label: "tuned on this data" }]}
                      markers={[{ time: oosStart, label: "out-of-sample starts" }]}
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <MiniStat title="Whole span" value={fmtPct(full.stats?.total_return_pct ?? 0)}
                              positive={(full.stats?.total_return_pct ?? 0) >= 0}
                              sub={`${fmtInt(full.stats?.trades ?? 0)} trades · Sharpe ${fmtNum(full.stats?.sharpe ?? 0)}`} />
                    <MiniStat title="Tuned-on leg" value={tunedLegPct == null ? "—" : fmtPct(tunedLegPct)}
                              positive={null}
                              sub="the optimizer saw these bars — inflated by construction" />
                    <MiniStat title="Out-of-sample leg" value={honestLegPct == null ? "—" : fmtPct(honestLegPct)}
                              positive={honestLegPct != null ? honestLegPct >= 0 : null}
                              sub="the only half that means anything" />
                  </div>

                  <div className="rounded-xl border border-line/60 bg-bg-elev/30 px-4 py-3 text-xs text-muted leading-relaxed">
                    <span className="text-text font-medium">How to read the split:</span> if the tuned-on leg is
                    strongly positive and the out-of-sample leg is flat or negative, the curve you&apos;re looking at
                    is mostly hindsight. If both legs look similar, that&apos;s the encouraging case — but it still
                    isn&apos;t proof, because you chose these params after seeing the out-of-sample span too. The
                    locked holdout remains the only untouched test.
                  </div>
                </section>
              )}
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

function MiniStat({ title, value, positive, sub }) {
  const tone = positive === true ? "text-profit" : positive === false ? "text-loss" : "text-text";
  return (
    <div className="rounded-xl border border-line bg-bg-elev/40 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className={`text-lg font-semibold mt-1 ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}
