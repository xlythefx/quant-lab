import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import { usePersistentState } from "../services/usePersistentState.js";
import { KpiCard, Section, InsightCard, TabBar } from "../components/analytics/primitives.jsx";
import { fmtNum, fmtPct, fmtInt } from "../services/format.js";
import {
  getSymbols, marketLabRegime, marketLabVolatility, marketLabStatistics, marketLabScan,
  marketLabFeatureImportance, marketLabScanBatch, marketLabPatterns, marketLabSimilarity,
  getPresets, savePresets,
  startModelBench, cancelModelBench, getModelBenchStatus, getModelBenchLastResult,
} from "../services/api.js";
import { subscribeModelBench } from "../services/socket.js";
import {
  RegimeRibbon, REGIME_COLORS, VBarChart, LineChart, HistogramChart, CentroidShape, EdgeHeatmap,
} from "../components/marketlab/charts.jsx";

// ---- date helpers (same convention as WalkForward) ----
function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}
function fmtDate(epoch) {
  if (!epoch) return "";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

const TABS = [
  { id: "regime", label: "Regime" },
  { id: "volatility", label: "Volatility" },
  { id: "statistics", label: "Statistics" },
  { id: "scanner", label: "Alpha Scanner" },
  { id: "features", label: "Feature Importance" },
  { id: "patterns", label: "Pattern Finder" },
  { id: "similarity", label: "Similarity" },
  { id: "bench", label: "Model Bench" },
];

const FEATURE_DEFAULTS = { fwd_horizon: 10, max_samples: 20000 };
const FEATURE_FIELDS = [["fwd_horizon", "Forward bars", 1], ["max_samples", "Max samples", 1000]];
const PATTERN_DEFAULTS = { k: 6, window_len: 20, fwd_horizon: 10 };
const PATTERN_FIELDS = [["k", "Clusters (k)", 1], ["window_len", "Window bars", 1], ["fwd_horizon", "Forward bars", 1]];
const SIM_DEFAULTS = { k: 25, window_len: 20, fwd_horizon: 10 };
const SIM_FIELDS = [["k", "Neighbors (k)", 1], ["window_len", "Window bars", 1], ["fwd_horizon", "Forward bars", 1]];

const SCAN_DEFAULTS = {
  vwma_length: 30, rsi_length: 14, z_threshold: 1.5,
  rsi_long_max: 35, rsi_short_min: 65, fwd_horizon: 10,
};
const z1 = (v) => v.toFixed(1);
const SCAN_KNOBS = [
  { key: "vwma_length", label: "VWMA length", min: 5, max: 200, step: 1 },
  { key: "z_threshold", label: "Z threshold", min: 0.5, max: 4.0, step: 0.1, fmt: z1 },
  { key: "rsi_length", label: "RSI length", min: 5, max: 50, step: 1 },
  { key: "rsi_long_max", label: "RSI long <", min: 25, max: 45, step: 1 },
  { key: "rsi_short_min", label: "RSI short >", min: 55, max: 75, step: 1 },
  { key: "fwd_horizon", label: "Forward bars", min: 1, max: 50, step: 1 },
];

const REGIME_DEFAULTS = {
  adx_period: 14, adx_trend_thresh: 25, trend_window: 20,
  vol_window: 20, vol_lookback: 500, vol_hi_pct: 0.80, vol_lo_pct: 0.20,
  smooth_bars: 0, fwd_horizon: 1,
};
const pct2 = (v) => v.toFixed(2);
const REGIME_KNOBS = [
  { key: "adx_period", label: "ADX period", min: 5, max: 50, step: 1 },
  { key: "adx_trend_thresh", label: "ADX trend ≥", min: 10, max: 50, step: 1 },
  { key: "trend_window", label: "Trend window", min: 5, max: 60, step: 1 },
  { key: "vol_window", label: "Vol window", min: 5, max: 60, step: 1 },
  { key: "vol_lookback", label: "Vol lookback", min: 50, max: 2000, step: 10 },
  { key: "vol_hi_pct", label: "High-vol ≥", min: 0.5, max: 0.95, step: 0.01, fmt: pct2 },
  { key: "vol_lo_pct", label: "Quiet ≤", min: 0.05, max: 0.5, step: 0.01, fmt: pct2 },
  { key: "smooth_bars", label: "Smooth", min: 0, max: 100, step: 1 },
  { key: "fwd_horizon", label: "Forward bars", min: 1, max: 50, step: 1 },
];

function getTabFromHash() {
  const m = window.location.hash.match(/tab=([^&]+)/);
  const t = m ? decodeURIComponent(m[1]) : "regime";
  return TABS.some((x) => x.id === t) ? t : "regime";
}
function setTabInHash(t) {
  window.location.hash = `#marketlab?tab=${encodeURIComponent(t)}`;
}

export default function MarketLab() {
  const [symbols, setSymbols] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [symbol, setSymbol] = usePersistentState("ql.mlab.symbol", "");
  const [timeframe, setTimeframe] = usePersistentState("ql.mlab.timeframe", "1h");
  const [range, setRange] = usePersistentState("ql.mlab.range", { start: "", end: "" });

  const [tab, setTab] = useState(getTabFromHash());
  useEffect(() => {
    const onHash = () => setTab(getTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const onTab = (id) => { setTabInHash(id); setTab(id); };

  // per-tab result cache + loading/error
  const blank = { regime: null, volatility: null, statistics: null, scanner: null, features: null, patterns: null, similarity: null };
  const [results, setResults] = useState(blank);
  const [loading, setLoading] = useState({ ...blank, regime: false });
  const [errors, setErrors] = useState(blank);
  const [scanParams, setScanParams] = usePersistentState("ql.mlab.scan", SCAN_DEFAULTS);
  const [regimeParams, setRegimeParams] = usePersistentState("ql.mlab.regimeparams", REGIME_DEFAULTS);
  const [featureParams, setFeatureParams] = usePersistentState("ql.mlab.features", FEATURE_DEFAULTS);
  const [patternParams, setPatternParams] = usePersistentState("ql.mlab.patterns", PATTERN_DEFAULTS);
  const [simParams, setSimParams] = usePersistentState("ql.mlab.sim", SIM_DEFAULTS);
  const [regimeModalOpen, setRegimeModalOpen] = useState(false);
  const [scanModalOpen, setScanModalOpen] = useState(false);

  // ---- load symbols + datasets on mount ----
  useEffect(() => {
    getSymbols().then((data) => {
      const opts = data?.symbols || [];
      setSymbols(opts);
      setDatasets(data?.datasets || []);
      if (!symbol && opts.length) setSymbol(opts[0]);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tfsForSymbol = useMemo(
    () => datasets.filter((d) => d.symbol === symbol).map((d) => d.timeframe),
    [datasets, symbol],
  );
  useEffect(() => {
    if (!symbol || tfsForSymbol.length === 0) return;
    if (!tfsForSymbol.includes(timeframe)) {
      setTimeframe(tfsForSymbol.includes("1h") ? "1h" : tfsForSymbol[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tfsForSymbol]);

  const currentDataset = useMemo(
    () => datasets.find((d) => d.symbol === symbol && d.timeframe === timeframe) || null,
    [datasets, symbol, timeframe],
  );

  // auto-fill the date range from the dataset bounds
  useEffect(() => {
    if (!currentDataset) return;
    const start = currentDataset.first_time ? fmtDate(currentDataset.first_time) : "";
    const end = currentDataset.last_time ? fmtDate(currentDataset.last_time) : "";
    if (!start || !end) return;
    if (range.start !== start || range.end !== end) setRange({ start, end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDataset?.first_time, currentDataset?.last_time]);

  const canRun = !!symbol && !!currentDataset;

  const API = {
    regime: marketLabRegime, volatility: marketLabVolatility, statistics: marketLabStatistics,
    scanner: marketLabScan, features: marketLabFeatureImportance,
    patterns: marketLabPatterns, similarity: marketLabSimilarity,
  };
  const paramsFor = (which) => ({
    scanner: { ...regimeParams, ...scanParams },
    regime: regimeParams,
    features: { ...regimeParams, ...featureParams },
    patterns: patternParams,
    similarity: simParams,
  }[which] || {});

  async function runActive() {
    if (!canRun || tab === "bench") return;
    const which = tab;
    setLoading((s) => ({ ...s, [which]: true }));
    setErrors((s) => ({ ...s, [which]: null }));
    try {
      const data = await API[which]({
        symbol, timeframe,
        start_time: dateStrToEpoch(range.start),
        end_time: dateStrToEpoch(range.end, true),
        params: paramsFor(which),
      });
      setResults((s) => ({ ...s, [which]: data }));
    } catch (e) {
      setErrors((s) => ({ ...s, [which]: e?.response?.data?.error || e.message }));
    } finally {
      setLoading((s) => ({ ...s, [which]: false }));
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="marketlab" />
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header>
          <h1 className="text-2xl font-semibold">Market Lab</h1>
          <p className="text-sm text-muted mt-1">
            Read-only structural analysis of historical OHLC — no strategy, no trades.
            Honest, transparent methods (no black-box ML): what regime are we in, is a big
            move coming, and what are the raw statistical tendencies of this instrument.
          </p>
        </header>

        {/* ---- shared setup bar ---- */}
        <section className="rounded-xl border border-line bg-bg-panel/60 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <SymbolSelector value={symbol} options={symbols} datasets={datasets} onChange={setSymbol} />
            <TimeframeSelector value={timeframe} onChange={setTimeframe} available={tfsForSymbol} />
            <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
            {tab !== "bench" && (
              <button
                onClick={runActive}
                disabled={!canRun || loading[tab]}
                className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-medium shadow disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading[tab] ? "Running…" : "Run Analysis"}
              </button>
            )}
          </div>
          {currentDataset && (
            <div className="text-[11px] text-muted mt-2">
              {currentDataset.rows?.toLocaleString()} bars of {symbol} {timeframe}
              {currentDataset.first_time && currentDataset.last_time
                ? ` · ${((currentDataset.last_time - currentDataset.first_time) / 86400 / 365).toFixed(1)} years available`
                : ""}
              {" · runs on the active tab only"}
            </div>
          )}
        </section>

        <TabBar tabs={TABS} active={tab} onSelect={onTab} />

        {errors[tab] && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
            {errors[tab]}
          </div>
        )}

        {tab === "regime" && (
          <KnobTrigger label="Regime settings"
            summary={`ADX ${regimeParams.adx_period}/${regimeParams.adx_trend_thresh} · vol ${regimeParams.vol_window} in ${regimeParams.vol_lookback} · smooth ${regimeParams.smooth_bars}`}
            onOpen={() => setRegimeModalOpen(true)} />
        )}
        {tab === "scanner" && (
          <KnobTrigger label="Setup definition"
            summary={`VWMA ${scanParams.vwma_length} · z ${z1(scanParams.z_threshold)} · RSI ${scanParams.rsi_length} (long<${scanParams.rsi_long_max}, short>${scanParams.rsi_short_min}) · fwd ${scanParams.fwd_horizon}`}
            onOpen={() => setScanModalOpen(true)} />
        )}

        {tab === "features" && (
          <ParamsBar title="Feature settings" fields={FEATURE_FIELDS} params={featureParams}
            onChange={setFeatureParams} onReset={() => setFeatureParams(FEATURE_DEFAULTS)}
            hint="Ranks causal indicators by how well they predict the next move. The honest readout is TEST accuracy vs baseline — re-run after editing." />
        )}
        {tab === "patterns" && (
          <ParamsBar title="Clustering settings" fields={PATTERN_FIELDS} params={patternParams}
            onChange={setPatternParams} onReset={() => setPatternParams(PATTERN_DEFAULTS)}
            hint="Groups recurring candle shapes (z-normalized) into k clusters and measures what tends to follow each." />
        )}
        {tab === "similarity" && (
          <ParamsBar title="Similarity settings" fields={SIM_FIELDS} params={simParams}
            onChange={setSimParams} onReset={() => setSimParams(SIM_DEFAULTS)}
            hint="Finds the k historical windows most like the latest one, and what happened next after each." />
        )}

        {tab === "regime" && <RegimeTab data={results.regime} loading={loading.regime} />}
        {tab === "volatility" && <VolatilityTab data={results.volatility} loading={loading.volatility} />}
        {tab === "statistics" && <StatisticsTab data={results.statistics} loading={loading.statistics} />}
        {tab === "scanner" && (
          <ScannerTab data={results.scanner} loading={loading.scanner}
            symbol={symbol} scanParams={scanParams} regimeParams={regimeParams}
            symbols={symbols} timeframe={timeframe} range={range} />
        )}
        {tab === "features" && <FeaturesTab data={results.features} loading={loading.features} />}
        {tab === "patterns" && <PatternsTab data={results.patterns} loading={loading.patterns} />}
        {tab === "similarity" && <SimilarityTab data={results.similarity} loading={loading.similarity} />}
        {tab === "bench" && <BenchTab symbol={symbol} timeframe={timeframe} range={range} canRun={canRun} />}
      </main>

      <KnobModal open={regimeModalOpen} title="Regime settings" knobs={REGIME_KNOBS}
        params={regimeParams} onChange={setRegimeParams}
        onReset={() => setRegimeParams(REGIME_DEFAULTS)}
        onClose={() => setRegimeModalOpen(false)}
        onRun={() => { setRegimeModalOpen(false); runActive(); }}
        running={loading.regime} />

      <KnobModal open={scanModalOpen} title="Setup definition" knobs={SCAN_KNOBS}
        params={scanParams} onChange={setScanParams}
        onReset={() => setScanParams(SCAN_DEFAULTS)}
        onClose={() => setScanModalOpen(false)}
        onRun={() => { setScanModalOpen(false); runActive(); }}
        running={loading.scanner} />
    </div>
  );
}

// --------------------------------------------------------------------------- //
function EmptyState({ loading, text }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-10 text-center text-sm text-muted">
      {loading ? "Computing…" : text}
    </div>
  );
}

function Card({ title, hint, children }) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <Section title={title} hint={hint}>{children}</Section>
    </section>
  );
}

function pct(v) { return fmtPct(v); }

// --------------------------------------------------------------------------- //
// Regime tab
// --------------------------------------------------------------------------- //
function RegimeTab({ data, loading }) {
  if (!data) return <EmptyState loading={loading} text="Pick a symbol and click Run Analysis." />;

  const mostCommon = [...data.distribution].sort((a, b) => b.bars - a.bars)[0];
  const bestFwd = [...(data.forward_returns || [])]
    .filter((r) => r.avg_fwd_return_pct != null)
    .sort((a, b) => b.avg_fwd_return_pct - a.avg_fwd_return_pct)[0];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Current regime" value={<span style={{ color: REGIME_COLORS[data.last_regime] }}>{data.last_regime}</span>} />
        <KpiCard title="Most common" value={mostCommon?.regime || "—"}
                 sub={mostCommon ? `${fmtNum(mostCommon.pct_time)}% of bars` : ""} />
        <KpiCard title="Bars analyzed" value={fmtInt(data.meta?.bars)} />
        <KpiCard title="Regime switches" value={fmtInt(data.transitions?.n_transitions)} />
      </div>

      <Card title="Regime ribbon" hint="Price (grey line) with the detected regime colored beneath each bar. Hover a band for its label.">
        <RegimeRibbon segments={data.segments} price={data.price} height={200} />
        <Legend />
      </Card>

      <div className="grid md:grid-cols-2 gap-5">
        <Card title="Time spent in each regime">
          <VBarChart
            bars={data.distribution.map((d) => ({ label: short(d.regime), value: d.pct_time, n: d.bars }))}
            colorMode="fixed" color="#60a5fa" height={200} yLabel="% of bars"
            fmt={(v) => `${fmtNum(v)}`}
          />
        </Card>

        <Card title="What happens next" hint="Average return over the next bar, conditioned on the current regime.">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
                <th className="py-1">Regime</th><th>Avg next</th><th>Win rate</th><th className="text-right">n</th>
              </tr>
            </thead>
            <tbody>
              {data.forward_returns?.map((r) => (
                <tr key={r.regime} className="border-t border-line/50">
                  <td className="py-1.5" style={{ color: REGIME_COLORS[r.regime] }}>{r.regime}</td>
                  <td className={signClass(r.avg_fwd_return_pct)}>{pct(r.avg_fwd_return_pct)}</td>
                  <td className="text-muted">{r.win_rate == null ? "—" : `${fmtNum(r.win_rate)}%`}</td>
                  <td className="text-right text-muted">{fmtInt(r.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Regime transitions" hint="How often the market moves from one regime (row) to another (column).">
        <TransitionMatrix transitions={data.transitions} labels={data.meta?.labels || []} />
      </Card>

      <InsightCard rows={[
        ["Current state", data.last_regime, "", tone(data.last_regime)],
        ["Dominant regime", mostCommon?.regime || "—", mostCommon ? `${fmtNum(mostCommon.pct_time)}% of time` : "", "neutral"],
        ["Best forward regime", bestFwd?.regime || "—", bestFwd ? `${pct(bestFwd.avg_fwd_return_pct)} avg next bar` : "", bestFwd && bestFwd.avg_fwd_return_pct >= 0 ? "profit" : "loss"],
        ["Avg regime length", avgDuration(data.transitions), "bars", "neutral"],
      ]} />
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted pt-1">
      {Object.entries(REGIME_COLORS).map(([k, c]) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm" style={{ background: c }} />{k}
        </span>
      ))}
    </div>
  );
}

function TransitionMatrix({ transitions, labels }) {
  if (!transitions?.matrix) return null;
  const m = transitions.matrix;
  const max = Math.max(1, ...labels.flatMap((a) => labels.map((b) => m[a]?.[b] || 0)));
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-1.5 text-muted text-left">from \ to</th>
            {labels.map((l) => <th key={l} className="p-1.5 text-muted font-normal whitespace-nowrap" style={{ color: REGIME_COLORS[l] }}>{short(l)}</th>)}
          </tr>
        </thead>
        <tbody>
          {labels.map((a) => (
            <tr key={a}>
              <td className="p-1.5 whitespace-nowrap" style={{ color: REGIME_COLORS[a] }}>{short(a)}</td>
              {labels.map((b) => {
                const v = m[a]?.[b] || 0;
                const intensity = v / max;
                return (
                  <td key={b} className="p-1.5 text-center font-mono"
                      style={{ background: a === b ? "transparent" : `rgba(59,130,246,${0.08 + intensity * 0.5})`,
                               color: a === b ? "#64748b" : "#e5e7eb" }}>
                    {a === b ? "·" : v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Volatility tab
// --------------------------------------------------------------------------- //
function VolatilityTab({ data, loading }) {
  if (!data) return <EmptyState loading={loading} text="Pick a symbol and click Run Analysis." />;
  const v = data.verdict || {};
  const toneCls = v.tone === "warn"
    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
    : "border-line bg-bg-panel/40 text-muted";

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Vol percentile" value={data.current_vol_percentile == null ? "—" : `${fmtNum(data.current_vol_percentile * 100)}%`}
                 sub="where current vol sits in its own history" />
        <KpiCard title="Annualized vol" value={data.current_rv_annualized == null ? "—" : `${fmtNum(data.current_rv_annualized * 100)}%`} />
        <KpiCard title="Clustering score" value={fmtNum(data.clustering_score)}
                 sub="ACF of squared returns (lags 1–5)" positive={data.clustering_score > 0 ? true : null} />
        <KpiCard title="Forecast skill" value={fmtNum(data.forecast_skill_corr)}
                 sub={`vs persistence ${fmtNum(data.persistence_skill_corr)}`} />
      </div>

      {v.text && (
        <div className={`rounded-md border px-4 py-3 text-sm ${toneCls}`}>
          <span className="font-medium">Verdict: </span>{v.text}
        </div>
      )}

      <Card title="Realized volatility over time"
            hint={`Annualized rolling volatility. Dashed magenta = EWMA forecast for the next ${data.forecast?.horizon_bars} bars.`}>
        <LineChart
          points={(data.rv_series || []).map((p) => ({ time: p.time, value: p.value }))}
          forecast={data.forecast?.ewma_next_vol_annualized}
          height={220} yLabel="ann. vol" fmt={(x) => `${fmtNum(x * 100)}%`}
        />
      </Card>

      <div className="grid md:grid-cols-2 gap-5">
        <Card title="Volatility clustering"
              hint="Autocorrelation of squared returns. Positive bars at low lags = big moves follow big moves.">
          <VBarChart
            bars={(data.acf_sq_returns || []).map((d) => ({ label: String(d.lag), value: d.acf }))}
            colorMode="sign" height={200} yLabel="ACF" fmt={(x) => fmtNum(x)}
          />
        </Card>

        <Card title="Forecast skill — honest baseline"
              hint="Correlation between predicted and realized next-period vol. If EWMA barely beats persistence, the model adds little.">
          <div className="grid grid-cols-2 gap-3 pt-2">
            <KpiCard title="EWMA" value={fmtNum(data.forecast_skill_corr)} positive={data.forecast_skill_corr > 0 ? true : null} />
            <KpiCard title="Persistence (naive)" value={fmtNum(data.persistence_skill_corr)} />
          </div>
          <p className="text-[11px] text-muted mt-3">
            Volatility (the <em>size</em> of moves) is somewhat predictable because it clusters.
            Direction is deliberately <strong>not</strong> forecast here — that's the part markets make hard.
          </p>
        </Card>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Statistics tab
// --------------------------------------------------------------------------- //
function StatisticsTab({ data, loading }) {
  if (!data) return <EmptyState loading={loading} text="Pick a symbol and click Run Analysis." />;
  const dist = data.distribution || {};
  const dows = (data.by_dow || []).filter((d) => d.n > 0);
  const bestDow = [...dows].sort((a, b) => (b.avg_return_pct ?? -1e9) - (a.avg_return_pct ?? -1e9))[0];
  const worstDow = [...dows].sort((a, b) => (a.avg_return_pct ?? 1e9) - (b.avg_return_pct ?? 1e9))[0];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Skew" value={fmtNum(dist.skew)} sub={dist.skew > 0 ? "right-tailed" : dist.skew < 0 ? "left-tailed" : ""} />
        <KpiCard title="Excess kurtosis" value={fmtNum(dist.excess_kurtosis)}
                 sub={dist.fat_tail_flag ? "fat tails ⚠" : "≈ normal tails"} positive={dist.fat_tail_flag ? false : null} />
        <KpiCard title="Tail ratio" value={fmtNum(dist.tail_ratio)} sub="|p95| / |p5|" />
        <KpiCard title="Lag-1 autocorr" value={fmtNum(data.lag1_autocorr)}
                 sub={data.lag1_autocorr > 0 ? "momentum" : data.lag1_autocorr < 0 ? "mean-reversion" : ""}
                 positive={data.lag1_autocorr > 0 ? true : data.lag1_autocorr < 0 ? false : null} />
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Card title="Average return by day of week" hint="UTC. Green = up days on average.">
          <VBarChart bars={(data.by_dow || []).map((d) => ({ label: d.label, value: d.avg_return_pct, n: d.n }))}
                     colorMode="sign" height={200} yLabel="avg %" fmt={(x) => fmtNum(x)} />
        </Card>
        <Card title="Average return by hour" hint="UTC (hour 0–23).">
          <VBarChart bars={(data.by_hour || []).map((d) => ({ label: d.label, value: d.avg_return_pct, n: d.n }))}
                     colorMode="sign" height={200} yLabel="avg %" labelEvery={3} fmt={(x) => fmtNum(x)} />
        </Card>
      </div>

      <Card title="Return distribution" hint="Histogram of per-bar log returns with a fitted normal curve (magenta). Fat tails stick out beyond the bell.">
        <HistogramChart counts={dist.histogram?.counts || []} binEdges={dist.histogram?.bin_edges || []}
                        mean={dist.mean || 0} std={dist.std || 0} height={240} />
      </Card>

      <Card title="Return autocorrelation" hint="Does a return predict the next? Positive = momentum, negative = mean-reversion.">
        <VBarChart bars={(data.autocorr || []).map((d) => ({ label: String(d.lag), value: d.acf }))}
                   colorMode="sign" height={200} yLabel="ACF" labelEvery={2} fmt={(x) => fmtNum(x)} />
      </Card>

      <div className="grid md:grid-cols-2 gap-5">
        <StreakTable title="After consecutive DOWN bars" rows={data.after_down_streaks} />
        <StreakTable title="After consecutive UP bars" rows={data.after_up_streaks} />
      </div>

      <InsightCard rows={[
        ["Best weekday", bestDow?.label || "—", bestDow ? `${pct(bestDow.avg_return_pct)} avg` : "", bestDow && bestDow.avg_return_pct >= 0 ? "profit" : "loss"],
        ["Worst weekday", worstDow?.label || "—", worstDow ? `${pct(worstDow.avg_return_pct)} avg` : "", "loss"],
        ["Return character", data.lag1_autocorr > 0 ? "Momentum" : "Mean-reverting", `lag-1 = ${fmtNum(data.lag1_autocorr)}`, "neutral"],
        ["Tails", dist.fat_tail_flag ? "Fat (risk of big moves)" : "Normal-ish", `kurtosis ${fmtNum(dist.excess_kurtosis)}`, dist.fat_tail_flag ? "loss" : "neutral"],
      ]} />

      <p className="text-[11px] text-muted">{data.meta?.caveat}</p>
    </div>
  );
}

function StreakTable({ title, rows }) {
  return (
    <Card title={title} hint="Average return over the next bar after a streak of N same-direction bars.">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
            <th className="py-1">Streak</th><th>Avg next</th><th>Win rate</th><th className="text-right">count</th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((r) => (
            <tr key={r.n} className="border-t border-line/50">
              <td className="py-1.5">{r.n} bar{r.n > 1 ? "s" : ""}</td>
              <td className={signClass(r.avg_fwd_return_pct)}>{fmtPct(r.avg_fwd_return_pct)}</td>
              <td className="text-muted">{r.win_rate == null ? "—" : `${fmtNum(r.win_rate)}%`}</td>
              <td className="text-right text-muted">{fmtInt(r.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Alpha Scanner tab
// --------------------------------------------------------------------------- //
// Plain-language explanations shown by the "?" icon next to a param.
const HELP = {
  adx_period: {
    title: "ADX period",
    body: (
      <>
        <p>ADX (Average Directional Index) measures <strong>how strong a trend is</strong> — it does <em>not</em> say up or down, only strength, on a 0–100 scale.</p>
        <p className="mt-2">The <strong>period</strong> is how many bars it averages over:</p>
        <ul className="list-disc pl-5 mt-1 space-y-1">
          <li><strong>Shorter</strong> (e.g. 7) → reacts faster, but noisier and flips more.</li>
          <li><strong>Longer</strong> (e.g. 20–30) → smoother and steadier, but lags behind turns.</li>
        </ul>
        <p className="mt-2 text-muted">14 is the classic default.</p>
      </>
    ),
  },
  adx_trend_thresh: {
    title: "ADX trend threshold",
    body: (
      <>
        <p>This is the cutoff that decides when the market counts as <strong>Trending</strong> vs just chopping sideways.</p>
        <ul className="list-disc pl-5 mt-2 space-y-1">
          <li>ADX <strong>below</strong> the threshold → no real trend → labeled <span className="text-[#94a3b8]">Choppy</span> / <span className="text-[#3b82f6]">Quiet</span> (good for mean-reversion).</li>
          <li>ADX <strong>at or above</strong> it → a strong directional move is underway → labeled <span className="text-[#22c55e]">Trending Up</span> / <span className="text-[#ef4444]">Trending Down</span> (dangerous for mean-reversion — price keeps running).</li>
        </ul>
        <p className="mt-2"><strong>Raise it</strong> (e.g. 30–35) → stricter, fewer Trending bands. <strong>Lower it</strong> (e.g. 20) → more bars called Trending.</p>
        <p className="mt-2 text-muted">This is the knob that most changes how the ribbon looks.</p>
      </>
    ),
  },
  vol_lookback: {
    title: "Volatility lookback",
    body: (
      <>
        <p>Volatility is judged <strong>relative to the recent past</strong>, not all of history. This sets how many trailing bars it compares against.</p>
        <p className="mt-2">On 15-minute bars, 500 bars ≈ <strong>5 days</strong>; on 1-hour bars ≈ 3 weeks. So "High-Volatility" means <em>"volatile compared to roughly the last week."</em></p>
        <p className="mt-2"><strong>Bigger</strong> → calmer, judged against more history. <strong>Smaller</strong> → twitchier, judged against only the recent past.</p>
        <p className="mt-2 text-muted">It's a trailing window, so it works identically in live trading.</p>
      </>
    ),
  },
  smooth_bars: {
    title: "Smoothing (minimum regime length)",
    body: (
      <>
        <p>Regimes can flicker — flipping label every few bars. This merges any regime stretch <strong>shorter than N bars</strong> into its neighbor, so the ribbon reads cleanly.</p>
        <p className="mt-2"><strong>0</strong> = off (raw, jumpy). <strong>15–30</strong> = noticeably calmer. The bigger the number, the fewer, longer regime bands.</p>
        <p className="mt-2 text-muted">Purely cosmetic for reading the ribbon — it doesn't invent data, just hides micro-flips.</p>
      </>
    ),
  },
  vol_window: {
    title: "Volatility window",
    body: (
      <>
        <p>How many bars are used to <strong>measure</strong> volatility (the rolling standard deviation of returns) at each point.</p>
        <p className="mt-2"><strong>Shorter</strong> → reacts fast to bursts but jumpy. <strong>Longer</strong> → smoother, slower to notice a vol spike.</p>
        <p className="mt-2 text-muted">Different from "Vol lookback": this is how vol is <em>computed</em>; lookback is the window it's <em>ranked against</em>.</p>
      </>
    ),
  },
  trend_window: {
    title: "Trend window",
    body: (
      <>
        <p>How many bars are used to measure the <strong>direction</strong> of the trend — a line is fitted to price over this window and its slope decides up vs down.</p>
        <p className="mt-2"><strong>Shorter</strong> → picks up direction changes quickly. <strong>Longer</strong> → only flags sustained moves.</p>
      </>
    ),
  },
  vol_hi_pct: {
    title: "High-volatility cutoff",
    body: (
      <>
        <p>When current volatility ranks in the <strong>top</strong> slice of its recent history, the bar is labeled <span className="text-[#f59e0b]">High-Volatility</span>.</p>
        <p className="mt-2"><strong>0.80</strong> means "top 20% most volatile." Raise toward 0.9 → only extreme bursts qualify; lower → more bars flagged High-Vol.</p>
      </>
    ),
  },
  vol_lo_pct: {
    title: "Quiet cutoff",
    body: (
      <>
        <p>When current volatility ranks in the <strong>bottom</strong> slice of its recent history (and there's no trend), the bar is labeled <span className="text-[#3b82f6]">Quiet</span>.</p>
        <p className="mt-2"><strong>0.20</strong> means "bottom 20% calmest." Raise → more bars called Quiet; lower → only dead-calm bars qualify.</p>
      </>
    ),
  },
  fwd_horizon: {
    title: "Forward bars",
    body: (
      <>
        <p>How many bars <strong>ahead</strong> we measure the outcome. "What happens next" = the return over the next N bars after a regime/setup.</p>
        <p className="mt-2">On 15-minute bars, 10 forward bars ≈ 2.5 hours. Match it to how long you'd actually hold a trade.</p>
        <p className="mt-2 text-muted">The last N bars are dropped from the stats (no future data exists yet for them).</p>
      </>
    ),
  },
  vwma_length: {
    title: "VWMA length",
    body: (
      <>
        <p>The <strong>Volume-Weighted Moving Average</strong> is the "fair value" line price reverts toward. This sets how many bars it averages.</p>
        <p className="mt-2"><strong>Shorter</strong> → hugs price closely (frequent, small stretches). <strong>Longer</strong> → a slower anchor (rarer, bigger stretches).</p>
      </>
    ),
  },
  rsi_length: {
    title: "RSI length",
    body: (
      <>
        <p>RSI measures recent up- vs down-pressure on a 0–100 scale. This sets how many bars it looks back over.</p>
        <p className="mt-2"><strong>Shorter</strong> (e.g. 2–7) → very twitchy, hits extremes often. <strong>Longer</strong> (e.g. 14–25) → smoother, fewer extreme readings.</p>
      </>
    ),
  },
  rsi_long_max: {
    title: "RSI long ceiling",
    body: (
      <>
        <p>A <strong>long</strong> mean-reversion setup only fires when RSI is <em>below</em> this — i.e. price is oversold enough to expect a bounce.</p>
        <p className="mt-2">Lower (e.g. 25–30) → stricter, only deeply oversold. Higher → looser, more long setups.</p>
      </>
    ),
  },
  rsi_short_min: {
    title: "RSI short floor",
    body: (
      <>
        <p>A <strong>short</strong> setup only fires when RSI is <em>above</em> this — i.e. price is overbought enough to expect a pullback.</p>
        <p className="mt-2">Higher (e.g. 70–75) → stricter, only deeply overbought. Lower → looser, more short setups.</p>
      </>
    ),
  },
  z_threshold: {
    title: "Z-score threshold",
    body: (
      <>
        <p>How far price must stretch away from its VWMA average — measured in <strong>standard deviations</strong> — before it counts as a mean-reversion setup.</p>
        <p className="mt-2"><strong>Higher</strong> (e.g. 2.5) → rarer, more extreme stretches, higher conviction, fewer triggers. <strong>Lower</strong> (e.g. 1.0) → more frequent but weaker setups.</p>
        <p className="mt-2 text-muted">The z-sweep chart shows how the edge changes as you raise it.</p>
      </>
    ),
  },
};

function HelpModal({ help, onClose }) {
  useEffect(() => {
    if (!help) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [help, onClose]);
  if (!help) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[460px] max-w-[92vw] rounded-xl border border-line bg-bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-line flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-accent-blue/15 text-accent-blue flex items-center justify-center font-semibold">?</span>
          <h3 className="text-base font-semibold">{help.title}</h3>
        </div>
        <div className="px-5 py-4 text-sm text-text leading-relaxed">{help.body}</div>
        <div className="px-5 py-4 border-t border-line flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md font-medium text-white bg-accent-grad">Got it</button>
        </div>
      </div>
    </div>
  );
}

function ParamsBar({ title, fields, params, onChange, onReset, hint }) {
  const set = (k, v) => onChange({ ...params, [k]: v });
  const [helpKey, setHelpKey] = useState(null);
  return (
    <section className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-muted">{title}</div>
        <button onClick={onReset} className="text-[11px] text-muted hover:text-text underline underline-offset-2">reset</button>
      </div>
      <div className="flex flex-wrap gap-4">
        {fields.map(([k, label, step]) => (
          <label key={k} className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted flex items-center gap-1">
              {label}
              {HELP[k] && (
                <button type="button" onClick={(e) => { e.preventDefault(); setHelpKey(k); }}
                  title={`What is ${label}?`}
                  className="w-4 h-4 rounded-full border border-line text-[10px] leading-none text-muted hover:text-accent-blue hover:border-accent-blue flex items-center justify-center">
                  ?
                </button>
              )}
            </span>
            <input type="number" step={step} value={params[k] ?? ""}
              onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) set(k, n); }}
              className="w-20 px-2 py-1.5 text-right rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue" />
          </label>
        ))}
      </div>
      {hint && <p className="text-[11px] text-muted mt-2">{hint}</p>}
      <HelpModal help={HELP[helpKey]} onClose={() => setHelpKey(null)} />
    </section>
  );
}

// --------------------------------------------------------------------------- //
// Dial-knob controls (Regime settings popup)
// --------------------------------------------------------------------------- //
function knobPoint(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180; // 0° = top (12 o'clock), clockwise positive
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}
function knobArc(cx, cy, r, d0, d1) {
  const p0 = knobPoint(cx, cy, r, d0);
  const p1 = knobPoint(cx, cy, r, d1);
  const large = d1 - d0 > 180 ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

function Knob({ spec, value, onChange, onHelp }) {
  const { key, label, min, max, step, fmt } = spec;
  const svgRef = useRef(null);
  const drag = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const clamp = (val) => Math.min(max, Math.max(min, val));
  const snap = (val) => clamp(parseFloat((Math.round((val - min) / step) * step + min).toFixed(6)));
  const v = clamp(Number.isFinite(value) ? value : min);
  const frac = (v - min) / (max - min || 1);
  const ang = -135 + frac * 270;
  const cx = 30, cy = 30, r = 22;
  const ind = knobPoint(cx, cy, r - 3, ang);

  const begin = (e) => { drag.current = { y: e.clientY, v }; svgRef.current?.setPointerCapture?.(e.pointerId); };
  const move = (e) => {
    if (!drag.current) return;
    const dy = drag.current.y - e.clientY;            // drag up = increase
    const next = snap(drag.current.v + dy * ((max - min) / 180));
    if (next !== value) onChange(next);
  };
  const end = (e) => { drag.current = null; svgRef.current?.releasePointerCapture?.(e.pointerId); };
  const wheel = (e) => { e.preventDefault(); onChange(snap(v + (e.deltaY < 0 ? step : -step))); };
  const bump = (dir) => onChange(snap(v + dir * step));
  const commit = () => {
    const parsed = parseFloat(draft);
    if (Number.isFinite(parsed)) onChange(snap(parsed));
    setEditing(false);
  };

  return (
    <div className="flex flex-col items-center gap-1 select-none w-[92px]">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted text-center">
        {label}
        {HELP[key] && (
          <button type="button" onClick={() => onHelp(key)} title={`What is ${label}?`}
            className="w-4 h-4 rounded-full border border-line text-[9px] leading-none text-muted hover:text-accent-blue hover:border-accent-blue flex items-center justify-center shrink-0">?</button>
        )}
      </div>
      <svg ref={svgRef} width="60" height="60" viewBox="0 0 60 60"
           onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onWheel={wheel}
           style={{ cursor: "ns-resize", touchAction: "none" }}>
        <path d={knobArc(cx, cy, r, -135, 135)} fill="none" stroke="rgba(148,163,184,0.22)" strokeWidth="4" strokeLinecap="round" />
        {frac > 0.001 && (
          <path d={knobArc(cx, cy, r, -135, ang)} fill="none" stroke="#3b82f6" strokeWidth="4" strokeLinecap="round" />
        )}
        <line x1={cx} y1={cy} x2={ind.x} y2={ind.y} stroke="#e5e7eb" strokeWidth="2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="2.5" fill="#e5e7eb" />
      </svg>
      {editing ? (
        <input
          autoFocus type="number" step={step} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }}
          className="w-16 px-1 py-0.5 text-center rounded bg-bg-panel border border-accent-blue font-mono text-sm focus:outline-none"
        />
      ) : (
        <div className="flex items-center gap-1">
          <span
            onDoubleClick={() => { setDraft(String(v)); setEditing(true); }}
            title="double-click to type a value"
            className="text-sm font-mono text-text leading-none cursor-text min-w-[36px] text-center">
            {fmt ? fmt(v) : v}
          </span>
          <div className="flex flex-col -my-0.5">
            <button type="button" onClick={() => bump(1)} disabled={v >= max}
              className="h-3.5 px-1 leading-none text-[9px] text-muted hover:text-accent-blue disabled:opacity-30">▲</button>
            <button type="button" onClick={() => bump(-1)} disabled={v <= min}
              className="h-3.5 px-1 leading-none text-[9px] text-muted hover:text-accent-blue disabled:opacity-30">▼</button>
          </div>
        </div>
      )}
    </div>
  );
}

function KnobTrigger({ label, summary, onOpen }) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/40 p-3 flex items-center justify-between flex-wrap gap-2">
      <div className="text-xs text-muted">{label}: <span className="font-mono text-text">{summary}</span></div>
      <button onClick={onOpen}
        className="px-3 py-1.5 rounded-md border border-line text-sm text-text hover:border-accent-blue flex items-center gap-2">
        <span>⚙</span> Adjust knobs
      </button>
    </section>
  );
}

function KnobModal({ open, title, knobs, params, onChange, onReset, onClose, onRun, running, footer }) {
  const [helpKey, setHelpKey] = useState(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") { if (helpKey) setHelpKey(null); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, helpKey, onClose]);
  if (!open) return null;
  const set = (k, val) => onChange({ ...params, [k]: val });
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[680px] max-w-[94vw] rounded-xl border border-line bg-bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full bg-accent-blue/15 text-accent-blue flex items-center justify-center">⚙</span>
            <div>
              <h3 className="text-base font-semibold">{title}</h3>
              <p className="text-[11px] text-muted">Drag a knob up/down (or scroll over it) to adjust. Tap <span className="font-mono">?</span> for an explanation.</p>
            </div>
          </div>
          <button onClick={onReset} className="text-[11px] text-muted hover:text-text underline underline-offset-2 shrink-0">reset to defaults</button>
        </div>
        <div className="px-5 py-6 grid grid-cols-3 sm:grid-cols-5 gap-y-6 gap-x-2 justify-items-center">
          {knobs.map((spec) => (
            <Knob key={spec.key} spec={spec} value={params[spec.key] ?? spec.min}
                  onChange={(val) => set(spec.key, val)} onHelp={setHelpKey} />
          ))}
        </div>
        {footer && <div className="px-5 pb-1 -mt-2">{footer}</div>}
        <div className="px-5 py-4 border-t border-line flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted">Saved automatically.</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-md text-muted hover:text-text">Close</button>
            <button onClick={onRun} disabled={running}
              className="px-4 py-2 text-sm rounded-md font-medium text-white bg-accent-grad disabled:opacity-40">
              {running ? "Running…" : "Apply & Run"}
            </button>
          </div>
        </div>
      </div>
      <HelpModal help={HELP[helpKey]} onClose={() => setHelpKey(null)} />
    </div>
  );
}

function SigBadge({ sig }) {
  const map = {
    significant: ["text-profit border-profit/40 bg-profit/10", "significant"],
    marginal: ["text-amber-400 border-amber-400/40 bg-amber-400/10", "marginal"],
    not_significant: ["text-muted border-line bg-bg-elev/40", "not significant"],
    insufficient: ["text-muted border-line bg-bg-elev/40", "too few"],
    no_data: ["text-muted border-line bg-bg-elev/40", "no data"],
  };
  const [cls, label] = map[sig] || map.no_data;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>;
}

function SideBlock({ title, block, baselineHint }) {
  const o = block.overall;
  return (
    <Card title={title} hint={baselineHint}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Triggers (n)" value={fmtInt(o.n)} />
        <KpiCard title="Avg trade return" value={pct(o.avg_return_pct)} positive={o.avg_return_pct >= 0} />
        <KpiCard title="Edge vs baseline" value={pct(o.edge_vs_baseline_pct)} positive={o.edge_vs_baseline_pct >= 0} sub="setup minus random entry" />
        <KpiCard title="Win rate" value={o.win_rate == null ? "—" : `${fmtNum(o.win_rate)}%`} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-xs text-muted">Statistical significance:</span>
        <SigBadge sig={o.significance} />
        {o.p_value != null && <span className="text-[11px] font-mono text-muted">p={o.p_value < 0.001 ? o.p_value.toExponential(1) : fmtNum(o.p_value)}</span>}
      </div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
            <th className="py-1">Regime</th><th>Avg</th><th>Edge</th><th>Sig</th><th className="text-right">n</th>
          </tr>
        </thead>
        <tbody>
          {block.by_regime.map((r) => (
            <tr key={r.regime} className="border-t border-line/50">
              <td className="py-1.5" style={{ color: REGIME_COLORS[r.regime] }}>{short(r.regime)}</td>
              <td className={signClass(r.avg_return_pct)}>{pct(r.avg_return_pct)}</td>
              <td className={signClass(r.edge_vs_baseline_pct)}>{pct(r.edge_vs_baseline_pct)}</td>
              <td><SigBadge sig={r.significance} /></td>
              <td className="text-right text-muted">{fmtInt(r.n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ScannerTab({ data, loading, symbol, scanParams, regimeParams, symbols, timeframe, range }) {
  const [saveOpen, setSaveOpen] = useState(false);
  if (!data) return (
    <div className="space-y-5">
      <EmptyState loading={loading} text="Set the VWMA/RSI setup above and click Run Analysis." />
      <BatchPanel symbols={symbols} timeframe={timeframe} range={range} params={{ ...regimeParams, ...scanParams }} />
    </div>
  );
  const base = data.baseline || {};
  const baselineHint = `Forward return over the next ${base.fwd_horizon} bars. Baseline drift = ${pct(base.drift_pct)}.`;

  const bestSig = (block) => [...(block.by_regime || [])]
    .filter((r) => r.significance === "significant" && r.edge_vs_baseline_pct != null)
    .sort((a, b) => b.edge_vs_baseline_pct - a.edge_vs_baseline_pct)[0];
  const bestShort = bestSig(data.short);
  const bestLong = bestSig(data.long);

  // Pre-fill the regimes to allow from whichever regimes showed a *significant*
  // edge (union of long & short). Fall back to mean-reversion-friendly defaults.
  const sigRegimes = new Set([
    ...data.short.by_regime.filter((r) => r.significance === "significant").map((r) => r.regime),
    ...data.long.by_regime.filter((r) => r.significance === "significant").map((r) => r.regime),
  ]);
  const presetAllowed = REGIME_LABELS_FE.reduce((acc, lab) => {
    acc[lab] = sigRegimes.size ? sigRegimes.has(lab) : (lab === "Quiet" || lab === "Choppy-Range");
    return acc;
  }, {});
  // Target the side with the stronger significant edge.
  const so = data.short.overall, lo = data.long.overall;
  const shortBetter = (so.significance === "significant" ? (so.edge_vs_baseline_pct || 0) : -1)
                    >= (lo.significance === "significant" ? (lo.edge_vs_baseline_pct || 0) : -1);

  return (
    <div className="space-y-5">
      <div className="flex justify-end -mb-2">
        <button onClick={() => setSaveOpen(true)}
          className="px-3 py-1.5 rounded-md border border-accent-blue/50 text-sm text-accent-blue hover:bg-accent-blue/10 flex items-center gap-2">
          <span>↪</span> Save as VWMA preset
        </button>
      </div>

      <SideBlock title="SHORT setup — overbought, expecting reversion down" block={data.short} baselineHint={baselineHint} />
      <SideBlock title="LONG setup — oversold, expecting reversion up" block={data.long} baselineHint={baselineHint} />

      <div className="grid md:grid-cols-2 gap-5">
        <Card title="Short edge vs conviction (z-sweep)" hint="Edge as the z-threshold rises. A smooth climb = real edge; a lone random spike = noise.">
          <VBarChart bars={(data.z_sweep || []).map((s) => ({ label: String(s.z), value: s.short_edge_pct, n: s.short_n }))}
                     colorMode="sign" height={200} yLabel="edge %" labelEvery={2} fmt={(x) => fmtNum(x)} />
        </Card>
        <Card title="Long edge vs conviction (z-sweep)" hint="Same, for long setups.">
          <VBarChart bars={(data.z_sweep || []).map((s) => ({ label: String(s.z), value: s.long_edge_pct, n: s.long_n }))}
                     colorMode="sign" height={200} yLabel="edge %" labelEvery={2} fmt={(x) => fmtNum(x)} />
        </Card>
      </div>

      {data.edge_heatmap && (
        <div className="grid md:grid-cols-2 gap-5">
          <Card title="Short edge surface (z × RSI)" hint="Green = profitable short edge; cells with too few samples are greyed.">
            <EdgeHeatmap grid={data.edge_heatmap.short} zAxis={data.edge_heatmap.z_axis} rsiAxis={data.edge_heatmap.rsi_short_axis} />
          </Card>
          <Card title="Long edge surface (z × RSI)" hint="Same, for long setups.">
            <EdgeHeatmap grid={data.edge_heatmap.long} zAxis={data.edge_heatmap.z_axis} rsiAxis={data.edge_heatmap.rsi_long_axis} />
          </Card>
        </div>
      )}

      <InsightCard rows={[
        ["Best SHORT regime", bestShort ? short(bestShort.regime) : "none significant", bestShort ? `${pct(bestShort.edge_vs_baseline_pct)} edge` : "", bestShort ? "profit" : "neutral"],
        ["Best LONG regime", bestLong ? short(bestLong.regime) : "none significant", bestLong ? `${pct(bestLong.edge_vs_baseline_pct)} edge` : "", bestLong ? "profit" : "neutral"],
        ["Baseline drift", pct(base.drift_pct), `over ${base.fwd_horizon} bars`, "neutral"],
        ["Next step", "Walk-Forward", "filter to the winning regime, then validate OOS", "neutral"],
      ]} />

      <p className="text-[11px] text-muted">{data.meta?.caveat}</p>

      <BatchPanel symbols={symbols} timeframe={timeframe} range={range} params={{ ...regimeParams, ...scanParams }} />

      <SavePresetModal
        open={saveOpen} onClose={() => setSaveOpen(false)}
        symbol={symbol} scanParams={scanParams} regimeParams={regimeParams}
        defaultAllowed={presetAllowed} defaultSides={shortBetter ? { long: false, short: true } : { long: true, short: false }} />
    </div>
  );
}

function BatchPanel({ symbols = [], timeframe, range, params }) {
  const [picked, setPicked] = useState([]);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const toggle = (s) => setPicked((p) => p.includes(s) ? p.filter((x) => x !== s) : (p.length < 20 ? [...p, s] : p));

  async function run() {
    if (!picked.length) return;
    setBusy(true); setErr(null);
    try {
      const data = await marketLabScanBatch({
        symbols: picked, timeframe,
        start_time: dateStrToEpoch(range.start), end_time: dateStrToEpoch(range.end, true), params,
      });
      const sorted = [...(data.results || [])].sort((a, b) =>
        (b.short_edge_pct ?? -1e9) - (a.short_edge_pct ?? -1e9));
      setRows(sorted);
    } catch (e) { setErr(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Cross-symbol scan" hint="Which instruments have the strongest mean-reversion edge right now? Pick up to 20, then scan.">
      <div className="flex flex-wrap gap-1.5 mb-3">
        {symbols.map((s) => (
          <button key={s} onClick={() => toggle(s)}
            className={`px-2 py-1 rounded text-[11px] font-mono border ${picked.includes(s)
              ? "border-accent-blue text-accent-blue bg-accent-blue/10" : "border-line text-muted hover:text-text"}`}>
            {s}
          </button>
        ))}
      </div>
      <button onClick={run} disabled={busy || !picked.length}
        className="px-3 py-1.5 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-40">
        {busy ? "Scanning…" : `Scan ${picked.length || ""} symbol${picked.length === 1 ? "" : "s"}`}
      </button>
      {err && <div className="text-xs text-loss mt-2">{err}</div>}
      {rows && (
        <table className="w-full text-sm mt-3">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
              <th className="py-1">Symbol</th><th>Short edge</th><th>Sig</th><th>Long edge</th><th>Sig</th><th className="text-right">bars</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t border-line/50">
                <td className="py-1.5 font-mono">{r.symbol}</td>
                {r.error ? <td colSpan={5} className="text-loss text-xs">{r.error}</td> : <>
                  <td className={signClass(r.short_edge_pct)}>{pct(r.short_edge_pct)}</td>
                  <td><SigBadge sig={r.short_sig} /></td>
                  <td className={signClass(r.long_edge_pct)}>{pct(r.long_edge_pct)}</td>
                  <td><SigBadge sig={r.long_sig} /></td>
                  <td className="text-right text-muted">{fmtInt(r.bars)}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------------- //
// Model Bench tab (async PyTorch LSTM training)
// --------------------------------------------------------------------------- //
const BENCH_DEFAULTS = { seq_len: 24, fwd_horizon: 5, hidden: 32, epochs: 30, max_samples: 15000 };
const BENCH_FIELDS = [
  ["seq_len", "Sequence bars", 1], ["fwd_horizon", "Forward bars", 1],
  ["hidden", "LSTM units", 1], ["epochs", "Max epochs", 1], ["max_samples", "Max samples", 1000],
];

function BenchTab({ symbol, timeframe, range, canRun }) {
  const [params, setParams] = usePersistentState("ql.mlab.bench", BENCH_DEFAULTS);
  const [job, setJob] = useState({ state: "idle" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getModelBenchStatus().then((s) => { if (s?.state) setJob(s); if (s?.result) setResult(s.result); }).catch(() => {});
    getModelBenchLastResult().then((r) => r && setResult(r)).catch(() => {});
    const unsub = subscribeModelBench({
      onProgress: (p) => setJob((j) => ({ ...j, state: "running", ...p })),
      onComplete: (p) => { setJob((j) => ({ ...j, state: "done" })); setResult(p.result); },
      onCancelled: () => setJob((j) => ({ ...j, state: "cancelled" })),
      onError: (p) => { setJob((j) => ({ ...j, state: "error" })); setError(p.message); },
    });
    return unsub;
  }, []);

  async function run() {
    setError(null); setResult(null);
    setJob({ state: "starting", epoch: 0, total_epochs: params.epochs });
    try {
      await startModelBench({
        symbol, timeframe,
        start_time: dateStrToEpoch(range.start), end_time: dateStrToEpoch(range.end, true),
        ...params,
      });
    } catch (e) { setError(e?.response?.data?.error || e.message); setJob({ state: "error" }); }
  }
  const running = job.state === "running" || job.state === "starting";

  return (
    <div className="space-y-5">
      <ParamsBar title="LSTM settings" fields={BENCH_FIELDS} params={params}
        onChange={setParams} onReset={() => setParams(BENCH_DEFAULTS)}
        hint="A real PyTorch LSTM trained to predict the next move, with a time-ordered train/val/test split. Requires torch installed on the backend." />

      <div className="flex items-center gap-3">
        <button onClick={run} disabled={!canRun || running}
          className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-medium shadow disabled:opacity-40">
          {running ? "Training…" : "Train LSTM"}
        </button>
        {running && (
          <button onClick={() => cancelModelBench()} className="px-3 py-1.5 rounded-md border border-line text-sm text-muted hover:text-loss hover:border-loss/50">
            Cancel
          </button>
        )}
        {running && job.total_epochs > 0 && (
          <span className="text-xs font-mono text-muted">
            epoch {job.epoch}/{job.total_epochs}
            {job.train_loss != null && ` · train loss ${fmtNum(job.train_loss)}`}
            {job.val_loss != null && ` · val loss ${fmtNum(job.val_loss)}`}
          </span>
        )}
      </div>

      {running && job.total_epochs > 0 && (
        <div className="h-2 rounded bg-bg-elev/60 overflow-hidden">
          <div className="h-full bg-accent-grad transition-all" style={{ width: `${(100 * (job.epoch || 0) / job.total_epochs).toFixed(0)}%` }} />
        </div>
      )}

      {error && <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>}

      {!result && !running && !error && (
        <EmptyState loading={false} text="Set the LSTM parameters and click Train LSTM. (Trains in the background — progress shows above.)" />
      )}

      {result && <BenchResult result={result} />}
    </div>
  );
}

function BenchResult({ result }) {
  const baseline = result.baseline_accuracy;
  const lstm = (result.models || []).find((m) => m.name === "LSTM") || {};
  const goodGap = lstm.overfit_gap != null && lstm.overfit_gap < 0.1;
  const beatsBaseline = lstm.test_accuracy != null && baseline != null && lstm.test_accuracy > baseline + 0.01;
  const pctv = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="LSTM test acc" value={pctv(lstm.test_accuracy)} sub={`baseline ${pctv(baseline)}`} positive={beatsBaseline} />
        <KpiCard title="Test AUC" value={lstm.test_auc == null ? "—" : fmtNum(lstm.test_auc)} />
        <KpiCard title="Train acc" value={pctv(lstm.train_accuracy)} sub={`val ${pctv(lstm.val_accuracy)}`} />
        <KpiCard title="Overfit gap" value={lstm.overfit_gap == null ? "—" : pctv(lstm.overfit_gap)} sub="train − test" positive={goodGap} />
      </div>

      <div className={`rounded-md border px-4 py-3 text-sm ${beatsBaseline && goodGap
        ? "border-profit/40 bg-profit/5 text-profit" : "border-amber-400/40 bg-amber-400/5 text-amber-300"}`}>
        {beatsBaseline
          ? "The LSTM beats the majority-class baseline out-of-sample — investigate further (and watch the overfit gap)."
          : "Out-of-sample, the LSTM does not beat simply guessing the majority class. The high train accuracy is memorization, not edge — exactly the trap this bench exists to reveal."}
      </div>

      <Card title="Model comparison" hint="Train/val/test accuracy per model. The LSTM must beat both the baseline and the logistic regression to matter.">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
              <th className="py-1">Model</th><th>Train</th><th>Val</th><th>Test</th><th>Test AUC</th><th>Overfit gap</th>
            </tr>
          </thead>
          <tbody>
            {(result.models || []).map((m) => (
              <tr key={m.name} className="border-t border-line/50">
                <td className="py-1.5">{m.name}</td>
                <td className="text-muted">{pctv(m.train_accuracy)}</td>
                <td className="text-muted">{pctv(m.val_accuracy)}</td>
                <td className={m.test_accuracy != null && baseline != null && m.test_accuracy > baseline ? "text-profit" : "text-text"}>{pctv(m.test_accuracy)}</td>
                <td className="text-muted">{m.test_auc == null ? "—" : fmtNum(m.test_auc)}</td>
                <td className={m.overfit_gap != null && m.overfit_gap >= 0.1 ? "text-loss" : "text-muted"}>{m.overfit_gap == null ? "—" : pctv(m.overfit_gap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-[11px] text-muted mt-2">
          {result.n_train?.toLocaleString()} train · {result.n_val?.toLocaleString()} val · {result.n_test?.toLocaleString()} test sequences · {result.features?.length} features
        </div>
      </Card>

      <p className="text-[11px] text-muted">{result.caveat}</p>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Feature Importance tab
// --------------------------------------------------------------------------- //
function FeaturesTab({ data, loading }) {
  if (!data) return <EmptyState loading={loading} text="Pick a symbol and click Run Analysis. (Trains a model — a few seconds.)" />;
  const s = data.scores || {};
  const gap = (s.train_accuracy != null && s.test_accuracy != null) ? s.train_accuracy - s.test_accuracy : null;
  const edge = s.test_minus_baseline;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Test vs baseline" value={edge == null ? "—" : `${(edge * 100).toFixed(2)}%`}
          sub="the honest signal" positive={edge != null ? edge > 0.005 : null} />
        <KpiCard title="Test accuracy" value={s.test_accuracy == null ? "—" : `${(s.test_accuracy * 100).toFixed(1)}%`}
          sub={`baseline ${s.baseline_accuracy == null ? "—" : (s.baseline_accuracy * 100).toFixed(1) + "%"}`} />
        <KpiCard title="Train accuracy" value={s.train_accuracy == null ? "—" : `${(s.train_accuracy * 100).toFixed(1)}%`} />
        <KpiCard title="Overfit gap" value={gap == null ? "—" : `${(gap * 100).toFixed(1)}%`}
          sub="train − test" positive={gap != null ? gap < 0.05 : null} />
      </div>

      <div className={`rounded-md border px-4 py-3 text-sm ${edge != null && edge > 0.005
        ? "border-profit/40 bg-profit/5 text-profit" : "border-amber-400/40 bg-amber-400/5 text-amber-300"}`}>
        {edge != null && edge > 0.005
          ? "These features carry some out-of-sample predictive signal — worth exploring further."
          : "Out-of-sample, the model barely beats guessing the majority class. The features rank below, but treat any 'edge' as in-sample structure, not a tradeable signal."}
      </div>

      <Card title="Feature importance (permutation, held-out)" hint="How much test accuracy drops when each feature is shuffled. Higher = more predictive out-of-sample.">
        <VBarChart bars={(data.importances || []).map((f) => ({ label: f.feature, value: f.importance }))}
          colorMode="fixed" color="#60a5fa" height={Math.max(180, (data.importances || []).length * 22)} fmt={(x) => x.toFixed(4)} />
      </Card>

      <p className="text-[11px] text-muted">{data.meta?.caveat}</p>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Pattern Finder tab
// --------------------------------------------------------------------------- //
function PatternsTab({ data, loading }) {
  if (!data) return <EmptyState loading={loading} text="Pick a symbol and click Run Analysis. (Clusters candle shapes — a few seconds.)" />;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Clusters" value={fmtInt(data.k)} />
        <KpiCard title="Window" value={`${data.window_len} bars`} />
        <KpiCard title="Forward horizon" value={`${data.fwd_horizon} bars`} />
        <KpiCard title="Baseline drift" value={pct(data.drift_pct)} />
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(data.clusters || []).map((c) => (
          <div key={c.id} className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Cluster {c.id}</div>
              <SigBadge sig={c.significance} />
            </div>
            <CentroidShape shape={c.centroid} height={56} color={c.edge_vs_drift_pct >= 0 ? "#22c55e" : "#ef4444"} />
            <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
              <div><div className="text-muted">edge</div><div className={signClass(c.edge_vs_drift_pct)}>{pct(c.edge_vs_drift_pct)}</div></div>
              <div><div className="text-muted">win</div><div>{c.win_rate == null ? "—" : `${fmtNum(c.win_rate)}%`}</div></div>
              <div><div className="text-muted">freq</div><div>{fmtNum(c.frequency_pct)}%</div></div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted">{data.meta?.caveat}</p>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Similarity Search tab
// --------------------------------------------------------------------------- //
function SimilarityTab({ data, loading }) {
  if (!data) return <EmptyState loading={loading} text="Pick a symbol and click Run Analysis." />;
  const a = data.aggregate || {};
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Neighbors" value={fmtInt(a.n)} />
        <KpiCard title="Avg outcome" value={pct(a.avg_fwd_return_pct)} positive={a.avg_fwd_return_pct >= 0} sub={`next ${data.fwd_horizon} bars`} />
        <KpiCard title="Win rate" value={a.win_rate == null ? "—" : `${fmtNum(a.win_rate)}%`} />
        <KpiCard title="Significance" value={a.significance || "—"} />
      </div>

      <Card title="Today's shape vs its closest historical matches" hint="Dashed grey = the latest window; blue = the nearest neighbor's shape.">
        <CentroidShape shape={data.neighbors?.[0]?.shape || []} overlay={data.query_shape} height={80} />
      </Card>

      <Card title="Nearest neighbors" hint="Each is a past window most like now, with what happened next.">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted text-left">
              <th className="py-1">When (UTC)</th><th>Distance</th><th className="text-right">Next-window return</th>
            </tr>
          </thead>
          <tbody>
            {(data.neighbors || []).slice(0, 15).map((nb, i) => (
              <tr key={i} className="border-t border-line/50">
                <td className="py-1.5 font-mono text-xs">{new Date(nb.end_time * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className="text-muted font-mono">{fmtNum(nb.distance)}</td>
                <td className={`text-right ${signClass(nb.fwd_return_pct)}`}>{pct(nb.fwd_return_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-[11px] text-muted">{data.meta?.caveat}</p>
    </div>
  );
}

const REGIME_LABELS_FE = ["Trending Up", "Trending Down", "High-Volatility", "Quiet", "Choppy-Range"];

function SavePresetModal({ open, onClose, symbol, scanParams, regimeParams, defaultAllowed, defaultSides }) {
  const [name, setName] = useState("");
  const [allowed, setAllowed] = useState(defaultAllowed);
  const [sides, setSides] = useState(defaultSides);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (open) { setAllowed(defaultAllowed); setSides(defaultSides); setMsg(null); setName(`${symbol || "MR"} regime-filtered`); } }, [open]); // eslint-disable-line
  if (!open) return null;

  async function save() {
    if (!name.trim()) { setMsg({ tone: "err", text: "Give the preset a name." }); return; }
    setBusy(true); setMsg(null);
    try {
      const existing = await getPresets("vwma_reversion");   // read
      const preset = {
        vwma_length: scanParams.vwma_length,
        z_threshold: scanParams.z_threshold,
        rsi_length: scanParams.rsi_length,
        rsi_long_max: scanParams.rsi_long_max,
        rsi_short_min: scanParams.rsi_short_min,
        sides,
        use_regime: true,
        use_five_regime: true,
        allowed_regimes: allowed,
        regime_adx_period: regimeParams.adx_period,
        regime_adx_threshold: regimeParams.adx_trend_thresh,
      };
      await savePresets("vwma_reversion", { ...(existing || {}), [name.trim()]: preset }); // read-modify-write
      setMsg({ tone: "ok", text: `Saved "${name.trim()}" → open VWMA Reversion in the dashboard to load it.` });
    } catch (e) {
      setMsg({ tone: "err", text: e?.response?.data?.error || e.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[460px] max-w-[92vw] rounded-xl border border-line bg-bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-line">
          <h3 className="text-base font-semibold">Save as VWMA Reversion preset</h3>
          <p className="text-[11px] text-muted mt-0.5">Writes a server preset (git-trackable). Load it from the strategy's settings to backtest or run live.</p>
        </div>
        <div className="px-5 py-4 space-y-4 text-sm">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-muted">Preset name</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue" />
          </label>
          <div>
            <span className="text-[11px] uppercase tracking-wider text-muted">Allowed regimes (pre-filled from significant edge)</span>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {REGIME_LABELS_FE.map((lab) => (
                <label key={lab} className="flex items-center gap-2 text-xs" style={{ color: REGIME_COLORS[lab] }}>
                  <input type="checkbox" checked={!!allowed[lab]}
                    onChange={(e) => setAllowed({ ...allowed, [lab]: e.target.checked })} className="accent-accent-blue" />
                  {lab}
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[11px] uppercase tracking-wider text-muted">Sides</span>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={sides.long} onChange={(e) => setSides({ ...sides, long: e.target.checked })} className="accent-accent-blue" /> Long
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={sides.short} onChange={(e) => setSides({ ...sides, short: e.target.checked })} className="accent-accent-blue" /> Short
            </label>
          </div>
          {msg && <div className={`text-xs ${msg.tone === "ok" ? "text-profit" : "text-loss"}`}>{msg.text}</div>}
        </div>
        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md text-muted hover:text-text">Close</button>
          <button onClick={save} disabled={busy}
            className="px-4 py-2 text-sm rounded-md font-medium text-white bg-accent-grad disabled:opacity-40">
            {busy ? "Saving…" : "Save preset"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- small helpers ----
function short(regime) {
  return { "Trending Up": "Trend↑", "Trending Down": "Trend↓", "High-Volatility": "High-Vol", "Quiet": "Quiet", "Choppy-Range": "Choppy" }[regime] || regime;
}
function signClass(v) {
  if (v == null) return "text-muted";
  return v >= 0 ? "text-profit" : "text-loss";
}
function tone(regime) {
  if (regime === "Trending Up") return "profit";
  if (regime === "Trending Down") return "loss";
  return "neutral";
}
function avgDuration(transitions) {
  const d = transitions?.avg_duration_bars || {};
  const vals = Object.values(d).filter((x) => x != null);
  if (!vals.length) return "—";
  return fmtNum(vals.reduce((a, b) => a + b, 0) / vals.length);
}
