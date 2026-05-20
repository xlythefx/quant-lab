import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { useLastResult } from "../services/lastResultStore.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt } from "../services/format.js";
import { runMonteCarlo, aiAnalyzeMonteCarlo } from "../services/api.js";

function getKey() {
  // Hash like #montecarlo?key=vwma_reversion|BTCUSDT|15m
  const m = window.location.hash.match(/key=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const MC_METHODS = [
  { id: "trade_bootstrap", label: "Trade-order bootstrap",
    blurb: "Resamples the order of THIS run's trades. Answers: how much of the equity curve was the luck of trade sequencing?" },
  { id: "block_bootstrap", label: "Block bootstrap (returns)",
    blurb: "Resamples per-bar equity returns in blocks (preserves short-term autocorrelation). Path-dependent risk distribution." },
  { id: "synthetic", label: "Synthetic price paths",
    blurb: "Bootstraps OHLC bar structure to build synthetic price series, re-runs the strategy on each. Tests robustness — slowest." },
];

export default function MonteCarlo() {
  const [key, setKey] = useState(getKey());
  useEffect(() => {
    const onHash = () => setKey(getKey());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const result = useLastResult(key);

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="montecarlo" />

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Monte Carlo</h1>
            {result && (
              <div className="text-xs text-muted font-mono mt-0.5">
                {result.strategy_id} · {result.symbol} · {result.timeframe}
              </div>
            )}
          </div>
          <a href="#dashboard" className="text-xs text-accent-blue hover:underline">← Dashboard</a>
        </header>

        {!result && (
          <div className="rounded-xl border border-line bg-bg-panel/60 p-10 text-center text-muted">
            <div className="text-base text-text mb-1">No backtest result loaded</div>
            <div className="text-xs">Run a strategy on the Dashboard first.</div>
            <a href="#dashboard" className="inline-block mt-4 px-4 py-2 rounded-md bg-accent-grad text-white text-sm">
              Open Dashboard →
            </a>
          </div>
        )}

        {result && <MonteCarloTab result={result} />}
      </main>
    </div>
  );
}

function MonteCarloTab({ result }) {
  const [method, setMethod] = useState("trade_bootstrap");
  const [nSims, setNSims] = useState(1000);
  const [blockSize, setBlockSize] = useState("");   // empty = auto
  const [seed, setSeed] = useState(42);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mc, setMc] = useState(null);

  const tradesCount = result?.trades?.length || 0;

  async function onRun() {
    setLoading(true); setError(null);
    try {
      const data = await runMonteCarlo({
        strategy_id: result.strategy_id,
        symbol: result.symbol,
        timeframe: result.timeframe,
        params: result.params,
        method,
        n_sims: Number(nSims) || 1000,
        block_size: blockSize === "" ? undefined : Number(blockSize),
        seed: Number(seed) || 42,
      });
      setMc(data);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || "MC run failed");
    } finally {
      setLoading(false);
    }
  }

  const effNSims = method === "synthetic" ? Math.min(Number(nSims) || 1000, 200) : (Number(nSims) || 1000);
  const methodDef = MC_METHODS.find((m) => m.id === method);

  return (
    <div className="space-y-4">
      {/* ---------- Controls ---------- */}
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

          <button onClick={onRun} disabled={loading}
            className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50">
            {loading ? "Running…" : "Run"}
          </button>
        </div>
        <div className="text-xs text-muted">{methodDef.blurb}</div>
        {method === "synthetic" && effNSims < (Number(nSims) || 0) && (
          <div className="text-xs text-amber-400/80">
            Synthetic re-runs the engine per path; capped at {effNSims} sims.
          </div>
        )}
        {method === "trade_bootstrap" && tradesCount === 0 && (
          <div className="text-xs text-loss">This run has no trades — pick another method or run a strategy that trades.</div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-loss/40 bg-loss/5 p-3 text-sm text-loss">{error}</div>
      )}

      {!mc && !loading && !error && (
        <div className="rounded-xl border border-line bg-bg-panel/40 p-10 text-center text-muted text-sm">
          Click <span className="text-text">Run</span> to simulate {Number(nSims) || 1000}× variations of this strategy.
        </div>
      )}

      {mc && <MonteCarloResults mc={mc} />}
    </div>
  );
}

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

function KpiCard({ title, value, sub, positive }) {
  const cls = positive == null
    ? "text-text"
    : positive ? "text-profit" : "text-loss";
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className={`text-2xl font-mono mt-1 ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MC Verdict — one-line traffic-light judgement based on robustness signals.
// ---------------------------------------------------------------------------

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
  const p05DD      = dd.p05 ?? 0;    // worst-case (most negative)
  const origRet    = orig.total_return_pct ?? 0;

  // Where does the original sit inside the distribution?
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

// ---------------------------------------------------------------------------
// Plain-English explainer for the MC distribution.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Path Rankings — best / median / worst single paths from the sampled set.
// ---------------------------------------------------------------------------

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

function MonteCarloResults({ mc }) {
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

      {/* KPI strip */}
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

      <PathRankings mc={mc} />

      {/* Fan chart */}
      <FanChart mc={mc} startingCapital={sc} />

      {/* Distributions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <HistPanel title="Final equity ($)" dist={fe} unit="usd" original={orig.final_equity} />
        <HistPanel title="Total return (%)" dist={ret} unit="pct" original={orig.total_return_pct} />
        <HistPanel title="Max drawdown (%)" dist={dd} unit="pct" original={orig.max_drawdown_pct} />
      </div>

      {/* AI analysis — click to run */}
      <AIInsightsPanel
        label="AI Analysis"
        contextHint="Claude interprets robustness, tail risk, and what this MC method can (and can't) tell you."
        fetcher={() => aiAnalyzeMonteCarlo(mc)}
      />
    </div>
  );
}

function FanChart({ mc, startingCapital }) {
  const innerRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 360 });

  useEffect(() => {
    const el = innerRef.current; if (!el) return;
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

  // Y range: combine envelopes + sampled paths so nothing clips.
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

  // Y ticks (5)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    return { v, y: yOf(v) };
  });
  // X ticks (5)
  const xLabelFor = (xv) => mc.x_label === "trade #"
    ? `#${xv}`
    : new Date(xv * 1000).toISOString().slice(0, 10);
  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const xv = xMin + ((xMax - xMin) * i) / 4;
    return { xv, x: xOf(xv), anchor: i === 0 ? "start" : i === 4 ? "end" : "middle" };
  });

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
      <div ref={innerRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          {/* Starting capital line */}
          <line x1={pad.l} x2={size.w - pad.r} y1={yOf(startingCapital)} y2={yOf(startingCapital)}
                stroke="rgba(229,231,235,0.25)" strokeWidth="0.6" strokeDasharray="2 3" />

          <path d={bandOf(p05, p95)} fill="rgba(59,130,246,0.12)" />
          <path d={bandOf(p25, p75)} fill="rgba(59,130,246,0.25)" />

          {/* sampled paths */}
          {(mc.paths || []).map((s, i) => (
            <path key={i} d={lineOf(s)} fill="none" stroke="rgba(229,231,235,0.18)" strokeWidth="0.6" />
          ))}

          <path d={lineOf(p50)} fill="none" stroke="#3b82f6" strokeWidth="1.6" />

          {/* Axes */}
          {yTicks.map((tk, i) => (
            <g key={i}>
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
                  className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {xLabelFor(tk.xv)}
            </text>
          ))}
        </svg>
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
    : (v) => `${fmtNum(v)}%`;
  const hist = dist.histogram || [];
  const max = Math.max(1, ...hist.map((b) => b.count));

  // Where does the "original" backtest's metric land?
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
