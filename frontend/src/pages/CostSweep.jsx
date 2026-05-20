import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import GridResultsPanel from "../components/GridResultsPanel.jsx";
import CostSweepPresetPicker from "../components/CostSweepPresetPicker.jsx";
import {
  getSymbols, getStrategies,
  startCostSweep, cancelCostSweep,
  getCostSweepStatus, getCostSweepLastResult,
} from "../services/api.js";
import { subscribeCostSweep } from "../services/socket.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtNum } from "../services/format.js";

const METRICS = [
  { id: "sharpe",        label: "Sharpe" },
  { id: "profit_factor", label: "Profit Factor" },
  { id: "total_return",  label: "Total Return" },
];

const SWEEP_DIMS = [
  { id: "slippage_bps", label: "Slippage (bps)",   defaultValues: "0, 5, 10, 15, 20, 25, 30, 40, 50",
    description: "Basis points of slippage applied against you on every fill (both sides)." },
  { id: "fee_pct",      label: "Fee % per side",   defaultValues: "0, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2",
    description: "Percent of notional per trade, each side. Typical maker ~0.02–0.05%, taker ~0.05–0.10%." },
  { id: "fee_flat",     label: "Fee flat ($/trade)", defaultValues: "0, 0.5, 1, 2, 5",
    description: "Flat dollars per trade, each side. Mostly relevant for tiny accounts." },
];

const MAX_SWEEP = 50;

function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}

function epochToDateStr(epoch) {
  if (epoch == null || !Number.isFinite(epoch)) return "";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function parseValueList(text) {
  const tokens = String(text || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    const n = parseFloat(tok);
    if (!Number.isFinite(n) || n < 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

export default function CostSweep() {
  // ---- setup form (persisted) -----------------------------------------
  const [symbols, setSymbols] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [symbol, setSymbol]         = usePersistentState("ql.cs.symbol", "");
  const [timeframe, setTimeframe]   = usePersistentState("ql.cs.timeframe", "1h");
  const [strategyId, setStrategyId] = usePersistentState("ql.cs.strategy", "");
  const [range, setRange]           = usePersistentState("ql.cs.range", { start: "", end: "" });
  const [metric, setMetric]         = usePersistentState("ql.cs.metric", "sharpe");
  const [sweepDim, setSweepDim]     = usePersistentState("ql.cs.sweep_dim", "slippage_bps");
  const [sweepText, setSweepText]   = usePersistentState("ql.cs.sweep_text", "0, 5, 10, 15, 20, 25, 30, 40, 50");
  const [params, setParams]         = usePersistentState("ql.cs.params", {});

  // Reset params when strategy changes.
  const lastStrategyId = useRef(strategyId);
  useEffect(() => {
    if (lastStrategyId.current && lastStrategyId.current !== strategyId) {
      setParams({});
    }
    lastStrategyId.current = strategyId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId]);

  // ---- live job + result ----------------------------------------------
  const [jobState, setJobState] = useState({ state: "idle" });
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);

  // Available timeframes for current symbol.
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

  // Active dataset.
  const currentDataset = useMemo(
    () => datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
    [datasets, symbol, timeframe],
  );

  // Auto-fill date range to dataset extent.
  useEffect(() => {
    if (!currentDataset) return;
    const start = epochToDateStr(currentDataset.first_time);
    const end   = epochToDateStr(currentDataset.last_time);
    if (!start || !end) return;
    if (range.start !== start || range.end !== end) {
      setRange({ start, end });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDataset?.first_time, currentDataset?.last_time]);

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

  // Hydrate status + last result.
  useEffect(() => {
    getCostSweepStatus().then((st) => {
      setJobState(st || { state: "idle" });
      if (st?.state === "idle" && st?.result) setResult(st.result);
    }).catch(() => {});
    getCostSweepLastResult().then((r) => {
      if (r) setResult(r);
    }).catch(() => {});
  }, []);

  // Socket subscription.
  useEffect(() => {
    const unsub = subscribeCostSweep({
      onProgress: (p) => {
        setJobState((prev) => ({
          ...(prev || {}),
          state: "running",
          job_id: p.job_id,
          run_idx: p.run_idx,
          total_runs: p.total_runs,
          current_best_metric: p.current_best_metric,
          last_metric_value: p.current_metric_value,
          last_sweep_value: p.sweep_value,
        }));
      },
      onComplete: (p) => {
        setResult(p.result);
        setJobState((prev) => ({ ...(prev || {}), state: "done" }));
      },
      onCancelled: () => {
        setJobState((prev) => ({ ...(prev || {}), state: "cancelled" }));
      },
      onError: (p) => {
        setError(p.message || "cost-sweep error");
        setJobState((prev) => ({ ...(prev || {}), state: "error" }));
      },
    });
    return unsub;
  }, []);

  // When sweep dim changes, reset values text to the dim's default if user
  // hasn't customized.
  const lastSweepDim = useRef(sweepDim);
  useEffect(() => {
    if (lastSweepDim.current !== sweepDim) {
      const dim = SWEEP_DIMS.find((d) => d.id === sweepDim);
      if (dim) setSweepText(dim.defaultValues);
      lastSweepDim.current = sweepDim;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweepDim]);

  const sweepValues = useMemo(() => parseValueList(sweepText), [sweepText]);
  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) || null,
    [strategies, strategyId],
  );
  const activeDim = SWEEP_DIMS.find((d) => d.id === sweepDim) || SWEEP_DIMS[0];
  const running = jobState?.state === "running" || jobState?.state === "starting";

  const canStart = !!symbol && !!strategyId && sweepValues.length > 0 && sweepValues.length <= MAX_SWEEP;

  // Apply a scenario preset (sets sweep_dim + sweep_text together).
  // We bump `lastSweepDim.current` first to suppress the auto-reset effect that
  // would otherwise clobber sweepText with the dim's generic default values.
  const onApplyPreset = ({ sweepDim: newDim, sweepText: newText }) => {
    lastSweepDim.current = newDim;
    setSweepDim(newDim);
    setSweepText(newText);
  };

  // ---- handlers --------------------------------------------------------
  const onStart = async () => {
    if (!canStart) return;
    setError(null);
    setJobState({ state: "starting", run_idx: 0, total_runs: sweepValues.length });
    try {
      await startCostSweep({
        strategy_id: strategyId,
        symbol,
        timeframe,
        start_time: dateStrToEpoch(range.start),
        end_time:   dateStrToEpoch(range.end, true),
        params,
        sweep_dim: sweepDim,
        sweep_values: sweepValues,
        metric,
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setJobState({ state: "idle" });
    }
  };

  const onCancel = async () => {
    try { await cancelCostSweep(); } catch {}
  };

  // Shape result to match GridResultsPanel's expected schema.
  const shapedResult = useMemo(() => {
    if (!result?.results?.length) return null;
    return {
      results: result.results,
      grid_params: [{
        name: result.sweep_dim,
        type: "float",
        values: result.sweep_values,
      }],
      metric: result.metric,
      total_combos: result.total_runs,
      partial: result.partial,
    };
  }, [result]);

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="costsweep" />

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Cost Sensitivity Sweep</h1>
          <p className="text-sm text-muted mt-1">
            Re-run the same backtest at multiple execution-cost levels (slippage, fee %, or flat fee) to see
            at what cost level your strategy's edge dies. Answers the question "would my P&amp;L survive
            realistic slippage in live trading?".
          </p>
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
                {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Field>
          </div>

          {/* Fixed strategy params */}
          {activeStrategy && (
            <FixedParamEditor
              schema={activeStrategy.schema}
              params={params}
              onChange={setParams}
            />
          )}

          {/* Scenario presets — quick-start buttons with modal explanations */}
          <div className="pt-2 border-t border-line/40">
            <CostSweepPresetPicker onApply={onApplyPreset} disabled={running} />
          </div>

          {/* Sweep config */}
          <div className="space-y-3 pt-2 border-t border-line/40">
            <div className="text-[11px] uppercase tracking-wider text-muted">Cost dimension to sweep</div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <Field label="Sweep">
                <select
                  value={sweepDim}
                  onChange={(e) => setSweepDim(e.target.value)}
                  className="px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
                >
                  {SWEEP_DIMS.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="text-[11px] text-muted/80">{activeDim.description}</div>
            <ValueListInput
              text={sweepText}
              onChange={setSweepText}
              values={sweepValues}
              max={MAX_SWEEP}
            />
          </div>

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
                Start Cost Sweep
              </button>
            )}
          </div>
        </section>

        {/* ---------------- Progress ---------------- */}
        {(running || jobState?.state === "cancelled") && <ProgressPanel jobState={jobState} />}

        {/* ---------------- Result ---------------- */}
        {shapedResult && !running && (
          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              Cost Sweep Result · varied <span className="font-mono text-text">{result.sweep_dim}</span>
              {" "}across {result.total_runs} values
              {result.partial && <span className="text-amber-400"> · partial (cancelled)</span>}
            </div>
            <GridResultsPanel result={shapedResult} />
          </div>
        )}
      </main>
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

function ValueListInput({ text, onChange, values, max }) {
  const overCap = values.length > max;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-muted text-[10px] uppercase shrink-0">Sweep values</span>
        <input
          type="text"
          value={text || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. 0, 5, 10, 15, 20"
          className="flex-1 px-2 py-1.5 rounded bg-bg border border-line font-mono text-xs focus:outline-none focus:border-accent-blue"
        />
        <span className={`text-[10px] font-mono shrink-0 ${overCap ? "text-loss" : "text-muted"}`}>
          {values.length} value{values.length === 1 ? "" : "s"}
          {overCap && ` · max ${max}`}
        </span>
      </div>
      <div className="text-[10px] text-muted/70 font-mono">
        Comma- or space-separated. Negatives ignored. Each value runs one backtest.
      </div>
    </div>
  );
}

function ProgressPanel({ jobState }) {
  const { run_idx = 0, total_runs = 0, last_sweep_value, last_metric_value } = jobState || {};
  const pct = total_runs ? (run_idx / total_runs) * 100 : 0;
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
          <span>Run {run_idx} / {total_runs}</span>
          <span className="font-mono">{Math.floor(pct)}%</span>
        </div>
        <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
          <div className="h-full bg-accent-grad transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {last_metric_value != null && (
        <div className="text-xs font-mono text-muted">
          last value: <span className="text-text">{fmtNum(last_sweep_value)}</span>
          {" "}· metric: <span className="text-text">{fmtNum(last_metric_value)}</span>
          {jobState?.current_best_metric != null && (
            <> · best: <span className="text-text">{fmtNum(jobState.current_best_metric)}</span></>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fixed-params editor — no toggles, just an inline edit for every schema entry.
// Reuses the value-editing UX from WalkForwardParamEditor's "fixed" branch.
// ---------------------------------------------------------------------------

function FixedParamEditor({ schema, params, onChange }) {
  // Seed missing values from defaults on schema change.
  useEffect(() => {
    if (!schema) return;
    let touched = false;
    const next = { ...(params || {}) };
    for (const s of schema) {
      if (s.name === "risk_pct") continue;
      if (next[s.name] === undefined) {
        next[s.name] = s.default;
        touched = true;
      }
    }
    if (touched) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const groups = useMemo(() => {
    const g = {};
    for (const s of schema || []) {
      if (s.name === "risk_pct") continue;
      (g[s.group] ||= []).push(s);
    }
    return g;
  }, [schema]);

  const setOne = (name, value) => onChange({ ...(params || {}), [name]: value });

  return (
    <div className="space-y-3 pt-2 border-t border-line/40">
      <div className="text-[11px] uppercase tracking-wider text-muted">Strategy params (fixed)</div>
      <div className="text-[11px] text-muted/70">
        Cost Sweep tests how these fixed params behave under different execution costs.
        Use Walk-Forward or Grid Search to find good params first.
      </div>

      {Object.entries(groups).map(([group, specs]) => (
        <section key={group}>
          <h4 className="text-[10px] uppercase tracking-wider text-muted mb-1.5">{group}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {specs.map((spec) => (
              <ParamRow
                key={spec.name}
                spec={spec}
                value={params?.[spec.name] ?? spec.default}
                onChange={(v) => setOne(spec.name, v)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ParamRow({ spec, value, onChange }) {
  const numeric = spec.type === "int" || spec.type === "float";

  return (
    <div className="rounded-md border border-line/60 bg-bg-elev/30 px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-mono text-text truncate">{spec.name}</span>
        <span className="text-[9px] uppercase tracking-wider text-muted">{spec.type}</span>
      </div>
      {numeric ? (
        <input
          type="number"
          value={value ?? ""}
          step={spec.type === "int" ? 1 : "any"}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(null);
            const n = spec.type === "int" ? parseInt(raw, 10) : parseFloat(raw);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="w-full px-2 py-1 text-right rounded bg-bg border border-line font-mono text-xs focus:outline-none focus:border-accent-blue"
        />
      ) : spec.type === "bool" ? (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-accent-blue"
          />
          <span className="text-muted">{value ? "true" : "false"}</span>
        </label>
      ) : spec.type === "sides" ? (
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!(value && value.long)} className="accent-profit"
              onChange={(e) => onChange({ ...(value || {}), long: e.target.checked })} />
            long
          </label>
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!(value && value.short)} className="accent-loss"
              onChange={(e) => onChange({ ...(value || {}), short: e.target.checked })} />
            short
          </label>
        </div>
      ) : spec.type === "sessions" ? (
        <div className="grid grid-cols-2 gap-1 text-[11px] font-mono">
          {Object.entries(value || {}).map(([name, cfg]) => (
            <label key={name} className="flex items-center gap-2 text-muted">
              <input
                type="checkbox"
                checked={!!cfg?.enabled}
                onChange={(e) =>
                  onChange({ ...(value || {}), [name]: { ...(cfg || {}), enabled: e.target.checked } })
                }
                className="accent-accent-blue"
              />
              <span className={cfg?.enabled ? "text-text" : ""}>{name}</span>
              <span className="text-muted/60">{cfg?.start}–{cfg?.end}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
