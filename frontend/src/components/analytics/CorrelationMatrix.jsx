// Portfolio correlation & combination analysis.
// Consumes the `correlation` block produced by backend/services/portfolio_correlation.py.
// Read-only: analyses how the strategies in a portfolio relate to each other
// (are they diversified, or the same bet several times over?).
import { useMemo, useState } from "react";
import { KpiCard, Section } from "./primitives.jsx";
import { fmtUsd, fmtNum, fmtPct, fmtInt } from "../../services/format.js";

// weights/shares arrive as fractions (0..1); fmtPct expects an already-percent value.
const pct0 = (frac) => (frac == null || Number.isNaN(frac) ? "—" : `${Math.round(frac * 100)}%`);

// Diverging colour for a correlation value in [-1, 1].
// +1 green, 0 ~transparent, -1 red. Used as a cell background tint.
function corrColor(c) {
  if (c == null || Number.isNaN(c)) return "transparent";
  const a = Math.min(Math.abs(c), 1) * 0.55;
  return c >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`;
}

function Heatmap({ block, labels }) {
  if (!block?.matrix?.length) {
    return <div className="text-xs text-muted">Not enough overlapping days to compute.</div>;
  }
  const m = block.matrix;
  const n = m.length;
  // grid: 1 header col + n value cols
  const cols = `minmax(72px, 1fr) repeat(${n}, minmax(48px, 1fr))`;
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid gap-px" style={{ gridTemplateColumns: cols }}>
        {/* top-left corner */}
        <div />
        {labels.map((l, j) => (
          <div key={`h${j}`} className="px-1 py-1.5 text-[10px] text-muted text-center truncate" title={l}>
            {l}
          </div>
        ))}
        {m.map((row, i) => (
          <FragmentRow key={`r${i}`} label={labels[i]} row={row} i={i} />
        ))}
      </div>
    </div>
  );
}

function FragmentRow({ label, row, i }) {
  return (
    <>
      <div className="px-1 py-1.5 text-[10px] text-muted text-right truncate self-center" title={label}>
        {label}
      </div>
      {row.map((c, j) => (
        <div
          key={`c${i}-${j}`}
          className="flex items-center justify-center text-[11px] font-mono py-1.5"
          style={{ background: i === j ? "rgba(34,197,94,0.55)" : corrColor(c) }}
          title={`${c >= 0 ? "+" : ""}${c.toFixed(2)}`}
        >
          {c >= 0 ? "+" : ""}{c.toFixed(2)}
        </div>
      ))}
    </>
  );
}

export default function CorrelationMatrix({ data, strategies }) {
  const [mode, setMode] = useState("return"); // "return" | "downside"

  // Label each sid with its symbol when available, e.g. "vwma_reversion (BTCUSDT)".
  const labelFor = useMemo(() => {
    const sym = {};
    (strategies || []).forEach((s) => { sym[s.strategy_id] = s.symbol; });
    return (sid) => (sym[sid] ? `${sid} · ${sym[sid]}` : sid);
  }, [strategies]);

  if (!data) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-10 text-center text-muted">
        <div className="text-base text-text mb-1">No correlation data</div>
        <div className="text-xs">Needs at least 2 strategies and 2 overlapping days of activity.</div>
      </div>
    );
  }

  const sids = data.sids || [];
  const labels = sids.map(labelFor);
  const block = mode === "downside" ? data.downside_corr : data.return_corr;
  const eff = data.effective_n || {};
  const dd = data.drawdown_overlap || {};
  const w = data.suggested_weights || {};

  // pair-extremes for a quick verbal insight
  const insight = useMemo(() => {
    const mat = data.return_corr?.matrix;
    if (!mat || mat.length < 2) return null;
    let hi = { v: -2 }, lo = { v: 2 };
    for (let i = 0; i < mat.length; i++)
      for (let j = i + 1; j < mat.length; j++) {
        if (mat[i][j] > hi.v) hi = { v: mat[i][j], i, j };
        if (mat[i][j] < lo.v) lo = { v: mat[i][j], i, j };
      }
    return { hi, lo };
  }, [data]);

  return (
    <div className="space-y-6">
      {/* ---- diversification KPIs ---- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          title="Diversification Ratio"
          value={fmtNum(data.diversification_ratio)}
          sub={data.diversification_ratio >= 1.4 ? "well diversified" : data.diversification_ratio >= 1.15 ? "some benefit" : "little benefit"}
          positive={data.diversification_ratio >= 1.15}
        />
        <KpiCard
          title="Effective # Strategies"
          value={fmtNum(eff.participation_ratio)}
          sub={`of ${eff.n_strategies} · Herfindahl ${fmtNum(eff.herfindahl)}`}
        />
        <KpiCard
          title="Deep-DD Overlap"
          value={fmtPct(dd.overlap_pct, false)}
          sub={`${dd.overlap_days}/${dd.pool_deep_days} worst-decile DD days ≥2 deep together`}
          positive={dd.overlap_pct < 50 ? true : dd.overlap_pct > 80 ? false : null}
        />
        <KpiCard
          title="Co-Crash Days"
          value={fmtInt(dd.co_crash_days)}
          sub={dd.co_crash_days == null ? "insufficient data (<20 days)" : "≥2 strategies in their worst 5%"}
          positive={dd.co_crash_days === 0 ? true : null}
        />
      </div>

      {/* ---- correlation heatmap ---- */}
      <Section
        title="Return Correlation"
        hint="Pearson correlation of daily dollar P&L between strategies. Green = move together (redundant); red = offset each other (diversifying)."
      >
        <div className="flex items-center gap-1 mb-2">
          {[["return", "All days"], ["downside", "Crash days only"]].map(([id, lbl]) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              disabled={id === "downside" && !data.downside_corr}
              className={`px-3 py-1 text-xs rounded-md border transition ${
                mode === id
                  ? "border-accent-blue text-text bg-accent-blue/10"
                  : id === "downside" && !data.downside_corr
                    ? "border-line text-muted/40 cursor-not-allowed"
                    : "border-line text-muted hover:text-text"
              }`}
            >
              {lbl}
            </button>
          ))}
          <span className="ml-2 text-[11px] text-muted">
            {mode === "downside" && data.downside_corr
              ? `worst-decile portfolio days (n=${data.downside_corr.n_days})`
              : `${data.n_days} days`}
          </span>
        </div>
        <Heatmap block={block} labels={labels} />
        {insight && (
          <div className="text-[11px] text-muted mt-2">
            Most correlated: <span className="text-text">{labels[insight.hi.i]} ↔ {labels[insight.hi.j]}</span> ({insight.hi.v >= 0 ? "+" : ""}{insight.hi.v.toFixed(2)}).
            {" "}Most diversifying: <span className="text-text">{labels[insight.lo.i]} ↔ {labels[insight.lo.j]}</span> ({insight.lo.v >= 0 ? "+" : ""}{insight.lo.v.toFixed(2)}).
          </div>
        )}
      </Section>

      {/* ---- leave-one-out ---- */}
      <Section
        title="Marginal Contribution (leave-one-out)"
        hint="What the portfolio's Sharpe and max drawdown would change by if each strategy were removed. A strategy whose removal IMPROVES Sharpe is dragging the book."
      >
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-panel/60">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Strategy</th>
                <th className="text-right px-3 py-2 font-medium">Total P&L</th>
                <th className="text-right px-3 py-2 font-medium">Δ Sharpe if removed</th>
                <th className="text-right px-3 py-2 font-medium">Δ Max DD if removed</th>
                <th className="text-left px-3 py-2 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {(data.leave_one_out || []).map((r) => {
                const helps = r.delta_sharpe > 0.01;
                const hurts = r.delta_sharpe < -0.01;
                return (
                  <tr key={r.strategy_id} className="border-t border-line">
                    <td className="px-3 py-2 text-text">{labelFor(r.strategy_id)}</td>
                    <td className={`px-3 py-2 text-right ${r.pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(r.pnl_dollars)}</td>
                    <td className={`px-3 py-2 text-right ${helps ? "text-profit" : hurts ? "text-loss" : "text-muted"}`}>
                      {r.delta_sharpe >= 0 ? "+" : ""}{fmtNum(r.delta_sharpe)}
                    </td>
                    <td className="px-3 py-2 text-right text-muted">
                      {r.delta_maxdd_pct >= 0 ? "+" : ""}{fmtNum(r.delta_maxdd_pct)}%
                    </td>
                    <td className={`px-3 py-2 ${helps ? "text-profit" : hurts ? "text-loss" : "text-muted"}`}>
                      {helps ? "earns its slot" : hurts ? "drags Sharpe — review" : "neutral"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-muted mt-1">
          Base portfolio (these strategies): Sharpe {fmtNum(data.base_stats?.sharpe)}, max DD {fmtNum(data.base_stats?.max_drawdown_pct)}%.
          Δ Sharpe &gt; 0 means removing the strategy would lower Sharpe (it helps). Δ Max DD &gt; 0 means it deepens the drawdown.
        </div>
      </Section>

      {/* ---- suggested weights ---- */}
      <Section
        title="Suggested Allocation (advisory)"
        hint="Risk-based weight suggestions from the daily return covariance. ADVISORY ONLY — the runner sizes by each strategy's risk_pct + priority, not these weights."
      >
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-panel/60">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Strategy</th>
                <th className="text-right px-3 py-2 font-medium">Current P&L share</th>
                <th className="text-right px-3 py-2 font-medium">Min-Variance</th>
                <th className="text-right px-3 py-2 font-medium">Equal-Risk</th>
                <th className="text-right px-3 py-2 font-medium">Max-Sharpe</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {sids.map((sid, i) => (
                <tr key={sid} className="border-t border-line">
                  <td className="px-3 py-2 text-text">{labelFor(sid)}</td>
                  <td className="px-3 py-2 text-right text-muted">{pct0(w.current_pnl_share?.[i])}</td>
                  <td className="px-3 py-2 text-right">{pct0(w.min_variance?.[i])}</td>
                  <td className="px-3 py-2 text-right">{pct0(w.equal_risk_contribution?.[i])}</td>
                  <td className="px-3 py-2 text-right">{pct0(w.max_sharpe?.[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ---- methodology caveat ---- */}
      <div className="rounded-md border border-accent-blue/30 bg-accent-blue/5 px-4 py-2 text-[11px] text-muted">
        Computed from each strategy's <span className="text-text">intrinsic</span> equity curve
        (synthetic full-capital: starting + realized + unrealized), aggregated to <span className="text-text">daily</span> dollar
        P&L. This is the signal-level relationship between strategies — not their realized behaviour under shared-cash contention.
        P&L is dollar-denominated with contract multipliers baked in, so crypto and futures strategies are compared on the same axis.
      </div>
    </div>
  );
}
