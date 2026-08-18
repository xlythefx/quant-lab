import { useEffect, useMemo, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import GridSearchParamEditor from "../components/GridSearchParamEditor.jsx";
import WalkForwardParamEditor from "../components/WalkForwardParamEditor.jsx";
import { CpuMeter } from "../components/walkforward/widgets.jsx";
import {
  getStrategies, listDatasets,
  startOvernightRun, cancelOvernightRun,
  getOvernightStatus, getOvernightLastResult, estimateOvernightRun,
} from "../services/api.js";
import { subscribeOvernight } from "../services/socket.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtNum, fmtInt, fmtPct } from "../services/format.js";
import { assetTrust, TRUST, METRIC_LABEL } from "../services/overnightVerdict.js";
import { exportVerdictPdf } from "../services/exportVerdictPdf.js";

const MODES = [
  { id: "grid_then_wf", label: "Grid → Walk-Forward", hint: "Map the range with a grid, then validate it out-of-sample. The verdict rests on the OOS result." },
  { id: "grid",         label: "Grid only",          hint: "Map the param terrain per asset. In-sample — use to find ranges to validate later." },
  { id: "walkforward",  label: "Walk-Forward only",  hint: "Validate a search space out-of-sample per asset." },
];
const METRICS = [
  { id: "sharpe",        label: "Sharpe" },
  { id: "profit_factor", label: "Profit Factor" },
  { id: "total_return",  label: "Total Return" },
];

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

export default function Overnight() {
  // ---- setup (persisted) ----------------------------------------------
  const [strategies, setStrategies] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [strategyId, setStrategyId] = usePersistentState("ql.ovn.strategy", "");
  const [timeframe, setTimeframe]   = usePersistentState("ql.ovn.timeframe", "15m");
  const [mode, setMode]             = usePersistentState("ql.ovn.mode", "grid_then_wf");
  const [metric, setMetric]         = usePersistentState("ql.ovn.metric", "sharpe");
  const [nWorkers, setNWorkers]     = usePersistentState("ql.ovn.n_workers", 1);
  const [baseParams, setBaseParams] = usePersistentState("ql.ovn.base", {});
  const [gridParams, setGridParams] = usePersistentState("ql.ovn.grid", []);
  const [searchSpace, setSearchSpace] = usePersistentState("ql.ovn.search", []);
  const [isBars, setIsBars]   = usePersistentState("ql.ovn.is_bars", 1000);
  const [oosBars, setOosBars] = usePersistentState("ql.ovn.oos_bars", 200);
  const [nTrials, setNTrials] = usePersistentState("ql.ovn.n_trials", 50);
  const maxWorkers = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 8;

  const [selected, setSelected] = useState(() => new Set());
  const [jobState, setJobState] = useState({ state: "idle" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [paramsOpen, setParamsOpen] = useState(false);

  const usesGrid = mode === "grid" || mode === "grid_then_wf";
  const usesWf = mode === "walkforward" || mode === "grid_then_wf";
  const running = jobState?.state === "running" || jobState?.state === "starting";

  // ---- load strategies + datasets -------------------------------------
  useEffect(() => {
    getStrategies().then(setStrategies).catch(() => {});
    listDatasets().then(setDatasets).catch(() => {});
  }, []);

  useEffect(() => {
    if (!strategyId && strategies.length) setStrategyId(strategies[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies]);

  // Assets that have cached data at the chosen timeframe.
  const assetsForTf = useMemo(() => {
    const seen = new Map();
    for (const d of datasets) {
      if (d.timeframe !== timeframe) continue;
      if (!seen.has(d.symbol)) seen.set(d.symbol, d);
    }
    return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [datasets, timeframe]);

  const timeframes = useMemo(
    () => [...new Set(datasets.map((d) => d.timeframe))].sort(),
    [datasets]
  );

  // Default to NO assets selected; clear the picks when the timeframe changes
  // (so you never carry over symbols that aren't cached at the new timeframe).
  useEffect(() => { setSelected(new Set()); }, [timeframe]);

  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) || null,
    [strategies, strategyId]
  );

  // ---- hydrate + subscribe --------------------------------------------
  useEffect(() => {
    getOvernightStatus().then((st) => {
      setJobState(st || { state: "idle" });
      if (st?.state === "idle" && st?.result) setResult(st.result);
    }).catch(() => {});
    getOvernightLastResult().then((r) => { if (r) setResult(r); }).catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = subscribeOvernight({
      onProgress: (p) => setJobState((prev) => ({ ...(prev || {}), ...p, state: "running" })),
      onComplete: (p) => { setResult(p.result); setJobState((prev) => ({ ...(prev || {}), state: "done" })); },
      onCancelled: () => setJobState((prev) => ({ ...(prev || {}), state: "cancelled" })),
      onError: (p) => { setError(p.message || "overnight run error"); setJobState((prev) => ({ ...(prev || {}), state: "error" })); },
    });
    return unsub;
  }, []);

  // ---- estimate (grid modes) ------------------------------------------
  useEffect(() => {
    if (!usesGrid || gridParams.length === 0) { setEstimate(null); return; }
    const t = setTimeout(() => {
      estimateOvernightRun({ mode, grid_params: gridParams, n_workers: nWorkers, symbols: [...selected] })
        .then(setEstimate).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [usesGrid, mode, gridParams, nWorkers, selected]);

  // ---- handlers -------------------------------------------------------
  const toggleSymbol = (sym) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(sym) ? next.delete(sym) : next.add(sym);
      return next;
    });
  };
  const allOn = assetsForTf.length > 0 && assetsForTf.every((d) => selected.has(d.symbol));
  const toggleAll = () =>
    setSelected(allOn ? new Set() : new Set(assetsForTf.map((d) => d.symbol)));

  const symbols = [...selected];
  const canStart = !!strategyId && symbols.length > 0 &&
    (!usesGrid || gridParams.length > 0) &&
    (!usesWf || (mode === "grid_then_wf" ? gridParams.length > 0 : searchSpace.length > 0)) &&
    !(estimate?.refuse);

  const submit = async () => {
    setError(null);
    setJobState({ state: "starting", total_assets: symbols.length, asset_idx: 0 });
    try {
      await startOvernightRun({
        strategy_id: strategyId,
        timeframe,
        symbols,
        mode,
        metric,
        n_workers: nWorkers,
        base_params: baseParams,
        grid_params: usesGrid ? gridParams : [],
        search_space: mode === "walkforward" ? searchSpace : [],
        wf_opts: usesWf ? { is_bars: Number(isBars), oos_bars: Number(oosBars), n_trials: Number(nTrials) } : {},
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
      setJobState({ state: "idle" });
    }
  };
  const cancel = async () => { try { await cancelOvernightRun(); } catch {} };

  // ---- derived (compact UI) -------------------------------------------
  const wfWindows = useMemo(() => {
    const rowsSel = assetsForTf.filter((d) => selected.has(d.symbol)).map((d) => d.rows).filter(Boolean);
    if (!rowsSel.length || !isBars || !oosBars) return null;
    const n = Math.floor((Math.max(...rowsSel) - Number(isBars)) / Math.max(1, Number(oosBars)));
    return n > 0 ? n : null;
  }, [assetsForTf, selected, isBars, oosBars]);

  const combos = estimate?.combos_per_asset;
  const paramSummary = usesGrid
    ? (gridParams.length ? `${gridParams.length} gridded${combos ? ` · ${fmtInt(combos)} combos/asset` : ""}`
                         : "— pick which parameters to sweep")
    : `${searchSpace.length} parameter${searchSpace.length === 1 ? "" : "s"} searched`;

  let estimateText = "";
  if (usesGrid && estimate) {
    estimateText = estimate.refuse
      ? `⚠ ${fmtInt(estimate.combos_per_asset)} combos/asset — over the 10,000 cap`
      : `${fmtInt(estimate.combos_per_asset)} combos/asset × ${symbols.length} asset${symbols.length === 1 ? "" : "s"}`
        + (mode === "grid_then_wf" ? " + Walk-Forward" :
           estimate.projected_grid_seconds ? ` · ~${fmtDuration(estimate.projected_grid_seconds)}` : "");
  } else if (mode === "walkforward") {
    estimateText = symbols.length ? `Walk-Forward · full history × ${symbols.length} asset${symbols.length === 1 ? "" : "s"}` : "";
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="overnight" />
      <main className="flex-1 p-5 max-w-6xl w-full mx-auto space-y-4">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Overnight Run</h1>
            <p className="text-xs text-muted mt-0.5">
              Sweep many assets unattended, find the best parameters for each, and export a plain-language verdict.
            </p>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-2.5 text-sm text-loss">{error}</div>
        )}

        {/* ---------------- Setup ---------------- */}
        <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
          {/* Row 1 — strategy · timeframe · rank-by · engine */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Field label="Strategy">
              <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} disabled={running} className={selCls}>
                {strategies.length === 0 && <option value="">— loading —</option>}
                {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="TF">
              <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} disabled={running} className={selCls}>
                {timeframes.length === 0 && <option value={timeframe}>{timeframe}</option>}
                {timeframes.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
              </select>
            </Field>
            <Field label="Rank by">
              <select value={metric} onChange={(e) => setMetric(e.target.value)} disabled={running} className={selCls}>
                {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="Engine">
              <div className="flex rounded-md border border-line overflow-hidden">
                {MODES.map((m) => (
                  <button key={m.id} type="button" onClick={() => setMode(m.id)} disabled={running} title={m.hint}
                          className={`px-2.5 py-1 text-xs transition disabled:opacity-40 ${
                            mode === m.id ? "bg-accent-blue/20 text-text" : "text-muted hover:text-text"}`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {/* Row 2 — CPUs · (WF windows inline when relevant) */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Field label="CPUs">
              <input type="range" min={1} max={maxWorkers} step={1} value={Math.min(nWorkers, maxWorkers)}
                     onChange={(e) => setNWorkers(parseInt(e.target.value, 10) || 1)} disabled={running}
                     className="w-24 accent-accent-blue disabled:opacity-40" />
              <span className="font-mono text-[11px] tabular-nums text-muted w-9 text-right shrink-0">
                {Math.min(nWorkers, maxWorkers)}/{maxWorkers}
              </span>
            </Field>
            {usesWf && (
              <>
                <span className="text-muted/40">·</span>
                <Field label="IS bars"><NumInput value={isBars} onChange={setIsBars} /></Field>
                <Field label="OOS bars"><NumInput value={oosBars} onChange={setOosBars} /></Field>
                <Field label="Trials"><NumInput value={nTrials} onChange={setNTrials} /></Field>
                <span className="text-[11px] text-muted/70">
                  full history{wfWindows ? ` · ≈${fmtInt(wfWindows)} windows/asset` : ""}
                </span>
              </>
            )}
          </div>

          {/* Assets */}
          <div className="pt-2 border-t border-line/40 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-muted">
                Assets · <span className={symbols.length ? "text-text" : ""}>{symbols.length}</span>/{assetsForTf.length}
              </span>
              <button type="button" onClick={toggleAll} disabled={running || assetsForTf.length === 0}
                      className="text-[11px] text-accent-blue hover:underline disabled:opacity-40">
                {allOn ? "Clear all" : "Select all"}
              </button>
            </div>
            {assetsForTf.length === 0 ? (
              <div className="text-[11px] text-muted/70 italic">
                No cached datasets at {timeframe} — download some on the Downloads page.
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1">
                {assetsForTf.map((d) => {
                  const on = selected.has(d.symbol);
                  return (
                    <label key={d.symbol}
                           className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] cursor-pointer transition ${
                             on ? "border-accent-blue/50 bg-accent-blue/10" : "border-line/50 hover:border-line"}`}>
                      <input type="checkbox" checked={on} disabled={running}
                             onChange={() => toggleSymbol(d.symbol)} className="accent-accent-blue w-3 h-3" />
                      <span className={`font-mono truncate ${on ? "text-text" : "text-muted"}`}>{d.symbol}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Parameters — collapsible to keep the page short */}
          {activeStrategy && (usesGrid || mode === "walkforward") && (
            <div className="pt-2 border-t border-line/40">
              <button type="button" onClick={() => setParamsOpen((o) => !o)}
                      className="flex items-center gap-2 w-full text-left group">
                <span className={`text-muted transition-transform ${paramsOpen ? "rotate-90" : ""}`}>▸</span>
                <span className="text-[11px] uppercase tracking-wider text-muted group-hover:text-text">
                  {usesGrid ? "Parameters & ranges" : "Search space"}
                </span>
                <span className="text-[11px] text-muted/70 font-mono ml-1">{paramSummary}</span>
              </button>
              {paramsOpen && (
                <div className="mt-2">
                  {usesGrid ? (
                    <GridSearchParamEditor
                      schema={activeStrategy.schema} baseParams={baseParams} gridParams={gridParams}
                      onChange={({ baseParams: b, gridParams: g }) => { setBaseParams(b); setGridParams(g); }} />
                  ) : (
                    <WalkForwardParamEditor
                      schema={activeStrategy.schema} baseParams={baseParams} searchSpace={searchSpace}
                      onChange={({ baseParams: b, searchSpace: ss }) => { setBaseParams(b); setSearchSpace(ss); }} />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Estimate + Start */}
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-line/40">
            <div className={`text-[11px] font-mono ${estimate?.refuse ? "text-loss" : "text-muted"}`}>{estimateText}</div>
            {running ? (
              <button onClick={cancel}
                      className="px-4 py-2 rounded-md bg-loss/15 text-loss border border-loss/40 text-sm font-semibold">
                Cancel
              </button>
            ) : (
              <button onClick={submit} disabled={!canStart}
                      className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-40">
                Start Overnight Run
              </button>
            )}
          </div>
        </section>

        {(running || jobState?.state === "cancelled") && <ProgressPanel jobState={jobState} metric={metric} />}
        {result && !running && <ResultsPanel result={result} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

const selCls = "px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue";

function Field({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      {children}
    </div>
  );
}

function NumInput({ value, onChange }) {
  return (
    <input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
           className="w-24 px-2 py-1 text-right rounded bg-bg border border-line font-mono text-xs focus:outline-none focus:border-accent-blue" />
  );
}

function ProgressPanel({ jobState, metric }) {
  const { asset_idx = 0, total_assets = 0, current_symbol, current_engine } = jobState || {};
  const combo = jobState?.total_combos ? (jobState.combo_idx / jobState.total_combos) * 100 : 0;
  const win = jobState?.total_windows ? (jobState.window_idx / jobState.total_windows) * 100 : 0;
  const inner = jobState?.total_windows ? win : combo;
  const cancelled = jobState?.state === "cancelled";
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">{cancelled ? "Cancelled" : "Running"}</div>
        <div className="text-xs font-mono text-muted">
          asset {asset_idx}/{total_assets}
          {jobState?.eta_seconds != null && <> · ETA {fmtDuration(jobState.eta_seconds)}</>}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted mb-1">
          <span>{current_symbol || "—"} · {current_engine || "grid"}
            {jobState?.total_windows ? ` · window ${jobState.window_idx}/${jobState.total_windows}`
                                     : ` · combo ${jobState?.combo_idx ?? 0}/${jobState?.total_combos ?? 0}`}</span>
          <span className="font-mono">{Math.floor(inner)}%</span>
        </div>
        <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
          <div className="h-full bg-accent-grad transition-all" style={{ width: `${inner}%` }} />
        </div>
      </div>
      <CpuMeter cpu={jobState?.cpu_percent} percore={jobState?.cpu_percent_percore || []}
                active={jobState?.active_workers} workers={jobState?.n_workers} />
      {jobState?.best_so_far && (
        <div className="text-xs font-mono text-muted">
          best so far: <span className="text-text">{jobState.best_so_far.symbol}</span>
          {" "}({METRIC_LABEL[metric] || metric} {fmtNum(jobState.best_so_far.metric_value)})
        </div>
      )}
    </section>
  );
}

function ResultsPanel({ result }) {
  const metric = result.metric;
  const rows = result.per_asset || [];
  const ranked = [...rows].sort(
    (a, b) => (b.headline_metric_value ?? -Infinity) - (a.headline_metric_value ?? -Infinity)
  );
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted">Verdict · {result.mode}</div>
          <div className="text-sm text-muted mt-0.5">
            {rows.length} asset{rows.length === 1 ? "" : "s"}
            {result.skipped?.length ? ` · ${result.skipped.length} skipped` : ""}
            {result.partial ? " · partial (interrupted)" : ""}
          </div>
        </div>
        <button onClick={() => exportVerdictPdf(result)}
                className="px-3 py-1.5 rounded-md bg-accent-grad text-white text-sm font-semibold">
          ⬇ Export verdict PDF
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted border-b border-line">
              <th className="text-left py-2 pr-3">Asset</th>
              <th className="text-left py-2 pr-3">Best settings</th>
              <th className="text-right py-2 pr-3">{METRIC_LABEL[metric] || metric}</th>
              <th className="text-right py-2 pr-3">Return</th>
              <th className="text-right py-2 pr-3">Max DD</th>
              <th className="text-right py-2 pr-3">Trades</th>
              <th className="text-left py-2 pr-3">OOS</th>
              <th className="text-left py-2">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((a) => {
              const trust = assetTrust(a);
              const st = a.best?.stats || {};
              const params = a.best?.params || {};
              return (
                <tr key={a.symbol} className="border-b border-line/40">
                  <td className="py-2 pr-3 font-mono text-text">{a.symbol}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-muted">
                    {Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtNum(a.headline_metric_value)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{st.total_return_pct != null ? fmtPct(st.total_return_pct) : "—"}</td>
                  <td className="py-2 pr-3 text-right font-mono">{st.max_drawdown_pct != null ? fmtPct(st.max_drawdown_pct, false) : "—"}</td>
                  <td className="py-2 pr-3 text-right font-mono">{st.trades != null ? fmtInt(st.trades) : "—"}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-muted">
                    {a.wf?.pct_windows_positive != null
                      ? `${Math.round(a.wf.pct_windows_positive * 100)}% windows +`
                      : "—"}
                  </td>
                  <td className="py-2">
                    <span style={{ color: trust.tone }}>{trust.emoji} {trust.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result.skipped?.length > 0 && (
        <div className="text-[11px] text-muted/70">
          Skipped: {result.skipped.map((s) => `${s.symbol} (${s.reason})`).join(" · ")}
        </div>
      )}
    </section>
  );
}
