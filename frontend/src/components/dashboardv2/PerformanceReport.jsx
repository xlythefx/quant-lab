import { KpiCard, Section } from "../analytics/primitives.jsx";
import EquityCurveV2 from "./EquityCurveV2.jsx";
import UnderwaterChart from "./UnderwaterChart.jsx";
import MonthlyReturnsHeatmap from "./MonthlyReturnsHeatmap.jsx";
import RiskReturnPanel from "./RiskReturnPanel.jsx";
import InterpretationCard from "./InterpretationCard.jsx";
import { fmtNum, fmtPct, fmtRatio } from "../../services/format.js";
import { annualizedVol, bestWorstMonth } from "./metrics.js";

/**
 * The Dashboard V2 "Performance" report — KPI cards, equity curve (+ optional
 * cost/look-ahead compare toggles), risk panel, underwater chart, monthly
 * heatmap and the plain-language interpretation.
 *
 * Shared by Dashboard V2 (portfolio / per-strategy slice) and Multi-Asset
 * (per-asset slice). Pure presentation: every number comes in via props.
 */

// Headline metrics for one result slice ({stats, equity, analytics}).
// Lifted from Dashboard V2 so any page showing the report derives them the same way.
export function deriveSliceMetrics(slice, sc) {
  if (!slice) return null;
  const st = slice.stats || {};
  const ra = slice.analytics?.advanced?.risk_adjusted || {};
  const { best, worst } = bestWorstMonth(slice.analytics?.monthly_returns, sc);
  return {
    sharpe: st.sharpe,
    cagr: ra.cagr_pct,
    totalReturn: st.total_return_pct,
    maxDD: st.max_drawdown_pct_peak,
    sortino: ra.sortino,
    winRate: typeof st.win_rate === "number" ? st.win_rate * 100 : null,
    vol: annualizedVol(slice.equity),
    calmar: ra.calmar,
    profitFactor: st.profit_factor,
    exposure: slice.analytics?.exposure_pct,
    best, worst,
  };
}

// Three toggles above the equity curve: With cost (reality) / No cost / Look-ahead.
// The gap between lines is the teaching point — cost drag and fill fantasy made visible.
function EquityVariantToggles({ ctl }) {
  const { show, toggle, loading, meta, noCostIsReality } = ctl;
  const Item = ({ kind, label, color, dash, hint }) => {
    const on = show[kind];
    const busy = loading?.[kind];
    return (
      <button
        onClick={() => toggle(kind)}
        title={hint}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] transition ${on ? "border-line bg-bg-elev text-text" : "border-line/50 text-muted hover:text-text"}`}
      >
        <svg width="18" height="6" aria-hidden="true">
          <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash || ""} opacity={on ? 1 : 0.35} />
        </svg>
        <span>{label}</span>
        {busy && <span className="text-muted animate-pulse">…</span>}
        {kind === "no_cost" && noCostIsReality && <span className="text-muted/70">(= with cost · costs are 0)</span>}
      </button>
    );
  };
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-widest text-muted">Compare</span>
      <Item kind="reality" label="With cost" color="#e5e7eb" dash=""
            hint="Honest fills + your configured trading costs — what's actually tradeable." />
      <Item kind="no_cost" label={meta.no_cost.label} color={meta.no_cost.color} dash={meta.no_cost.dash}
            hint="Honest fills, zero trading costs — the gap to 'With cost' is what fees + slippage eat." />
      <Item kind="look_ahead" label={meta.look_ahead.label} color={meta.look_ahead.color} dash={meta.look_ahead.dash}
            hint="Fictitious perfect fills (diagnostic) — the gap to 'With cost' is pure fill fantasy." />
    </div>
  );
}

export default function PerformanceTab({ derived, sc, chart, variantCtl, scale, setScale, underwater, monthGrid, interpText, hasAdvanced }) {
  const d = derived || {};
  return (
    <div className="space-y-5">
      {/* metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="Sharpe Ratio" value={fmtRatio(d.sharpe)} sub="risk-adjusted" positive={d.sharpe == null ? null : d.sharpe > 0} />
        <KpiCard title="CAGR" value={fmtPct(d.cagr)} sub="annualized" positive={d.cagr == null ? null : d.cagr >= 0} />
        <KpiCard title="Total Return" value={fmtPct(d.totalReturn)} sub="cumulative" positive={d.totalReturn == null ? null : d.totalReturn >= 0} />
        <KpiCard title="Max Drawdown" value={d.maxDD == null ? "—" : fmtPct(-Math.abs(d.maxDD))} sub="peak-to-trough" positive={false} />
        <KpiCard title="Sortino" value={fmtRatio(d.sortino)} sub="downside-adjusted" positive={d.sortino == null ? null : d.sortino > 0} />
        <KpiCard title="Win Rate" value={d.winRate == null ? "—" : `${fmtNum(d.winRate)}%`} sub="of trades" />
      </div>

      {!hasAdvanced && (
        <div className="text-[11px] text-muted/80 italic">
          Some risk-adjusted metrics are unavailable for this result — re-run the backtest to compute them.
        </div>
      )}

      {/* equity + risk panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        <Section title="Equity Curve" hint="value as % of starting capital">
          {variantCtl && <EquityVariantToggles ctl={variantCtl} />}
          <div className="rounded-xl border border-line bg-bg-panel/40 relative" style={{ height: 320 }}>
            <div className="absolute top-2 right-3 z-10 flex items-center gap-1 p-0.5 rounded-md border border-line bg-bg-elev">
              {["linear", "log"].map((sv) => (
                <button
                  key={sv}
                  onClick={() => setScale(sv)}
                  className={`px-2 py-0.5 text-[11px] rounded transition ${scale === sv ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}
                >
                  {sv}
                </button>
              ))}
            </div>
            <EquityCurveV2 strategies={chart.strategies} pointsByStrategy={chart.points} startingCapital={sc} scale={scale} />
          </div>
        </Section>
        <RiskReturnPanel m={d} />
      </div>

      {/* underwater */}
      <Section title="Underwater / Drawdown" hint="depth below the running peak">
        <div className="rounded-xl border border-line bg-bg-panel/40" style={{ height: 150 }}>
          <UnderwaterChart points={underwater} />
        </div>
      </Section>

      {/* monthly heatmap */}
      <Section title="Monthly Returns" hint="% of starting capital, by calendar month">
        <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
          <MonthlyReturnsHeatmap grid={monthGrid} />
        </div>
      </Section>

      <InterpretationCard text={interpText} />
    </div>
  );
}
