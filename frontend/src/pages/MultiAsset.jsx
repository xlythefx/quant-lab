import { useEffect, useMemo, useRef, useState } from "react";
import IconNavRail from "../components/dashboardv2/IconNavRail.jsx";
import StrategyEditor from "../components/StrategyEditor.jsx";
import PriceChartV2 from "../components/dashboardv2/PriceChartV2.jsx";
import EquityCurveV2 from "../components/dashboardv2/EquityCurveV2.jsx";
import RangeSelector from "../components/dashboardv2/RangeSelector.jsx";
import PerformanceTab, { deriveSliceMetrics } from "../components/dashboardv2/PerformanceReport.jsx";
import { TabBar } from "../components/analytics/primitives.jsx";
import BrandAtom from "../components/BrandAtom.jsx";
import { getSymbols, getStrategies, getRiskConfig, runPortfolioBacktest, getPortfolioChartData } from "../services/api.js";
import { saveUserDefaults, getUserDefaults } from "../services/strategiesStore.js";
import { setLast as setLastResult } from "../services/lastResultStore.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtUsd, fmtNum, fmtInt, fmtPct, fmtDateLong } from "../services/format.js";
import {
  rangeToWindow, resolveDefaultParams, statusPill, startingCapital,
  underwaterSeries, monthlyReturnsGrid, interpretation,
} from "../components/dashboardv2/metrics.js";

/**
 * Multi-Asset — run ONE strategy (one shared param set) across a basket of
 * assets, each as an INDEPENDENT backtest with the full starting capital.
 * "All assets" overlays every equity curve; picking an asset (rail, legend or
 * clicking its curve) shows the Dashboard V2 performance report for it, plus
 * its price chart on a second tab.
 *
 * Backend is untouched: every asset is one /backtest/portfolio call with a
 * single spec, then /backtest/chart-data on demand for the Chart tab —
 * the exact calls Dashboard V2 makes, just repeated per asset.
 *
 * Deliberately NOT a shared-cash portfolio (that's Dashboard V2's job) and
 * deliberately no "hide losers" — the whole basket always stays visible so the
 * result can't be quietly cherry-picked after the fact.
 */

const ASSET_LABELS = {
  crypto: "Crypto", commodity: "Commodities", forex: "Forex",
  futures: "Futures · CME", equity_index_future: "Futures · TS",
  stock: "Stocks", index: "Indices",
};
const CLASS_ORDER = { crypto: 0, commodity: 1, forex: 2, futures: 3, equity_index_future: 3.5, stock: 4, index: 5 };
const TF_ORDER = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"];

const SELECT_CLS = "bg-transparent text-sm font-mono text-text leading-none focus:outline-none cursor-pointer";
const OPTION_CLS = "bg-bg-panel text-text";

const assetId = (symbol, broker) => `${symbol}::${broker || ""}`;
const ALL_ID = "__all__";

// Rail orderings. `stat` sorts read the finished run; assets that have not
// finished (or failed) have no number and always sink to the bottom, in label
// order, so a half-finished run doesn't shuffle the list on every completion.
const SORTS = [
  { id: "pnl_desc",  label: "P&L high → low", stat: "total_return_pct", dir: -1 },
  { id: "pnl_asc",   label: "P&L low → high", stat: "total_return_pct", dir: 1 },
  { id: "az",        label: "A → Z" },
  { id: "za",        label: "Z → A" },
  { id: "dd_worst",  label: "Drawdown worst first", stat: "max_drawdown_pct_peak", dir: 1 },
  { id: "dd_best",   label: "Drawdown best first", stat: "max_drawdown_pct_peak", dir: -1 },
  { id: "trades_desc", label: "Most trades", stat: "trades", dir: -1 },
  { id: "trades_asc",  label: "Fewest trades", stat: "trades", dir: 1 },
];
const SORT_BY_ID = Object.fromEntries(SORTS.map((s) => [s.id, s]));

function sortBasketRows(rows, sortId, runs, strategyId) {
  const sort = SORT_BY_ID[sortId] || SORTS[0];
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  if (sort.id === "az") return [...rows].sort(byLabel);
  if (sort.id === "za") return [...rows].sort((a, b) => byLabel(b, a));
  const statOf = (row) => {
    const run = runs[row.id];
    const v = run?.status === "done" ? run.result?.per_strategy?.[strategyId]?.stats?.[sort.stat] : null;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return [...rows].sort((a, b) => {
    const va = statOf(a), vb = statOf(b);
    if (va == null && vb == null) return byLabel(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * sort.dir || byLabel(a, b);
  });
}
// Evenly spaced hues so 30+ overlaid curves stay distinguishable on hover.
const colorFor = (i, n) => `hsl(${Math.round((i * 360) / Math.max(n, 1))} 70% 62%)`;

function Field({ label, children }) {
  return (
    <label className="flex flex-col justify-center gap-1 px-3.5 min-w-[96px] cursor-pointer">
      <span className="text-[9px] uppercase tracking-[0.14em] text-muted/80 leading-none">{label}</span>
      {children}
    </label>
  );
}

export default function MultiAsset() {
  const [strategyId, setStrategyId] = usePersistentState("ql.ma.strategy", "");
  const [timeframe, setTimeframe]   = usePersistentState("ql.ma.timeframe", "15m");
  const [basket, setBasket]         = usePersistentState("ql.ma.basket", []);        // [assetId]
  const [paramsById, setParamsById] = usePersistentState("ql.ma.params", {});        // {strategyId: params}
  const [rangeKey, setRangeKey]     = usePersistentState("ql.ma.range", "MAX");
  const [customRange, setCustomRange] = usePersistentState("ql.ma.customRange", { start: "", end: "" });
  const [selectedId, setSelectedId] = usePersistentState("ql.ma.selected", "");
  const [scale, setScale]           = usePersistentState("ql.ma.scale", "linear");
  const [tab, setTab]               = usePersistentState("ql.ma.tab", "performance");
  const [sortId, setSortId]         = usePersistentState("ql.ma.sort", "pnl_desc");

  const [datasets, setDatasets] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [riskConfig, setRiskConfig] = useState(null);

  // Per-asset run state: {status: "queued"|"running"|"done"|"error", result?, error?}
  const [runs, setRuns] = useState({});
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);   // {index, total, label}
  const [elapsed, setElapsed] = useState(0);
  const [editing, setEditing] = useState(false);
  const inflightRef = useRef(0);

  // Per-asset chart data, fetched lazily for the selected asset then cached.
  const [chartCache, setChartCache] = useState({});   // {assetId: data|null(failed)}
  const [chartLoading, setChartLoading] = useState(false);
  // Bumped whenever the cache is cleared; an in-flight chart fetch from an
  // older generation is ignored instead of landing in the fresh cache.
  const chartGenRef = useRef(0);
  const clearCharts = () => { chartGenRef.current++; setChartCache({}); };

  useEffect(() => { getSymbols().then((d) => setDatasets(d.datasets || [])).catch(() => {}); }, []);
  useEffect(() => { getStrategies().then(setCatalog).catch(() => {}); }, []);
  useEffect(() => { getRiskConfig().then(setRiskConfig).catch(() => {}); }, []);

  const catalogById = useMemo(() => { const m = {}; for (const s of catalog) m[s.id] = s; return m; }, [catalog]);
  const strategyOptions = useMemo(
    () => catalog.filter((m) => m && !m.archived).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [catalog],
  );
  const meta = catalogById[strategyId];
  useEffect(() => {
    if (!strategyId && strategyOptions.length) setStrategyId(strategyOptions[0].id);
  }, [strategyOptions, strategyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // One shared param set per strategy — resolved WITHOUT a symbol on purpose so
  // per-symbol presets don't sneak in (the point is: does the idea transfer as-is?).
  const params = useMemo(
    () => paramsById[strategyId] || resolveDefaultParams(meta, null, timeframe, getUserDefaults(strategyId)),
    [paramsById, strategyId, meta, timeframe],
  );

  const timeframes = useMemo(() => {
    const seen = new Set(datasets.map((d) => d.timeframe));
    return Array.from(seen).sort((a, b) => (TF_ORDER.indexOf(a) + 99) % 100 - (TF_ORDER.indexOf(b) + 99) % 100);
  }, [datasets]);

  // Assets that actually have data at the chosen timeframe, grouped by class.
  const assetsByClass = useMemo(() => {
    const groups = {};
    for (const d of datasets) {
      if (d.timeframe !== timeframe) continue;
      const cls = d.asset_class || "crypto";
      (groups[cls] ||= []).push({ id: assetId(d.symbol, d.broker), symbol: d.symbol, broker: d.broker || "", cls, dataset: d });
    }
    for (const cls of Object.keys(groups)) {
      const rows = groups[cls];
      const counts = {};
      for (const r of rows) counts[r.symbol] = (counts[r.symbol] || 0) + 1;
      for (const r of rows) r.label = counts[r.symbol] > 1 ? `${r.symbol} · ${r.broker}` : r.symbol;
      rows.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.broker.localeCompare(b.broker));
    }
    return Object.keys(groups)
      .sort((a, b) => (CLASS_ORDER[a] ?? 99) - (CLASS_ORDER[b] ?? 99))
      .map((cls) => ({ cls, label: ASSET_LABELS[cls] || cls, rows: groups[cls] }));
  }, [datasets, timeframe]);
  const assetById = useMemo(() => {
    const m = {}; for (const g of assetsByClass) for (const r of g.rows) m[r.id] = r; return m;
  }, [assetsByClass]);

  // The basket as resolved rows, dropping anything without data at this timeframe.
  const basketRows = useMemo(() => basket.map((id) => assetById[id]).filter(Boolean), [basket, assetById]);
  const missing = basket.length - basketRows.length;
  // Display order only — runs, colors and the overview keep basket order so a
  // re-sort never changes which curve is which color.
  const railRows = useMemo(() => sortBasketRows(basketRows, sortId, runs, strategyId), [basketRows, sortId, runs, strategyId]);

  // Union of the basket's date edges — drives the range pills' hints/limits.
  const bounds = useMemo(() => {
    if (!basketRows.length) return null;
    let first = Infinity, last = 0;
    for (const r of basketRows) { first = Math.min(first, r.dataset.first_time ?? Infinity); last = Math.max(last, r.dataset.last_time ?? 0); }
    return Number.isFinite(first) && last ? { firstTime: first, lastTime: last } : null;
  }, [basketRows]);

  // Keep the selection on something in the basket ("All assets" needs 2+).
  const showAll = basketRows.length >= 2;
  useEffect(() => {
    if (selectedId === ALL_ID ? !showAll : !basketRows.some((r) => r.id === selectedId)) {
      setSelectedId(showAll ? ALL_ID : (basketRows[0]?.id || ""));
    }
  }, [basketRows, selectedId, showAll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Inputs changed → results are stale, drop them (never show numbers from a different setup).
  useEffect(() => { setRuns({}); clearCharts(); inflightRef.current++; setLoading(false); setProgress(null); },
    [strategyId, timeframe, params]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, [loading]);

  const specFor = (row) => ({
    strategy_id: strategyId, symbol: row.symbol, timeframe, params, priority: 1, broker: row.broker || undefined,
  });
  const windowFor = (row) => rangeToWindow(rangeKey, { firstTime: row.dataset.first_time, lastTime: row.dataset.last_time }, customRange);

  // ---- run: one independent backtest per asset, in sequence ----------------
  const runAll = async () => {
    if (!strategyId || !basketRows.length) return;
    const myReq = ++inflightRef.current;
    setLoading(true);
    clearCharts();
    setRuns(Object.fromEntries(basketRows.map((r) => [r.id, { status: "queued" }])));

    for (let i = 0; i < basketRows.length; i++) {
      const row = basketRows[i];
      if (myReq !== inflightRef.current) return;
      setProgress({ index: i + 1, total: basketRows.length, label: row.label });
      setRuns((r) => ({ ...r, [row.id]: { status: "running" } }));
      try {
        const res = await runPortfolioBacktest({ strategies: [specFor(row)], ...windowFor(row) });
        if (myReq !== inflightRef.current) return;
        setRuns((r) => ({ ...r, [row.id]: { status: "done", result: res } }));
      } catch (e) {
        if (myReq !== inflightRef.current) return;
        setRuns((r) => ({ ...r, [row.id]: { status: "error", error: e?.response?.data?.error || e.message || "Backtest failed." } }));
      }
    }
    setLoading(false);
    setProgress(null);
  };

  // Drill-in from the overview (curve click or legend) → that asset's report.
  const openAsset = (id) => { if (assetById[id]) { setSelectedId(id); setTab("performance"); } };

  // ---- lazy chart data for the selected asset -----------------------------
  const isAll = selectedId === ALL_ID;
  const selectedRow = (!isAll && assetById[selectedId]) || null;
  const selectedRun = (!isAll && runs[selectedId]) || null;
  const selectedResult = selectedRun?.status === "done" ? selectedRun.result : null;
  // No cleanup-cancel here: `chartLoading` is a dependency, so the effect
  // re-runs the instant it flips to true — a cleanup flag would cancel the very
  // fetch it just started and the spinner would never clear. Staleness is
  // handled by the generation counter instead.
  useEffect(() => {
    if (tab !== "chart" || !selectedRow || !selectedResult || selectedId in chartCache || chartLoading) return;
    const gen = chartGenRef.current;
    const id = selectedId;
    setChartLoading(true);
    getPortfolioChartData({ strategies: [specFor(selectedRow)], ...windowFor(selectedRow) })
      .then((d) => { if (gen === chartGenRef.current) setChartCache((c) => ({ ...c, [id]: d })); })
      .catch(() => { if (gen === chartGenRef.current) setChartCache((c) => ({ ...c, [id]: null })); })  // record failure → no refetch loop
      .finally(() => setChartLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedId, selectedResult, chartCache, chartLoading]);

  // ---- per-asset performance report (same derivations as Dashboard V2) ----
  const slice = selectedResult?.per_strategy?.[strategyId] || null;
  const sc = startingCapital(selectedResult, riskConfig);
  const derived = useMemo(() => deriveSliceMetrics(slice, sc), [slice, sc]);
  const monthGrid = useMemo(() => monthlyReturnsGrid(slice?.analytics?.monthly_returns, sc), [slice, sc]);
  const underwater = useMemo(() => underwaterSeries(slice), [slice]);
  const assetChart = useMemo(() => ({
    strategies: selectedRow ? [{ id: selectedId, color: "#3b82f6", label: selectedRow.label }] : [],
    points: { [selectedId]: (slice?.equity || []).map((e) => ({ time: e.time, value: e.value })) },
  }), [slice, selectedId, selectedRow]);

  // ---- "All assets" overview: one equity line per finished asset -----------
  const overview = useMemo(() => {
    const series = [], points = {}, rows = [];
    basketRows.forEach((row, i) => {
      const psd = runs[row.id]?.status === "done" ? runs[row.id].result.per_strategy?.[strategyId] : null;
      if (!psd) return;
      const color = colorFor(i, basketRows.length);
      series.push({ id: row.id, color, label: row.label });
      points[row.id] = (psd.equity || []).map((e) => ({ time: e.time, value: e.value }));
      rows.push({ row, color, stats: psd.stats || {} });
    });
    rows.sort((a, b) => (b.stats.total_return_pct ?? -Infinity) - (a.stats.total_return_pct ?? -Infinity));
    const rets = rows.map((r) => r.stats.total_return_pct).filter((v) => typeof v === "number");
    const sorted = [...rets].sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
    const dds = rows.map((r) => r.stats.max_drawdown_pct_peak).filter((v) => typeof v === "number");
    return {
      series, points, rows,
      profitable: rets.filter((v) => v > 0).length, count: rets.length, median,
      avgDD: dds.length ? dds.reduce((a, b) => a + b, 0) / dds.length : null,
      trades: rows.reduce((a, r) => a + (r.stats.trades || 0), 0),
    };
  }, [basketRows, runs, strategyId]);
  const overviewSc = startingCapital(overview.rows[0] ? runs[overview.rows[0].row.id]?.result : null, riskConfig);

  // ---- basket editing -------------------------------------------------------
  const toggleAsset = (id) => setBasket((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  const toggleClass = (rows) => {
    const ids = rows.map((r) => r.id);
    const allIn = ids.every((id) => basket.includes(id));
    setBasket((b) => (allIn ? b.filter((x) => !ids.includes(x)) : Array.from(new Set([...b, ...ids]))));
  };

  const onApplyParams = (p) => {
    setParamsById((m) => ({ ...m, [strategyId]: p }));
    setEditing(false);
  };
  const onResetDefaults = () => onApplyParams(resolveDefaultParams(meta, null, timeframe, getUserDefaults(strategyId)));

  const stats = selectedResult?.per_strategy?.[strategyId]?.stats;
  const pill = stats ? statusPill(stats) : { label: selectedRun?.status === "error" ? "FAILED" : "NO RUN", tone: selectedRun?.status === "error" ? "loss" : "muted" };
  const pillCls = pill.tone === "profit" ? "text-profit border-profit/40 bg-profit/10"
    : pill.tone === "loss" ? "text-loss border-loss/40 bg-loss/10"
    : pill.tone === "neutral" ? "text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10"
    : "text-muted border-line bg-bg-elev";
  const doneCount = Object.values(runs).filter((r) => r.status === "done").length;
  const canRun = !!strategyId && basketRows.length > 0 && !loading;
  const activeForChart = useMemo(() => [{ id: strategyId, params, color: "#3b82f6" }], [strategyId, params]);

  // ---- Analytics deep-dive for the selected asset --------------------------
  // Same handoff as Dashboard V2 (lastResultStore → #analytics?key=…), but the
  // slice is cached ON CLICK rather than per finished asset: every cache write
  // re-serializes the whole store, so writing a 34-asset basket as it runs
  // would be 34 growing stringifies for entries nobody may open. Writing the
  // one you open also works while the rest of the basket is still running.
  // The broker is part of the key so ES on Databento and ES on TradeStation
  // in the same basket don't overwrite each other.
  const analyticsKey = selectedRow && slice
    ? `${strategyId}|${selectedRow.symbol}${selectedRow.broker ? `@${selectedRow.broker}` : ""}|${timeframe}`
    : null;
  const openAnalytics = (e) => {
    if (!analyticsKey) { e.preventDefault(); return; }
    setLastResult(analyticsKey, {
      strategy_id: strategyId, symbol: selectedRow.symbol, timeframe,
      risk_config: selectedResult.risk_config,
      params: slice.spec?.params || params,
      // Compact benchmark series keeps Analytics' buy-and-hold line alive;
      // full candles are only ever fetched on demand for the Chart tab.
      candles: slice.benchmark || [],
      overlays: [],
      trades: slice.trades || [],
      equity: slice.equity || [],
      stats: slice.stats || {},
      analytics: slice.analytics || {},
    });
  };

  return (
    <div className="flex h-screen">
      <IconNavRail view="multiasset" />

      <div className="flex flex-1 min-h-0">
        {/* left rail — the basket */}
        <aside className="w-72 shrink-0 border-r border-line bg-bg-panel/40 flex flex-col h-full">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BrandAtom size={16} />
              <span className="text-[10px] uppercase tracking-widest text-muted">Assets</span>
            </div>
            <span className="text-[10px] font-mono text-muted">{doneCount ? `${doneCount}/` : ""}{basketRows.length}</span>
          </div>
          {basketRows.length > 1 && (
            <label className="px-4 py-2 border-b border-line flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted">
              <span>Sort</span>
              <select
                value={sortId}
                onChange={(e) => setSortId(e.target.value)}
                className={`${SELECT_CLS} flex-1 text-xs normal-case tracking-normal`}
                title="Order the basket"
              >
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id} className={OPTION_CLS}>{s.label}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {showAll && (
              <div
                onClick={() => setSelectedId(ALL_ID)}
                className={`rounded-lg border px-3 py-2 cursor-pointer transition ${
                  isAll ? "border-accent-blue/60 bg-bg-elev" : "border-line/60 hover:border-line hover:bg-bg-elev/40"
                }`}
              >
                <div className="text-sm font-medium text-text">All assets</div>
                <div className="flex items-center justify-between mt-0.5 text-[11px] font-mono">
                  <span className={overview.count ? (overview.profitable / overview.count >= 0.5 ? "text-profit" : "text-loss") : "text-muted"}>
                    {overview.count ? `${overview.profitable} / ${overview.count} profitable` : "—"}
                  </span>
                  <span className="text-muted">combined curves</span>
                </div>
              </div>
            )}
            {basketRows.length === 0 && (
              <div className="text-xs text-muted px-1 py-6 text-center leading-relaxed">
                Basket is empty.<br />Pick assets in the toolbar.
              </div>
            )}
            {railRows.map((row) => (
              <AssetRow
                key={row.id}
                row={row}
                run={runs[row.id]}
                strategyId={strategyId}
                selected={row.id === selectedId}
                onSelect={() => setSelectedId(row.id)}
                onRemove={() => toggleAsset(row.id)}
              />
            ))}
            {missing > 0 && (
              <div className="text-[10px] text-muted/70 px-1 pt-2">
                {missing} basket item{missing === 1 ? "" : "s"} hidden — no {timeframe} data.
              </div>
            )}
          </div>
          <BasketPicker groups={assetsByClass} basket={basket} onToggle={toggleAsset} onToggleClass={toggleClass} />
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto flex flex-col">
          {/* header */}
          <div className="px-6 pt-5 pb-3 border-b border-line">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight text-text">{isAll ? "All assets" : (selectedRow?.label || "Multi-Asset")}</h1>
              {!isAll && (
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${pillCls}`}>● {pill.label}</span>
              )}
              <span className="text-xs text-muted">
                {isAll ? `${basketRows.length} assets · ` : ""}{meta?.name || strategyId || "no strategy"} · {timeframe}
                {selectedRow ? ` · ${ASSET_LABELS[selectedRow.cls] || selectedRow.cls}` : ""}
              </span>
            </div>
            <div className="text-xs text-muted mt-1 font-mono">
              {isAll
                ? (overview.count ? `${overview.count} of ${basketRows.length} run · each an independent run with full starting capital · click a curve to open that asset` : "Not yet run")
                : stats?.first_time
                  ? `Backtest ${fmtDateLong(stats.first_time)} – ${fmtDateLong(stats.last_time)} · independent run · full starting capital`
                  : selectedRun?.status === "error" ? selectedRun.error : "Not yet run"}
            </div>

            {/* toolbar */}
            <div className="flex items-center gap-3 mt-4 flex-wrap">
              <div className="flex items-stretch h-11 rounded-xl border border-line bg-bg-panel/40 divide-x divide-line overflow-hidden">
                <Field label="Strategy">
                  <select className={SELECT_CLS} value={strategyId} onChange={(e) => setStrategyId(e.target.value)} aria-label="Strategy">
                    {strategyOptions.length === 0
                      ? <option className={OPTION_CLS} value="">—</option>
                      : strategyOptions.map((m) => <option className={OPTION_CLS} key={m.id} value={m.id}>{m.name || m.id}</option>)}
                  </select>
                </Field>
                <Field label="Timeframe">
                  <select className={SELECT_CLS} value={timeframe} onChange={(e) => setTimeframe(e.target.value)} aria-label="Timeframe">
                    {(timeframes.length ? timeframes : [timeframe]).map((t) => <option className={OPTION_CLS} key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <button
                  onClick={() => setEditing(true)}
                  disabled={!meta}
                  title="Edit the ONE param set shared by every asset in the basket"
                  className="px-3.5 text-xs text-muted hover:text-accent-blue disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Params ✎
                </button>
              </div>

              <div className="flex items-center gap-3 ml-auto">
                <RangeSelector value={rangeKey} onChange={setRangeKey} bounds={bounds} customRange={customRange} onCustomChange={setCustomRange} />
                <a
                  href={analyticsKey ? `#analytics?key=${encodeURIComponent(analyticsKey)}` : undefined}
                  aria-disabled={!analyticsKey}
                  onClick={openAnalytics}
                  title={analyticsKey
                    ? `Open in-depth analytics for ${selectedRow.label}`
                    : isAll ? "Pick a single asset to open its analytics" : "Run the basket first"}
                  className={`h-11 inline-flex items-center px-4 rounded-xl text-sm font-medium border transition ${
                    analyticsKey
                      ? "border-line text-text hover:border-accent-blue/60 hover:text-accent-blue cursor-pointer"
                      : "border-line text-muted/40 cursor-not-allowed"
                  }`}
                >
                  Analytics →
                </a>
                <button
                  onClick={runAll}
                  disabled={!canRun}
                  className={`h-11 inline-flex items-center gap-2 px-5 rounded-xl text-sm font-medium transition ${
                    canRun ? "bg-accent-grad text-white shadow-lg shadow-accent-blue/20 hover:opacity-90 cursor-pointer" : "bg-bg-elev text-muted cursor-not-allowed"
                  }`}
                >
                  {loading ? "Running…" : `▶ Run ${basketRows.length || ""} asset${basketRows.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </div>

          {stats && <KpiStrip stats={stats} />}
          {isAll && overview.count > 0 && <OverviewStrip o={overview} />}

          <div className="px-6 py-5 flex-1 flex flex-col min-h-0">
            {loading && progress && (
              <div className="mb-4 rounded-xl border border-accent-blue/30 bg-accent-blue/5 px-4 py-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 text-sm text-text min-w-0">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-accent-blue border-t-transparent animate-spin shrink-0" />
                    <span className="truncate">{progress.index} / {progress.total} · running {progress.label}…</span>
                  </div>
                  <span className="text-xs font-mono text-muted shrink-0">{fmtElapsed(elapsed)}</span>
                </div>
                <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
                  <div className="h-full bg-accent-grad transition-all" style={{ width: `${((progress.index - 1) / progress.total) * 100}%` }} />
                </div>
              </div>
            )}

            {!selectedRow && !isAll && (
              <EmptyHint title="Build a basket" sub="Pick a strategy and timeframe, add assets from the picker at the bottom-left, then run." />
            )}
            {isAll && overview.count === 0 && !loading && (
              <EmptyHint title="Ready to run" sub={`${basketRows.length} assets · ${meta?.name || strategyId} · ${timeframe} · ${rangeKey}`} />
            )}
            {isAll && overview.count > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-muted/80 font-mono">
                    One equity line per asset, % of starting capital. Hover to focus a line, click it to open that asset's report.
                  </div>
                  <div className="flex items-center gap-1 p-0.5 rounded-md border border-line bg-bg-elev">
                    {["linear", "log"].map((sv) => (
                      <button key={sv} onClick={() => setScale(sv)}
                        className={`px-2 py-0.5 text-[11px] rounded transition ${scale === sv ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}>
                        {sv}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-bg-panel/40" style={{ height: 460 }}>
                  <EquityCurveV2
                    strategies={overview.series}
                    pointsByStrategy={overview.points}
                    startingCapital={overviewSc}
                    scale={scale}
                    onSelectSeries={openAsset}
                  />
                </div>
                {/* legend — sorted best → worst; every asset stays listed */}
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
                  {overview.rows.map(({ row, color, stats: st }) => {
                    const ret = st.total_return_pct;
                    const tone = typeof ret === "number" ? (ret > 0 ? "text-profit" : ret < 0 ? "text-loss" : "text-text") : "text-muted";
                    return (
                      <button
                        key={row.id}
                        onClick={() => openAsset(row.id)}
                        title={`Open ${row.label}`}
                        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-line/60 bg-bg-panel/40 hover:border-accent-blue/60 text-left transition"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
                          <span className="text-sm text-text truncate">{row.label}</span>
                        </span>
                        <span className={`text-[11px] font-mono shrink-0 ${tone}`}>
                          {typeof ret === "number" ? fmtPct(ret) : "—"} <span className="text-muted">· {fmtInt(st.trades)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {selectedRow && !selectedResult && !loading && selectedRun?.status !== "error" && (
              <EmptyHint title="Ready to run" sub={`${basketRows.length} asset${basketRows.length === 1 ? "" : "s"} · ${meta?.name || strategyId} · ${timeframe} · ${rangeKey}`} />
            )}
            {selectedRow && selectedRun?.status === "error" && (
              <div className="px-4 py-2 rounded-lg text-sm text-loss bg-loss/10 border border-loss/30">{selectedRun.error}</div>
            )}

            {selectedRow && selectedResult && slice && (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="mb-4">
                  <TabBar
                    tabs={[{ id: "performance", label: "Performance" }, { id: "chart", label: "Chart" }]}
                    active={tab}
                    onSelect={setTab}
                  />
                </div>

                {tab === "performance" && (
                  <PerformanceTab
                    derived={derived}
                    sc={sc}
                    chart={assetChart}
                    scale={scale}
                    setScale={setScale}
                    underwater={underwater}
                    monthGrid={monthGrid}
                    interpText={interpretation(slice, derived)}
                    hasAdvanced={!!slice.analytics?.advanced}
                  />
                )}

                {tab === "chart" && (
                  <>
                    <div className="text-[11px] text-muted/80 mb-2 font-mono">
                      {selectedRow.label} · candles, overlays, dashed ATR stop (while a trade is open), entry/exit markers.
                    </div>
                    <div className="rounded-xl border border-line bg-bg-panel/40 overflow-hidden flex-1" style={{ minHeight: 560 }}>
                      <PriceChartV2
                        result={selectedResult}
                        chartData={chartCache[selectedId] || null}
                        loading={chartLoading}
                        selectedId={strategyId}
                        active={activeForChart}
                        symbol={selectedRow.symbol}
                        timeframe={timeframe}
                        broker={selectedRow.broker}
                        portfolioId="__portfolio__"
                      />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {editing && meta && (
        <StrategyEditor
          open
          color="#3b82f6"
          schema={meta.schema}
          params={params}
          strategyId={strategyId}
          builtinPresets={meta.presets || {}}
          symbol={selectedRow?.symbol}
          timeframe={timeframe}
          onChange={() => {}}
          onClose={() => setEditing(false)}
          onApply={onApplyParams}
          onResetDefaults={onResetDefaults}
          onSaveAsDefault={(p) => saveUserDefaults(strategyId, p)}
        />
      )}
    </div>
  );
}

function fmtElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// One basket entry: symbol, run state, and the headline return/trades once done.
function AssetRow({ row, run, strategyId, selected, onSelect, onRemove }) {
  const st = run?.status === "done" ? run.result?.per_strategy?.[strategyId]?.stats : null;
  const ret = st?.total_return_pct;
  const tone = typeof ret === "number" ? (ret > 0 ? "text-profit" : ret < 0 ? "text-loss" : "text-text") : "text-muted";
  const state = run?.status === "running" ? <span className="w-3 h-3 rounded-full border-2 border-accent-blue border-t-transparent animate-spin" />
    : run?.status === "queued" ? <span className="text-[10px] text-muted">queued</span>
    : run?.status === "error" ? <span className="text-[10px] text-loss" title={run.error}>failed</span>
    : null;
  return (
    <div
      onClick={onSelect}
      className={`group rounded-lg border px-3 py-2 cursor-pointer transition ${
        selected ? "border-accent-blue/60 bg-bg-elev" : "border-line/60 hover:border-line hover:bg-bg-elev/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-text truncate">{row.label}</div>
        <div className="flex items-center gap-2 shrink-0">
          {state}
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove from basket"
            className="text-muted/50 hover:text-loss opacity-0 group-hover:opacity-100 transition text-xs"
          >✕</button>
        </div>
      </div>
      <div className="flex items-center justify-between mt-0.5 text-[11px] font-mono">
        <span className={tone}>{typeof ret === "number" ? fmtPct(ret) : "—"}</span>
        <span className="text-muted">{st ? `${fmtInt(st.trades)} trades · DD ${fmtPct(st.max_drawdown_pct_peak, false)}` : (ASSET_LABELS[row.cls] || row.cls)}</span>
      </div>
    </div>
  );
}

// Bottom-of-rail popover: checkboxes grouped by asset class, only assets with
// data at the current timeframe. Class header toggles the whole group.
function BasketPicker({ groups, basket, onToggle, onToggleClass }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const inBasket = new Set(basket);
  return (
    <div className="p-3 border-t border-line relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 rounded-lg border border-line bg-bg-elev text-sm text-text hover:border-accent-blue/50 transition"
      >
        + Add assets
      </button>
      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-1 max-h-96 overflow-y-auto rounded-lg border border-line bg-bg-panel shadow-xl shadow-black/40 py-1 z-50">
          {groups.length === 0 && <div className="px-3 py-2 text-xs text-muted">No datasets at this timeframe.</div>}
          {groups.map((g) => {
            const allIn = g.rows.every((r) => inBasket.has(r.id));
            return (
              <div key={g.cls}>
                <button
                  onClick={() => onToggleClass(g.rows)}
                  className="w-full flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wider text-muted/70 hover:text-text"
                >
                  <span>{g.label}</span><span>{allIn ? "clear" : "all"}</span>
                </button>
                {g.rows.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 px-3 py-1 text-sm text-muted hover:text-text hover:bg-bg-elev/50 cursor-pointer">
                    <input type="checkbox" checked={inBasket.has(r.id)} onChange={() => onToggle(r.id)} className="accent-[#3b82f6]" />
                    <span className="font-mono">{r.label}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Headline numbers for the selected asset (same five Dashboard V2 shows).
function KpiStrip({ stats }) {
  const ret = stats.total_return_pct;
  const pnl = stats.total_return_dollars;
  const tone = (v) => (typeof v === "number" && Number.isFinite(v) ? (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-text") : "text-text");
  const Kpi = ({ label, value, sub, valueCls = "text-text" }) => (
    <div className="rounded-xl border border-line bg-bg-panel/40 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-mono font-semibold leading-tight ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70 font-mono mt-0.5 truncate">{sub}</div>}
    </div>
  );
  return (
    <div className="px-6 py-3 border-b border-line grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <Kpi label="Capital" value={fmtUsd(stats.final_equity)} sub={`from ${fmtUsd(stats.starting_capital)}`} />
      <Kpi label="Net P&L" value={fmtUsd(pnl)} valueCls={tone(pnl)} />
      <Kpi label="Total return" value={fmtPct(ret)} valueCls={tone(ret)} />
      <Kpi label="Trades" value={fmtInt(stats.trades)} sub={Number.isFinite(stats.win_rate) ? `${fmtNum(stats.win_rate * 100)}% win` : undefined} />
      <Kpi label="Max drawdown" value={fmtPct(stats.max_drawdown_pct_peak, false)} valueCls="text-loss" sub="peak-to-trough" />
    </div>
  );
}

// Basket-wide summary for the "All assets" view. Median (not mean) return so one
// runaway asset can't flatter the basket; the profitable count is the honest
// "does it generalize?" number.
function OverviewStrip({ o }) {
  const Kpi = ({ label, value, sub, valueCls = "text-text" }) => (
    <div className="rounded-xl border border-line bg-bg-panel/40 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-mono font-semibold leading-tight ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70 font-mono mt-0.5 truncate">{sub}</div>}
    </div>
  );
  const share = o.count ? o.profitable / o.count : 0;
  const tone = (v) => (typeof v === "number" ? (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-text") : "text-text");
  return (
    <div className="px-6 py-3 border-b border-line grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Kpi label="Profitable" value={`${fmtInt(o.profitable)} / ${fmtInt(o.count)}`} sub={`${fmtNum(share * 100)}% of basket`}
           valueCls={share >= 0.5 ? "text-profit" : "text-loss"} />
      <Kpi label="Median return" value={o.median == null ? "—" : fmtPct(o.median)} valueCls={tone(o.median)} sub="middle asset" />
      <Kpi label="Avg max drawdown" value={o.avgDD == null ? "—" : fmtPct(o.avgDD, false)} valueCls="text-loss" sub="peak-to-trough" />
      <Kpi label="Total trades" value={fmtInt(o.trades)} sub="across all assets" />
    </div>
  );
}

function EmptyHint({ title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-text font-semibold text-lg">{title}</div>
      <div className="text-sm text-muted mt-2 max-w-md font-mono">{sub}</div>
    </div>
  );
}
