import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import CustomEquityChart from "../components/CustomEquityChart.jsx";
import WalkForwardParamEditor from "../components/WalkForwardParamEditor.jsx";
import WalkForwardPresetPicker from "../components/WalkForwardPresetPicker.jsx";
import WalkForwardGuide from "../components/WalkForwardGuide.jsx";
import {
  getSymbols, getStrategies,
  startWalkForward, cancelWalkForward, getWalkForwardStatus, getWalkForwardLastResult,
  aiSuggestWalkForward, aiAnalyzeWalkForwardSection, aiChatWalkForward,
} from "../services/api.js";
import { subscribeWalkForward } from "../services/socket.js";
import { setLast as setLastResult } from "../services/lastResultStore.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt } from "../services/format.js";
import { TabBar } from "../components/analytics/primitives.jsx";
import {
  Field, NumInput, BudgetHint,
  ProgressPanel,
  WFVerdict, Kpi,
  BestParamRankings, TopCombinations, WindowRankings, WindowHeatmap,
  PnlHeatmapGrid, SessionsEditor,
  useParamStats,
} from "../components/walkforward/widgets.jsx";

const METRICS = [
  { id: "sharpe",        label: "Sharpe" },
  { id: "profit_factor", label: "Profit Factor" },
  { id: "total_return",  label: "Total Return" },
];

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

const TABS = [
  { id: "setup",      label: "Setup" },
  { id: "overview",   label: "Overview" },
  { id: "folds",      label: "Folds" },
  { id: "parameters", label: "Parameters" },
  { id: "optuna",     label: "Optuna" },
  { id: "robustness", label: "Robustness" },
  { id: "regime",     label: "Regime" },
  { id: "ai",         label: "AI Analysis" },
];

function getTabFromHash() {
  const m = window.location.hash.match(/tab=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "setup";
}

function setTabInHash(t) {
  window.location.hash = `#walkforward?tab=${encodeURIComponent(t)}`;
}

function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}

function fmtDate(epoch) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function wfKey(result) {
  if (!result) return null;
  return `WF|${result.strategy_id}|${result.symbol}|${result.timeframe}`;
}

export default function WalkForward() {
  // ---- setup form (persisted) -----------------------------------------
  const [symbols, setSymbols] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [symbol, setSymbol]       = usePersistentState("ql.wf.symbol", "");
  const [timeframe, setTimeframe] = usePersistentState("ql.wf.timeframe", "1h");
  const [strategyId, setStrategyId] = usePersistentState("ql.wf.strategy", "");
  const [range, setRange] = usePersistentState("ql.wf.range", { start: "", end: "" });
  const [isBars, setIsBars]   = usePersistentState("ql.wf.is_bars", 1000);
  const [oosBars, setOosBars] = usePersistentState("ql.wf.oos_bars", 200);
  const [nTrials, setNTrials] = usePersistentState("ql.wf.n_trials", 50);
  const [metric, setMetric]   = usePersistentState("ql.wf.metric", "sharpe");
  const [nWorkers, setNWorkers] = usePersistentState("ql.wf.n_workers", 1);
  const [embargoBars, setEmbargoBars] = usePersistentState("ql.wf.embargo_bars", 0);
  const [purgeRadius, setPurgeRadius] = usePersistentState("ql.wf.purge_radius", 0);
  const [showGuide, setShowGuide] = useState(false);
  const maxWorkers = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;

  const tfsForSymbol = useMemo(
    () => datasets.filter((d) => d.symbol === symbol).map((d) => d.timeframe),
    [datasets, symbol],
  );
  useEffect(() => {
    if (!symbol || tfsForSymbol.length === 0) return;
    if (!tfsForSymbol.includes(timeframe)) {
      setTimeframe(tfsForSymbol.includes("15m") ? "15m" : tfsForSymbol[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfsForSymbol]);

  const [baseParams, setBaseParams]   = usePersistentState("ql.wf.base", {});
  const [searchSpace, setSearchSpace] = usePersistentState("ql.wf.search", []);
  const [sessions, setSessions]       = usePersistentState("ql.wf.sessions", []);
  const lastStrategyId = useRef(strategyId);
  useEffect(() => {
    if (lastStrategyId.current && lastStrategyId.current !== strategyId) {
      setBaseParams({});
      setSearchSpace([]);
    }
    lastStrategyId.current = strategyId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  // ---- live job state --------------------------------------------------
  const [jobState, setJobState] = useState({ state: "idle" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const liveWindows = useRef([]);
  const mainRef = useRef(null);
  const progressRef = useRef(null);
  const [chatOpen, setChatOpen] = useState(false);

  // ---- AI Suggest state ------------------------------------------------
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false);
  const [aiSuggestResult, setAiSuggestResult] = useState(null);
  const [aiSuggestError, setAiSuggestError] = useState(null);

  // ---- tab state (URL-hash synced) ------------------------------------
  const [tab, setTab] = useState(getTabFromHash());
  useEffect(() => {
    const onHash = () => setTab(getTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const onTab = (id) => { setTabInHash(id); setTab(id); };

  // Once a result appears, auto-flip from Setup to Overview so the user
  // sees the headline numbers without having to click.
  const lastResultRef = useRef(null);
  useEffect(() => {
    if (result && result !== lastResultRef.current && tab === "setup") {
      onTab("overview");
    }
    lastResultRef.current = result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const currentDataset = useMemo(
    () => datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
    [datasets, symbol, timeframe],
  );

  useEffect(() => {
    if (!currentDataset) return;
    const start = currentDataset.first_time ? fmtDate(currentDataset.first_time) : "";
    const end   = currentDataset.last_time  ? fmtDate(currentDataset.last_time)  : "";
    if (!start || !end) return;
    if (range.start !== start || range.end !== end) {
      setRange({ start, end });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDataset?.first_time, currentDataset?.last_time]);

  const onApplyPreset = (values) => {
    setRange({ start: values.start, end: values.end });
    setIsBars(values.isBars);
    setOosBars(values.oosBars);
    setNTrials(values.nTrials);
    setMetric(values.metric);
    setAiSuggestResult(null);
    setAiSuggestError(null);
  };

  const onAiSuggest = async () => {
    if (!currentDataset) {
      setAiSuggestError("Pick a symbol/timeframe with downloaded data first.");
      return;
    }
    setAiSuggestLoading(true); setAiSuggestError(null);
    try {
      const res = await aiSuggestWalkForward({
        strategy_id: strategyId,
        symbol,
        timeframe,
        rows: currentDataset.rows,
        first_time: currentDataset.first_time,
        last_time: currentDataset.last_time,
        timeframe_seconds: TF_SECONDS[timeframe] || 60,
        search_space: searchSpace,
        search_space_len: searchSpace.length,
        base_params: baseParams,
      });
      const s = res.suggestion || {};
      if (s.is_bars)  setIsBars(s.is_bars);
      if (s.oos_bars) setOosBars(s.oos_bars);
      if (s.n_trials) setNTrials(s.n_trials);
      if (s.metric)   setMetric(s.metric);
      setAiSuggestResult({ ...s, usage: res.usage, model: res.model });
    } catch (e) {
      setAiSuggestError(e?.response?.data?.error || e.message || "AI suggest failed");
    } finally {
      setAiSuggestLoading(false);
    }
  };

  // ---- load lists ------------------------------------------------------
  useEffect(() => {
    getSymbols().then((data) => {
      const opts = data?.symbols || [];
      setSymbols(opts);
      setDatasets(data?.datasets || []);
      if (!symbol && opts.length) setSymbol(opts[0]);
    }).catch((e) => setError(e?.response?.data?.error || e.message));

    getStrategies().then((arr) => {
      setStrategies(arr || []);
      if (!strategyId && arr?.length) setStrategyId(arr[0].id);
    }).catch((e) => setError(e?.response?.data?.error || e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- hydrate status + last result on mount ---------------------------
  useEffect(() => {
    getWalkForwardStatus().then((st) => {
      setJobState(st || { state: "idle" });
      if (st?.windows) liveWindows.current = st.windows;
      if (st?.state === "idle" && st?.result) setResult(st.result);
    }).catch(() => {});
    getWalkForwardLastResult().then((r) => {
      if (r) setResult(r);
    }).catch(() => {});
  }, []);

  // ---- socket subscription --------------------------------------------
  useEffect(() => {
    const unsub = subscribeWalkForward({
      onProgress: (p) => {
        setJobState((prev) => ({
          ...(prev || {}),
          state: "running",
          job_id: p.job_id,
          window_idx: p.window_idx,
          total_windows: p.total_windows,
          trial_idx: p.trial_idx,
          n_trials: p.n_trials,
          current_best_score: p.current_score,
        }));
      },
      onWindowDone: (p) => {
        liveWindows.current = [...liveWindows.current, p.window];
        setJobState((prev) => ({ ...(prev || {}), windows: [...liveWindows.current] }));
      },
      onComplete: (p) => {
        setResult(p.result);
        setJobState((prev) => ({ ...(prev || {}), state: "done", windows: liveWindows.current }));
      },
      onCancelled: () => {
        setJobState((prev) => ({ ...(prev || {}), state: "cancelled" }));
      },
      onError: (p) => {
        setError(p.message || "walk-forward error");
        setJobState((prev) => ({ ...(prev || {}), state: "error" }));
      },
    });
    return unsub;
  }, []);

  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) || null,
    [strategies, strategyId]
  );

  const running = jobState?.state === "running" || jobState?.state === "starting";

  useEffect(() => {
    if (running) {
      progressRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [running]);

  const onStart = async () => {
    setError(null);
    liveWindows.current = [];
    setJobState({ state: "starting" });
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    try {
      // Convert sessions array → dict keyed by name for the backend.
      const sessions_cfg = Object.fromEntries(
        (sessions || [])
          .filter((s) => s.name && s.enabled)
          .map((s) => [s.name, { enabled: true, start: s.start, end: s.end }])
      );
      await startWalkForward({
        strategy_id: strategyId,
        symbol,
        timeframe,
        start_time: dateStrToEpoch(range.start),
        end_time:   dateStrToEpoch(range.end, true),
        base_params: baseParams,
        search_space: searchSpace,
        is_bars: isBars,
        oos_bars: oosBars,
        n_trials: nTrials,
        n_workers: nWorkers,
        metric,
        embargo_bars: embargoBars,
        purge_radius: purgeRadius,
        sessions_cfg: Object.keys(sessions_cfg).length > 0 ? sessions_cfg : null,
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setJobState({ state: "idle" });
    }
  };

  const onCancel = async () => {
    try { await cancelWalkForward(); } catch {}
  };

  const onOpenInAnalytics = () => {
    if (!result) return;
    const k = wfKey(result);
    setLastResult(k, result);
    window.location.hash = `#analytics?key=${encodeURIComponent(k)}`;
  };

  const onOpenInCostSweep = () => {
    if (!result) return;
    const windows = result.windows || [];
    if (!windows.length) return;
    const first = windows[0];
    const last  = windows[windows.length - 1];
    const handoff = {
      strategy_id: result.strategy_id,
      symbol:      result.symbol,
      timeframe:   result.timeframe,
      params:      last.best_params || {},
      oos_start:   first.oos_start,
      oos_end:     last.oos_end,
    };
    localStorage.setItem("ql.cs.wf_import", JSON.stringify(handoff));
    window.location.hash = "#costsweep";
  };

  const tabs = useMemo(
    () => TABS.map((t) => ({ ...t, disabled: t.id !== "setup" && !result })),
    [result],
  );

  const setupProps = {
    symbols, datasets, symbol, setSymbol,
    timeframe, setTimeframe, tfsForSymbol,
    range, setRange,
    currentDataset,
    onApplyPreset, running,
    aiSuggestLoading, aiSuggestResult, aiSuggestError, onAiSuggest,
    strategies, strategyId, setStrategyId,
    isBars, setIsBars, oosBars, setOosBars,
    nTrials, setNTrials, metric, setMetric,
    nWorkers, setNWorkers, maxWorkers,
    embargoBars, setEmbargoBars, purgeRadius, setPurgeRadius,
    searchSpace, activeStrategy, baseParams, setBaseParams, setSearchSpace,
    sessions, setSessions,
    onStart, onCancel,
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="walkforward" />

      <div className="flex-1 flex overflow-hidden">
        <main ref={mainRef} className="flex-1 p-6 overflow-y-auto space-y-5 min-w-0 max-w-7xl w-full mx-auto">
          <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Walk-Forward Optimization</h1>
            <p className="text-sm text-muted mt-1">
              Roll an in-sample / out-of-sample window across history. Optuna searches
              params on each IS window; the best params are evaluated on the next OOS
              window. The stitched OOS performance is the honest, out-of-sample report.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
              {result && (
                <button
                  onClick={onOpenInCostSweep}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold border border-accent-blue/50 text-accent-blue hover:bg-accent-blue/10 transition"
                >
                  Cost Sweep →
                </button>
              )}
              {result && (
                <button
                  onClick={onOpenInAnalytics}
                  className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent-grad text-white"
                >
                  Open in Analytics →
                </button>
              )}
              <button
                onClick={() => setShowGuide(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-line text-xs text-muted hover:text-text hover:border-accent-blue"
                title="What do IS / OOS / trials / workers mean?"
              >
                <span className="w-4 h-4 rounded-full bg-accent-blue/15 text-accent-blue flex items-center justify-center text-[10px] font-bold">?</span>
                Guide
              </button>
            </div>
          </header>

          {error && (
            <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>
          )}

          {/* Progress banner sits ABOVE the tab bar so it's visible from any tab */}
          {(running || jobState?.state === "cancelled") && (
            <div ref={progressRef}>
              <ProgressPanel jobState={jobState} />
            </div>
          )}

          <TabBar tabs={tabs} active={tab} onSelect={onTab} />

          {tab === "setup"      && <SetupTab {...setupProps} />}
          {tab === "overview"   && result && <OverviewTab   result={result} />}
          {tab === "folds"      && result && <FoldsTab      result={result} />}
          {tab === "parameters" && result && <ParametersTab result={result} />}
          {tab === "optuna"     && result && <OptunaTab     result={result} />}
          {tab === "robustness" && result && <RobustnessTab result={result} />}
          {tab === "regime"     && result && <RegimeTab     result={result} />}
          {tab === "ai"         && result && <AITab         result={result} />}

          {!result && tab !== "setup" && (
            <div className="rounded-xl border border-line bg-bg-panel/60 p-10 text-center text-muted">
              <div className="text-base text-text mb-1">No walk-forward result loaded</div>
              <div className="text-xs">Configure and start a run on the Setup tab.</div>
              <button
                onClick={() => onTab("setup")}
                className="inline-block mt-4 px-4 py-2 rounded-md bg-accent-grad text-white text-sm"
              >
                Go to Setup →
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Floating chat toggle button */}
      <button
        onClick={() => setChatOpen((o) => !o)}
        title={chatOpen ? "Close assistant" : "Open assistant"}
        className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-accent-grad shadow-lg flex items-center justify-center hover:opacity-90 transition-opacity"
      >
        {chatOpen ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        )}
      </button>

      <WFChatSidebar open={chatOpen} onClose={() => setChatOpen(false)} result={result} />
      <WalkForwardGuide open={showGuide} onClose={() => setShowGuide(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------

function SetupTab({
  symbols, datasets, symbol, setSymbol,
  timeframe, setTimeframe, tfsForSymbol,
  range, setRange,
  currentDataset,
  onApplyPreset, running,
  aiSuggestLoading, aiSuggestResult, aiSuggestError, onAiSuggest,
  strategies, strategyId, setStrategyId,
  isBars, setIsBars, oosBars, setOosBars,
  nTrials, setNTrials, metric, setMetric,
  nWorkers, setNWorkers, maxWorkers,
  embargoBars, setEmbargoBars, purgeRadius, setPurgeRadius,
  searchSpace, activeStrategy, baseParams, setBaseParams, setSearchSpace,
  sessions, setSessions,
  onStart, onCancel,
}) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-4">
      <div className="text-[11px] uppercase tracking-wider text-muted">Setup</div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <SymbolSelector value={symbol} options={symbols} datasets={datasets} onChange={setSymbol} />
        <TimeframeSelector value={timeframe} onChange={setTimeframe} available={tfsForSymbol} />
        <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
      </div>

      <WalkForwardPresetPicker
        dataset={currentDataset}
        timeframe={timeframe}
        onApply={onApplyPreset}
        disabled={running}
      />

      <div className="rounded-md border border-accent-blue/30 bg-accent-blue/5 p-3 flex items-start gap-3">
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-wider text-accent-blue">AI Suggest · Claude Haiku 4.5</div>
          <div className="text-xs text-muted mt-0.5">
            {currentDataset
              ? <>Have <span className="text-text font-mono">{currentDataset.rows.toLocaleString()}</span> bars · ~{((currentDataset.last_time - currentDataset.first_time) / 86400 / 365).toFixed(1)} years of {symbol} {timeframe}. Claude will pick IS / OOS / trials / metric.</>
              : <>Pick a symbol + timeframe with downloaded data, then click for an AI-tuned config.</>}
          </div>
          {aiSuggestError && <div className="text-xs text-loss font-mono mt-1.5">{aiSuggestError}</div>}
          {aiSuggestResult && (
            <div className="text-xs text-text mt-2 leading-relaxed">
              <span className="text-accent-blue">▸</span> {aiSuggestResult.rationale}
              {aiSuggestResult.expected_windows != null && (
                <span className="text-muted font-mono"> · ~{aiSuggestResult.expected_windows} windows</span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onAiSuggest}
          disabled={aiSuggestLoading || !currentDataset || !strategyId}
          className="shrink-0 px-4 py-2 rounded-md bg-accent-grad text-white text-xs font-semibold disabled:opacity-40"
        >
          {aiSuggestLoading ? "Thinking…" : (aiSuggestResult ? "Re-suggest" : "AI Suggest")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Field label="Strategy">
          <select
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className="px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
          >
            {strategies.length === 0 && <option value="">— loading —</option>}
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        <Field label="IS bars">
          <NumInput value={isBars} onChange={setIsBars} min={10} />
        </Field>
        <Field label="OOS bars">
          <NumInput value={oosBars} onChange={setOosBars} min={1} />
        </Field>
        <Field label="Trials / window">
          <NumInput value={nTrials} onChange={setNTrials} min={1} />
        </Field>
        <Field label="Metric">
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
            className="px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
          >
            {METRICS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Field label={`Workers (CPUs)`}>
          <div className="flex items-center gap-3 min-w-[280px]">
            <input
              type="range"
              min={1}
              max={maxWorkers}
              step={1}
              value={Math.min(nWorkers, maxWorkers)}
              onChange={(e) => setNWorkers(parseInt(e.target.value, 10) || 1)}
              className="w-44 accent-accent-blue"
              disabled={running}
              title="Parallel Optuna trials per window. 1 = sequential and fully reproducible (same seed → same result). >1 is faster but non-deterministic."
            />
            <span className="font-mono text-sm tabular-nums w-12 text-right">
              {nWorkers} / {maxWorkers}
            </span>
          </div>
        </Field>
        <span className="text-[11px] text-muted/70">
          Parallel Optuna trials per window. 1 = sequential (stable, reproducible).
          {nWorkers > 1 && <> <span className="text-amber-400">·  results non-deterministic above 1.</span></>}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2 border-t border-line/40">
        <div className="text-[11px] uppercase tracking-wider text-muted">Rigor (optional)</div>
        <Field label="Embargo bars">
          <NumInput value={embargoBars} onChange={setEmbargoBars} min={0} />
        </Field>
        <Field label="Purge radius">
          <NumInput value={purgeRadius} onChange={setPurgeRadius} min={0} />
        </Field>
        <span className="text-[11px] text-muted/70 max-w-md">
          Embargo = bars skipped between IS and OOS (prevents leakage from straddling indicators).
          Purge = bars trimmed off the right edge of IS (purged CV).
        </span>
      </div>

      <BudgetHint searchSpaceLen={searchSpace.length} nTrials={nTrials} isBars={isBars} oosBars={oosBars} />

      <div className="pt-2 border-t border-line/40">
        <SessionsEditor value={sessions} onChange={setSessions} />
      </div>

      {activeStrategy && (
        <div className="pt-2 border-t border-line/40">
          <WalkForwardParamEditor
            schema={activeStrategy.schema}
            baseParams={baseParams}
            searchSpace={searchSpace}
            onChange={({ baseParams: b, searchSpace: ss }) => {
              setBaseParams(b);
              setSearchSpace(ss);
            }}
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        {running ? (
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md bg-loss/15 text-loss border border-loss/40 text-sm font-semibold"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onStart}
            disabled={!symbol || !strategyId}
            className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-40"
          >
            Start Walk-Forward
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// OVERVIEW — headline KPIs + stitched OOS equity (B&H overlay in C.1)
// ---------------------------------------------------------------------------

function OverviewTab({ result }) {
  const s = result.stats || {};
  const lng = s.long || {};
  const sht = s.short || {};
  const windows = result.windows || [];
  const equityPts = (result.equity || []).map((p) => ({ time: p.time, value: p.value }));
  const sessions = (result.analytics?.by_session || []).sort((a, b) => b.pnl_dollars - a.pnl_dollars);
  const pnlGrid  = result.analytics?.heatmap?.pnl   || [];
  const cntGrid  = result.analytics?.heatmap?.count || [];

  // Stitched buy-and-hold series.
  const bhPts = useMemo(() => {
    let value = 100;
    const pts = [];
    for (const w of windows) {
      if (w.bh_return_pct == null || w.oos_start == null || w.oos_end == null) continue;
      if (pts.length === 0) pts.push({ time: w.oos_start, value });
      else pts.push({ time: w.oos_start, value });
      value = value * (1 + w.bh_return_pct / 100);
      pts.push({ time: w.oos_end, value });
    }
    return pts;
  }, [windows]);

  const hasBh = bhPts.length >= 2;
  const strategyMeta = hasBh
    ? [{ id: result.strategy_id, color: "#3b82f6" }, { id: "__bh__", color: "#94a3b8" }]
    : [{ id: result.strategy_id, color: "#3b82f6" }];
  const pointsByStrategy = hasBh
    ? { [result.strategy_id]: equityPts, __bh__: bhPts }
    : { [result.strategy_id]: equityPts };

  return (
    <section className="space-y-4">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        Walk-Forward Result · {windows.length} window{windows.length === 1 ? "" : "s"}
        {result.wf_spec && (
          <> · IS={result.wf_spec.is_bars}b OOS={result.wf_spec.oos_bars}b · metric={result.wf_spec.metric}</>
        )}
        {result.wf_spec?.embargo_bars > 0 && <> · embargo={result.wf_spec.embargo_bars}</>}
        {result.wf_spec?.purge_radius > 0 && <> · purge={result.wf_spec.purge_radius}</>}
      </div>

      <WFVerdict result={result} />

      {/* ── Headline KPIs ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi title="OOS Final Equity"   value={fmtUsd(s.final_equity)} sub={`from ${fmtUsd(s.starting_capital)}`} />
        <Kpi title="OOS Total Return"   value={fmtPct(s.total_return_pct)}
             positive={s.total_return_dollars >= 0} sub={fmtUsd(s.total_return_dollars)} />
        <Kpi title="OOS Sharpe"         value={fmtNum(s.sharpe)} />
        <Kpi title="OOS Profit Factor"  value={s.profit_factor == null ? "∞" : fmtNum(s.profit_factor)} />
        <Kpi title="OOS Win Rate"       value={`${fmtNum((s.win_rate ?? 0) * 100)}%`} sub={`${fmtInt(s.wins)} W / ${fmtInt(s.losses)} L`} />
        <Kpi title="OOS Trades"         value={fmtInt(s.trades)} />
        <Kpi title="OOS Max Drawdown"   value={fmtPct(s.max_drawdown_pct, false)} positive={false} sub={fmtUsd(s.max_drawdown_dollars)} />
        <Kpi title="OOS Avg Trade"      value={fmtUsd(s.avg_pnl_dollars)} />
      </div>

      {/* ── Long vs Short ─────────────────────────────────────────────── */}
      {(lng.trades > 0 || sht.trades > 0) && (
        <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-muted">Long vs Short</div>
          <div className="grid grid-cols-2 gap-4">
            {/* Long side */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-profit/80 uppercase tracking-wider">Longs</div>
              <div className="grid grid-cols-2 gap-2">
                <Kpi title="Trades"   value={fmtInt(lng.trades)} />
                <Kpi title="Win Rate" value={`${fmtNum((lng.win_rate ?? 0) * 100)}%`} />
                <Kpi title="PnL"      value={fmtUsd(lng.pnl_dollars)} positive={lng.pnl_dollars >= 0} />
                <Kpi title="Avg Trade" value={fmtUsd(lng.avg_pnl_dollars)} positive={lng.avg_pnl_dollars >= 0} />
              </div>
            </div>
            {/* Short side */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-loss/80 uppercase tracking-wider">Shorts</div>
              <div className="grid grid-cols-2 gap-2">
                <Kpi title="Trades"   value={fmtInt(sht.trades)} />
                <Kpi title="Win Rate" value={`${fmtNum((sht.win_rate ?? 0) * 100)}%`} />
                <Kpi title="PnL"      value={fmtUsd(sht.pnl_dollars)} positive={sht.pnl_dollars >= 0} />
                <Kpi title="Avg Trade" value={fmtUsd(sht.avg_pnl_dollars)} positive={sht.avg_pnl_dollars >= 0} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Session Breakdown ─────────────────────────────────────────── */}
      {sessions.length > 0 && (
        <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
          <div className="px-4 py-2 border-b border-line/40">
            <span className="text-[11px] uppercase tracking-wider text-muted">Session Breakdown</span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elev/40">
              <tr>
                <th className="text-left px-4 py-2">Session</th>
                <th className="text-right px-4 py-2">Trades</th>
                <th className="text-right px-4 py-2">Win%</th>
                <th className="text-right px-4 py-2">PnL</th>
                <th className="text-right px-4 py-2 border-l border-line/40">Long PnL</th>
                <th className="text-right px-4 py-2">Short PnL</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm">
              {sessions.map((r) => (
                <tr key={r.session} className="border-t border-line/40 hover:bg-bg-elev/30">
                  <td className="px-4 py-2 text-text">{r.session}</td>
                  <td className="px-4 py-2 text-right">{fmtInt(r.trades)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(r.win_rate * 100)}%</td>
                  <td className={`px-4 py-2 text-right ${r.pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>
                    {fmtUsd(r.pnl_dollars)}
                  </td>
                  <td className={`px-4 py-2 text-right border-l border-line/40 ${r.long_pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>
                    {fmtUsd(r.long_pnl_dollars)}
                  </td>
                  <td className={`px-4 py-2 text-right ${r.short_pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>
                    {fmtUsd(r.short_pnl_dollars)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── PnL Heatmap ───────────────────────────────────────────────── */}
      {pnlGrid.length > 0 && (
        <PnlHeatmapGrid pnlGrid={pnlGrid} cntGrid={cntGrid} />
      )}

      {/* ── Equity Chart ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wider text-muted">Stitched OOS Equity</div>
          {hasBh && (
            <div className="text-[10px] font-mono text-muted flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5 bg-[#3b82f6]" /> strategy
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-0.5 bg-[#94a3b8]" /> buy-and-hold
              </span>
            </div>
          )}
        </div>
        <div className="h-[320px]">
          <CustomEquityChart
            strategies={strategyMeta}
            pointsByStrategy={pointsByStrategy}
            startingCapital={s.starting_capital ?? 100000}
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// FOLDS — per-window table + heatmap (C.2 adds IS-vs-OOS / vs-B&H / CI charts)
// ---------------------------------------------------------------------------

function FoldsTab({ result }) {
  const windows = result.windows || [];
  return (
    <section className="space-y-4">
      <FoldsISvsOOSChart windows={windows} />
      <FoldsStratVsBHChart windows={windows} />
      <FoldsSharpeCIChart windows={windows} />
      <WindowRankings windows={windows} />
      <WindowHeatmap windows={windows} searchSpace={result?.wf_spec?.search_space || []} />
    </section>
  );
}

// Paired bars: IS metric (training score) vs OOS Sharpe. Gap = overfit signal.
function FoldsISvsOOSChart({ windows }) {
  if (!windows.length) return null;
  const rows = windows.map((w) => ({
    idx: w.window_idx,
    is: typeof w.is_score === "number" ? w.is_score : null,
    oos: w.oos_stats?.sharpe ?? 0,
  }));
  const all = rows.flatMap((r) => [r.is, r.oos]).filter((v) => v != null);
  let yMin = Math.min(0, ...all), yMax = Math.max(0, ...all);
  if (yMin === yMax) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08 || 0.1;
  yMin -= pad; yMax += pad;

  const w = 720, h = 220;
  const px = { l: 56, r: 16, t: 12, b: 28 };
  const innerW = w - px.l - px.r, innerH = h - px.t - px.b;
  const groupW = innerW / rows.length;
  const barW = Math.max(4, (groupW - 4) / 2);
  const yOf = (v) => px.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-text">IS score vs OOS Sharpe per window</div>
          <div className="text-[11px] text-muted">
            Big gap = overfit (training score didn't generalize). Aligned bars = honest edge.
          </div>
        </div>
        <div className="text-[10px] font-mono text-muted flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-[#94a3b8] rounded-sm" /> IS</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-[#3b82f6] rounded-sm" /> OOS</span>
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <svg width={w} height={h} className="block">
          <line x1={px.l} x2={w - px.r} y1={yOf(0)} y2={yOf(0)} stroke="rgba(229,231,235,0.25)" strokeWidth="0.6" />
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const v = yMin + (yMax - yMin) * (1 - p);
            return (
              <g key={i}>
                <line x1={px.l} x2={w - px.r} y1={px.t + p * innerH} y2={px.t + p * innerH}
                      stroke="rgba(229,231,235,0.05)" />
                <text x={px.l - 6} y={px.t + p * innerH + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {fmtNum(v)}
                </text>
              </g>
            );
          })}
          {rows.map((r, i) => {
            const gx = px.l + i * groupW;
            const xIs = gx + 2;
            const xOos = gx + 2 + barW + 2;
            const yIs = r.is != null ? yOf(r.is) : yOf(0);
            const yOos = yOf(r.oos);
            return (
              <g key={r.idx}>
                {r.is != null && (
                  <rect x={xIs} y={Math.min(yIs, yOf(0))}
                        width={barW} height={Math.abs(yIs - yOf(0))}
                        fill="#94a3b8" fillOpacity="0.7" />
                )}
                <rect x={xOos} y={Math.min(yOos, yOf(0))}
                      width={barW} height={Math.abs(yOos - yOf(0))}
                      fill={r.oos >= 0 ? "#3b82f6" : "#ef4444"} fillOpacity="0.85" />
                {(i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 10) === 0) && (
                  <text x={gx + groupW / 2} y={h - 10} textAnchor="middle"
                        className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                    #{r.idx}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// Strategy OOS return % vs underlying buy-and-hold % per fold.
function FoldsStratVsBHChart({ windows }) {
  const rows = windows
    .filter((w) => w.bh_return_pct != null)
    .map((w) => ({
      idx: w.window_idx,
      strat: w.oos_stats?.total_return_pct ?? 0,
      bh: w.bh_return_pct,
    }));
  if (rows.length < 1) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Need bh_return_pct (Phase B.2) on at least one window to render strategy-vs-B&H bars.
      </div>
    );
  }
  const all = rows.flatMap((r) => [r.strat, r.bh]);
  let yMin = Math.min(0, ...all), yMax = Math.max(0, ...all);
  if (yMin === yMax) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08 || 0.1;
  yMin -= pad; yMax += pad;

  const w = 720, h = 220;
  const px = { l: 56, r: 16, t: 12, b: 28 };
  const innerW = w - px.l - px.r, innerH = h - px.t - px.b;
  const groupW = innerW / rows.length;
  const barW = Math.max(4, (groupW - 4) / 2);
  const yOf = (v) => px.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const beat = rows.filter((r) => r.strat > r.bh).length;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-text">Strategy vs Buy-and-Hold per window</div>
          <div className="text-[11px] text-muted">
            {beat}/{rows.length} windows beat passive ({fmtNum(beat / rows.length * 100)}%).
            Trading is only worth doing if you're consistently winning here.
          </div>
        </div>
        <div className="text-[10px] font-mono text-muted flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-[#3b82f6] rounded-sm" /> strategy</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 bg-[#94a3b8] rounded-sm" /> B&amp;H</span>
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <svg width={w} height={h} className="block">
          <line x1={px.l} x2={w - px.r} y1={yOf(0)} y2={yOf(0)} stroke="rgba(229,231,235,0.25)" strokeWidth="0.6" />
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const v = yMin + (yMax - yMin) * (1 - p);
            return (
              <g key={i}>
                <line x1={px.l} x2={w - px.r} y1={px.t + p * innerH} y2={px.t + p * innerH}
                      stroke="rgba(229,231,235,0.05)" />
                <text x={px.l - 6} y={px.t + p * innerH + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {fmtNum(v)}%
                </text>
              </g>
            );
          })}
          {rows.map((r, i) => {
            const gx = px.l + i * groupW;
            const xS = gx + 2, xB = gx + 2 + barW + 2;
            const yS = yOf(r.strat), yB = yOf(r.bh);
            const won = r.strat > r.bh;
            return (
              <g key={r.idx}>
                <rect x={xS} y={Math.min(yS, yOf(0))} width={barW} height={Math.abs(yS - yOf(0))}
                      fill={won ? "#3b82f6" : "#ef4444"} fillOpacity="0.85">
                  <title>#{r.idx}: strat {fmtPct(r.strat)} vs B&H {fmtPct(r.bh)}</title>
                </rect>
                <rect x={xB} y={Math.min(yB, yOf(0))} width={barW} height={Math.abs(yB - yOf(0))}
                      fill="#94a3b8" fillOpacity="0.6" />
                {(i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 10) === 0) && (
                  <text x={gx + groupW / 2} y={h - 10} textAnchor="middle"
                        className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                    #{r.idx}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// OOS Sharpe with bootstrap CI brackets. Windows whose CI crosses zero are faded.
function FoldsSharpeCIChart({ windows }) {
  const rows = windows
    .filter((w) => w.oos_sharpe_ci_low != null && w.oos_sharpe_ci_high != null)
    .map((w) => ({
      idx: w.window_idx,
      sharpe: w.oos_stats?.sharpe ?? 0,
      lo: w.oos_sharpe_ci_low,
      hi: w.oos_sharpe_ci_high,
    }));
  if (rows.length < 1) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Need bootstrap Sharpe CIs (Phase B.2) to render confidence brackets.
      </div>
    );
  }
  const all = rows.flatMap((r) => [r.lo, r.hi, r.sharpe]);
  let yMin = Math.min(0, ...all), yMax = Math.max(0, ...all);
  if (yMin === yMax) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.1 || 0.1;
  yMin -= pad; yMax += pad;

  const w = 720, h = 240;
  const px = { l: 56, r: 16, t: 12, b: 28 };
  const innerW = w - px.l - px.r, innerH = h - px.t - px.b;
  const colW = innerW / rows.length;
  const dotW = Math.max(2, colW * 0.5);
  const yOf = (v) => px.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const crossesZero = (r) => r.lo <= 0 && r.hi >= 0;
  const ambiguous = rows.filter(crossesZero).length;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-text">OOS Sharpe with 95% bootstrap CI</div>
          <div className="text-[11px] text-muted">
            Brackets that cross zero = window's Sharpe is not statistically distinguishable from random.
            {ambiguous > 0 && <> {ambiguous}/{rows.length} ambiguous.</>}
          </div>
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <svg width={w} height={h} className="block">
          <line x1={px.l} x2={w - px.r} y1={yOf(0)} y2={yOf(0)} stroke="rgba(229,231,235,0.3)" strokeDasharray="2 3" strokeWidth="0.6" />
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const v = yMin + (yMax - yMin) * (1 - p);
            return (
              <g key={i}>
                <line x1={px.l} x2={w - px.r} y1={px.t + p * innerH} y2={px.t + p * innerH}
                      stroke="rgba(229,231,235,0.05)" />
                <text x={px.l - 6} y={px.t + p * innerH + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {fmtNum(v)}
                </text>
              </g>
            );
          })}
          {rows.map((r, i) => {
            const cx = px.l + i * colW + colW / 2;
            const yLo = yOf(r.lo), yHi = yOf(r.hi), yS = yOf(r.sharpe);
            const faded = crossesZero(r);
            const color = r.sharpe >= 0 ? "#3b82f6" : "#ef4444";
            const opacity = faded ? 0.35 : 0.95;
            return (
              <g key={r.idx} opacity={opacity}>
                <line x1={cx} x2={cx} y1={yLo} y2={yHi} stroke={color} strokeWidth="1.5" />
                <line x1={cx - dotW / 2} x2={cx + dotW / 2} y1={yLo} y2={yLo} stroke={color} strokeWidth="1.5" />
                <line x1={cx - dotW / 2} x2={cx + dotW / 2} y1={yHi} y2={yHi} stroke={color} strokeWidth="1.5" />
                <circle cx={cx} cy={yS} r={3} fill={color}>
                  <title>#{r.idx}: Sharpe {fmtNum(r.sharpe)} (95% CI [{fmtNum(r.lo)}, {fmtNum(r.hi)}])</title>
                </circle>
                {(i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 10) === 0) && (
                  <text x={cx} y={h - 10} textAnchor="middle"
                        className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                    #{r.idx}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PARAMETERS — best-pick rankings + top full combos (C.3 adds drift chart)
// ---------------------------------------------------------------------------

function ParametersTab({ result }) {
  const windows = result.windows || [];
  const searchSpace = result?.wf_spec?.search_space || [];
  return (
    <section className="space-y-4">
      <ParameterDriftChart windows={windows} searchSpace={searchSpace} />
      <BestParamRankings result={result} />
      <TopCombinations result={result} />
    </section>
  );
}

// Z-scored parameter drift across windows. One line per numeric param;
// y=0 = median pick. Lines hugging zero = stable; diverging = drift.
function ParameterDriftChart({ windows, searchSpace }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 280 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 280 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { cols, stats } = useParamStats(windows, searchSpace);

  if (!cols.length || windows.length < 2) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Need at least 2 windows with numeric search-space params to chart drift.
      </div>
    );
  }

  // Compute z-scores per param per window.
  const series = cols.map((spec, i) => {
    const s = stats[spec.name];
    const ys = windows.map((w) => {
      const v = w.best_params?.[spec.name];
      if (typeof v !== "number" || !s || s.stdev < 1e-9) return 0;
      return (v - s.median) / s.stdev;
    });
    const palette = ["#3b82f6", "#22c55e", "#ef4444", "#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];
    return { name: spec.name, ys, color: palette[i % palette.length], stable: stats[spec.name]?.stdev < 1e-9 ? true : Math.max(...ys.map(Math.abs)) < 1 };
  });

  const allZ = series.flatMap((s) => s.ys);
  let yMin = Math.min(-1, ...allZ), yMax = Math.max(1, ...allZ);
  const pad = (yMax - yMin) * 0.1 || 1;
  yMin -= pad; yMax += pad;

  const px = { l: 56, r: 130, t: 16, b: 26 };
  const innerW = Math.max(1, size.w - px.l - px.r);
  const innerH = Math.max(1, size.h - px.t - px.b);
  const xOf = (i) => px.l + (windows.length <= 1 ? 0 : (i / (windows.length - 1)) * innerW);
  const yOf = (z) => px.t + (1 - (z - yMin) / (yMax - yMin)) * innerH;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold text-text">Parameter drift across windows</div>
        <div className="text-[11px] text-muted">
          Each line = one optimized param, z-scored against its own median across windows.
          Hugging zero = stable; swinging = drift / overfit signal.
        </div>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          <line x1={px.l} x2={size.w - px.r} y1={yOf(0)} y2={yOf(0)} stroke="rgba(229,231,235,0.3)" strokeDasharray="2 3" strokeWidth="0.6" />
          {[-2, -1, 1, 2].map((z) => (
            yMin <= z && z <= yMax && (
              <g key={z}>
                <line x1={px.l} x2={size.w - px.r} y1={yOf(z)} y2={yOf(z)} stroke="rgba(229,231,235,0.05)" />
                <text x={px.l - 6} y={yOf(z) + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {z}σ
                </text>
              </g>
            )
          ))}
          {series.map((s) => {
            const d = s.ys.map((y, i) =>
              `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(y).toFixed(1)}`
            ).join("");
            return (
              <g key={s.name}>
                <path d={d} fill="none" stroke={s.color} strokeWidth="1.4" opacity="0.85" />
                {s.ys.map((y, i) => (
                  <circle key={i} cx={xOf(i)} cy={yOf(y)} r={2.5} fill={s.color}>
                    <title>{s.name} window #{windows[i]?.window_idx} · z={fmtNum(y)}</title>
                  </circle>
                ))}
              </g>
            );
          })}
          {/* legend */}
          {series.map((s, i) => (
            <g key={`leg-${s.name}`} transform={`translate(${size.w - px.r + 8},${px.t + 4 + i * 16})`}>
              <line x1={0} x2={14} y1={6} y2={6} stroke={s.color} strokeWidth="1.6" />
              <text x={18} y={9} className="fill-text" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {s.name}
              </text>
            </g>
          ))}
          {/* x axis */}
          {[0, Math.floor(windows.length / 4), Math.floor(windows.length / 2), Math.floor(3 * windows.length / 4), windows.length - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0).map((i) => (
            <text key={`x${i}`} x={xOf(i)} y={size.h - 8}
                  textAnchor={i === 0 ? "start" : i === windows.length - 1 ? "end" : "middle"}
                  className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
              #{windows[i]?.window_idx}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OPTUNA — placeholder until C.4 fills in scatter charts
// ---------------------------------------------------------------------------

function OptunaTab({ result }) {
  const windows = result.windows || [];
  const searchSpace = result?.wf_spec?.search_space || [];
  const trialCount = windows.reduce((sum, w) => sum + (w.optuna_trials?.length || 0), 0);

  const numericParams = useMemo(
    () => (searchSpace || []).filter((p) => p.type === "int" || p.type === "float").map((p) => p.name),
    [searchSpace],
  );
  const [paramName, setParamName] = useState(numericParams[0] || "");
  const [windowIdx, setWindowIdx] = useState(windows[0]?.window_idx ?? 1);

  useEffect(() => {
    if (numericParams.length && !numericParams.includes(paramName)) setParamName(numericParams[0]);
  }, [numericParams, paramName]);

  if (trialCount === 0) {
    return (
      <section className="space-y-3">
        <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted">
          <div className="text-text font-semibold mb-1">No Optuna trials recorded</div>
          <div>
            The result has no <span className="font-mono">optuna_trials</span> populated — re-run the walk-forward to capture trial history.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-muted">Window:</span>
        <select
          value={windowIdx}
          onChange={(e) => setWindowIdx(Number(e.target.value))}
          className="px-2 py-1 text-xs font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
        >
          {windows.map((w) => (
            <option key={w.window_idx} value={w.window_idx}>
              #{w.window_idx} · {fmtDate(w.oos_start)} → {fmtDate(w.oos_end)} · OOS sharpe {fmtNum(w.oos_stats?.sharpe ?? 0)}
            </option>
          ))}
        </select>
        {numericParams.length > 0 && (
          <>
            <span className="text-muted ml-4">Param scatter:</span>
            <select
              value={paramName}
              onChange={(e) => setParamName(e.target.value)}
              className="px-2 py-1 text-xs font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
            >
              {numericParams.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        )}
      </div>

      <OptunaTrialScatter window={windows.find((w) => w.window_idx === windowIdx) || windows[0]} />

      {paramName && (
        <OptunaParamScatter windows={windows} paramName={paramName} />
      )}
    </section>
  );
}

// Trial-order scatter for one window with best-so-far step line.
function OptunaTrialScatter({ window }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 280 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 280 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trials = window?.optuna_trials || [];
  if (trials.length < 2) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Window #{window?.window_idx} has fewer than 2 trials.
      </div>
    );
  }

  const values = trials.map((t) => Number(t.value));
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        All trial values are non-finite for window #{window.window_idx}.
      </div>
    );
  }
  let yMin = Math.min(...finite), yMax = Math.max(...finite);
  if (yMin === yMax) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08 || 0.1;
  yMin -= pad; yMax += pad;

  // best-so-far step line (TPE max-objective convention).
  const bestSoFar = [];
  let best = -Infinity;
  for (const v of values) {
    if (Number.isFinite(v) && v > best) best = v;
    bestSoFar.push(best);
  }

  const px = { l: 56, r: 16, t: 16, b: 30 };
  const innerW = Math.max(1, size.w - px.l - px.r);
  const innerH = Math.max(1, size.h - px.t - px.b);
  const xOf = (i) => px.l + (trials.length <= 1 ? 0 : (i / (trials.length - 1)) * innerW);
  const yOf = (v) => px.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const bestPath = bestSoFar.map((v, i) =>
    Number.isFinite(v) ? `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}` : ""
  ).join("");

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-text">Window #{window.window_idx} trial trace</div>
          <div className="text-[11px] text-muted">
            {trials.length} trials. Best-so-far step line shows how quickly Optuna converged.
          </div>
        </div>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const v = yMin + (yMax - yMin) * (1 - p);
            return (
              <g key={i}>
                <line x1={px.l} x2={size.w - px.r} y1={px.t + p * innerH} y2={px.t + p * innerH}
                      stroke="rgba(229,231,235,0.05)" />
                <text x={px.l - 6} y={px.t + p * innerH + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {fmtNum(v)}
                </text>
              </g>
            );
          })}
          {values.map((v, i) => Number.isFinite(v) && (
            <circle key={i} cx={xOf(i)} cy={yOf(v)} r={2.5} fill="#94a3b8" fillOpacity="0.55">
              <title>trial {i}: {fmtNum(v)}</title>
            </circle>
          ))}
          <path d={bestPath} fill="none" stroke="#3b82f6" strokeWidth="1.6" />
          <text x={px.l} y={size.h - 10} textAnchor="start"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">trial 0</text>
          <text x={size.w - px.r} y={size.h - 10} textAnchor="end"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">trial {trials.length - 1}</text>
        </svg>
      </div>
    </div>
  );
}

// Param-value vs trial-score scatter across ALL windows for one param.
function OptunaParamScatter({ windows, paramName }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 280 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 280 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = [];
  for (const w of windows) {
    for (const t of (w.optuna_trials || [])) {
      const x = t.params?.[paramName];
      const y = Number(t.value);
      if (typeof x === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        pts.push({ x, y, idx: w.window_idx });
      }
    }
  }
  if (pts.length < 5) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Not enough trials to scatter for {paramName}.
      </div>
    );
  }

  let xMin = Math.min(...pts.map((p) => p.x)), xMax = Math.max(...pts.map((p) => p.x));
  let yMin = Math.min(...pts.map((p) => p.y)), yMax = Math.max(...pts.map((p) => p.y));
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;
  const xPad = (xMax - xMin) * 0.06, yPad = (yMax - yMin) * 0.08;
  xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad;

  const px = { l: 56, r: 16, t: 16, b: 36 };
  const innerW = Math.max(1, size.w - px.l - px.r);
  const innerH = Math.max(1, size.h - px.t - px.b);
  const xOf = (v) => px.l + ((v - xMin) / (xMax - xMin)) * innerW;
  const yOf = (v) => px.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // Color by window index so the user can spot if early windows preferred
  // different param values than later ones (regime shift).
  const maxIdx = Math.max(...pts.map((p) => p.idx)) || 1;
  const colorOf = (idx) => {
    const t = idx / maxIdx;
    return `hsl(${(220 + t * 100) | 0}, 70%, 60%)`;
  };

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold text-text">{paramName} vs trial score (all windows)</div>
        <div className="text-[11px] text-muted">
          Color shades from blue (early windows) → magenta (late). Clusters at a particular x value =
          Optuna preferred that param value across many windows.
        </div>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const v = yMin + (yMax - yMin) * (1 - p);
            return (
              <g key={i}>
                <line x1={px.l} x2={size.w - px.r} y1={px.t + p * innerH} y2={px.t + p * innerH}
                      stroke="rgba(229,231,235,0.05)" />
                <text x={px.l - 6} y={px.t + p * innerH + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {fmtNum(v)}
                </text>
              </g>
            );
          })}
          {pts.map((p, i) => (
            <circle key={i} cx={xOf(p.x)} cy={yOf(p.y)} r={2.5} fill={colorOf(p.idx)} fillOpacity="0.6">
              <title>#{p.idx}: {paramName}={fmtNum(p.x)}, score={fmtNum(p.y)}</title>
            </circle>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const v = xMin + (xMax - xMin) * p;
            return (
              <text key={`x${i}`} x={px.l + p * innerW} y={size.h - 18}
                    textAnchor={p === 0 ? "start" : p === 1 ? "end" : "middle"}
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {fmtNum(v)}
              </text>
            );
          })}
          <text x={px.l + innerW / 2} y={size.h - 4} textAnchor="middle"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
            {paramName}
          </text>
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROBUSTNESS — robustness KPI tiles (C.5 adds the fan chart)
// ---------------------------------------------------------------------------

function RobustnessTab({ result }) {
  const rob = result?.analytics?.advanced?.robustness || result?.analytics?.robustness || {};
  const fmtProb = (v) => v == null ? "—" : `${fmtNum(v * 100)}%`;
  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi
          title="Deflated Sharpe"
          value={fmtProb(rob.deflated_sharpe_probability)}
          sub="P(Sharpe > 0 | overfit-adjusted)"
          positive={rob.deflated_sharpe_probability != null ? rob.deflated_sharpe_probability >= 0.9 : null}
        />
        <Kpi
          title="WF Efficiency"
          value={rob.walk_forward_efficiency == null ? "—" : fmtNum(rob.walk_forward_efficiency)}
          sub="median OOS / IS Sharpe"
          positive={rob.walk_forward_efficiency != null ? rob.walk_forward_efficiency >= 0.5 : null}
        />
        <Kpi
          title="Parameter stability"
          value={rob.parameter_stability_score == null ? "—" : fmtNum(rob.parameter_stability_score)}
          sub="higher = flatter optimum"
          positive={rob.parameter_stability_score != null ? rob.parameter_stability_score >= 0.5 : null}
        />
        <Kpi
          title="% windows positive"
          value={rob.pct_windows_positive_oos == null ? "—" : `${fmtNum(rob.pct_windows_positive_oos * 100)}%`}
          sub="OOS Sharpe > 0"
          positive={rob.pct_windows_positive_oos != null ? rob.pct_windows_positive_oos >= 0.6 : null}
        />
      </div>
      <WFEquityFanChart result={result} />
    </section>
  );
}

// Per-fold OOS equity quantile fan chart. Each window's OOS sub-curve is
// rebased to "% of starting capital" and resampled onto a common N-step grid,
// then we compute p10/p25/p50/p75/p90 per step.
function WFEquityFanChart({ result }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 320 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 320 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bands = useMemo(() => {
    const windows = result.windows || [];
    const equity = result.equity || [];
    if (windows.length < 2 || equity.length === 0) return null;

    const N = 40; // resample resolution
    const matrix = [];
    for (const w of windows) {
      if (w.oos_start == null || w.oos_end == null) continue;
      const slice = equity.filter((p) => p.time >= w.oos_start && p.time <= w.oos_end);
      if (slice.length < 2) continue;
      const base = slice[0].equity || slice[0].value || 1;
      if (base <= 0) continue;
      // Rebase each window so it starts at 100 (% of carry-equity at window start).
      const rebased = slice.map((p) => (p.equity ? p.equity / base : p.value / slice[0].value) * 100);
      // Resample to uniform N points by linear interpolation in index space.
      const out = new Array(N);
      for (let i = 0; i < N; i++) {
        const idx = (i / (N - 1)) * (rebased.length - 1);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        const t = idx - lo;
        out[i] = rebased[lo] * (1 - t) + rebased[hi] * t;
      }
      matrix.push(out);
    }
    if (matrix.length < 2) return null;

    const pct = (arr, p) => {
      const s = [...arr].sort((a, b) => a - b);
      const idx = (s.length - 1) * (p / 100);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      return s[lo] * (hi - idx) + s[hi] * (idx - lo);
    };
    const bands = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    for (let i = 0; i < N; i++) {
      const col = matrix.map((row) => row[i]);
      bands.p10.push(pct(col, 10));
      bands.p25.push(pct(col, 25));
      bands.p50.push(pct(col, 50));
      bands.p75.push(pct(col, 75));
      bands.p90.push(pct(col, 90));
    }
    return { bands, N, nWindows: matrix.length };
  }, [result]);

  if (!bands) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Need at least 2 windows with OOS equity to build a fan chart.
      </div>
    );
  }

  const pad = { l: 56, r: 16, t: 16, b: 26 };
  const innerW = Math.max(1, size.w - pad.l - pad.r);
  const innerH = Math.max(1, size.h - pad.t - pad.b);

  const all = [...bands.bands.p10, ...bands.bands.p90];
  let yMin = Math.min(100, ...all);
  let yMax = Math.max(100, ...all);
  const yPad = (yMax - yMin) * 0.06 || 1;
  yMin -= yPad; yMax += yPad;

  const xOf = (i) => pad.l + (i / (bands.N - 1)) * innerW;
  const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const lineOf = (series) => series.map((v, i) =>
    `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`
  ).join("");
  const bandOf = (lo, hi) => {
    const up = lo.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join("");
    const dn = [...hi].reverse().map((v, i) => {
      const idx = hi.length - 1 - i;
      return `L${xOf(idx).toFixed(1)},${yOf(v).toFixed(1)}`;
    }).join("");
    return `${up}${dn}Z`;
  };

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    return { v, y: yOf(v) };
  });

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-text">Per-fold OOS equity fan</div>
          <div className="text-[11px] text-muted">
            Each window's OOS curve rebased to 100% at its start, resampled, stacked. Bands show
            p10/p25/p50/p75/p90 across {bands.nWindows} windows. Bands hugging 100 = consistent edge;
            wide spread = regime-dependent.
          </div>
        </div>
        <div className="text-[10px] font-mono text-muted flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "rgba(59,130,246,0.12)" }} />
            p10–p90
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "rgba(59,130,246,0.25)" }} />
            p25–p75
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-[#3b82f6]" />
            median
          </span>
        </div>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          <line x1={pad.l} x2={size.w - pad.r} y1={yOf(100)} y2={yOf(100)}
                stroke="rgba(229,231,235,0.3)" strokeDasharray="2 3" strokeWidth="0.6" />
          <path d={bandOf(bands.bands.p10, bands.bands.p90)} fill="rgba(59,130,246,0.12)" />
          <path d={bandOf(bands.bands.p25, bands.bands.p75)} fill="rgba(59,130,246,0.25)" />
          <path d={lineOf(bands.bands.p50)} fill="none" stroke="#3b82f6" strokeWidth="1.6" />
          {yTicks.map((tk, i) => (
            <g key={i}>
              <line x1={pad.l} x2={size.w - pad.r} y1={tk.y} y2={tk.y}
                    stroke="rgba(229,231,235,0.06)" />
              <text x={pad.l - 6} y={tk.y + 3} textAnchor="end"
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {fmtNum(tk.v)}%
              </text>
            </g>
          ))}
          <text x={pad.l} y={size.h - 8} textAnchor="start"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">window start</text>
          <text x={size.w - pad.r} y={size.h - 8} textAnchor="end"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">window end</text>
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// REGIME — needs Phase B oos_realized_vol (placeholder until then)
// ---------------------------------------------------------------------------

function RegimeTab({ result }) {
  const windows = result.windows || [];
  const withVol = useMemo(
    () => windows.filter((w) => w.oos_realized_vol != null && w.oos_stats),
    [windows],
  );

  if (withVol.length < 3) {
    return (
      <section className="space-y-3">
        <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted">
          <div className="text-text font-semibold mb-1">Regime bucketing by realized volatility</div>
          <div>
            Need at least 3 windows with <span className="font-mono">oos_realized_vol</span> populated.
            Re-run a walk-forward after the Phase B.2 backend changes to enable this view.
          </div>
        </div>
      </section>
    );
  }

  // Tercile bucket by realized vol of the underlying.
  const sorted = [...withVol].sort((a, b) => a.oos_realized_vol - b.oos_realized_vol);
  const n = sorted.length;
  const t1 = Math.floor(n / 3);
  const t2 = Math.floor((2 * n) / 3);
  const buckets = [
    { label: "Low vol", tone: "profit", windows: sorted.slice(0, t1) },
    { label: "Mid vol", tone: "neutral", windows: sorted.slice(t1, t2) },
    { label: "High vol", tone: "loss", windows: sorted.slice(t2) },
  ];

  const summarize = (ws) => {
    if (!ws.length) return null;
    const sharpes = ws.map((w) => w.oos_stats?.sharpe ?? 0);
    const rets    = ws.map((w) => w.oos_stats?.total_return_pct ?? 0);
    const dds     = ws.map((w) => Math.abs(w.oos_stats?.max_drawdown_pct ?? 0));
    const wins    = ws.map((w) => w.oos_stats?.win_rate ?? 0);
    const vols    = ws.map((w) => w.oos_realized_vol);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    return {
      sharpe: mean(sharpes),
      ret:    mean(rets),
      dd:     mean(dds),
      win:    mean(wins),
      volLo:  Math.min(...vols),
      volHi:  Math.max(...vols),
      n:      ws.length,
    };
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-line bg-bg-panel/40 p-3 text-xs text-muted">
        <span className="text-text">Realized volatility</span> is the annualized std of log-returns on the
        underlying close, per OOS window. Windows are bucketed into terciles —
        compare per-bucket Sharpe to see if the strategy needs a vol filter.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {buckets.map((b) => {
          const stats = summarize(b.windows);
          const tone = b.tone === "profit" ? "border-profit/40 bg-profit/5" :
                       b.tone === "loss"   ? "border-loss/40 bg-loss/5" :
                                              "border-line bg-bg-elev/30";
          return (
            <div key={b.label} className={`rounded-md border ${tone} p-3 space-y-2`}>
              <div className="text-sm font-semibold text-text">{b.label} ({stats?.n ?? 0} windows)</div>
              {stats ? (
                <>
                  <div className="text-[11px] font-mono text-muted">
                    realized vol: {fmtNum(stats.volLo)}% – {fmtNum(stats.volHi)}%
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] font-mono">
                    <span className="text-muted">avg Sharpe</span>
                    <span className={stats.sharpe >= 1 ? "text-profit" : stats.sharpe >= 0 ? "text-text" : "text-loss"}>
                      {fmtNum(stats.sharpe)}
                    </span>
                    <span className="text-muted">avg return</span>
                    <span className={stats.ret >= 0 ? "text-profit" : "text-loss"}>
                      {fmtPct(stats.ret)}
                    </span>
                    <span className="text-muted">avg max DD</span>
                    <span className="text-loss">{fmtPct(stats.dd, false)}</span>
                    <span className="text-muted">avg win rate</span>
                    <span className="text-text">{fmtNum(stats.win * 100)}%</span>
                  </div>
                </>
              ) : (
                <div className="text-[11px] text-muted">no windows in bucket</div>
              )}
            </div>
          );
        })}
      </div>

      <RegimeScatter windows={withVol} />
    </section>
  );
}

function RegimeScatter({ windows }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 320 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 320 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 56, r: 16, t: 16, b: 36 };
  const innerW = Math.max(1, size.w - pad.l - pad.r);
  const innerH = Math.max(1, size.h - pad.t - pad.b);

  const pts = windows
    .filter((w) => w.oos_realized_vol != null && w.oos_stats?.sharpe != null)
    .map((w) => ({ x: w.oos_realized_vol, y: w.oos_stats.sharpe, idx: w.window_idx }));

  if (pts.length < 3) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Not enough windows to scatter.
      </div>
    );
  }

  let xMin = Math.min(...pts.map((p) => p.x));
  let xMax = Math.max(...pts.map((p) => p.x));
  let yMin = Math.min(0, ...pts.map((p) => p.y));
  let yMax = Math.max(0, ...pts.map((p) => p.y));
  const xPad = (xMax - xMin) * 0.06 || 1e-6;
  const yPad = (yMax - yMin) * 0.08 || 0.1;
  xMin -= xPad; xMax += xPad; yMin -= yPad; yMax += yPad;

  const xOf = (v) => pad.l + ((v - xMin) / (xMax - xMin)) * innerW;
  const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // Simple linear regression y = a + b*x for the trendline.
  const n = pts.length;
  const xm = pts.reduce((s, p) => s + p.x, 0) / n;
  const ym = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - xm) * (p.y - ym); den += (p.x - xm) ** 2; }
  const slope = den > 0 ? num / den : 0;
  const intercept = ym - slope * xm;
  const trendY = (x) => intercept + slope * x;

  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const v = xMin + ((xMax - xMin) * i) / 4;
    return { v, x: xOf(v), anchor: i === 0 ? "start" : i === 4 ? "end" : "middle" };
  });
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    return { v, y: yOf(v) };
  });

  // Color by tercile rank on x for visual link to the bucket cards.
  const sortedX = [...pts].map((p) => p.x).sort((a, b) => a - b);
  const t1 = sortedX[Math.floor(sortedX.length / 3)];
  const t2 = sortedX[Math.floor(2 * sortedX.length / 3)];
  const colorOf = (x) => x <= t1 ? "#22c55e" : x <= t2 ? "#94a3b8" : "#ef4444";

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-text">Realized vol → OOS Sharpe</div>
          <div className="text-[11px] text-muted">
            Each dot = one window. Slope = {fmtNum(slope)} Sharpe per +1% vol.
            {Math.abs(slope) > 0.05
              ? slope > 0 ? " Edge is vol-favored (does better in high vol)."
                          : " Edge is vol-averse (decays in high vol)."
              : " Edge is largely regime-agnostic."}
          </div>
        </div>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          <line x1={pad.l} x2={size.w - pad.r} y1={yOf(0)} y2={yOf(0)}
                stroke="rgba(229,231,235,0.25)" strokeDasharray="2 3" strokeWidth="0.6" />
          <line x1={xOf(xMin)} x2={xOf(xMax)} y1={yOf(trendY(xMin))} y2={yOf(trendY(xMax))}
                stroke="#3b82f6" strokeWidth="1.3" />
          {pts.map((p, i) => (
            <circle key={i} cx={xOf(p.x)} cy={yOf(p.y)} r={4}
                    fill={colorOf(p.x)} fillOpacity="0.85" stroke="rgba(0,0,0,0.3)" strokeWidth="0.5">
              <title>#{p.idx} · vol {fmtNum(p.x)}% · Sharpe {fmtNum(p.y)}</title>
            </circle>
          ))}
          {yTicks.map((tk, i) => (
            <g key={`y${i}`}>
              <line x1={pad.l} x2={size.w - pad.r} y1={tk.y} y2={tk.y}
                    stroke="rgba(229,231,235,0.06)" />
              <text x={pad.l - 6} y={tk.y + 3} textAnchor="end"
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {fmtNum(tk.v)}
              </text>
            </g>
          ))}
          {xTicks.map((tk, i) => (
            <text key={`x${i}`} x={tk.x} y={size.h - 16} textAnchor={tk.anchor}
                  className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {fmtNum(tk.v)}%
            </text>
          ))}
          <text x={pad.l + innerW / 2} y={size.h - 2} textAnchor="middle"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
            realized vol (annualized %)
          </text>
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI — per-section caching (mirrors Analytics' AITab)
// ---------------------------------------------------------------------------

const AI_SECTIONS = [
  { id: "overview",   label: "Overview",   hint: "Headline OOS performance, deploy verdict." },
  { id: "folds",      label: "Folds",      hint: "Per-window consistency, IS-vs-OOS gap." },
  { id: "parameters", label: "Parameters", hint: "Parameter drift across windows." },
  { id: "robustness", label: "Robustness", hint: "Deflated Sharpe, WFE, stability." },
  { id: "regime",     label: "Regime",     hint: "Performance vs realized vol of underlying." },
];

function AITab({ result }) {
  const [byId, setById] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [selected, setSelected] = useState("overview");

  async function runSection(id) {
    setLoadingId(id);
    try {
      const data = await aiAnalyzeWalkForwardSection(result, id);
      setById((m) => ({ ...m, [id]: data }));
    } catch (e) {
      setById((m) => ({ ...m, [id]: { error: e?.response?.data?.error || e.message || "AI analysis failed" } }));
    } finally {
      setLoadingId(null);
    }
  }

  async function runAll() {
    for (const sec of AI_SECTIONS) {
      if (byId[sec.id] && !byId[sec.id].error) continue;
      await runSection(sec.id);
    }
  }

  const current = byId[selected];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-accent-blue/30 bg-accent-blue/5 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-accent-blue">AI Analysis · Claude Haiku 4.5</div>
            <div className="text-xs text-muted mt-0.5">
              Each section gives a focused 2–4 paragraph read of that tab's data. Pick one, or run them all.
            </div>
          </div>
          <button onClick={runAll} disabled={loadingId != null}
            className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50">
            {loadingId ? `Running ${loadingId}…` : "Run all sections"}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {AI_SECTIONS.map((sec) => {
            const has = byId[sec.id] && !byId[sec.id].error;
            const err = byId[sec.id] && byId[sec.id].error;
            const isLoading = loadingId === sec.id;
            const isSelected = selected === sec.id;
            return (
              <button key={sec.id}
                onClick={() => { setSelected(sec.id); if (!has && !isLoading) runSection(sec.id); }}
                disabled={isLoading}
                className={`text-left px-3 py-2 rounded-md border text-xs transition ${
                  isSelected
                    ? "border-accent-blue bg-accent-blue/10 text-text"
                    : "border-line bg-bg-elev/30 text-muted hover:text-text hover:border-accent-blue/40"
                }`}
                title={sec.hint}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text">{sec.label}</span>
                  <span className="text-[10px] font-mono">
                    {isLoading ? "…" : has ? "✓" : err ? "✗" : ""}
                  </span>
                </div>
                <div className="text-[10px] text-muted/80 mt-0.5">{sec.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-bg-panel/60 p-5 min-h-[200px]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-text">
            {AI_SECTIONS.find((s) => s.id === selected)?.label} — Analysis
          </div>
          {current && !current.error && (
            <button onClick={() => runSection(selected)} disabled={loadingId === selected}
              className="text-[11px] text-accent-blue hover:underline disabled:opacity-50">
              Re-run
            </button>
          )}
        </div>

        {loadingId === selected && (
          <div className="text-xs text-muted font-mono">
            Claude Haiku is analyzing — usually 5–10s…
          </div>
        )}

        {!current && loadingId !== selected && (
          <div className="text-sm text-muted">
            Click a section above to generate analysis.
          </div>
        )}

        {current?.error && (
          <div className="text-sm text-loss font-mono">{current.error}</div>
        )}

        {current?.text && (
          <div className="space-y-2 text-sm text-text leading-relaxed whitespace-pre-wrap">
            {current.text}
          </div>
        )}

        {current?.usage && (
          <div className="text-[10px] text-muted font-mono pt-3 mt-3 border-t border-line/30">
            {current.model} · in {current.usage.input_tokens}t · out {current.usage.output_tokens}t
            {current.usage.cache_read_input_tokens > 0 && ` · cache hit ${current.usage.cache_read_input_tokens}t`}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CHAT SIDEBAR
// ---------------------------------------------------------------------------

function WFChatSidebar({ open, onClose, result }) {
  if (!open) return null;
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await aiChatWalkForward(next, result || {});
      setMessages((m) => [...m, { role: "assistant", content: res.text, _meta: res }]);
    } catch (e) {
      const err = e?.response?.data?.error || e.message || "Request failed";
      setMessages((m) => [...m, { role: "assistant", content: `Error: ${err}`, _error: true }]);
    } finally {
      setLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside className="fixed right-0 top-0 bottom-0 w-80 z-40 border-l border-line flex flex-col bg-bg-panel shadow-2xl">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold text-text">Assistant</div>
          <div className="text-[10px] text-muted mt-0.5">Ask anything about this walk-forward run</div>
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-[10px] text-muted hover:text-loss transition"
              title="Clear chat"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="text-muted hover:text-text transition"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3 text-xs">
        {messages.length === 0 && (
          <div className="text-muted text-[11px] space-y-2 pt-2">
            <p>Ask Claude about your walk-forward results. For example:</p>
            <ul className="space-y-1 list-none">
              {[
                "Is this strategy ready to paper trade?",
                "Which windows were the worst performers?",
                "Did the parameters drift a lot?",
                "What's the Sharpe across folds?",
              ].map((q) => (
                <li key={q}>
                  <button
                    onClick={() => { setInput(q); textareaRef.current?.focus(); }}
                    className="text-left text-accent-blue/80 hover:text-accent-blue underline-offset-2 hover:underline"
                  >
                    {q}
                  </button>
                </li>
              ))}
            </ul>
            {!result && (
              <p className="text-muted/60 pt-2">Run a walk-forward first to get data-aware answers.</p>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[90%] rounded-lg px-3 py-2 leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-accent-blue/20 text-text"
                  : m._error
                  ? "bg-loss/10 text-loss border border-loss/30"
                  : "bg-bg-elev text-text border border-line/50"
              }`}
            >
              {m.content}
              {m._meta?.usage && (
                <div className="text-[9px] text-muted/60 mt-1.5 font-mono">
                  {m._meta.model?.split("-").slice(-2).join("-")} · {m._meta.usage.output_tokens}t out
                  {m._meta.usage.cache_read_input_tokens > 0 && " · cached"}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-bg-elev border border-line/50 rounded-lg px-3 py-2 text-muted font-mono text-[11px]">
              Claude is thinking…
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="px-3 py-3 border-t border-line">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder="Ask about the results… (Enter to send)"
            className="flex-1 resize-none rounded-md border border-line bg-bg-elev px-2.5 py-2 text-xs text-text placeholder:text-muted focus:outline-none focus:border-accent-blue/60 leading-relaxed"
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="px-3 py-2 rounded-md bg-accent-grad text-white text-xs font-semibold disabled:opacity-40 shrink-0"
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}
