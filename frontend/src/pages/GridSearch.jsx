import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import GridSearchParamEditor from "../components/GridSearchParamEditor.jsx";
import GridResultsPanel from "../components/GridResultsPanel.jsx";
import CostAssumptions from "../components/CostAssumptions.jsx";
import { CpuMeter } from "../components/walkforward/widgets.jsx";
import {
  getSymbols, getStrategies,
  startGridSearch, cancelGridSearch,
  getGridSearchStatus, getGridSearchLastResult,
  estimateGridSearch,
} from "../services/api.js";
import { subscribeGridSearch } from "../services/socket.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtNum } from "../services/format.js";

const METRICS = [
  { id: "sharpe",        label: "Sharpe" },
  { id: "profit_factor", label: "Profit Factor" },
  { id: "total_return",  label: "Total Return" },
];

function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function epochToDateStr(epoch) {
  if (epoch == null || !Number.isFinite(epoch)) return "";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

export default function GridSearch() {
  // ---- setup form (persisted) -----------------------------------------
  const [symbols, setSymbols] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [symbol, setSymbol]         = usePersistentState("ql.gs.symbol", "");
  const [timeframe, setTimeframe]   = usePersistentState("ql.gs.timeframe", "1h");
  const [strategyId, setStrategyId] = usePersistentState("ql.gs.strategy", "");
  const [range, setRange]           = usePersistentState("ql.gs.range", { start: "", end: "" });
  const [metric, setMetric]         = usePersistentState("ql.gs.metric", "sharpe");
  // Optional early-stop: blank = exhaustive full grid; a number stops the sweep
  // at the first combo whose trade count lands within ±tol of the target.
  const [targetTrades, setTargetTrades] = usePersistentState("ql.gs.targetTrades", "");
  const [targetTol, setTargetTol]       = usePersistentState("ql.gs.targetTol", "0");
  const [nWorkers, setNWorkers]         = usePersistentState("ql.gs.n_workers", 1);
  const maxWorkers = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;
  // Early-stop is order-dependent → forced single-core (see backend). The slider
  // still shows, but the effective worker count is 1 while a trade target is set.
  const earlyStop = targetTrades !== "";
  const effWorkers = earlyStop ? 1 : Math.min(nWorkers, maxWorkers);

  // Per-strategy params (reset when strategy changes).
  const [baseParams, setBaseParams] = usePersistentState("ql.gs.base", {});
  const [gridParams, setGridParams] = usePersistentState("ql.gs.grid", []);
  const lastStrategyId = useRef(strategyId);
  useEffect(() => {
    if (lastStrategyId.current && lastStrategyId.current !== strategyId) {
      setBaseParams({});
      setGridParams([]);
    }
    lastStrategyId.current = strategyId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  // ---- live job + result ----------------------------------------------
  const [jobState, setJobState] = useState({ state: "idle" });
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);

  // ---- estimate (debounced) -------------------------------------------
  const [estimate, setEstimate] = useState({ combos: 0, projected_seconds: 0, warn: false, refuse: false });

  // ---- soft-warn confirm ----------------------------------------------
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Available timeframes for the current symbol.
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

  // Active dataset for the chosen symbol+timeframe.
  const currentDataset = useMemo(
    () => datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
    [datasets, symbol, timeframe],
  );

  // Snap the date range to the dataset's full extent whenever the dataset
  // changes. User can still narrow afterwards.
  useEffect(() => {
    if (!currentDataset) return;
    const start = epochToDateStr(currentDataset.first_time);
    const end   = epochToDateStr(currentDataset.last_time);
    if (!start || !end) return;
    if (range.start !== start || range.end !== end) {
      setRange({ start, end });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDataset?.symbol, currentDataset?.timeframe, currentDataset?.first_time, currentDataset?.last_time]);

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
    getGridSearchStatus().then((st) => {
      setJobState(st || { state: "idle" });
      if (st?.state === "idle" && st?.result) setResult(st.result);
    }).catch(() => {});
    getGridSearchLastResult().then((r) => {
      if (r) setResult(r);
    }).catch(() => {});
  }, []);

  // ---- socket subscription --------------------------------------------
  useEffect(() => {
    const unsub = subscribeGridSearch({
      onProgress: (p) => {
        setJobState((prev) => ({
          ...(prev || {}),
          state: "running",
          job_id: p.job_id,
          combo_idx: p.combo_idx,
          total_combos: p.total_combos,
          current_best_metric: p.current_best_metric,
          last_metric_value: p.current_metric_value,
        }));
      },
      onComplete: (p) => {
        setResult(p.result);
        setJobState((prev) => ({ ...(prev || {}), state: "done" }));
      },
      onTargetHit: (p) => {
        setJobState((prev) => ({ ...(prev || {}), target_match: p }));
      },
      onResources: (p) => {
        setJobState((prev) => ({
          ...(prev || {}),
          cpu_percent: p.cpu_percent,
          cpu_percent_percore: p.cpu_percent_percore,
          active_workers: p.active_workers,
          n_workers: p.n_workers,
          eta_seconds: p.eta_seconds,
        }));
      },
      onCancelled: () => {
        setJobState((prev) => ({ ...(prev || {}), state: "cancelled" }));
      },
      onError: (p) => {
        setError(p.message || "grid-search error");
        setJobState((prev) => ({ ...(prev || {}), state: "error" }));
      },
    });
    return unsub;
  }, []);

  // ---- debounced estimate fetch ---------------------------------------
  useEffect(() => {
    const t = setTimeout(() => {
      if (gridParams.length === 0) {
        setEstimate({ combos: 0, projected_seconds: 0, warn: false, refuse: false });
        return;
      }
      estimateGridSearch({ grid_params: gridParams, n_workers: effWorkers })
        .then(setEstimate)
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [gridParams, effWorkers]);

  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) || null,
    [strategies, strategyId]
  );
  const running = jobState?.state === "running" || jobState?.state === "starting";

  // ---- handlers --------------------------------------------------------
  const submitJob = async () => {
    setError(null);
    setJobState({ state: "starting", combo_idx: 0, total_combos: estimate.combos });
    try {
      await startGridSearch({
        strategy_id: strategyId,
        symbol,
        timeframe,
        start_time: dateStrToEpoch(range.start),
        end_time:   dateStrToEpoch(range.end, true),
        base_params: baseParams,
        grid_params: gridParams,
        metric,
        target_trades: targetTrades === "" ? null : Number(targetTrades),
        target_trades_tol: Number(targetTol) || 0,
        n_workers: effWorkers,
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setJobState({ state: "idle" });
    }
  };

  const onStart = () => {
    if (estimate.refuse) {
      setError(`Grid would produce ${estimate.combos} backtests — over the 5000 cap. Narrow your grid.`);
      return;
    }
    if (estimate.warn) {
      setConfirmOpen(true);
      return;
    }
    submitJob();
  };

  const onCancel = async () => {
    try { await cancelGridSearch(); } catch {}
  };

  // ---- render ----------------------------------------------------------
  const canStart = !!symbol && !!strategyId && gridParams.length > 0 && !estimate.refuse;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="gridsearch" />

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Grid Search</h1>
          <p className="text-sm text-muted mt-1">
            Exhaustively backtest every combination of the param values you list, over a
            single date range. Use it to probe param sensitivity, sanity-check what
            walk-forward picked, or compare specific configurations side-by-side.
          </p>
        </header>

        {error && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>
        )}

        {/* ---------------- Setup ---------------- */}
        <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-4">
          <div className="text-[11px] uppercase tracking-wider text-muted">Setup</div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <SymbolSelector value={symbol} options={symbols} datasets={datasets} onChange={setSymbol} />
            <TimeframeSelector value={timeframe} onChange={setTimeframe} available={tfsForSymbol} />
            <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
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

            <Field label="Default metric">
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

            <Field label="Stop at trades">
              <input
                type="number" min="0" placeholder="off"
                value={targetTrades}
                onChange={(e) => setTargetTrades(e.target.value)}
                className="w-20 px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
              />
              <span className="text-xs text-muted">±</span>
              <input
                type="number" min="0"
                value={targetTol}
                onChange={(e) => setTargetTol(e.target.value)}
                disabled={targetTrades === ""}
                className="w-14 px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue disabled:opacity-40"
              />
            </Field>

            <Field label="Workers (CPUs)">
              <input
                type="range"
                min={1}
                max={maxWorkers}
                step={1}
                value={Math.min(nWorkers, maxWorkers)}
                onChange={(e) => setNWorkers(parseInt(e.target.value, 10) || 1)}
                disabled={running || earlyStop}
                title="Combos are split across this many CPU cores. Results are identical at any worker count — only the wall-clock changes."
                className="w-32 accent-accent-blue disabled:opacity-40"
              />
              <span className="font-mono text-xs tabular-nums text-muted w-10 text-right shrink-0">
                {effWorkers}/{maxWorkers}
              </span>
              {earlyStop && (
                <span className="text-[11px] text-muted/70">single-core (early-stop)</span>
              )}
            </Field>
          </div>

          {targetTrades !== "" && (
            <div className="text-[11px] font-mono text-muted -mt-1">
              Sweep stops at the first combo with {targetTrades}
              {Number(targetTol) > 0 ? ` ±${targetTol}` : ""} trades. Leave blank for a full grid.
            </div>
          )}

          <EstimateBar estimate={estimate} />

          <CostAssumptions />

          {activeStrategy && (
            <div className="pt-2 border-t border-line/40">
              <GridSearchParamEditor
                schema={activeStrategy.schema}
                baseParams={baseParams}
                gridParams={gridParams}
                onChange={({ baseParams: b, gridParams: g }) => {
                  setBaseParams(b);
                  setGridParams(g);
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
                disabled={!canStart}
                className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-40"
              >
                Start Grid Search
              </button>
            )}
          </div>
        </section>

        {/* ---------------- Progress ---------------- */}
        {(running || jobState?.state === "cancelled") && <ProgressPanel jobState={jobState} />}

        {/* ---------------- Result ---------------- */}
        {result?.stopped_early && result?.target_match && !running && (
          <div className="rounded-md border border-profit/40 bg-profit/10 px-4 py-3 text-sm text-profit">
            Stopped early at combo {result.target_match.combo_idx} of {result.total_combos} —
            hit <span className="font-mono">{result.target_match.trades}</span> trades
            (target {result.target_trades}{result.target_trades_tol > 0 ? ` ±${result.target_trades_tol}` : ""}):{" "}
            <span className="font-mono text-text">
              {Object.entries(result.target_match.params).map(([k, v]) => `${k}=${v}`).join(", ")}
            </span>
          </div>
        )}
        {result && !running && <GridResultsPanel result={result} />}
      </main>

      <ConfirmModal
        open={confirmOpen}
        title="Large grid"
        message={
          <span>
            This will run <span className="text-text font-mono">{estimate.combos}</span> backtests
            (~<span className="text-text font-mono">{fmtDuration(estimate.projected_seconds)}</span> projected).
            Continue?
          </span>
        }
        confirmLabel="Run anyway"
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={() => { setConfirmOpen(false); submitJob(); }}
        onCancel={() => setConfirmOpen(false)}
      />
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

function EstimateBar({ estimate }) {
  if (!estimate.combos) {
    return (
      <div className="text-[11px] font-mono text-muted">
        Toggle Grid on a param and enter values to see the projected run size.
      </div>
    );
  }
  const tone =
    estimate.refuse ? "border-loss/40 bg-loss/10 text-loss" :
    estimate.warn   ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                    : "border-profit/40 bg-profit/10 text-profit";
  const msg =
    estimate.refuse ? `Too many combos (${estimate.combos}) — narrow your grid (max 5000).` :
    estimate.warn   ? `Will run ${estimate.combos} backtests (~${fmtDuration(estimate.projected_seconds)}) — confirm before starting.`
                    : `Will run ${estimate.combos} backtests (~${fmtDuration(estimate.projected_seconds)}).`;
  return (
    <div className={`rounded-md border px-3 py-2 text-xs font-mono ${tone}`}>{msg}</div>
  );
}

function ProgressPanel({ jobState }) {
  const { combo_idx = 0, total_combos = 0 } = jobState || {};
  const pct = total_combos ? (combo_idx / total_combos) * 100 : 0;
  const cancelled = jobState?.state === "cancelled";
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          {cancelled ? "Cancelled" : "Running"}
        </div>
        <div className="text-xs font-mono text-muted">
          job {jobState?.job_id || "—"}
          {jobState?.eta_seconds != null && <> · ETA {fmtDuration(jobState.eta_seconds)}</>}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1">
          <span>Combo {combo_idx} / {total_combos}</span>
          <span className="font-mono">{Math.floor(pct)}%</span>
        </div>
        <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
          <div className="h-full bg-accent-grad transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <CpuMeter
        cpu={jobState?.cpu_percent}
        percore={jobState?.cpu_percent_percore || []}
        active={jobState?.active_workers}
        workers={jobState?.n_workers}
      />
      {jobState?.current_best_metric != null && (
        <div className="text-xs font-mono text-muted">
          best so far: <span className="text-text">{fmtNum(jobState.current_best_metric)}</span>
          {jobState?.last_metric_value != null && (
            <> · last: <span className="text-text">{fmtNum(jobState.last_metric_value)}</span></>
          )}
        </div>
      )}
    </section>
  );
}
