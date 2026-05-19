import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import CustomEquityChart from "../components/CustomEquityChart.jsx";
import WalkForwardParamEditor from "../components/WalkForwardParamEditor.jsx";
import WalkForwardGuide from "../components/WalkForwardGuide.jsx";
import {
  getSymbols, getStrategies,
  startWalkForward, cancelWalkForward, getWalkForwardStatus, getWalkForwardLastResult,
  aiSuggestWalkForward, aiAnalyzeWalkForward,
} from "../services/api.js";
import { subscribeWalkForward } from "../services/socket.js";
import { setLast as setLastResult } from "../services/lastResultStore.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt } from "../services/format.js";

const METRICS = [
  { id: "sharpe",        label: "Sharpe" },
  { id: "profit_factor", label: "Profit Factor" },
  { id: "total_return",  label: "Total Return" },
];

const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

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
  const [datasets, setDatasets] = useState([]);   // for TF filtering
  const [strategies, setStrategies] = useState([]);
  const [symbol, setSymbol]       = usePersistentState("ql.wf.symbol", "");
  const [timeframe, setTimeframe] = usePersistentState("ql.wf.timeframe", "1h");
  const [strategyId, setStrategyId] = usePersistentState("ql.wf.strategy", "");
  const [range, setRange] = usePersistentState("ql.wf.range", { start: "", end: "" });
  const [isBars, setIsBars]   = usePersistentState("ql.wf.is_bars", 1000);
  const [oosBars, setOosBars] = usePersistentState("ql.wf.oos_bars", 200);
  const [nTrials, setNTrials] = usePersistentState("ql.wf.n_trials", 50);
  const [metric, setMetric]   = usePersistentState("ql.wf.metric", "sharpe");
  // CPU parallelism for Optuna inside each window. Default 1 = sequential
  // (most stable). Hardware-clamped at runtime via navigator.hardwareConcurrency.
  const [nWorkers, setNWorkers] = usePersistentState("ql.wf.n_workers", 1);
  const [showGuide, setShowGuide] = useState(false);
  const maxWorkers = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;

  // Timeframes that actually have parquet data for the current symbol.
  const tfsForSymbol = useMemo(
    () => datasets.filter((d) => d.symbol === symbol).map((d) => d.timeframe),
    [datasets, symbol],
  );
  // If the persisted timeframe isn't available for this symbol, drop to the
  // first available one (prefer 15m). Matches Dashboard behavior.
  useEffect(() => {
    if (!symbol || tfsForSymbol.length === 0) return;
    if (!tfsForSymbol.includes(timeframe)) {
      setTimeframe(tfsForSymbol.includes("15m") ? "15m" : tfsForSymbol[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfsForSymbol]);

  // baseParams/searchSpace: persisted, but reset on strategy change since
  // the schema (and thus param names) differs per strategy.
  const [baseParams, setBaseParams]   = usePersistentState("ql.wf.base", {});
  const [searchSpace, setSearchSpace] = usePersistentState("ql.wf.search", []);
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

  // ---- AI Suggest state ------------------------------------------------
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false);
  const [aiSuggestResult, setAiSuggestResult] = useState(null);  // {is_bars, oos_bars, n_trials, metric, rationale, expected_windows}
  const [aiSuggestError, setAiSuggestError] = useState(null);

  const currentDataset = useMemo(
    () => datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
    [datasets, symbol, timeframe],
  );

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

  // ---- handlers --------------------------------------------------------
  const onStart = async () => {
    setError(null);
    liveWindows.current = [];
    setJobState({ state: "starting" });
    try {
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

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="walkforward" />

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Walk-Forward Optimization</h1>
            <p className="text-sm text-muted mt-1">
              Roll an in-sample / out-of-sample window across history. Optuna searches
              params on each IS window; the best params are evaluated on the next OOS
              window. The stitched OOS performance is the honest, out-of-sample report.
            </p>
          </div>
          <button
            onClick={() => setShowGuide(true)}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-line text-xs text-muted hover:text-text hover:border-accent-blue"
            title="What do IS / OOS / trials / workers mean?"
          >
            <span className="w-4 h-4 rounded-full bg-accent-blue/15 text-accent-blue flex items-center justify-center text-[10px] font-bold">?</span>
            Guide
          </button>
        </header>

        {error && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>
        )}

        {/* ---------------- Setup ---------------- */}
        <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-4">
          <div className="text-[11px] uppercase tracking-wider text-muted">Setup</div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <SymbolSelector value={symbol} options={symbols} onChange={setSymbol} />
            <TimeframeSelector value={timeframe} onChange={setTimeframe} available={tfsForSymbol} />
            <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
          </div>

          {/* AI Suggest: autofill IS/OOS/trials/metric from dataset size */}
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

          {/* CPU parallelism: slider + numeric readout. 1..navigator.hardwareConcurrency. */}
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
                  title="Parallel Optuna trials per window. 1 = sequential and fully reproducible (same seed → same result). >1 is faster but non-deterministic: TPE updates its surrogate model in trial-completion order, which varies across runs."
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

          <BudgetHint searchSpaceLen={searchSpace.length} nTrials={nTrials} isBars={isBars} oosBars={oosBars} />

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

        {/* ---------------- Progress ---------------- */}
        {(running || jobState?.state === "cancelled") && (
          <ProgressPanel jobState={jobState} />
        )}

        {/* ---------------- Result ---------------- */}
        {result && !running && (
          <ResultPanel result={result} onOpenInAnalytics={onOpenInAnalytics} />
        )}
      </main>

      <WalkForwardGuide open={showGuide} onClose={() => setShowGuide(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      {children}
    </div>
  );
}

function NumInput({ value, onChange, min, max }) {
  return (
    <input
      type="number"
      value={value ?? ""}
      min={min} max={max}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="w-24 px-2 py-1.5 text-right rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
    />
  );
}

function BudgetHint({ searchSpaceLen, nTrials, isBars, oosBars }) {
  // estimate windows fitting in a "typical" range — without total bars we
  // can only describe per-window cost; show that.
  const perWindow = (searchSpaceLen ? nTrials : 1) + 1; // +1 OOS eval
  const heavy = perWindow > 200;
  return (
    <div className={`text-[11px] font-mono ${heavy ? "text-loss" : "text-muted"}`}>
      ≈ {perWindow} backtests per window
      &nbsp;·&nbsp; IS={isBars} bars, OOS={oosBars} bars
    </div>
  );
}

function ProgressPanel({ jobState }) {
  const { window_idx = 0, total_windows = 0, trial_idx = 0, n_trials = 0 } = jobState || {};
  const wPct = total_windows ? (window_idx / total_windows) * 100 : 0;
  const tPct = n_trials ? Math.min(100, (trial_idx / n_trials) * 100) : 0;
  const cancelled = jobState?.state === "cancelled";

  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          {cancelled ? "Cancelled" : "Running"}
        </div>
        <div className="text-xs font-mono text-muted">
          job {jobState?.job_id || "—"}
          {jobState?.eta_seconds != null && (
            <> · ETA {Math.round(jobState.eta_seconds)}s</>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <ProgressBar label={`Window ${window_idx} / ${total_windows}`} pct={wPct} />
        <ProgressBar label={`Trial ${trial_idx} / ${n_trials} (current window)`} pct={tPct} />
      </div>

      {jobState?.current_best_score != null && (
        <div className="text-xs font-mono text-muted">
          best score so far: <span className="text-text">{fmtNum(jobState.current_best_score)}</span>
        </div>
      )}

      {jobState?.windows?.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted cursor-pointer hover:text-text">
            {jobState.windows.length} window{jobState.windows.length === 1 ? "" : "s"} completed
          </summary>
          <div className="mt-3 space-y-2">
            {jobState.windows.slice(-5).map((w) => (
              <WindowCard key={w.window_idx} w={w} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ProgressBar({ label, pct }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-muted mb-1">
        <span>{label}</span>
        <span className="font-mono">{Math.floor(pct)}%</span>
      </div>
      <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
        <div className="h-full bg-accent-grad transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ResultPanel({ result, onOpenInAnalytics }) {
  const s = result.stats || {};
  const windows = result.windows || [];
  const equityPts = (result.equity || []).map((p) => ({ time: p.time, value: p.value }));
  const strategyMeta = [{ id: result.strategy_id, color: "#3b82f6" }];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          Walk-Forward Result · {windows.length} window{windows.length === 1 ? "" : "s"}
          {result.wf_spec && (
            <> · IS={result.wf_spec.is_bars}b OOS={result.wf_spec.oos_bars}b · metric={result.wf_spec.metric}</>
          )}
        </div>
        <button
          onClick={onOpenInAnalytics}
          className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent-grad text-white"
        >
          Open in Analytics →
        </button>
      </div>

      <WFVerdict result={result} />

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

      <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
        <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Stitched OOS Equity</div>
        <div className="h-[260px]">
          <CustomEquityChart
            strategies={strategyMeta}
            pointsByStrategy={{ [result.strategy_id]: equityPts }}
            startingCapital={s.starting_capital ?? 100000}
          />
        </div>
      </div>

      <BestParamRankings result={result} />

      <WindowRankings windows={windows} />

      <WalkForwardAIInsights result={result} />

      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-muted">Per-window results</div>
        {windows.length === 0 && <div className="text-sm text-muted">no windows</div>}
        {windows.map((w) => <WindowCard key={w.window_idx} w={w} />)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Verdict banner — synthesizes the headline stats into a one-line judgment.
// ---------------------------------------------------------------------------

function WFVerdict({ result }) {
  const s = result.stats || {};
  const windows = result.windows || [];
  const sharpe = s.sharpe ?? 0;
  const pf = s.profit_factor;
  const ret = s.total_return_pct ?? 0;
  const dd = Math.abs(s.max_drawdown_pct ?? 0);
  const positiveWins = windows.filter((w) => (w.oos_stats?.sharpe ?? 0) > 0).length;
  const pctPositive = windows.length ? positiveWins / windows.length : 0;

  // Scoring model: weighted blend of OOS Sharpe, % positive windows, and return/DD ratio.
  const calmar = dd > 0 ? ret / dd : 0;
  let score = 0;
  if (sharpe >= 1.5) score += 3; else if (sharpe >= 1.0) score += 2; else if (sharpe >= 0.5) score += 1;
  if (pctPositive >= 0.7) score += 2; else if (pctPositive >= 0.5) score += 1;
  if (calmar >= 2) score += 2; else if (calmar >= 1) score += 1;
  if (pf != null && pf >= 1.5) score += 1;

  let tier, tone, label, summary;
  if (score >= 6)        { tier = "Strong";   tone = "profit";  label = "🟢 Deploy candidate"; }
  else if (score >= 4)   { tier = "Decent";   tone = "profit";  label = "🟡 Promising — refine further"; }
  else if (score >= 2)   { tier = "Marginal"; tone = "amber";   label = "🟠 Marginal — likely overfit or thin edge"; }
  else                   { tier = "Weak";     tone = "loss";    label = "🔴 Does not generalize — kill or rework"; }

  summary = [
    `${fmtPct(ret)} OOS return`,
    `Sharpe ${fmtNum(sharpe)}`,
    `${fmtInt(positiveWins)}/${fmtInt(windows.length)} windows positive (${fmtNum(pctPositive * 100)}%)`,
    `max DD ${fmtPct(dd, false)}`,
  ].join(" · ");

  const toneClasses = {
    profit: "border-profit/40 bg-profit/5 text-profit",
    amber:  "border-amber-400/40 bg-amber-400/5 text-amber-400",
    loss:   "border-loss/40 bg-loss/5 text-loss",
  };

  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone]}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-70">Verdict · {tier}</div>
          <div className="text-base font-semibold mt-0.5">{label}</div>
        </div>
        <div className="text-xs font-mono opacity-90">{summary}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Best Parameter Combinations — ranks each search-toggled param across windows.
// For INT params: frequency table of picked values with avg OOS Sharpe.
// For FLOAT params: min / median / max / stdev of picked values + drift indicator.
// ---------------------------------------------------------------------------

function BestParamRankings({ result }) {
  const windows = result.windows || [];
  const searchSpace = result?.wf_spec?.search_space || [];

  const rankings = useMemo(() => {
    if (windows.length === 0 || searchSpace.length === 0) return [];
    return searchSpace.map((spec) => {
      const picks = windows
        .map((w) => ({ value: w.best_params?.[spec.name], oos: w.oos_stats?.sharpe ?? 0, ret: w.oos_stats?.total_return_pct ?? 0 }))
        .filter((p) => typeof p.value === "number" && Number.isFinite(p.value));
      if (picks.length === 0) return { spec, picks: [], buckets: [] };

      const values = picks.map((p) => p.value);
      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
      const stdev = Math.sqrt(variance);
      const range = sorted[sorted.length - 1] - sorted[0];
      const spread = mean !== 0 ? stdev / Math.abs(mean) : 0;  // coefficient of variation

      // Group identical / nearly-identical picks into buckets (top by avg OOS Sharpe).
      const bucketSize = spec.type === "int" ? 1 : Math.max((spec.high - spec.low) / 20, 1e-9);
      const bucketMap = new Map();
      for (const p of picks) {
        const key = spec.type === "int" ? p.value : Math.round(p.value / bucketSize) * bucketSize;
        if (!bucketMap.has(key)) bucketMap.set(key, { value: key, count: 0, sumSharpe: 0, sumRet: 0 });
        const b = bucketMap.get(key);
        b.count += 1;
        b.sumSharpe += p.oos;
        b.sumRet += p.ret;
      }
      const buckets = Array.from(bucketMap.values())
        .map((b) => ({ ...b, avgSharpe: b.sumSharpe / b.count, avgRet: b.sumRet / b.count }))
        .sort((a, b) => b.avgSharpe - a.avgSharpe || b.count - a.count)
        .slice(0, 5);

      // Drift verdict: low stdev relative to range = stable.
      const stable = spread < 0.15;
      return { spec, picks, buckets, stats: { mean, median, stdev, range, spread, stable } };
    });
  }, [windows, searchSpace]);

  if (rankings.length === 0) {
    return null;
  }

  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text">Best Parameter Combinations</div>
        <div className="text-xs text-muted">
          Across {windows.length} windows: top values Optuna picked (ranked by avg OOS Sharpe).
          Low spread = robust; high spread = parameter drift / overfit signal.
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rankings.map(({ spec, picks, buckets, stats }) => (
          <ParamRankingCard key={spec.name} spec={spec} picks={picks} buckets={buckets} stats={stats} />
        ))}
      </div>
    </section>
  );
}

function ParamRankingCard({ spec, picks, buckets, stats }) {
  if (!picks.length) {
    return (
      <div className="rounded-md border border-line bg-bg-elev/30 p-3">
        <div className="text-xs font-mono text-text">{spec.name}</div>
        <div className="text-[11px] text-muted mt-1">no picks recorded</div>
      </div>
    );
  }
  const stableTone = stats.stable ? "text-profit" : "text-amber-400";
  const stableLabel = stats.stable ? "✓ stable" : "⚠ drifting";

  return (
    <div className="rounded-md border border-line bg-bg-elev/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-mono text-text">{spec.name}</div>
        <span className={`text-[10px] font-mono ${stableTone}`}>{stableLabel}</span>
      </div>
      <div className="text-[11px] text-muted font-mono">
        median <span className="text-text">{fmtNum(stats.median)}</span>
        &nbsp;· mean <span className="text-text">{fmtNum(stats.mean)}</span>
        &nbsp;· σ <span className="text-text">{fmtNum(stats.stdev)}</span>
        &nbsp;· range <span className="text-text">{fmtNum(stats.range)}</span>
      </div>
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-muted">Top picks (rank · value · avg OOS Sharpe · windows)</div>
        {buckets.map((b, i) => {
          const tone = b.avgSharpe >= 1 ? "text-profit" : b.avgSharpe >= 0 ? "text-text" : "text-loss";
          const medal = ["🥇", "🥈", "🥉", "4.", "5."][i] || `${i + 1}.`;
          return (
            <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
              <span className="w-6 text-muted">{medal}</span>
              <span className="w-16 text-text">{spec.type === "int" ? fmtInt(b.value) : fmtNum(b.value)}</span>
              <span className={`flex-1 ${tone}`}>sharpe {fmtNum(b.avgSharpe)}</span>
              <span className="text-muted">ret {fmtPct(b.avgRet)}</span>
              <span className="text-muted">{b.count}w</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Window Rankings — best & worst OOS windows side-by-side.
// ---------------------------------------------------------------------------

function WindowRankings({ windows }) {
  const ranked = useMemo(() => {
    if (!windows || windows.length < 3) return [];
    return [...windows]
      .map((w, i) => ({ w, originalIdx: i, sharpe: w.oos_stats?.sharpe ?? 0, ret: w.oos_stats?.total_return_pct ?? 0 }))
      .sort((a, b) => b.sharpe - a.sharpe);
  }, [windows]);

  if (ranked.length === 0) return null;
  const top3 = ranked.slice(0, 3);
  const bot3 = ranked.slice(-3).reverse();

  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text">Window Rankings</div>
        <div className="text-xs text-muted">
          Best and worst OOS windows by Sharpe. Big gap between top and bottom = inconsistent — strategy is regime-sensitive.
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RankBlock title="🏆 Top 3 windows" items={top3} tone="profit" />
        <RankBlock title="📉 Bottom 3 windows" items={bot3} tone="loss" />
      </div>
    </section>
  );
}

function RankBlock({ title, items, tone }) {
  const headTone = tone === "profit" ? "text-profit" : "text-loss";
  return (
    <div className="rounded-md border border-line bg-bg-elev/30 p-3 space-y-2">
      <div className={`text-xs font-semibold ${headTone}`}>{title}</div>
      {items.map(({ w, sharpe, ret }, i) => {
        const medal = i === 0 ? (tone === "profit" ? "🥇" : "🚨") : i === 1 ? (tone === "profit" ? "🥈" : "⚠") : (tone === "profit" ? "🥉" : "·");
        return (
          <div key={w.window_idx} className="text-[11px] font-mono space-y-0.5 pb-1 border-b border-line/30 last:border-b-0">
            <div className="flex items-center justify-between">
              <span className="text-text">
                {medal} <span className="text-muted">#{w.window_idx}</span>
                &nbsp;{fmtDate(w.oos_start)} → {fmtDate(w.oos_end)}
              </span>
              <span className={tone === "profit" ? "text-profit" : "text-loss"}>
                Sharpe {fmtNum(sharpe)} · {fmtPct(ret)}
              </span>
            </div>
            <div className="text-muted/80 truncate">
              {Object.entries(w.best_params || {})
                .filter(([k]) => !["sessions", "sides"].includes(k))
                .slice(0, 4)
                .map(([k, v]) => `${k}=${typeof v === "number" ? fmtNum(v) : v}`)
                .join(" · ")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WalkForwardAIInsights({ result }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  async function onRun() {
    setLoading(true); setErr(null);
    try {
      setData(await aiAnalyzeWalkForward(result));
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "AI analysis failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-accent-blue/30 bg-accent-blue/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-accent-blue">AI Insights · Claude Haiku 4.5</div>
          <div className="text-xs text-muted mt-0.5">
            Claude reviews OOS performance, parameter drift, and IS-vs-OOS degradation.
          </div>
        </div>
        <button onClick={onRun} disabled={loading}
          className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50">
          {loading ? "Analyzing…" : (data ? "Re-run AI Analysis" : "Run AI Analysis")}
        </button>
      </div>
      {err && <div className="text-sm text-loss font-mono">{err}</div>}
      {loading && (
        <div className="text-xs text-muted font-mono">
          Claude is reasoning (adaptive thinking enabled) — usually 20–40s…
        </div>
      )}
      {data?.text && (
        <div className="text-sm text-text leading-relaxed whitespace-pre-wrap">{data.text}</div>
      )}
      {data?.usage && (
        <div className="text-[10px] text-muted font-mono pt-1 border-t border-line/30">
          {data.model} · in {data.usage.input_tokens}t · out {data.usage.output_tokens}t
          {data.usage.cache_read_input_tokens > 0 && ` · cache hit ${data.usage.cache_read_input_tokens}t`}
        </div>
      )}
    </div>
  );
}

function WindowCard({ w }) {
  const os = w.oos_stats || {};
  const pos = (os.total_return_dollars ?? 0) >= 0;
  return (
    <div className="rounded-md border border-line bg-bg-panel/40 p-3">
      <div className="flex items-center justify-between text-xs font-mono">
        <div className="text-text">
          <span className="text-muted">#{w.window_idx}</span>
          &nbsp; IS {fmtDate(w.is_start)} → {fmtDate(w.is_end)}
          &nbsp; <span className="text-muted">·</span>
          &nbsp; OOS {fmtDate(w.oos_start)} → {fmtDate(w.oos_end)}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-muted">IS score: <span className="text-text">{w.is_score == null ? "—" : fmtNum(w.is_score)}</span></div>
          <div className={pos ? "text-profit" : "text-loss"}>
            OOS {fmtPct(os.total_return_pct ?? 0)} · {fmtUsd(os.total_return_dollars ?? 0)}
          </div>
          <div className="text-muted">{fmtInt(os.trades ?? 0)}t · sharpe {fmtNum(os.sharpe ?? 0)}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[11px] font-mono">
        {Object.entries(w.best_params || {})
          .filter(([k]) => !["sessions", "sides"].includes(k))
          .map(([k, v]) => (
            <span key={k} className="px-2 py-0.5 rounded bg-bg-elev/60 border border-line/40 text-muted">
              {k}=<span className="text-text">{typeof v === "number" ? fmtNum(v) : String(v)}</span>
            </span>
          ))}
      </div>
    </div>
  );
}

function Kpi({ title, value, sub, positive }) {
  const cls = positive == null ? "text-text" : positive ? "text-profit" : "text-loss";
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className={`text-xl font-mono mt-0.5 ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}
