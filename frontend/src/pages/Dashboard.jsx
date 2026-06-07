import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import SpeedControl from "../components/SpeedControl.jsx";
import BacktestKindToggle from "../components/BacktestKindToggle.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import TradingChart from "../components/TradingChart.jsx";
import CustomEquityChart from "../components/CustomEquityChart.jsx";
import StatsPanel from "../components/StatsPanel.jsx";
import StrategyCard from "../components/StrategyCard.jsx";
import StrategyEditor from "../components/StrategyEditor.jsx";
import PortfolioSummary from "../components/PortfolioSummary.jsx";
import {
  getSymbols, prepareBacktest, getStrategies, getOHLCV, runBacktest,
  runPortfolioBacktest, getRiskConfig,
} from "../services/api.js";
import {
  setSpeed as wsSetSpeed,
  socket,
  startStrategy, stopStrategy, applyStrategy, clearAllStrategySubscriptions,
} from "../services/socket.js";
import {
  useActiveStrategies, removeStrategy, updateParams, moveStrategy,
  saveUserDefaults, getUserDefaults, clearAll as clearAllStrategies,
} from "../services/strategiesStore.js";
import { setLast as setLastResult, getLast as getLastResult } from "../services/lastResultStore.js";
import { usePersistentState } from "../services/usePersistentState.js";

const COLOR_WIN  = "#22c55e";
const COLOR_LOSS = "#ef4444";

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function makeMarker(signal, win) {
  const isEntry = signal.kind === "entry";
  const long = signal.side === "long";
  return {
    time: signal.time,
    position: isEntry ? (long ? "belowBar" : "aboveBar") : (long ? "aboveBar" : "belowBar"),
    shape: isEntry ? (long ? "arrowUp" : "arrowDown") : "square",
    color: win ? COLOR_WIN : COLOR_LOSS,
    text: isEntry ? (long ? "L" : "S") : "X",
    size: 1,
  };
}
function tradesToMarkers(trades) {
  const out = [];
  for (const t of trades) {
    const win = !!t.win || (t.pnl_dollars != null ? t.pnl_dollars >= 0 : false);
    out.push(makeMarker({ kind: "entry", side: t.side, time: t.entry_time }, win));
    out.push(makeMarker({ kind: "exit",  side: t.side, time: t.exit_time  }, win));
  }
  return out;
}
function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}
function epochToDateStr(sec) {
  if (!sec) return "";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/**
 * Build the Dashboard's hindsight chart state from whatever's in the
 * cross-page result cache. Used to rehydrate on mount so coming back to
 * the page is instant. If nothing in cache, returns empty shells.
 */
function restoreFromCache(active, symbol, timeframe) {
  const empty = { staticData: null, equityPoints: {}, markersByStrategy: {}, statsById: {} };
  if (!symbol || !active || active.length === 0) return empty;

  // Use the first active strategy's cached candles as the chart base.
  // Each subsequent strategy contributes its own overlays/markers/equity.
  let baseCandles = null;
  const overlaysByStrategy = {};
  const markersByStrategy  = {};
  const equityPoints       = {};
  const statsById          = {};

  for (const s of active) {
    const r = getLastResult(`${s.id}|${symbol}|${timeframe}`);
    if (!r) continue;
    if (!baseCandles && r.candles?.length) baseCandles = r.candles;
    overlaysByStrategy[s.id] = r.overlays || [];
    markersByStrategy[s.id]  = tradesToMarkers(r.trades || []);
    equityPoints[s.id]       = (r.equity || []).map((e) => ({ time: e.time, value: e.value }));
    statsById[s.id] = {
      ...(r.stats || {}),
      equity: r.stats?.final_equity ?? 0,
      drawdown: r.stats?.max_drawdown_pct ?? 0,
      trades: r.stats?.trades ?? 0,
      win_rate: r.stats?.win_rate ?? 0,
    };
  }

  if (!baseCandles) return empty;
  return {
    staticData: { candles: baseCandles, overlaysByStrategy, markersByStrategy },
    equityPoints,
    markersByStrategy,
    statsById,
  };
}

export default function Dashboard() {
  // Selectors persist across page navigation so coming back to the
  // dashboard restores your last view (symbol/tf/mode/etc).
  const [mode,         setMode]         = usePersistentState("ql.dash.mode",         "backtest");
  const [backtestKind, setBacktestKind] = usePersistentState("ql.dash.backtestKind", "hindsight");
  const [symbol,       setSymbol]       = usePersistentState("ql.dash.symbol",       "");
  const [broker,       setBroker]       = usePersistentState("ql.dash.broker",       "");
  const [timeframe,    setTimeframe]    = usePersistentState("ql.dash.timeframe",    "15m");
  const [speed,        setSpeed]        = usePersistentState("ql.dash.speed",        60);

  const [symbolList, setSymbolList] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [strategiesCatalog, setStrategiesCatalog] = useState([]);
  const catalogById = useMemo(() => {
    const m = {}; for (const s of strategiesCatalog) m[s.id] = s; return m;
  }, [strategiesCatalog]);

  const [riskConfig, setRiskConfig] = useState(null);

  const active = useActiveStrategies();
  const [armed, setArmed] = useState(false);     // replay: started?
  const [range, setRange] = usePersistentState("ql.dash.range", { start: "", end: "" });

  // Restore chart state from the result cache on FIRST MOUNT so navigating
  // away and back doesn't flash a spinner. Auto-run still fires afterwards
  // and silently refreshes if anything actually changed.
  const initial = useRef(restoreFromCache(active, symbol, timeframe)).current;

  const [equityPoints,      setEquityPoints]      = useState(initial.equityPoints);
  const [markersByStrategy, setMarkersByStrategy] = useState(initial.markersByStrategy);
  const [statsById,         setStatsById]         = useState(initial.statsById);
  const [staticData,        setStaticData]        = useState(initial.staticData);

  const [hindsightLoading, setHindsightLoading] = useState(false);
  const [hindsightError, setHindsightError] = useState(null);
  const [portfolioResult, setPortfolioResult] = useState(
    () => getLastResult(`__portfolio__|${symbol}|${timeframe}`) || null
  );
  const inflightRef = useRef(0);

  const [editingId, setEditingId] = useState(null);

  // ---- catalog + datasets + risk config -------------------------
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getSymbols()
        .then((d) => {
          if (cancelled) return;
          setSymbolList(d.symbols);
          setDatasets(d.datasets || []);
        })
        .catch(() => {});
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, [armed, mode, backtestKind]);

  useEffect(() => { getStrategies().then(setStrategiesCatalog).catch(() => {}); }, []);
  useEffect(() => { getRiskConfig().then(setRiskConfig).catch(() => {}); }, []);

  // Don't auto-pick a symbol on load — wait for the user to click. If
  // the currently selected symbol disappears (e.g. dataset deleted), drop it.
  useEffect(() => {
    if (symbol && symbolList.length > 0 && !symbolList.includes(symbol)) {
      setSymbol("");
      setBroker("");
    }
  }, [symbolList]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== "backtest" || !symbol) return;
    const tfs = datasets.filter((d) => d.symbol === symbol && (!broker || d.broker === broker)).map((d) => d.timeframe);
    if (tfs.length > 0 && !tfs.includes(timeframe)) {
      setTimeframe(tfs.includes("15m") ? "15m" : tfs[0]);
    }
  }, [symbol, datasets, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live mode: futures/commodity symbols stream from TradeStation CSV (1H only).
  // Auto-correct timeframe whenever the symbol or mode changes.
  const _FUTURES_LIVE_TF = "1h";
  const _FUTURES_CLASSES = new Set(["equity_index_future", "commodity", "futures"]);
  const _liveAssetClass = (
    datasets.find((d) => d.symbol === symbol && (!broker || d.broker === broker))?.asset_class  // has backtest data
    || localStorage.getItem("ql.symbolSelector.assetClass")         // read active tab
    || "crypto"
  );
  const _isFuturesLive = mode === "live" && _FUTURES_CLASSES.has(_liveAssetClass);

  useEffect(() => {
    if (!_isFuturesLive) return;
    if (timeframe !== _FUTURES_LIVE_TF) setTimeframe(_FUTURES_LIVE_TF);
  }, [mode, symbol, _isFuturesLive]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== "backtest" || backtestKind !== "replay") return;
    const ds = datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe && (!broker || d.broker === broker));
    if (!ds) return;
    setRange((r) => ({
      start: r.start || epochToDateStr(ds.first_time),
      end:   r.end   || epochToDateStr(ds.last_time),
    }));
  }, [symbol, timeframe, datasets, mode, backtestKind]);

  // Disarm replay on input change.
  useEffect(() => { setArmed(false); }, [mode, symbol, timeframe, backtestKind]);

  // Auto-apply timeframe defaults when timeframe changes.
  useEffect(() => {
    for (const s of active) {
      const meta = catalogById[s.id];
      if (!meta?.timeframe_defaults?.[timeframe]) continue;
      const defaults = {};
      for (const spec of meta.schema) defaults[spec.name] = spec.default;
      for (const preset of [meta.timeframe_defaults?.[timeframe], meta.symbol_defaults?.[symbol]]) {
        if (!preset) continue;
        for (const [k, v] of Object.entries(preset)) {
          const base = defaults[k];
          defaults[k] = (v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object" && !Array.isArray(base))
            ? { ...base, ...v } : v;
        }
      }
      const userSaved = getUserDefaults(s.id);
      updateParams(s.id, userSaved ? { ...defaults, ...userSaved } : defaults);
    }
  }, [timeframe]); // eslint-disable-line react-hooks/exhaustive-deps

  const tfsForSymbol = mode === "backtest"
    ? datasets.filter((d) => d.symbol === symbol && (!broker || d.broker === broker)).map((d) => d.timeframe)
    : _isFuturesLive ? [_FUTURES_LIVE_TF]   // only 1h available from TradeStation CSV
    : null;

  const datasetExists = mode !== "backtest" || datasets.some(
    (d) => d.symbol === symbol && d.timeframe === timeframe && (!broker || d.broker === broker),
  );

  const streaming = mode === "live"
    ? !!symbol
    : (backtestKind === "replay" && armed && !!symbol);

  useEffect(() => {
    if (mode === "backtest" && backtestKind === "replay" && armed) {
      wsSetSpeed({ symbol, timeframe, speed, broker: broker || undefined });
    }
  }, [speed, mode, backtestKind, symbol, timeframe, armed]);

  // ---- streaming socket listeners (Replay + Live) --------------
  useEffect(() => {
    const onEquity = (p) => {
      const STARTING = riskConfig?.starting_capital ?? 100000;
      const valuePct = p.equity;   // already %
      setEquityPoints((prev) => {
        const arr = prev[p.strategy_id] ? [...prev[p.strategy_id]] : [];
        if (arr.length && arr[arr.length - 1].time >= p.time) {
          arr[arr.length - 1] = { time: p.time, value: valuePct };
        } else {
          arr.push({ time: p.time, value: valuePct });
        }
        return { ...prev, [p.strategy_id]: arr };
      });
      setStatsById((prev) => ({
        ...prev,
        [p.strategy_id]: {
          ...(prev[p.strategy_id] || {}),
          total_return_pct: valuePct - 100,
          total_return_dollars: ((valuePct - 100) / 100) * STARTING,
          trades: p.trades, win_rate: p.win_rate,
          max_drawdown_pct: p.drawdown,
        },
      }));
      const trade = p.trade;
      if (trade) {
        const win = trade.pnl_dollars != null
          ? trade.pnl_dollars >= 0
          : (trade.pnl_pct != null ? trade.pnl_pct >= 0 : false);
        setMarkersByStrategy((prev) => {
          const list = (prev[p.strategy_id] || []).map((m) => ({ ...m }));
          for (let i = list.length - 1; i >= 0; i--) {
            const m = list[i];
            const isEntryArrow = m.shape === "arrowUp" || m.shape === "arrowDown";
            const sideMatch = (trade.side === "long" && m.shape === "arrowUp")
                          || (trade.side === "short" && m.shape === "arrowDown");
            if (isEntryArrow && sideMatch) {
              list[i] = { ...m, color: win ? COLOR_WIN : COLOR_LOSS };
              break;
            }
          }
          list.push(makeMarker({ kind: "exit", side: trade.side, time: trade.exit_time }, win));
          return { ...prev, [p.strategy_id]: list };
        });
      }
    };
    const onSignal = (p) => {
      const strat = active.find((s) => s.id === p.strategy_id);
      if (!strat) return;
      if (p.kind !== "entry") return;
      setMarkersByStrategy((prev) => {
        const list = prev[p.strategy_id] ? [...prev[p.strategy_id]] : [];
        list.push(makeMarker(p, /*win=*/false));
        return { ...prev, [p.strategy_id]: list };
      });
    };
    const onError = (p) => console.warn("[strategy] error:", p);

    socket.on("equity_update", onEquity);
    socket.on("signal_update", onSignal);
    socket.on("strategy_error", onError);
    return () => {
      socket.off("equity_update", onEquity);
      socket.off("signal_update", onSignal);
      socket.off("strategy_error", onError);
    };
  }, [active, riskConfig]);

  const resetStreamingState = () => {
    setEquityPoints({}); setMarkersByStrategy({}); setStatsById({});
  };

  useEffect(() => {
    const brk = broker || undefined;
    if (!streaming) {
      for (const s of active) stopStrategy({ strategy_id: s.id, symbol, timeframe, mode, broker: brk });
      clearAllStrategySubscriptions();
      return;
    }
    resetStreamingState();
    for (const s of active) {
      startStrategy({ strategy_id: s.id, symbol, timeframe, mode, params: s.params, broker: brk });
    }
    return () => {
      for (const s of active) stopStrategy({ strategy_id: s.id, symbol, timeframe, mode, broker: brk });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, mode, symbol, timeframe, broker, active.length]);

  // ---- Hindsight runner (portfolio mode) -----------------------
  //
  // Single call into /api/backtest/portfolio walks all active strategies
  // through ONE shared cash pool. N=1 degenerates to single-strategy.
  // The portfolio response includes a per_strategy block we decompose into
  // the same state shape the rest of the UI already expects.
  const runHindsight = async () => {
    if (!symbol || !active.length || !datasetExists) {
      setStaticData(null);
      setHindsightError(null);
      setPortfolioResult(null);
      return;
    }
    const myReq = ++inflightRef.current;
    setHindsightError(null);
    setHindsightLoading(true);

    try {
      const candlesP = getOHLCV({ symbol, timeframe, mode: "backtest", limit: 200000, broker: broker || undefined });
      const portfolioP = runPortfolioBacktest({
        strategies: active.map((s, i) => ({
          strategy_id: s.id, symbol, timeframe,
          params: s.params, priority: i + 1, broker: broker || undefined,
        })),
      });

      const [candles, portfolio] = await Promise.all([candlesP, portfolioP]);
      if (myReq !== inflightRef.current) return;  // stale

      const overlaysByStrategy = {};
      const markersByStrategyLocal = {};
      const equityLocal = {};
      const statsLocal = {};

      for (const s of active) {
        const psd = portfolio.per_strategy?.[s.id];
        if (!psd) {
          console.warn("portfolio result missing strategy:", s.id);
          continue;
        }
        overlaysByStrategy[s.id] = psd.overlays || [];
        markersByStrategyLocal[s.id] = tradesToMarkers(psd.trades || []);
        equityLocal[s.id] = (psd.equity || []).map((e) => ({ time: e.time, value: e.value }));
        statsLocal[s.id] = {
          ...(psd.stats || {}),
          equity: psd.stats?.final_equity ?? 0,
          drawdown: psd.stats?.max_drawdown_pct ?? 0,
          trades: psd.stats?.trades ?? 0,
          win_rate: psd.stats?.win_rate ?? 0,
        };
        // Cache the per-strategy slice for the Analytics page.
        // Reuse the existing legacy-shape so single-strategy Analytics
        // works unchanged: pull the per_strategy block + risk_config.
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

      // Cache the FULL portfolio result under a synthetic key so the
      // Analytics page can render the polished portfolio view.
      setLastResult(`__portfolio__|${symbol}|${timeframe}`, portfolio);

      setStaticData({ candles, overlaysByStrategy, markersByStrategy: markersByStrategyLocal });
      setEquityPoints(equityLocal);
      setStatsById(statsLocal);
      setMarkersByStrategy(markersByStrategyLocal);
      setPortfolioResult(portfolio);
    } catch (e) {
      if (myReq !== inflightRef.current) return;
      const status = e?.response?.status;
      if (status === 404) {
        getSymbols().then((d) => { setSymbolList(d.symbols); setDatasets(d.datasets || []); }).catch(() => {});
      }
      setHindsightError(e?.response?.data?.error || e.message || "hindsight run failed");
    } finally {
      if (myReq === inflightRef.current) setHindsightLoading(false);
    }
  };

  // Hydrate the chart from cached results whenever inputs change. NEVER
  // auto-runs the backtest — the user must press "Run Backtest" explicitly.
  useEffect(() => {
    if (mode !== "backtest" || backtestKind !== "hindsight") return;
    if (!symbol || !datasetExists || active.length === 0) {
      setStaticData(null);
      setEquityPoints({});
      setMarkersByStrategy({});
      setStatsById({});
      setPortfolioResult(null);
      return;
    }
    const restored = restoreFromCache(active, symbol, timeframe);
    setStaticData(restored.staticData);
    setEquityPoints(restored.equityPoints);
    setMarkersByStrategy(restored.markersByStrategy);
    setStatsById(restored.statsById);
    setPortfolioResult(getLastResult(`__portfolio__|${symbol}|${timeframe}`) || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, backtestKind, symbol, timeframe, active.length, datasetExists]);

  const allCached = symbol && active.length > 0 && active.every(
    (s) => getLastResult(`${s.id}|${symbol}|${timeframe}`) != null
  );

  // Re-run a single strategy's hindsight (Apply & Re-run from editor).
  const reRunOneHindsight = async (id, params) => {
    if (!symbol || !staticData) return;
    try {
      const r = await runBacktest({ strategy_id: id, symbol, timeframe, params, broker: broker || undefined });
      const newMarkers = tradesToMarkers(r.trades || []);
      setStaticData((prev) => ({
        ...prev,
        overlaysByStrategy: { ...prev.overlaysByStrategy, [id]: r.overlays || [] },
        markersByStrategy: { ...prev.markersByStrategy, [id]: newMarkers },
      }));
      setEquityPoints((prev) => ({ ...prev, [id]: (r.equity || []).map((e) => ({ time: e.time, value: e.value })) }));
      setStatsById((prev) => ({
        ...prev,
        [id]: {
          ...(r.stats || {}),
          equity: r.stats?.final_equity ?? 0,
          drawdown: r.stats?.max_drawdown_pct ?? 0,
          trades: r.stats?.trades ?? 0,
          win_rate: r.stats?.win_rate ?? 0,
        },
      }));
      setMarkersByStrategy((prev) => ({ ...prev, [id]: newMarkers }));
      setLastResult(`${id}|${symbol}|${timeframe}`, r);
    } catch (e) {
      console.warn("re-run hindsight failed", e);
    }
  };

  const onApplyParams = (id, params) => {
    updateParams(id, params);
    if (mode === "backtest" && backtestKind === "hindsight") {
      reRunOneHindsight(id, params);
    } else if (streaming) {
      setEquityPoints((prev) => ({ ...prev, [id]: [] }));
      setMarkersByStrategy((prev) => ({ ...prev, [id]: [] }));
      setStatsById((prev) => ({ ...prev, [id]: undefined }));
      applyStrategy({ strategy_id: id, symbol, timeframe, mode, params, broker: broker || undefined });
    }
  };

  const onRunReplay = async () => {
    try {
      await prepareBacktest({ symbol, timeframe, broker: broker || undefined });
      setArmed(true);
    } catch (e) {
      if (e?.response?.status === 404) {
        getSymbols().then((d) => { setSymbolList(d.symbols); setDatasets(d.datasets || []); }).catch(() => {});
      }
    }
  };

  const replayOpts = mode === "backtest" && backtestKind === "replay"
    ? {
        start_time: dateStrToEpoch(range.start),
        end_time: dateStrToEpoch(range.end, true),
        loop: true,
        broker: broker || undefined,
      }
    : undefined;

  const useStaticChart = mode === "backtest" && backtestKind === "hindsight" && !!staticData;

  const sessionsForChart = useMemo(() => {
    for (const s of active) {
      if (s.params && s.params.sessions && typeof s.params.sessions === "object") return s.params.sessions;
    }
    for (const s of active) {
      const meta = catalogById[s.id];
      const spec = meta?.schema?.find((x) => x.name === "sessions");
      if (spec?.default) return spec.default;
    }
    return null;
  }, [active, catalogById]);

  // Equity-chart series. Per-strategy lines + a synthetic "Portfolio" line
  // (the shared cash pool's aggregate MTM) when running 2+ strategies.
  const SHOW_PORTFOLIO_LINE = active.length >= 2 && portfolioResult?.equity?.length > 0;

  // Track which series are hidden (clicked off in the legend). Reset whenever
  // the active set or portfolio-mode toggle changes so we don't carry stale
  // hide-flags into a different chart.
  const [hiddenSeries, setHiddenSeries] = useState(() => new Set());
  useEffect(() => {
    setHiddenSeries(new Set());
  }, [active.length, SHOW_PORTFOLIO_LINE]);
  const toggleSeriesHidden = (id) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Series advertised to the chart's legend (full list, regardless of hidden
  // state). Per-strategy entries carry their human-readable name from the
  // catalog so the legend reads "VWMA Momentum" rather than "vwma_momentum".
  const allChartSeries = useMemo(() => {
    const out = active.map((s) => ({
      id: s.id,
      color: s.color,
      label: catalogById[s.id]?.name || s.id,
    }));
    if (SHOW_PORTFOLIO_LINE) {
      out.push({ id: "__portfolio__", color: "#ffffff", label: "Portfolio (shared)" });
    }
    return out;
  }, [active, catalogById, SHOW_PORTFOLIO_LINE]);

  // Filter down to the series that should actually be drawn.
  const chartStrategies = useMemo(
    () => allChartSeries.filter((s) => !hiddenSeries.has(s.id)),
    [allChartSeries, hiddenSeries],
  );
  const chartEquityPoints = useMemo(() => {
    const base = { ...equityPoints };
    if (SHOW_PORTFOLIO_LINE) {
      base.__portfolio__ = portfolioResult.equity.map((e) => ({ time: e.time, value: e.value }));
    }
    return base;
  }, [equityPoints, portfolioResult, SHOW_PORTFOLIO_LINE]);

  // Analytics deep-link target.
  // - 2+ strategies with a cached portfolio result → portfolio view (all
  //   strategies + per-strategy view selector + Skipped Signals tab).
  // - Otherwise the single active strategy's last result.
  // Monte Carlo now lives standalone — open it from the top nav. No
  // dashboard-side deep-link needed.
  const analyticsKey = active.length > 0 && symbol
    ? (active.length >= 2 && portfolioResult
        ? `__portfolio__|${symbol}|${timeframe}`
        : `${active[0].id}|${symbol}|${timeframe}`)
    : null;
  const analyticsHref = analyticsKey ? `#analytics?key=${encodeURIComponent(analyticsKey)}` : "#analytics";

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="dashboard" mode={mode} onModeChange={setMode} />

      {/* Controls */}
      <div className="px-6 py-3 flex flex-wrap items-center gap-6 border-b border-line bg-bg-panel/30">
        <SymbolSelector value={symbol} broker={broker || null} options={symbolList} datasets={datasets} onChange={(sym, brk) => { setSymbol(sym); setBroker(brk || ""); }} />
        <TimeframeSelector value={timeframe} onChange={setTimeframe} available={tfsForSymbol} />
        {mode === "backtest" && (
          <BacktestKindToggle value={backtestKind} onChange={setBacktestKind} />
        )}
        {mode === "backtest" && backtestKind === "replay" && (
          <>
            <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
            <SpeedControl value={speed} onChange={setSpeed} />
            <button
              onClick={onRunReplay}
              disabled={!symbol || !datasetExists || armed}
              className="ml-auto px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {armed ? "Replaying…" : "▶ Run Replay"}
            </button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {mode === "backtest" && backtestKind === "hindsight" && (
            <button
              onClick={runHindsight}
              disabled={!symbol || !datasetExists || active.length === 0 || hindsightLoading}
              className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold uppercase tracking-wider disabled:opacity-40 disabled:cursor-not-allowed"
              title={allCached ? "Re-run backtest (cached results shown)" : "Run backtest"}
            >
              {hindsightLoading ? "Running…" : allCached ? "↻ Re-run" : "▶ Run Backtest"}
            </button>
          )}
          {staticData && (
            <a
              href={analyticsHref}
              className="px-4 py-2 rounded-md border border-accent-blue/60 text-accent-blue hover:bg-accent-blue/10 text-sm font-medium"
            >
              View Analytics →
            </a>
          )}
          <a
            href="#downloads"
            title="Manage cached datasets"
            className="px-3 py-2 rounded-md border border-line text-muted hover:text-text hover:border-accent-blue text-sm font-medium inline-flex items-center gap-1.5"
          >
            <DownloadIcon />
            Data
          </a>
        </div>
      </div>

      {hindsightError && (
        <div className="px-6 py-2 text-sm text-loss bg-loss/10 border-b border-loss/30">
          {hindsightError}
        </div>
      )}

      {/* Strategy cards */}
      <div className="px-6 py-3 border-b border-line bg-bg-panel/20">
        <div className="flex items-center gap-3 overflow-x-auto pb-1">
          {active.length === 0 && (
            <div className="text-xs text-muted">
              no strategies active —
              {" "}<a href="#strategies" className="text-accent-blue hover:underline">browse the catalog →</a>
            </div>
          )}
          {active.map((s, i) => (
            <StrategyCard
              key={s.id}
              strategy={catalogById[s.id]}
              color={s.color}
              stats={statsById[s.id]}
              priority={active.length > 1 ? i + 1 : null}
              canMoveUp={i > 0}
              canMoveDown={i < active.length - 1}
              onSettings={() => setEditingId(s.id)}
              onRemove={() => removeStrategy(s.id)}
              onMoveUp={active.length > 1 ? () => moveStrategy(s.id, "up") : undefined}
              onMoveDown={active.length > 1 ? () => moveStrategy(s.id, "down") : undefined}
            />
          ))}
          {active.length > 0 && (
            <a href="#strategies"
               className="text-xs text-muted hover:text-text px-3 py-2 border border-dashed border-line rounded-lg whitespace-nowrap">
              + Add
            </a>
          )}
          {active.length > 1 && (
            <button
              onClick={() => clearAllStrategies()}
              className="text-xs text-muted hover:text-loss px-3 py-2 border border-dashed border-line hover:border-loss/40 rounded-lg whitespace-nowrap transition"
              title="Remove all strategies from dashboard"
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Portfolio aggregate — shown when 2+ strategies share a cash pool. */}
      {mode === "backtest" && backtestKind === "hindsight"
        && active.length >= 2 && portfolioResult && (
        <div className="px-4 pt-3">
          <PortfolioSummary
            result={portfolioResult}
            symbol={symbol}
            timeframe={timeframe}
          />
        </div>
      )}

      {/* Charts */}
      <main className="flex-1 p-4 flex flex-col gap-3">
        <div className="relative h-[52vh] rounded-xl border border-line bg-bg-panel/60 overflow-hidden shadow-2xl shadow-black/40">
          {/* Idle states for backtest hindsight */}
          {mode === "backtest" && backtestKind === "hindsight" && !staticData && !hindsightLoading && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-bg/70 backdrop-blur">
              {symbolList.length === 0 ? (
                <>
                  <div className="text-text text-base">No cached datasets yet</div>
                  <a href="#downloads" className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-medium">Open Downloads →</a>
                </>
              ) : !symbol ? (
                <div className="text-sm text-muted">Pick a symbol above, then press <span className="text-text">Run Backtest</span>.</div>
              ) : !datasetExists ? (
                <>
                  <div className="text-text text-base">No dataset for <span className="font-mono text-accent-violet">{symbol} {timeframe}</span></div>
                  <a href="#downloads" className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-medium">Open Downloads →</a>
                </>
              ) : active.length === 0 ? (
                <>
                  <div className="text-sm text-muted">No strategies active.</div>
                  <a href="#strategies" className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm">Browse strategies →</a>
                </>
              ) : (
                <>
                  <div className="text-base text-text">Ready · <span className="font-mono text-accent-violet">{symbol} {timeframe}</span></div>
                  <button onClick={runHindsight}
                    className="mt-1 px-6 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold uppercase tracking-wider">
                    ▶ Run Backtest
                  </button>
                </>
              )}
            </div>
          )}

          {/* Replay idle */}
          {mode === "backtest" && backtestKind === "replay" && !armed && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-bg/70 backdrop-blur">
              {datasetExists ? (
                <>
                  <div className="text-base text-text">Ready to replay <span className="font-mono text-accent-violet">{symbol} {timeframe}</span></div>
                  <button onClick={onRunReplay}
                    className="mt-1 px-6 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold uppercase tracking-wider">
                    ▶ Run Replay
                  </button>
                </>
              ) : (
                <a href="#downloads" className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-medium">Open Downloads →</a>
              )}
            </div>
          )}

          {hindsightLoading && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-bg/80 backdrop-blur">
              <div className="w-10 h-10 rounded-full border-2 border-accent-violet border-t-transparent animate-spin" />
              <div className="text-sm text-muted">running backtest…</div>
            </div>
          )}

          {useStaticChart && (
            <TradingChart
              key="static-chart"
              mode="backtest"
              symbol={symbol}
              timeframe={timeframe}
              staticData={staticData}
              sessions={sessionsForChart}
              onMissingDataset={() => {
                setStaticData(null);
                getSymbols().then((d) => { setSymbolList(d.symbols); setDatasets(d.datasets || []); }).catch(() => {});
              }}
            />
          )}

          {streaming && (
            <TradingChart
              key="stream-chart"
              mode={mode}
              symbol={symbol}
              broker={broker || undefined}
              timeframe={timeframe}
              speed={speed}
              markersByStrategy={markersByStrategy}
              activeStrategies={active}
              replayOpts={replayOpts}
              sessions={sessionsForChart}
              onMissingDataset={() => {
                setArmed(false);
                getSymbols().then((d) => { setSymbolList(d.symbols); setDatasets(d.datasets || []); }).catch(() => {});
              }}
            />
          )}
        </div>

        {/* Equity panel — per-strategy lines + aggregate "Portfolio" line on top.
            Clickable legend toggles each series. The "shared" line shows the
            portfolio's actual MTM (cash + open positions); strategy lines are
            each strategy's standalone attribution. */}
        <div className="relative h-[28vh] rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
          {active.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">
              add strategies on the Strategies page to see equity curves here
            </div>
          )}
          {allChartSeries.length > 0 && (
            <div className="absolute top-2 right-3 z-10 flex items-center gap-1.5 flex-wrap justify-end max-w-[70%]">
              {allChartSeries.map((s) => {
                const off = hiddenSeries.has(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggleSeriesHidden(s.id)}
                    title={off ? "Click to show" : "Click to hide"}
                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono border transition ${
                      off
                        ? "border-line/40 text-muted/50 bg-bg-panel/30"
                        : "border-line/60 text-muted hover:text-text bg-bg-panel/60"
                    }`}
                  >
                    <span
                      className="w-3 h-[2px] rounded-sm"
                      style={{
                        background: s.color,
                        opacity: off ? 0.3 : 1,
                      }}
                    />
                    <span className={off ? "line-through" : ""}>{s.label}</span>
                  </button>
                );
              })}
            </div>
          )}
          <CustomEquityChart
            strategies={chartStrategies}
            pointsByStrategy={chartEquityPoints}
            startingCapital={riskConfig?.starting_capital ?? 100000}
          />
        </div>

        <StatsPanel strategies={active} statsById={statsById} />
      </main>

      {editingId && (() => {
        const s = active.find((x) => x.id === editingId);
        const meta = catalogById[editingId];
        if (!s || !meta) return null;
        return (
          <StrategyEditor
            open
            color={s.color}
            schema={meta.schema}
            params={s.params}
            strategyId={s.id}
            builtinPresets={meta.presets || {}}
            onClose={() => setEditingId(null)}
            onApply={(p) => { onApplyParams(s.id, p); setEditingId(null); }}
            onSaveAsDefault={(p) => saveUserDefaults(s.id, p)}
            onResetDefaults={() => {
              // Start from code-level defaults.
              const defaults = {};
              for (const spec of meta.schema) defaults[spec.name] = spec.default;
              // Layer 1: per-timeframe, Layer 2: per-symbol (symbol wins over timeframe).
              for (const preset of [meta.timeframe_defaults?.[timeframe], meta.symbol_defaults?.[symbol]]) {
                if (!preset) continue;
                for (const [k, v] of Object.entries(preset)) {
                  const base = defaults[k];
                  if (v && typeof v === "object" && !Array.isArray(v)
                      && base && typeof base === "object" && !Array.isArray(base)) {
                    const merged = { ...base };
                    for (const [k2, v2] of Object.entries(v)) {
                      const baseSub = base[k2];
                      merged[k2] = (v2 && typeof v2 === "object" && !Array.isArray(v2)
                          && baseSub && typeof baseSub === "object" && !Array.isArray(baseSub))
                        ? { ...baseSub, ...v2 } : v2;
                    }
                    defaults[k] = merged;
                  } else {
                    defaults[k] = v;
                  }
                }
              }
              // Layer 3: user-saved defaults override everything.
              const userDefaults = getUserDefaults(s.id);
              const resolved = userDefaults ? { ...defaults, ...userDefaults } : defaults;
              onApplyParams(s.id, resolved);
            }}
            onChange={() => {}}
          />
        );
      })()}
    </div>
  );
}
