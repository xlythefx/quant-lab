import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import SymbolSelector from "../components/SymbolSelector.jsx";
import TimeframeSelector from "../components/TimeframeSelector.jsx";
import DateRangePicker from "../components/DateRangePicker.jsx";
import MCStrategyPicker from "../components/MCStrategyPicker.jsx";
import { fmtUsd, fmtNum, fmtPct, fmtInt } from "../services/format.js";
import {
  runMonteCarlo, aiAnalyzeMonteCarlo, getSymbols, getStrategies,
} from "../services/api.js";
import { TabBar, KpiCard } from "../components/analytics/primitives.jsx";

function getTabFromHash() {
  const m = window.location.hash.match(/tab=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "setup";
}

function setTabInHash(t) {
  const hash = window.location.hash;
  const stripped = hash.replace(/[?&]tab=[^&]*/g, "");
  const sep = stripped.includes("?") ? "&" : "?";
  window.location.hash = `${stripped || "#montecarlo"}${sep}tab=${encodeURIComponent(t)}`;
}

function isoToEpochSec(iso) {
  if (!iso) return null;
  const t = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

const MC_METHODS = [
  { id: "trade_bootstrap", label: "Trade-order bootstrap",
    blurb: "Resamples the order of THIS run's trades. Answers: how much of the equity curve was the luck of trade sequencing?" },
  { id: "block_bootstrap", label: "Block bootstrap (returns)",
    blurb: "Resamples per-bar equity returns in blocks (preserves short-term autocorrelation). Path-dependent risk distribution." },
  { id: "synthetic", label: "Synthetic price paths",
    blurb: "Bootstraps OHLC bar structure to build synthetic price series, re-runs the strategy on each. Tests robustness — slowest." },
];

const TABS = [
  { id: "setup",        label: "Setup" },
  { id: "distribution", label: "Distribution" },
  { id: "paths",        label: "Paths" },
  { id: "drawdown",     label: "Drawdown" },
  { id: "sharpe",       label: "Sharpe" },
  { id: "ai",           label: "AI Analysis" },
];

export default function MonteCarlo() {
  const [tab, setTab] = useState(getTabFromHash());
  useEffect(() => {
    const onHash = () => setTab(getTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Setup state — Monte Carlo is now standalone (no Dashboard dependency).
  const [symbolList, setSymbolList] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [symbol, setSymbol] = useState(null);
  const [timeframe, setTimeframe] = useState("15m");
  const [strategies, setStrategies] = useState([]);   // [{id, params}]
  const [dateRange, setDateRange] = useState({ start: "", end: "" });

  const [method, setMethod] = useState("trade_bootstrap");
  const [nSims, setNSims] = useState(1000);
  const [blockSize, setBlockSize] = useState("");
  const [seed, setSeed] = useState(42);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mc, setMc] = useState(null);

  const onTab = (id) => { setTabInHash(id); setTab(id); };

  // Load symbol catalog + strategy catalog.
  useEffect(() => {
    getSymbols().then((d) => { setSymbolList(d.symbols || []); setDatasets(d.datasets || []); })
                .catch(() => {});
    getStrategies().then(setCatalog).catch(() => {});
  }, []);

  // When a run completes, auto-flip from Setup to Distribution.
  const lastMcRef = useRef(null);
  useEffect(() => {
    if (mc && mc !== lastMcRef.current && tab === "setup") onTab("distribution");
    lastMcRef.current = mc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mc]);

  const canRun = !!symbol && !!timeframe && strategies.length > 0 && !loading;

  async function onRun() {
    if (!canRun) return;
    setLoading(true); setError(null);
    try {
      const payload = {
        strategies: strategies.map((s, i) => ({
          strategy_id: s.id, symbol, timeframe,
          params: s.params, priority: i + 1,
        })),
        start_time: isoToEpochSec(dateRange.start),
        end_time:   isoToEpochSec(dateRange.end),
        method,
        n_sims: Number(nSims) || 1000,
        block_size: blockSize === "" ? undefined : Number(blockSize),
        seed: Number(seed) || 42,
      };
      const data = await runMonteCarlo(payload);
      setMc(data);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || "MC run failed");
    } finally {
      setLoading(false);
    }
  }

  const tabs = useMemo(
    () => TABS.map((t) => ({ ...t, disabled: t.id !== "setup" && !mc })),
    [mc],
  );

  // Header context line — shows the MC config when a run is loaded.
  const subtitle = mc
    ? `${mc.is_portfolio ? `Portfolio · ${mc.strategies.length} strategies` : `${mc.strategies?.[0]?.strategy_id || "single"}`}`
      + ` · ${mc.strategies?.[0]?.symbol || ""} · ${mc.strategies?.[0]?.timeframe || ""}`
      + ` · ${mc.method} · ${mc.n_sims} sims`
    : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="montecarlo" />

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Monte Carlo</h1>
            {subtitle && (
              <div className="text-xs text-muted font-mono mt-0.5">{subtitle}</div>
            )}
          </div>
          <a href="#dashboard" className="text-xs text-accent-blue hover:underline">← Dashboard</a>
        </header>

        <TabBar tabs={tabs} active={tab} onSelect={onTab} />

        {tab === "setup" && (
          <SetupTab
            symbolList={symbolList} datasets={datasets} catalog={catalog}
            symbol={symbol} setSymbol={setSymbol}
            timeframe={timeframe} setTimeframe={setTimeframe}
            strategies={strategies} setStrategies={setStrategies}
            dateRange={dateRange} setDateRange={setDateRange}
            method={method} setMethod={setMethod}
            nSims={nSims} setNSims={setNSims}
            blockSize={blockSize} setBlockSize={setBlockSize}
            seed={seed} setSeed={setSeed}
            onRun={onRun} loading={loading} error={error}
            canRun={canRun} mc={mc}
          />
        )}
        {tab === "distribution" && mc && <DistributionTab mc={mc} />}
        {tab === "paths"        && mc && <PathsTab mc={mc} />}
        {tab === "drawdown"     && mc && <DrawdownTab mc={mc} />}
        {tab === "sharpe"       && mc && <SharpeTab mc={mc} />}
        {tab === "ai"           && mc && <AITab mc={mc} />}

        {!mc && tab !== "setup" && (
          <div className="rounded-xl border border-line bg-bg-panel/60 p-10 text-center text-muted">
            <div className="text-base text-text mb-1">No Monte Carlo run yet</div>
            <div className="text-xs">Configure the Setup tab and click Run.</div>
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
  );
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------

function SetupTab({
  symbolList, datasets, catalog,
  symbol, setSymbol, timeframe, setTimeframe,
  strategies, setStrategies, dateRange, setDateRange,
  method, setMethod, nSims, setNSims, blockSize, setBlockSize, seed, setSeed,
  onRun, loading, error, canRun, mc,
}) {
  const portfolioCap   = 50;
  const singleCap      = 200;
  const isPortfolio    = strategies.length >= 2;
  const effNSimsCap    = method === "synthetic" ? (isPortfolio ? portfolioCap : singleCap) : (Number(nSims) || 1000);
  const cappedNSims    = method === "synthetic" ? Math.min(Number(nSims) || 1000, effNSimsCap) : (Number(nSims) || 1000);
  const methodDef      = MC_METHODS.find((m) => m.id === method);

  return (
    <div className="space-y-4">
      {/* ---- Market + date range ---- */}
      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">Market</div>
        <div className="flex flex-wrap items-center gap-4">
          <SymbolSelector value={symbol} options={symbolList} datasets={datasets} onChange={setSymbol} />
          <TimeframeSelector value={timeframe} onChange={setTimeframe} />
          <DateRangePicker start={dateRange.start} end={dateRange.end} onChange={setDateRange} />
        </div>
      </div>

      {/* ---- Strategies (the basket) ---- */}
      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            Strategies {strategies.length > 0 && <span className="text-text">({strategies.length})</span>}
          </div>
          <div className="text-[10px] text-muted">
            {isPortfolio
              ? "Portfolio mode — shared cash pool, priority by order"
              : "Single-strategy mode — pick more to run a portfolio MC"}
          </div>
        </div>
        <MCStrategyPicker catalog={catalog} strategies={strategies} onChange={setStrategies} />
      </div>

      {/* ---- Method + sim settings ---- */}
      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[260px]">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Method</div>
            <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-elev/30">
              {MC_METHODS.map((m) => (
                <button key={m.id} onClick={() => setMethod(m.id)}
                  className={`px-3 py-1.5 text-xs rounded-md transition flex-1 ${method === m.id ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <NumField label="Simulations" value={nSims} onChange={setNSims} step={100} min={10} />
          {method !== "trade_bootstrap" && (
            <NumField label="Block size (blank=auto)" value={blockSize} onChange={setBlockSize}
                       step={1} min={1} placeholder="auto" />
          )}
          <NumField label="Seed" value={seed} onChange={setSeed} step={1} />

          <button onClick={onRun} disabled={!canRun}
            className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50">
            {loading ? "Running…" : (mc ? "Re-run" : "Run")}
          </button>
        </div>
        <div className="text-xs text-muted">{methodDef.blurb}</div>
        {method === "synthetic" && cappedNSims < (Number(nSims) || 0) && (
          <div className="text-xs text-amber-400/80">
            Synthetic re-runs the {isPortfolio ? "portfolio runner" : "engine"} per path
            {isPortfolio && ` (${strategies.length} strategies per path)`} —
            capped at {cappedNSims} sims.
          </div>
        )}
        {method === "synthetic" && isPortfolio && (
          <div className="text-[11px] text-amber-400/70">
            All strategies must share the same (symbol, timeframe). Backend will reject
            mixed-symbol baskets in synthetic mode.
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-loss/40 bg-loss/5 p-3 text-sm text-loss">{error}</div>
      )}

      {!mc && !loading && !error && (
        <div className="rounded-xl border border-line bg-bg-panel/40 p-6 text-center text-muted text-sm">
          {!symbol
            ? "Pick a symbol to begin."
            : strategies.length === 0
              ? "Add at least one strategy to run."
              : <>Click <span className="text-text">Run</span> to simulate
                  {" "}{Number(nSims) || 1000}× variations of
                  {" "}{isPortfolio ? `this ${strategies.length}-strategy basket` : "this strategy"}.</>
          }
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DISTRIBUTION — Verdict + Interpretation + KPI strip + 3 histograms
// ---------------------------------------------------------------------------

function DistributionTab({ mc }) {
  const sc = mc.starting_capital;
  const dist = mc.distribution || {};
  const fe = dist.final_equity || {};
  const ret = dist.total_return_pct || {};
  const dd = dist.max_drawdown_pct || {};
  const sharpe = dist.sharpe || {};
  const orig = mc.original || {};

  return (
    <div className="space-y-4">
      <MCVerdict mc={mc} />
      <MCInterpretation mc={mc} />

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KpiCard title="Prob. of profit" value={`${fmtNum(mc.prob_profit * 100)}%`}
                 sub={`${fmtInt(mc.n_sims)} sims`} positive={mc.prob_profit >= 0.5} />
        <KpiCard title="Prob. of ruin" value={`${fmtNum(mc.prob_ruin * 100)}%`}
                 sub="equity ≤ 0" positive={mc.prob_ruin <= 0.01} />
        <KpiCard title="Median final" value={fmtUsd(fe.p50)}
                 sub={`p05 ${fmtUsd(fe.p05)} · p95 ${fmtUsd(fe.p95)}`} />
        <KpiCard title="Median return" value={`${fmtNum(ret.p50)}%`}
                 sub={`p05 ${fmtNum(ret.p05)}% · p95 ${fmtNum(ret.p95)}%`}
                 positive={(ret.p50 || 0) >= 0} />
        <KpiCard title="Median max DD" value={`${fmtNum(dd.p50)}%`}
                 sub={`p05 ${fmtNum(dd.p05)}% · p95 ${fmtNum(dd.p95)}%`} positive={false} />
        <KpiCard title="Median Sharpe" value={fmtNum(sharpe.p50)}
                 sub={`p05 ${fmtNum(sharpe.p05)} · p95 ${fmtNum(sharpe.p95)}`}
                 positive={(sharpe.p50 || 0) >= 1} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <HistPanel title="Final equity ($)" dist={fe} unit="usd" original={orig.final_equity} />
        <HistPanel title="Total return (%)" dist={ret} unit="pct" original={orig.total_return_pct} />
        <HistPanel title="Max drawdown (%)" dist={dd} unit="pct" original={orig.max_drawdown_pct} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PATHS — fan chart + path rankings
// ---------------------------------------------------------------------------

function PathsTab({ mc }) {
  return (
    <div className="space-y-4">
      <FanChart mc={mc} startingCapital={mc.starting_capital} />
      <PathRankings mc={mc} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DRAWDOWN — DD histogram (Phase C.7 adds tail probabilities)
// ---------------------------------------------------------------------------

function DrawdownTab({ mc }) {
  const dist = mc.distribution || {};
  const dd = dist.max_drawdown_pct || {};
  const orig = mc.original || {};
  const hist = dd.histogram || [];
  const total = hist.reduce((s, b) => s + (b.count || 0), 0);

  // Tail probability P[max DD ≤ threshold] — DD is negative, so "≤ -10" = worse than 10% drawdown.
  const tailProb = (threshold) => {
    if (!total) return null;
    let n = 0;
    for (const b of hist) {
      // bin midpoint
      const mid = (b.bin_lo + b.bin_hi) / 2;
      if (mid <= threshold) n += b.count || 0;
    }
    return n / total;
  };
  const thresholds = [-10, -20, -30, -50];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {thresholds.map((t) => {
          const p = tailProb(t);
          return (
            <KpiCard
              key={t}
              title={`P[DD ≥ ${Math.abs(t)}%]`}
              value={p == null ? "—" : `${fmtNum(p * 100)}%`}
              sub={`prob. max DD reaches ${t}% or worse`}
              positive={p == null ? null : p < 0.05}
            />
          );
        })}
      </div>

      <HistPanel title="Max drawdown across simulations (%)" dist={dd} unit="pct" original={orig.max_drawdown_pct} />

      <div className="rounded-xl border border-line bg-bg-panel/40 p-4 text-xs text-muted">
        Tail probabilities are computed from the histogram bin counts. P[DD ≥ X%] = fraction of simulated paths
        whose worst drawdown reached X% or worse. Useful for stop-out sizing — if P[DD ≥ 30%] is 8%, expect
        a 30%+ drawdown roughly 1 in 12 hypothetical scenarios.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SHARPE — Sharpe histogram (Phase C.7 adds t-score vs null)
// ---------------------------------------------------------------------------

function SharpeTab({ mc }) {
  const dist = mc.distribution || {};
  const sharpe = dist.sharpe || {};
  const orig = mc.original || {};
  const nSims = mc.n_sims || 0;

  // t-statistic for "is the mean simulated Sharpe significantly > 0?"
  // Approximate with mean / SE. SE = std / sqrt(n).
  const mean = sharpe.mean;
  const std = sharpe.std;
  const tScore = (mean != null && std != null && std > 0 && nSims > 0)
    ? (mean / (std / Math.sqrt(nSims)))
    : null;
  // For large n the t-distribution → normal; 1.96 ≈ 95% one-sided 97.5%.
  // Reporting one-sided: H1 = Sharpe > 0.
  const oneSidedP = tScore == null ? null : approxOneSidedP(tScore);

  // Fraction of simulated Sharpes that beat zero.
  const hist = sharpe.histogram || [];
  const total = hist.reduce((s, b) => s + (b.count || 0), 0);
  let aboveZero = 0;
  for (const b of hist) {
    const mid = (b.bin_lo + b.bin_hi) / 2;
    if (mid > 0) aboveZero += b.count || 0;
  }
  const fracAboveZero = total > 0 ? aboveZero / total : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Mean Sharpe" value={fmtNum(mean)}
                 sub={`σ ${fmtNum(std)} · n ${fmtInt(nSims)}`}
                 positive={mean != null ? mean >= 1 : null} />
        <KpiCard title="t-score vs 0" value={tScore == null ? "—" : fmtNum(tScore)}
                 sub="mean / (std / √n)"
                 positive={tScore != null ? tScore >= 2 : null} />
        <KpiCard title="One-sided p" value={oneSidedP == null ? "—" : oneSidedP < 1e-4 ? "<0.0001" : fmtNum(oneSidedP)}
                 sub="P(mean Sharpe ≤ 0)"
                 positive={oneSidedP != null ? oneSidedP < 0.05 : null} />
        <KpiCard title="Paths with Sharpe>0" value={fracAboveZero == null ? "—" : `${fmtNum(fracAboveZero * 100)}%`}
                 sub="fraction above zero"
                 positive={fracAboveZero != null ? fracAboveZero >= 0.75 : null} />
      </div>

      <HistPanel title="Sharpe across simulations" dist={sharpe} unit="num" original={orig.sharpe} />

      <div className="rounded-xl border border-line bg-bg-panel/40 p-4 text-xs text-muted">
        The t-score treats the simulated Sharpes as a sample drawn from some underlying distribution and
        tests whether the mean is statistically distinguishable from zero. A t-score above ~2 (one-sided p &lt; 0.025)
        is the conventional significance bar. Caveat: simulations under the SAME strategy are not independent
        — interpret with care, not as a hard rejection criterion.
      </div>
    </div>
  );
}

// Cheap normal-approx survival function — good enough for big simulated samples.
function approxOneSidedP(z) {
  if (z >= 6) return 1e-9;
  if (z <= -6) return 1 - 1e-9;
  // Abramowitz & Stegun 26.2.17 approximation (4-decimal accuracy).
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const phi = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-(z * z) / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdfPositive = 1 - phi * poly;
  return z >= 0 ? 1 - cdfPositive : cdfPositive;
}

// ---------------------------------------------------------------------------
// AI — Claude analysis
// ---------------------------------------------------------------------------

function AITab({ mc }) {
  return (
    <AIInsightsPanel
      label="AI Analysis"
      contextHint="Claude interprets robustness, tail risk, and what this MC method can (and can't) tell you."
      fetcher={() => aiAnalyzeMonteCarlo(mc)}
    />
  );
}

// ===========================================================================
// MC-specific widgets (kept inline since they're not used outside this page)
// ===========================================================================

function AIInsightsPanel({ fetcher, label, contextHint }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  async function onRun() {
    setLoading(true); setErr(null);
    try {
      setData(await fetcher());
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
          <div className="text-xs text-muted mt-0.5">{contextHint}</div>
        </div>
        <button onClick={onRun} disabled={loading}
          className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50">
          {loading ? "Analyzing…" : (data ? `Re-run ${label}` : `Run ${label}`)}
        </button>
      </div>

      {err && <div className="text-sm text-loss font-mono">{err}</div>}
      {loading && (
        <div className="text-xs text-muted font-mono">
          Claude Haiku is analyzing — usually 5–10s…
        </div>
      )}
      {data?.text && (
        <div className="space-y-2 text-sm text-text leading-relaxed whitespace-pre-wrap">
          {data.text}
        </div>
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

function NumField({ label, value, onChange, step = 1, min, placeholder }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{label}</div>
      <input type="number" step={step} min={min} placeholder={placeholder}
        value={value} onChange={(e) => onChange(e.target.value)}
        className="w-28 px-2 py-1.5 text-sm font-mono bg-bg-elev/30 border border-line rounded-md focus:border-accent-blue outline-none" />
    </div>
  );
}

function MCVerdict({ mc }) {
  const dist = mc.distribution || {};
  const ret = dist.total_return_pct || {};
  const dd  = dist.max_drawdown_pct || {};
  const orig = mc.original || {};

  const probProfit = mc.prob_profit ?? 0;
  const probRuin   = mc.prob_ruin   ?? 0;
  const p05Ret     = ret.p05 ?? 0;
  const p95Ret     = ret.p95 ?? 0;
  const p50Ret     = ret.p50 ?? 0;
  const p05DD      = dd.p05 ?? 0;
  const origRet    = orig.total_return_pct ?? 0;

  let origPercentile = null;
  if (ret.p95 != null && ret.p05 != null && ret.p95 !== ret.p05) {
    const span = (origRet - ret.p05) / (ret.p95 - ret.p05);
    origPercentile = Math.max(0, Math.min(1, span)) * 100;
  }

  let score = 0;
  if (probProfit >= 0.9) score += 3; else if (probProfit >= 0.75) score += 2; else if (probProfit >= 0.55) score += 1;
  if (probRuin <= 0.001) score += 2; else if (probRuin <= 0.01) score += 1; else if (probRuin > 0.05) score -= 2;
  if (p05Ret >= 0) score += 2; else if (p05Ret >= -10) score += 1;
  if (p50Ret >= 25) score += 1;
  if (Math.abs(p05DD) <= 15) score += 1;

  let tier, tone, label;
  if (score >= 7)      { tier = "Robust";   tone = "profit"; label = "🟢 Edge survives resampling — strong robustness"; }
  else if (score >= 4) { tier = "Decent";   tone = "profit"; label = "🟡 Edge holds in most scenarios — workable"; }
  else if (score >= 1) { tier = "Fragile";  tone = "amber";  label = "🟠 Edge sensitive to trade order / sequencing"; }
  else                 { tier = "Risky";    tone = "loss";   label = "🔴 Result is mostly luck — high tail risk"; }

  const lines = [
    `${fmtNum(probProfit * 100)}% prob profit`,
    `${fmtNum(probRuin * 100)}% prob ruin`,
    `worst-5% return ${fmtPct(p05Ret)}`,
    `worst-5% DD ${fmtPct(p05DD, false)}`,
  ];

  const toneClasses = {
    profit: "border-profit/40 bg-profit/5 text-profit",
    amber:  "border-amber-400/40 bg-amber-400/5 text-amber-400",
    loss:   "border-loss/40 bg-loss/5 text-loss",
  };

  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone]}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-70">MC Verdict · {tier}</div>
          <div className="text-base font-semibold mt-0.5">{label}</div>
        </div>
        <div className="text-xs font-mono opacity-90">{lines.join(" · ")}</div>
      </div>
      {origPercentile != null && (
        <div className="text-[11px] font-mono opacity-75 mt-2 pt-2 border-t border-current/20">
          Your original backtest ({fmtPct(origRet)}) sits at the
          <span className="font-bold"> {fmtNum(origPercentile)}th percentile </span>
          of simulated paths — {origPercentile >= 75 ? "above average (possibly luck-favored)"
            : origPercentile >= 25 ? "typical for this distribution"
            : "below average (possibly unlucky)"}.
        </div>
      )}
    </div>
  );
}

function MCInterpretation({ mc }) {
  const dist = mc.distribution || {};
  const ret = dist.total_return_pct || {};
  const dd  = dist.max_drawdown_pct || {};
  const fe  = dist.final_equity || {};

  const items = [
    {
      label: "Best 5% of paths",
      icon: "🏆",
      text: `Returns ≥ ${fmtPct(ret.p95)} — best case, equity reaches ${fmtUsd(fe.p95)}.`,
      tone: "text-profit",
    },
    {
      label: "Median outcome",
      icon: "⚖",
      text: `Returns ${fmtPct(ret.p50)} — typical case, equity ${fmtUsd(fe.p50)} with ${fmtPct(dd.p50, false)} drawdown.`,
      tone: "text-text",
    },
    {
      label: "Worst 5% of paths",
      icon: "📉",
      text: `Returns ≤ ${fmtPct(ret.p05)} and drawdown of ${fmtPct(dd.p05, false)} — plan for this scenario.`,
      tone: "text-loss",
    },
  ];

  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">How to read this</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {items.map((it) => (
          <div key={it.label} className="space-y-0.5">
            <div className={`text-xs font-semibold ${it.tone}`}>{it.icon} {it.label}</div>
            <div className="text-[11px] text-muted leading-relaxed">{it.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PathRankings({ mc }) {
  const paths = mc.paths || [];
  const sc = mc.starting_capital;
  const rankings = useMemo(() => {
    if (paths.length < 3) return null;
    const scored = paths.map((p, i) => {
      const final = p[p.length - 1]?.equity ?? sc;
      let peak = -Infinity, maxDD = 0;
      for (const pt of p) {
        if (pt.equity > peak) peak = pt.equity;
        const ddPct = peak > 0 ? (pt.equity - peak) / peak * 100 : 0;
        if (ddPct < maxDD) maxDD = ddPct;
      }
      const ret = sc > 0 ? (final / sc - 1) * 100 : 0;
      return { idx: i, final, ret, maxDD };
    }).sort((a, b) => b.ret - a.ret);
    return {
      best: scored[0],
      median: scored[Math.floor(scored.length / 2)],
      worst: scored[scored.length - 1],
    };
  }, [paths, sc]);

  if (!rankings) return null;

  const cards = [
    { ...rankings.best,   label: "🏆 Luckiest path",   tone: "profit", hint: "best return out of sampled paths" },
    { ...rankings.median, label: "⚖ Typical path",    tone: "text",   hint: "median return — most realistic" },
    { ...rankings.worst,  label: "📉 Unluckiest path", tone: "loss",   hint: "worst return — your stress test" },
  ];

  const toneOf = (t) => t === "profit" ? "text-profit" : t === "loss" ? "text-loss" : "text-text";

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text">Path Rankings</div>
        <div className="text-xs text-muted">
          A spread of {paths.length} sampled equity paths — the gap between luckiest and unluckiest tells you how much sequencing matters.
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-md border border-line bg-bg-elev/30 p-3 space-y-1">
            <div className={`text-xs font-semibold ${toneOf(c.tone)}`}>{c.label}</div>
            <div className="text-[10px] text-muted">{c.hint}</div>
            <div className="text-xs font-mono mt-1">
              <div>final: <span className="text-text">{fmtUsd(c.final)}</span></div>
              <div>return: <span className={toneOf(c.ret >= 0 ? "profit" : "loss")}>{fmtPct(c.ret)}</span></div>
              <div>max DD: <span className="text-loss">{fmtPct(c.maxDD, false)}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FanChart({ mc, startingCapital }) {
  const measureRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 360 });
  const [animKey, setAnimKey] = useState(0);

  // Re-trigger draw animation whenever mc result changes.
  useEffect(() => { setAnimKey((k) => k + 1); }, [mc]);

  useEffect(() => {
    const el = measureRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 360 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const env = mc.envelopes || {};
  const p05 = env.p05 || [], p25 = env.p25 || [], p50 = env.p50 || [],
        p75 = env.p75 || [], p95 = env.p95 || [];

  if (p50.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        no Monte Carlo paths produced
      </div>
    );
  }

  const pad = { l: 64, r: 16, t: 12, b: 26 };
  const innerW = Math.max(1, size.w - pad.l - pad.r);
  const innerH = Math.max(1, size.h - pad.t - pad.b);

  const allX = p50.map((p) => p.x);
  const xMin = allX[0], xMax = allX[allX.length - 1];

  let yMin = Infinity, yMax = -Infinity;
  for (const series of [p05, p95, ...(mc.paths || [])]) {
    for (const pt of series) {
      if (pt.equity < yMin) yMin = pt.equity;
      if (pt.equity > yMax) yMax = pt.equity;
    }
  }
  if (!isFinite(yMin)) { yMin = startingCapital * 0.5; yMax = startingCapital * 1.5; }
  const yPad = (yMax - yMin) * 0.05 || startingCapital * 0.05;
  yMin -= yPad; yMax += yPad;

  const xOf = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * innerW;
  const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * innerH;

  const lineOf = (series) => series.map((p, i) =>
    `${i === 0 ? "M" : "L"}${xOf(p.x).toFixed(1)},${yOf(p.equity).toFixed(1)}`
  ).join("");

  const bandOf = (lo, hi) => {
    const up = lo.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.x).toFixed(1)},${yOf(p.equity).toFixed(1)}`).join("");
    const dn = hi.slice().reverse().map((p, i) => `L${xOf(p.x).toFixed(1)},${yOf(p.equity).toFixed(1)}`).join("");
    return `${up}${dn}Z`;
  };

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    return { v, y: yOf(v) };
  });
  const xLabelFor = (xv) => mc.x_label === "trade #"
    ? `#${xv}`
    : new Date(xv * 1000).toISOString().slice(0, 10);
  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const xv = xMin + ((xMax - xMin) * i) / 4;
    return { xv, x: xOf(xv), anchor: i === 0 ? "start" : i === 4 ? "end" : "middle" };
  });

  const paths = mc.paths || [];
  const n = Math.max(1, paths.length - 1);
  // Paths stagger from 0.25 s → 0.75 s; median draws last at 0.9 s.
  const pathDelay = (i) => (0.25 + (i / n) * 0.5).toFixed(2);

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-muted">
          Equity fan · {mc.method} · {mc.n_sims} sims
        </div>
        <div className="text-[10px] text-muted flex items-center gap-3 font-mono">
          <LegendSwatch color="rgba(59,130,246,0.15)" label="p05–p95" />
          <LegendSwatch color="rgba(59,130,246,0.3)" label="p25–p75" />
          <LegendSwatch color="#3b82f6" label="median" line />
        </div>
      </div>

      <div ref={measureRef} className="relative w-full">
        <div>
          <svg key={animKey} width={size.w} height={size.h} className="block">
            <defs>
              <style>{`
                @keyframes mc-draw {
                  from { stroke-dashoffset: 1; opacity: 0; }
                  to   { stroke-dashoffset: 0; opacity: 1; }
                }
                @keyframes mc-fade {
                  from { opacity: 0; }
                  to   { opacity: 1; }
                }
                @keyframes mc-glow {
                  0%   { filter: drop-shadow(0 0 0px #3b82f6); }
                  60%  { filter: drop-shadow(0 0 5px #3b82f6cc); }
                  100% { filter: drop-shadow(0 0 2px #3b82f680); }
                }
              `}</style>
              <linearGradient id="mc-band-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.08" />
              </linearGradient>
            </defs>

            <line x1={pad.l} x2={size.w - pad.r} y1={yOf(startingCapital)} y2={yOf(startingCapital)}
                  stroke="rgba(229,231,235,0.25)" strokeWidth="0.6" strokeDasharray="2 3"
                  style={{ animation: "mc-fade 0.3s ease-out 0.05s both" }} />

            {/* Bands — fade in first */}
            <path d={bandOf(p05, p95)} fill="url(#mc-band-grad)"
                  style={{ animation: "mc-fade 0.5s ease-out 0.05s both" }} />
            <path d={bandOf(p25, p75)} fill="rgba(59,130,246,0.22)"
                  style={{ animation: "mc-fade 0.5s ease-out 0.15s both" }} />

            {/* Individual paths — staggered draw left→right */}
            {paths.map((s, i) => (
              <path
                key={i}
                d={lineOf(s)}
                fill="none"
                stroke={`rgba(229,231,235,${0.13 + (i % 5) * 0.025})`}
                strokeWidth="0.6"
                pathLength="1"
                strokeDasharray="1"
                style={{ animation: `mc-draw 0.9s ease-out ${pathDelay(i)}s both` }}
              />
            ))}

            {/* Median — draws last with a glow pulse */}
            <path
              d={lineOf(p50)}
              fill="none"
              stroke="#3b82f6"
              strokeWidth="2"
              pathLength="1"
              strokeDasharray="1"
              style={{ animation: "mc-draw 1.1s ease-out 0.85s both, mc-glow 1.4s ease-out 1.9s both" }}
            />

            {yTicks.map((tk, i) => (
              <g key={i} style={{ animation: "mc-fade 0.4s ease-out 0.6s both" }}>
                <line x1={pad.l} x2={size.w - pad.r} y1={tk.y} y2={tk.y}
                      stroke="rgba(229,231,235,0.06)" />
                <text x={pad.l - 6} y={tk.y + 3} textAnchor="end"
                      className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                  {fmtUsd(tk.v)}
                </text>
              </g>
            ))}
            {xTicks.map((tk, i) => (
              <text key={i} x={tk.x} y={size.h - 8} textAnchor={tk.anchor}
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace"
                    style={{ animation: "mc-fade 0.4s ease-out 0.65s both" }}>
                {xLabelFor(tk.xv)}
              </text>
            ))}
          </svg>
        </div>

      </div>
    </div>
  );
}

function LegendSwatch({ color, label, line }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-3 h-3 rounded-sm" style={{
        background: line ? "transparent" : color,
        borderTop: line ? `2px solid ${color}` : "none",
      }} />
      {label}
    </span>
  );
}

function HistPanel({ title, dist, unit, original }) {
  const fmt = unit === "usd"
    ? (v) => fmtUsd(v)
    : unit === "num"
      ? (v) => fmtNum(v)
      : (v) => `${fmtNum(v)}%`;
  const hist = dist.histogram || [];
  const max = Math.max(1, ...hist.map((b) => b.count));

  const origBin = (original != null && hist.length)
    ? hist.findIndex((b) => original >= b.bin_lo && original <= b.bin_hi)
    : -1;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className="text-xs font-mono text-muted">
        mean {fmt(dist.mean)} · σ {fmt(dist.std)} · min {fmt(dist.min)} · max {fmt(dist.max)}
      </div>
      <div className="space-y-0.5 mt-2">
        {hist.length === 0 && <div className="text-sm text-muted py-4">no data</div>}
        {hist.map((b, i) => {
          const w = (b.count / max) * 100;
          const isOrig = i === origBin;
          return (
            <div key={i} className="flex items-center gap-2 text-[10px] font-mono">
              <span className="w-24 text-muted text-right">{fmt(b.bin_lo)}</span>
              <div className="flex-1 h-3 bg-bg-elev/30 rounded">
                <div className={`h-3 rounded ${isOrig ? "bg-accent-blue" : "bg-accent-blue/30"}`}
                     style={{ width: `${w}%` }} />
              </div>
              <span className="w-10 text-right text-muted">{b.count}</span>
            </div>
          );
        })}
      </div>
      {original != null && (
        <div className="text-[11px] font-mono text-accent-blue mt-2">
          ▸ Original = {fmt(original)}
        </div>
      )}
    </div>
  );
}
