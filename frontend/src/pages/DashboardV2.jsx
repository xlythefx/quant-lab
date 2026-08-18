import { useEffect, useMemo, useRef, useState } from "react";
import IconNavRail from "../components/dashboardv2/IconNavRail.jsx";
import StrategyEditor from "../components/StrategyEditor.jsx";
import LookAheadComparisonModal from "../components/LookAheadComparisonModal.jsx";
import { KpiCard, Section, TabBar } from "../components/analytics/primitives.jsx";
import StrategySidebar, { PORTFOLIO_ID } from "../components/dashboardv2/StrategySidebar.jsx";
import EquityCurveV2 from "../components/dashboardv2/EquityCurveV2.jsx";
import PriceChartV2 from "../components/dashboardv2/PriceChartV2.jsx";
import UnderwaterChart from "../components/dashboardv2/UnderwaterChart.jsx";
import MonthlyReturnsHeatmap from "../components/dashboardv2/MonthlyReturnsHeatmap.jsx";
import RangeSelector from "../components/dashboardv2/RangeSelector.jsx";
import RiskReturnPanel from "../components/dashboardv2/RiskReturnPanel.jsx";
import InterpretationCard from "../components/dashboardv2/InterpretationCard.jsx";
import { getSymbols, getStrategies, getRiskConfig, runPortfolioBacktest } from "../services/api.js";
import {
  useActiveStrategies, addStrategy, removeStrategy, updateParams, saveUserDefaults, getUserDefaults,
} from "../services/strategiesStore.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { goLive } from "../services/appMode.js";
import { setLast as setLastResult } from "../services/lastResultStore.js";
import { socket } from "../services/socket.js";
import { ProgressBar } from "../components/walkforward/widgets.jsx";
import { fmtUsd, fmtNum, fmtInt, fmtPct, fmtRatio, fmtDate, fmtDateLong, fmtTime } from "../services/format.js";
import {
  startingCapital, rangeToWindow, resolveWindowDates, epochToDateStr, resolveDefaultParams,
  annualizedVol, underwaterSeries, monthlyReturnsGrid, bestWorstMonth, statusPill, interpretation,
} from "../components/dashboardv2/metrics.js";

const ASSET_LABELS = {
  crypto: "Crypto", commodity: "Commodities", forex: "Forex",
  futures: "Futures · CME", equity_index_future: "Futures · TS",
  stock: "Stocks", index: "Indices",
};
const CLASS_ORDER = { crypto: 0, commodity: 1, forex: 2, futures: 3, equity_index_future: 3.5, stock: 4, index: 5 };

const AGG_ID = "__agg__";

// Shared toolbar field-cell styling so Asset / Symbol / Timeframe read as one
// uniform segmented control (vs. the shared selectors' mismatched labels).
const SELECT_CLS = "bg-transparent text-sm font-mono text-text leading-none focus:outline-none cursor-pointer";
// Native <select> popups use the browser default (white) background unless the
// OPTIONS carry an OPAQUE color — the transparent select alone isn't enough, so
// light option text ends up on white. Give every <option> a solid dark bg +
// light text so the open dropdown is readable on the dark theme.
const OPTION_CLS = "bg-bg-panel text-text";

function Field({ label, children }) {
  return (
    <label className="flex flex-col justify-center gap-1 px-3.5 min-w-[96px] cursor-pointer">
      <span className="text-[9px] uppercase tracking-[0.14em] text-muted/80 leading-none">{label}</span>
      {children}
    </label>
  );
}

function mapPoints(equity) {
  return (equity || []).map((e) => ({ time: e.time, value: e.value }));
}

function agoLabel(sec) {
  if (!sec) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return fmtDate(sec);
}

export default function DashboardV2() {
  // Reuse the Dashboard's persisted symbol/broker/timeframe so context carries
  // between the two dashboards. V2-only UI state lives under ql.dv2.*.
  const [symbol, setSymbol]       = usePersistentState("ql.dash.symbol", "");
  const [broker, setBroker]       = usePersistentState("ql.dash.broker", "");
  const [timeframe, setTimeframe] = usePersistentState("ql.dash.timeframe", "15m");
  const [rangeKey, setRangeKey]   = usePersistentState("ql.dv2.range", "MAX");
  // Custom date window (used when rangeKey === "CUSTOM"); "YYYY-MM-DD" strings.
  const [customRange, setCustomRange] = usePersistentState("ql.dv2.customRange", { start: "", end: "" });
  const [scale, setScale]         = usePersistentState("ql.dv2.scale", "linear");
  const [tab, setTab]             = usePersistentState("ql.dv2.tab", "performance");
  const [selectedId, setSelectedId] = usePersistentState("ql.dv2.selected", PORTFOLIO_ID);

  const [datasets, setDatasets] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [riskConfig, setRiskConfig] = useState(null);

  const active = useActiveStrategies();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(0);
  const [progress, setProgress] = useState(null);  // latest backtest_progress payload
  const [elapsed, setElapsed] = useState(0);        // ms since the current run started
  const [editingId, setEditingId] = useState(null);
  // {strategyId, params} when the look-ahead-vs-reality comparison modal is open.
  const [laCompare, setLaCompare] = useState(null);
  const inflightRef = useRef(0);

  // Equity-curve compare: overlay the selected entity's equity under 3 regimes.
  //   reality    = honest fills + real (configured) costs  ← the main run
  //   no_cost    = honest fills + ZERO costs               ← isolates cost drag
  //   look_ahead = perfect fills + real costs              ← isolates fill fantasy
  // Extra lines are fetched LAZILY the first time toggled on, then cached until
  // the run changes. reality defaults on; the other two off.
  const [showVariant, setShowVariant] = useState({ reality: true, no_cost: false, look_ahead: false });
  const [variantData, setVariantData] = useState({ no_cost: null, look_ahead: null });
  const [variantLoading, setVariantLoading] = useState({ no_cost: false, look_ahead: false });

  const catalogById = useMemo(() => {
    const m = {}; for (const s of catalog) m[s.id] = s; return m;
  }, [catalog]);

  // ---- catalog + datasets + risk config ----
  useEffect(() => { getSymbols().then((d) => { setDatasets(d.datasets || []); }).catch(() => {}); }, []);
  useEffect(() => { getStrategies().then(setCatalog).catch(() => {}); }, []);
  useEffect(() => { getRiskConfig().then(setRiskConfig).catch(() => {}); }, []);

  // Auto-correct timeframe to one the selected symbol actually has data for.
  const tfsForSymbol = useMemo(
    () => datasets.filter((d) => d.symbol === symbol && (!broker || d.broker === broker)).map((d) => d.timeframe),
    [datasets, symbol, broker],
  );
  useEffect(() => {
    if (!symbol || tfsForSymbol.length === 0) return;
    if (!tfsForSymbol.includes(timeframe)) setTimeframe(tfsForSymbol.includes("15m") ? "15m" : tfsForSymbol[0]);
  }, [symbol, tfsForSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedDataset = useMemo(
    () => datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe && (!broker || d.broker === broker)),
    [datasets, symbol, timeframe, broker],
  );
  const datasetExists = !!selectedDataset;
  // Dataset edges drive every range computation (window for the run, "?" hint,
  // and custom-input min/max).
  const bounds = useMemo(
    () => (selectedDataset ? { firstTime: selectedDataset.first_time, lastTime: selectedDataset.last_time } : null),
    [selectedDataset],
  );
  // Seed the custom window with the dataset's full span the first time the user
  // switches to Custom (so the inputs start full, not empty).
  useEffect(() => {
    if (rangeKey === "CUSTOM" && bounds && !customRange.start && !customRange.end) {
      setCustomRange({ start: epochToDateStr(bounds.firstTime), end: epochToDateStr(bounds.lastTime) });
    }
  }, [rangeKey, bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const assetClass = selectedDataset?.asset_class
    || datasets.find((d) => d.symbol === symbol && (!broker || d.broker === broker))?.asset_class
    || "crypto";
  const assetLabel = ASSET_LABELS[assetClass] || assetClass;
  // Mirror the engine's sizing branch: futures size by `contracts` (risk_pct
  // inert), crypto/spot by `risk_pct` (contracts inert). Hide the dead control.
  const hiddenSizingParams = ["equity_index_future", "futures"].includes(assetClass) ? ["risk_pct"] : ["contracts"];

  // ---- uniform toolbar selectors (V2-local; replaces shared SymbolSelector) --
  // Asset-class tab is persisted under the same key the shared selector uses, so
  // the choice carries across pages.
  const [activeClass, setActiveClass] = usePersistentState("ql.symbolSelector.assetClass", "crypto");
  const assetClasses = useMemo(() => {
    const seen = new Set();
    for (const d of datasets) seen.add(d.asset_class || "crypto");
    return Array.from(seen).sort((a, b) => (CLASS_ORDER[a] ?? 99) - (CLASS_ORDER[b] ?? 99));
  }, [datasets]);
  const effectiveClass = assetClasses.includes(activeClass) ? activeClass : (assetClasses[0] || "crypto");
  const symbolRows = useMemo(() => {
    const seen = new Set();
    const rows = [];
    for (const d of datasets) {
      if ((d.asset_class || "crypto") !== effectiveClass) continue;
      const b = d.broker || "";
      const k = `${d.symbol}::${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ symbol: d.symbol, broker: b });
    }
    const counts = {};
    for (const r of rows) counts[r.symbol] = (counts[r.symbol] || 0) + 1;
    for (const r of rows) { r.id = `${r.symbol}::${r.broker}`; r.label = counts[r.symbol] > 1 ? `${r.symbol} · ${r.broker}` : r.symbol; }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.broker.localeCompare(b.broker));
    return rows;
  }, [datasets, effectiveClass]);
  const selectedRow = symbolRows.find((r) => r.symbol === symbol && (broker === "" || r.broker === broker))
    || symbolRows.find((r) => r.symbol === symbol) || null;
  // When the active class holds no current selection, default to its first symbol.
  useEffect(() => {
    if (symbolRows.length > 0 && !selectedRow) {
      setSymbol(symbolRows[0].symbol);
      setBroker(symbolRows[0].broker || "");
    }
  }, [effectiveClass, symbolRows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selection valid: a removed strategy falls back to Portfolio, and a
  // lone strategy is selected directly (the Portfolio aggregate entry only
  // appears for 2+ strategies, so "Portfolio" wouldn't show as selectable).
  useEffect(() => {
    if (selectedId !== PORTFOLIO_ID && !active.some((s) => s.id === selectedId)) {
      setSelectedId(active.length === 1 ? active[0].id : PORTFOLIO_ID);
    } else if (selectedId === PORTFOLIO_ID && active.length === 1) {
      setSelectedId(active[0].id);
    }
  }, [active, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- run handler (mirrors Dashboard.runHindsight) ----
  // `overrideList` lets apply-and-rerun pass the just-edited roster without
  // waiting for the store's `active` to flush through a render.
  const runBacktest = async (overrideList) => {
    const list = Array.isArray(overrideList) ? overrideList : active;
    if (!symbol || !list.length || !datasetExists) {
      setError(!symbol ? "Pick a symbol first." : !list.length ? "Add at least one strategy." : "No dataset for this symbol/timeframe.");
      return;
    }
    const myReq = ++inflightRef.current;
    setError(null);
    setProgress(null);
    setLoading(true);
    // Live stage/HMM-refit progress streamed from the backend to this client.
    const onProg = (pl) => { if (myReq === inflightRef.current) setProgress(pl); };
    socket.on("backtest_progress", onProg);
    const { start_time, end_time } = rangeToWindow(rangeKey, bounds, customRange);
    try {
      const portfolio = await runPortfolioBacktest({
        strategies: list.map((s, i) => ({
          strategy_id: s.id, symbol, timeframe,
          params: s.params, priority: i + 1, broker: broker || undefined,
        })),
        start_time, end_time, sid: socket.id,
      });
      if (myReq !== inflightRef.current) return;
      setResult(portfolio);
      setLastRun(Math.floor(Date.now() / 1000));

      // Cache slices so the Analytics page (which reads lastResultStore) can
      // deep-dive without re-running. Mirrors Dashboard.runHindsight: each
      // per-strategy slice in the legacy single-strategy shape, plus the full
      // portfolio under the __portfolio__ key.
      for (const s of list) {
        const psd = portfolio.per_strategy?.[s.id];
        if (!psd) continue;
        setLastResult(`${s.id}|${symbol}|${timeframe}`, {
          strategy_id: s.id, symbol, timeframe,
          risk_config: portfolio.risk_config,
          params: psd.spec?.params || s.params,
          candles: psd.candles || [],
          overlays: psd.overlays || [],
          trades: psd.trades || [],
          equity: psd.equity || [],
          stats: psd.stats || {},
          analytics: psd.analytics || {},
        });
      }
      setLastResult(`__portfolio__|${symbol}|${timeframe}`, portfolio);
    } catch (e) {
      if (myReq !== inflightRef.current) return;
      setError(e?.response?.data?.error || e.message || "Backtest failed.");
    } finally {
      socket.off("backtest_progress", onProg);
      if (myReq === inflightRef.current) { setLoading(false); setProgress(null); }
    }
  };

  // Tick an elapsed-time counter while a backtest is running (for the progress strip).
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const t0 = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, [loading]);

  // Clear results when the run inputs change so we never show stale numbers.
  useEffect(() => { setResult(null); setError(null); }, [symbol, broker, timeframe, active.length]);

  // ---- equity-curve variants (no-cost / look-ahead overlays) ----
  const COST_ZERO = { fee_pct: 0, fee_flat: 0, slippage_bps: 0, futures_commission: 0 };
  const isZeroCost = (rc) =>
    !!rc && ["fee_pct", "fee_flat", "slippage_bps", "futures_commission"].every((k) => !Number(rc[k]));

  // A fresh run invalidates any cached variant overlays.
  useEffect(() => { setVariantData({ no_cost: null, look_ahead: null }); }, [result]);

  const fetchVariant = async (kind) => {
    if (!result || variantData[kind] || variantLoading[kind]) return;
    // Respect cost = 0: the no-cost curve IS the reality curve — reuse it, no run.
    if (kind === "no_cost" && isZeroCost(result.risk_config)) {
      setVariantData((v) => ({ ...v, no_cost: result }));
      return;
    }
    const { start_time, end_time } = rangeToWindow(rangeKey, bounds, customRange);
    const strategies = active.map((s, i) => ({
      strategy_id: s.id, symbol, timeframe,
      params: kind === "look_ahead" ? { ...s.params, look_ahead: true } : s.params,
      priority: i + 1, broker: broker || undefined,
    }));
    setVariantLoading((l) => ({ ...l, [kind]: true }));
    try {
      const res = await runPortfolioBacktest({
        strategies, start_time, end_time,
        risk_overrides: kind === "no_cost" ? COST_ZERO : undefined,
      });
      setVariantData((v) => ({ ...v, [kind]: res }));
    } catch {
      setShowVariant((s) => ({ ...s, [kind]: false }));   // drop the overlay, keep reality
    } finally {
      setVariantLoading((l) => ({ ...l, [kind]: false }));
    }
  };

  // Fetch any toggled-on overlay that isn't cached yet (covers "just toggled on"
  // and "result changed while toggled on").
  useEffect(() => {
    if (!result) return;
    for (const kind of ["no_cost", "look_ahead"]) {
      if (showVariant[kind] && !variantData[kind] && !variantLoading[kind]) fetchVariant(kind);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, showVariant, variantData, variantLoading]);

  const toggleVariant = (kind) => setShowVariant((s) => ({ ...s, [kind]: !s[kind] }));

  // ---- selection slice resolution ----
  const sliceFor = (id) => {
    if (!result) return null;
    if (id === PORTFOLIO_ID) return result;
    return result.per_strategy?.[id] || null;
  };
  const pointsFor = (id) => {
    const s = sliceFor(id);
    return s ? mapPoints(s.equity) : null;
  };
  const slice = sliceFor(selectedId);

  // ---- derived metrics for the selected slice ----
  const sc = startingCapital(slice || result, riskConfig);
  const derived = useMemo(() => {
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
  }, [slice, sc]);

  const monthGrid = useMemo(() => monthlyReturnsGrid(slice?.analytics?.monthly_returns, sc), [slice, sc]);
  const underwater = useMemo(() => underwaterSeries(slice), [slice]);

  // ---- equity chart series for the selected entity ----
  const chart = useMemo(() => {
    if (!result) return { strategies: [], points: {} };
    if (selectedId === PORTFOLIO_ID) {
      const strategies = active.map((s) => ({ id: s.id, color: s.color, label: catalogById[s.id]?.name || s.id }));
      const points = {};
      for (const s of active) points[s.id] = mapPoints(result.per_strategy?.[s.id]?.equity);
      if (active.length >= 2) {
        strategies.push({ id: AGG_ID, color: "#e5e7eb", label: "Portfolio" });
        points[AGG_ID] = mapPoints(result.equity);
      }
      return { strategies, points };
    }
    const s = active.find((a) => a.id === selectedId);
    return {
      strategies: [{ id: selectedId, color: s?.color || "#3b82f6", label: catalogById[selectedId]?.name || selectedId }],
      points: { [selectedId]: mapPoints(result.per_strategy?.[selectedId]?.equity) },
    };
  }, [result, selectedId, active, catalogById]);

  // The selected entity's equity from a variant run (portfolio aggregate or one strategy).
  const variantPoints = (res) => {
    if (!res) return null;
    return selectedId === PORTFOLIO_ID
      ? mapPoints(res.equity)
      : mapPoints(res.per_strategy?.[selectedId]?.equity);
  };

  // Reality (base chart) + optional no-cost / look-ahead overlays for the equity panel.
  const VARIANT_META = {
    no_cost:    { color: "#22c55e", label: "No cost",    dash: "5 4" },
    look_ahead: { color: "#f59e0b", label: "Look-ahead", dash: "2 3" },
  };
  const equityChart = useMemo(() => {
    const strategies = [];
    const points = {};
    if (showVariant.reality) {
      strategies.push(...chart.strategies);
      Object.assign(points, chart.points);
    }
    for (const kind of ["no_cost", "look_ahead"]) {
      if (!showVariant[kind]) continue;
      const pts = variantPoints(variantData[kind]);
      if (!pts || !pts.length) continue;
      const id = `__var_${kind}__`;
      strategies.push({ id, ...VARIANT_META[kind] });
      points[id] = pts;
    }
    return { strategies, points };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, showVariant, variantData, selectedId]);

  const noCostIsReality = isZeroCost(result?.risk_config);
  const variantCtl = {
    show: showVariant, toggle: toggleVariant, loading: variantLoading,
    meta: VARIANT_META, noCostIsReality,
  };

  const isPortfolio = selectedId === PORTFOLIO_ID;
  // Deep-dive link: the cache was populated on run under these exact keys, and
  // `result` is cleared whenever symbol/tf/roster change, so the key always
  // matches the cached payload.
  const analyticsKey = result
    ? (isPortfolio ? `__portfolio__|${symbol}|${timeframe}` : `${selectedId}|${symbol}|${timeframe}`)
    : null;
  const headerName = isPortfolio ? "Portfolio" : (catalogById[selectedId]?.name || selectedId);
  const pill = derived ? statusPill(slice?.stats) : { label: "NO RUN", tone: "muted" };
  const pillCls = pill.tone === "profit" ? "text-profit border-profit/40 bg-profit/10"
    : pill.tone === "loss" ? "text-loss border-loss/40 bg-loss/10"
    : pill.tone === "neutral" ? "text-accent-cyan border-accent-cyan/40 bg-accent-cyan/10"
    : "text-muted border-line bg-bg-elev";

  const onAdd = (id) => {
    const meta = catalogById[id];
    addStrategy(id, resolveDefaultParams(meta, symbol, timeframe, getUserDefaults(id)));
  };

  // Apply edited params to the store and re-run the whole portfolio (shared cash
  // makes per-strategy results interdependent, so we recompute the lot). Pass the
  // edited roster explicitly so the run doesn't use stale pre-update params.
  const onApplyParams = (id, p) => {
    updateParams(id, p);
    setEditingId(null);
    if (symbol && datasetExists) {
      runBacktest(active.map((s) => (s.id === id ? { ...s, params: p } : s)));
    }
  };
  const onResetDefaults = (id) => {
    const meta = catalogById[id];
    onApplyParams(id, resolveDefaultParams(meta, symbol, timeframe, getUserDefaults(id)));
  };
  const editingStrategy = editingId ? active.find((s) => s.id === editingId) : null;
  const editingMeta = editingId ? catalogById[editingId] : null;
  // Window for the look-ahead comparison — same range the portfolio run uses.
  const laWindow = useMemo(
    () => rangeToWindow(rangeKey, bounds, customRange),
    [bounds, rangeKey, customRange],
  );
  // Human label for the Config tab: pills show as-is, CUSTOM shows the dates.
  const rangeLabel = useMemo(() => {
    if (rangeKey !== "CUSTOM") return rangeKey;
    const w = resolveWindowDates("CUSTOM", bounds, customRange);
    return w ? `${fmtDateLong(w.start_time)} – ${fmtDateLong(w.end_time)}` : "Custom";
  }, [rangeKey, bounds, customRange]);

  const canRun = symbol && active.length > 0 && datasetExists && !loading;

  return (
    <div className="flex h-screen">
      <IconNavRail view="dashboardv2" />

      <div className="flex flex-1 min-h-0">
        <StrategySidebar
          active={active}
          catalogById={catalogById}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRemove={removeStrategy}
          onAdd={onAdd}
          onEdit={setEditingId}
          sliceFor={sliceFor}
          pointsFor={pointsFor}
          strategySubtitle={symbol ? `${assetLabel} · ${symbol}` : "no symbol"}
        />

        <main className="flex-1 min-w-0 overflow-y-auto">
          {/* header */}
          <div className="px-6 pt-5 pb-3 border-b border-line">
            {/* title block */}
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-semibold tracking-tight text-text">{headerName}</h1>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${pillCls}`}>
                  ● {pill.label}
                </span>
                <span className="text-xs text-muted">
                  {isPortfolio ? `${active.length} ${active.length === 1 ? "strategy" : "strategies"}` : assetLabel}
                  {symbol ? ` · ${symbol} · ${timeframe}` : ""}
                </span>
              </div>
              <div className="text-xs text-muted mt-1 font-mono">
                {slice?.stats?.first_time
                  ? `Backtest ${fmtDateLong(slice.stats.first_time)} – ${fmtDateLong(slice.stats.last_time)} · ${(slice.equity || []).length} bars · last run ${agoLabel(lastRun)}`
                  : "Not yet run"}
              </div>
            </div>

            {/* unified control toolbar */}
            <div className="flex items-center gap-3 mt-4 flex-wrap">
              {/* segmented selector group */}
              <div className="flex items-stretch h-11 rounded-xl border border-line bg-bg-panel/40 divide-x divide-line overflow-hidden">
                <Field label="Asset">
                  <select className={SELECT_CLS} value={effectiveClass} onChange={(e) => setActiveClass(e.target.value)} aria-label="Asset class">
                    {assetClasses.length === 0
                      ? <option className={OPTION_CLS} value={effectiveClass}>—</option>
                      : assetClasses.map((c) => <option className={OPTION_CLS} key={c} value={c}>{ASSET_LABELS[c] || c}</option>)}
                  </select>
                </Field>
                <Field label="Symbol">
                  <select
                    className={SELECT_CLS}
                    value={selectedRow ? selectedRow.id : ""}
                    onChange={(e) => { const r = symbolRows.find((x) => x.id === e.target.value); if (r) { setSymbol(r.symbol); setBroker(r.broker || ""); } }}
                    aria-label="Symbol"
                  >
                    {symbolRows.length === 0 ? (
                      <option className={OPTION_CLS} value="">no data</option>
                    ) : (
                      <>
                        {!selectedRow && <option className={OPTION_CLS} value="">— pick —</option>}
                        {symbolRows.map((r) => <option className={OPTION_CLS} key={r.id} value={r.id}>{r.label}</option>)}
                      </>
                    )}
                  </select>
                </Field>
                <Field label="Timeframe">
                  <select className={SELECT_CLS} value={timeframe} onChange={(e) => setTimeframe(e.target.value)} aria-label="Timeframe">
                    {(tfsForSymbol.length ? tfsForSymbol : [timeframe]).map((t) => <option className={OPTION_CLS} key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
              </div>

              {/* range + actions, pinned right */}
              <div className="flex items-center gap-3 ml-auto">
                <RangeSelector
                  value={rangeKey}
                  onChange={setRangeKey}
                  bounds={bounds}
                  customRange={customRange}
                  onCustomChange={setCustomRange}
                />
                <a
                  href={analyticsKey ? `#analytics?key=${encodeURIComponent(analyticsKey)}` : undefined}
                  aria-disabled={!analyticsKey}
                  onClick={(e) => { if (!analyticsKey) e.preventDefault(); }}
                  title={analyticsKey
                    ? `Open in-depth analytics for ${isPortfolio ? "the portfolio" : headerName}`
                    : "Run a backtest first"}
                  className={`h-11 inline-flex items-center px-4 rounded-xl text-sm font-medium border transition ${
                    analyticsKey
                      ? "border-line text-text hover:border-accent-blue/60 hover:text-accent-blue cursor-pointer"
                      : "border-line text-muted/40 cursor-not-allowed"
                  }`}
                >
                  Analytics →
                </a>
                {!isPortfolio && (
                  <button
                    onClick={() => {
                      // Backtest → live handoff (nav + params only, no live UI here):
                      // stash the prefill, flip to the Live Terminal, deploy modal opens.
                      const s = active.find((x) => x.id === selectedId);
                      try {
                        localStorage.setItem("ql.live_deploy_prefill", JSON.stringify({
                          strategy_id: selectedId,
                          symbol: symbol || "",
                          timeframe,
                          params: s?.params || {},
                        }));
                      } catch { /* ignore */ }
                      goLive();
                    }}
                    title={`Deploy ${headerName} live with these params (opens the Live Terminal)`}
                    className="h-11 inline-flex items-center gap-2 px-4 rounded-xl text-sm font-medium border border-[#00d4a1]/50 text-[#00d4a1] hover:bg-[#00d4a1]/10 transition"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00d4a1] animate-pulse" />
                    Go Live
                  </button>
                )}
                <button
                  onClick={() => runBacktest()}
                  disabled={!canRun}
                  className={`h-11 inline-flex items-center gap-2 px-5 rounded-xl text-sm font-medium transition ${
                    canRun ? "bg-accent-grad text-white shadow-lg shadow-accent-blue/20 hover:opacity-90 cursor-pointer" : "bg-bg-elev text-muted cursor-not-allowed"
                  }`}
                >
                  {loading ? "Running…" : "▶ Run backtest"}
                </button>
              </div>
            </div>
          </div>

          {/* KPI strip — headline numbers for the selected strategy/portfolio,
              visible on every tab so you never have to open Performance to see
              capital, return, trades, and drawdown. */}
          {slice?.stats && <KpiStrip stats={slice.stats} />}

          {/* tabs */}
          <div className="px-6 pt-3">
            <TabBar
              tabs={[
                { id: "performance", label: "Performance" },
                { id: "chart", label: "Chart" },
                { id: "trades", label: "Trades" },
                { id: "config", label: "Config" },
              ]}
              active={tab}
              onSelect={setTab}
            />
          </div>

          {/* body */}
          <div className="px-6 py-5">
            {error && (
              <div className="mb-4 px-4 py-2 rounded-lg text-sm text-loss bg-loss/10 border border-loss/30">{error}</div>
            )}

            {loading && (
              <RunProgress
                progress={progress}
                elapsedMs={elapsed}
                baselineMsg={
                  active.some((s) => s.params?.use_regime && s.params?.regime_method === "hmm")
                    ? "Fitting HMM regime model — first run can take ~60–90s, then cached."
                    : "Running backtest…"
                }
              />
            )}

            {!result && !loading && (
              <EmptyState
                hasStrategies={active.length > 0}
                hasSymbol={!!symbol}
                canRun={canRun}
                loading={loading}
                onRun={() => runBacktest()}
                contextLine={[
                  isPortfolio ? `Portfolio · ${active.length} strategies` : headerName,
                  symbol,
                  timeframe,
                  rangeKey,
                ].filter(Boolean).join("  ·  ")}
              />
            )}

            {/* Result tabs — dimmed while a re-run is in flight so stale numbers read as recomputing. */}
            <div className={loading && result ? "opacity-40 pointer-events-none transition-opacity" : "transition-opacity"}>
            {result && slice && tab === "performance" && (
              <PerformanceTab
                derived={derived}
                sc={sc}
                chart={equityChart}
                variantCtl={variantCtl}
                scale={scale}
                setScale={setScale}
                underwater={underwater}
                monthGrid={monthGrid}
                interpText={interpretation(slice, derived)}
                hasAdvanced={!!slice.analytics?.advanced}
              />
            )}

            {result && slice && tab === "chart" && (
              <div>
                <div className="text-[11px] text-muted/80 mb-2 font-mono">
                  {isPortfolio ? "All strategies" : headerName} · candles, VWMA & ±z·σ bands, dashed ATR stop (shown only while a trade is open), entry/exit markers.
                </div>
                <div className="rounded-xl border border-line bg-bg-panel/40 overflow-hidden" style={{ height: 560 }}>
                  <PriceChartV2
                    result={result}
                    selectedId={selectedId}
                    active={active}
                    symbol={symbol}
                    timeframe={timeframe}
                    broker={broker}
                    portfolioId={PORTFOLIO_ID}
                  />
                </div>
              </div>
            )}

            {result && slice && tab === "trades" && (
              <TradesTab trades={slice.trades} isPortfolio={isPortfolio} catalogById={catalogById} />
            )}

            {result && slice && tab === "config" && (
              <ConfigTab
                isPortfolio={isPortfolio}
                active={active}
                selectedId={selectedId}
                slice={slice}
                catalogById={catalogById}
                symbol={symbol}
                timeframe={timeframe}
                rangeKey={rangeLabel}
                riskConfig={result.risk_config || riskConfig}
                onEdit={setEditingId}
              />
            )}
            </div>
          </div>
        </main>
      </div>

      {editingStrategy && editingMeta && (
        <StrategyEditor
          open
          color={editingStrategy.color}
          schema={editingMeta.schema}
          params={editingStrategy.params}
          strategyId={editingStrategy.id}
          builtinPresets={editingMeta.presets || {}}
          hiddenParams={hiddenSizingParams}
          onChange={() => {}}
          onClose={() => setEditingId(null)}
          onApply={(p) => onApplyParams(editingStrategy.id, p)}
          onResetDefaults={() => onResetDefaults(editingStrategy.id)}
          onSaveAsDefault={(p) => saveUserDefaults(editingStrategy.id, p)}
          onCompareLookAhead={(p) => setLaCompare({ strategyId: editingStrategy.id, params: p })}
        />
      )}

      <LookAheadComparisonModal
        open={!!laCompare}
        onClose={() => setLaCompare(null)}
        strategyId={laCompare?.strategyId}
        symbol={symbol}
        timeframe={timeframe}
        broker={broker || undefined}
        params={laCompare?.params}
        startTime={laWindow.start_time}
        endTime={laWindow.end_time}
        startingCapital={sc}
      />
    </div>
  );
}

function fmtElapsed(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Headline KPI strip under the header: final capital, net P&L ($ and %), trade
// count, and worst peak-to-trough drawdown. Reads straight from the selected
// slice's stats — same numbers the Performance tab shows, surfaced up top.
function KpiStrip({ stats }) {
  const ret = stats.total_return_pct;
  const pnl = stats.total_return_dollars;
  const dd = stats.max_drawdown_pct_peak; // ≤ 0, peak-relative (industry standard)
  const tone = (v) => (typeof v === "number" && Number.isFinite(v)
    ? (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-text")
    : "text-text");
  return (
    <div className="px-6 py-3 border-b border-line grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <Kpi label="Capital" value={fmtUsd(stats.final_equity)}
           sub={`from ${fmtUsd(stats.starting_capital)}`} />
      <Kpi label="Net P&L" value={fmtUsd(pnl)} valueCls={tone(pnl)} />
      <Kpi label="Total return" value={fmtPct(ret)} valueCls={tone(ret)} />
      <Kpi label="Trades" value={fmtInt(stats.trades)}
           sub={Number.isFinite(stats.win_rate) ? `${fmtNum(stats.win_rate * 100)}% win` : undefined} />
      <Kpi label="Max drawdown" value={fmtPct(dd, false)} valueCls="text-loss"
           sub="peak-to-trough" />
    </div>
  );
}

function Kpi({ label, value, sub, valueCls = "text-text" }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-mono font-semibold leading-tight ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70 font-mono mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

// Live progress strip shown while a backtest runs. Reflects the real backend
// stage streamed over the socket (strategy → HMM refit → simulate → stats); the
// HMM refit stage shows a determinate bar (it's the slow one), everything else a
// pulsing indeterminate bar. Falls back to baselineMsg before any event arrives.
function RunProgress({ progress, elapsedMs, baselineMsg }) {
  const p = progress || {};
  let label = baselineMsg;
  let pct = null;
  if (p.stage === "strategy") {
    label = `Analyzing ${p.label}${p.total > 1 ? ` (${p.index}/${p.total})` : ""}${p.hmm ? " — fitting HMM…" : "…"}`;
  } else if (p.stage === "hmm") {
    label = `Fitting HMM regime model · ${p.label} — refit ${p.refit}/${p.n_refits}`;
    pct = p.pct;
  } else if (p.stage === "simulate") {
    label = "Simulating portfolio…";
  } else if (p.stage === "stats") {
    label = "Computing stats & analytics…";
  }
  return (
    <div className="mb-4 rounded-xl border border-accent-blue/30 bg-accent-blue/5 px-4 py-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 text-sm text-text min-w-0">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-accent-blue border-t-transparent animate-spin shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <span className="text-xs font-mono text-muted shrink-0">{fmtElapsed(elapsedMs)}</span>
      </div>
      {pct != null ? (
        <ProgressBar label="HMM fit" pct={pct} />
      ) : (
        <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
          <div className="h-full w-full bg-accent-grad/60 animate-pulse" />
        </div>
      )}
    </div>
  );
}

function EmptyState({ hasStrategies, hasSymbol, canRun, loading, onRun, contextLine }) {
  const ready = hasStrategies && hasSymbol;
  const heading = !hasStrategies ? "Add strategies to your portfolio"
    : !hasSymbol ? "Pick a symbol"
    : "Ready to run";
  const sub = !hasStrategies
    ? "Use “+ Add strategy” in the left rail to build a shared-cash portfolio."
    : !hasSymbol
      ? "Choose a symbol and timeframe above, then run a backtest."
      : "Compute the performance report — equity curve, drawdown, monthly returns and trade stats.";

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {/* icon (pulsing glow once a run is queued) */}
      <div className="relative mb-5">
        {ready && <span className="absolute inset-0 rounded-2xl bg-accent-blue/25 blur-xl animate-pulse" aria-hidden="true" />}
        <div className="relative w-14 h-14 rounded-2xl bg-accent-grad/15 border border-accent-blue/30 flex items-center justify-center text-accent-blue">
          {ready ? (
            <svg className="w-6 h-6 translate-x-[1px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          )}
        </div>
      </div>

      <div className="text-text font-semibold text-lg">{heading}</div>
      {ready && contextLine && (
        <div className="text-xs font-mono text-accent-cyan/90 mt-1.5 tracking-wide">{contextLine}</div>
      )}
      <div className="text-sm text-muted mt-2 max-w-md">{sub}</div>

      {ready && (
        <button
          onClick={onRun}
          disabled={!canRun}
          className={`mt-6 h-11 inline-flex items-center gap-2 px-6 rounded-xl text-sm font-medium transition ${
            canRun
              ? "bg-accent-grad text-white shadow-lg shadow-accent-blue/20 hover:opacity-90 cursor-pointer"
              : "bg-bg-elev text-muted cursor-not-allowed"
          }`}
        >
          {loading ? "Running…" : "▶ Run backtest"}
        </button>
      )}
      {ready && !canRun && !loading && (
        <div className="text-[11px] text-muted/70 mt-2">Dataset for this symbol/timeframe isn’t downloaded yet.</div>
      )}

      {/* faded preview of the report that's about to render */}
      {ready && <GhostReport />}
    </div>
  );
}

// Skeleton of the Performance tab — KPI card row + a faint equity sweep. Purely
// decorative; fills the empty canvas with a hint of what a run produces.
function GhostReport() {
  return (
    <div className="w-full max-w-3xl mt-10 opacity-35 pointer-events-none select-none" aria-hidden="true">
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-line bg-bg-panel/40 p-3 h-[58px]">
            <div className="h-1.5 w-2/3 bg-bg-elev rounded mb-2.5" />
            <div className="h-3 w-1/2 bg-bg-elev rounded" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-line bg-bg-panel/40 mt-3 h-32 overflow-hidden">
        <svg viewBox="0 0 600 130" width="100%" height="100%" preserveAspectRatio="none">
          <defs>
            <linearGradient id="ghostfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0,110 C90,100 130,70 200,72 C270,74 300,40 380,46 C450,51 500,20 600,14"
                fill="none" stroke="#3b82f6" strokeWidth="2" vectorEffect="non-scaling-stroke" opacity="0.7" />
          <path d="M0,110 C90,100 130,70 200,72 C270,74 300,40 380,46 C450,51 500,20 600,14 L600,130 L0,130 Z"
                fill="url(#ghostfill)" stroke="none" />
        </svg>
      </div>
    </div>
  );
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

function PerformanceTab({ derived, sc, chart, variantCtl, scale, setScale, underwater, monthGrid, interpText, hasAdvanced }) {
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

function TradesTab({ trades, isPortfolio, catalogById }) {
  const list = trades || [];
  if (list.length === 0) return <div className="text-sm text-muted py-10 text-center">No trades for this selection.</div>;
  const CAP = 1000;
  const shown = list.slice(0, CAP);
  return (
    <div>
      <div className="text-xs text-muted mb-2 font-mono">
        {list.length} trade{list.length === 1 ? "" : "s"}{list.length > CAP ? ` (showing first ${CAP})` : ""}
      </div>
      <div className="rounded-xl border border-line overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-xs font-mono">
            <thead className="bg-bg-elev text-muted sticky top-0">
              <tr className="text-left">
                {isPortfolio && <th className="px-3 py-2 font-medium">Strategy</th>}
                <th className="px-3 py-2 font-medium">Side</th>
                <th className="px-3 py-2 font-medium">Entry</th>
                <th className="px-3 py-2 font-medium text-right">Entry px</th>
                <th className="px-3 py-2 font-medium text-right">Exit px</th>
                <th className="px-3 py-2 font-medium text-right">P&amp;L $</th>
                <th className="px-3 py-2 font-medium text-right">P&amp;L %</th>
                <th className="px-3 py-2 font-medium text-right">Dur (min)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t, i) => {
                const win = t.win || (t.pnl_dollars != null ? t.pnl_dollars >= 0 : false);
                return (
                  <tr key={i} className="border-t border-line/60 hover:bg-bg-elev/40">
                    {isPortfolio && <td className="px-3 py-1.5 text-muted">{catalogById[t.strategy_id]?.name || t.strategy_id || "—"}</td>}
                    <td className={`px-3 py-1.5 uppercase ${t.side === "long" ? "text-accent-cyan" : "text-accent-violet"}`}>{t.side}</td>
                    <td className="px-3 py-1.5 text-muted">{fmtTime(t.entry_time)}</td>
                    <td className="px-3 py-1.5 text-right">{fmtNum(t.entry_price)}</td>
                    <td className="px-3 py-1.5 text-right">{fmtNum(t.exit_price)}</td>
                    <td className={`px-3 py-1.5 text-right ${win ? "text-profit" : "text-loss"}`}>{fmtUsd(t.pnl_dollars)}</td>
                    <td className={`px-3 py-1.5 text-right ${win ? "text-profit" : "text-loss"}`}>{fmtPct(t.pnl_pct)}</td>
                    <td className="px-3 py-1.5 text-right text-muted">{t.duration_min != null ? fmtNum(t.duration_min) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ConfigTab({ isPortfolio, active, selectedId, slice, catalogById, symbol, timeframe, rangeKey, riskConfig, onEdit }) {
  const Info = ({ label, value }) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-line/60 last:border-0 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-text text-right break-all">{value}</span>
    </div>
  );

  const fmtVal = (v) => {
    if (v == null) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  };

  const renderParams = (id) => {
    const meta = catalogById[id];
    const params = (id === selectedId && !isPortfolio ? slice?.spec?.params : null)
      || active.find((s) => s.id === id)?.params
      || {};
    const schema = meta?.schema || [];
    return (
      <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-text">{meta?.name || id}</div>
          <button
            onClick={() => onEdit?.(id)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-line text-xs text-muted hover:text-accent-blue hover:border-accent-blue/60 cursor-pointer transition"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Edit
          </button>
        </div>
        {schema.length === 0 ? (
          <div className="text-xs text-muted">No parameters.</div>
        ) : (
          schema.map((spec) => (
            <Info key={spec.name} label={spec.name} value={fmtVal(params[spec.name] ?? spec.default)} />
          ))
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
        <div className="text-sm font-semibold text-text mb-2">Run configuration</div>
        <Info label="Symbol" value={symbol || "—"} />
        <Info label="Timeframe" value={timeframe} />
        <Info label="Range" value={rangeKey} />
        <Info label="Window" value={slice?.stats?.first_time ? `${fmtDate(slice.stats.first_time)} → ${fmtDate(slice.stats.last_time)}` : "—"} />
        <Info label="Starting capital" value={fmtUsd(riskConfig?.starting_capital)} />
        <Info label="Fee (flat / %)" value={`${fmtUsd(riskConfig?.fee_flat)} / ${riskConfig?.fee_pct ?? "—"}`} />
        <Info label="Slippage (bps)" value={riskConfig?.slippage_bps ?? "—"} />
      </div>

      {isPortfolio
        ? active.map((s) => <div key={s.id}>{renderParams(s.id)}</div>)
        : renderParams(selectedId)}
    </div>
  );
}
