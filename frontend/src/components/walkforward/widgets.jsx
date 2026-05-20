// Leaf widgets for the Walk-Forward page.
// Extracted from WalkForward.jsx so the page file can stay a thin tabbed shell.
// State (useState) lives in the widgets themselves where it was inline.

import { useMemo, useState } from "react";
import { fmtUsd, fmtNum, fmtPct, fmtInt } from "../../services/format.js";
import { aiAnalyzeWalkForward } from "../../services/api.js";

export function fmtDate(epoch) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

// -- Setup form inputs --------------------------------------------------------

export function Field({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      {children}
    </div>
  );
}

export function NumInput({ value, onChange, min, max }) {
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

export function BudgetHint({ searchSpaceLen, nTrials, isBars, oosBars }) {
  const perWindow = (searchSpaceLen ? nTrials : 1) + 1; // +1 OOS eval
  const heavy = perWindow > 200;
  return (
    <div className={`text-[11px] font-mono ${heavy ? "text-loss" : "text-muted"}`}>
      ≈ {perWindow} backtests per window
      &nbsp;·&nbsp; IS={isBars} bars, OOS={oosBars} bars
    </div>
  );
}

// -- Live progress ------------------------------------------------------------

export function ProgressBar({ label, pct }) {
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

export function ProgressPanel({ jobState }) {
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

// -- Verdict banner -----------------------------------------------------------

export function WFVerdict({ result }) {
  const s = result.stats || {};
  const windows = result.windows || [];
  const sharpe = s.sharpe ?? 0;
  const pf = s.profit_factor;
  const ret = s.total_return_pct ?? 0;
  const dd = Math.abs(s.max_drawdown_pct ?? 0);
  const positiveWins = windows.filter((w) => (w.oos_stats?.sharpe ?? 0) > 0).length;
  const pctPositive = windows.length ? positiveWins / windows.length : 0;

  const calmar = dd > 0 ? ret / dd : 0;
  let score = 0;
  if (sharpe >= 1.5) score += 3; else if (sharpe >= 1.0) score += 2; else if (sharpe >= 0.5) score += 1;
  if (pctPositive >= 0.7) score += 2; else if (pctPositive >= 0.5) score += 1;
  if (calmar >= 2) score += 2; else if (calmar >= 1) score += 1;
  if (pf != null && pf >= 1.5) score += 1;

  let tier, tone, label;
  if (score >= 6)        { tier = "Strong";   tone = "profit";  label = "🟢 Deploy candidate"; }
  else if (score >= 4)   { tier = "Decent";   tone = "profit";  label = "🟡 Promising — refine further"; }
  else if (score >= 2)   { tier = "Marginal"; tone = "amber";   label = "🟠 Marginal — likely overfit or thin edge"; }
  else                   { tier = "Weak";     tone = "loss";    label = "🔴 Does not generalize — kill or rework"; }

  const summary = [
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

// -- KPI tile (smaller variant for WF result grid) ---------------------------

export function Kpi({ title, value, sub, positive }) {
  const cls = positive == null ? "text-text" : positive ? "text-profit" : "text-loss";
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className={`text-xl font-mono mt-0.5 ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

// -- Best Parameter Combinations ---------------------------------------------

export function BestParamRankings({ result }) {
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
      const spread = mean !== 0 ? stdev / Math.abs(mean) : 0;

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

      const stable = spread < 0.15;
      return { spec, picks, buckets, stats: { mean, median, stdev, range, spread, stable } };
    });
  }, [windows, searchSpace]);

  if (rankings.length === 0) return null;

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

// -- Top Combinations ---------------------------------------------------------

export function TopCombinations({ result }) {
  const windows = result.windows || [];
  const searchSpace = result?.wf_spec?.search_space || [];
  const paramKeys = useMemo(() => searchSpace.map((s) => s.name), [searchSpace]);

  const topReal = useMemo(() => {
    if (windows.length === 0 || paramKeys.length === 0) return [];
    return [...windows]
      .map((w) => ({
        params: w.best_params || {},
        sharpe: w.oos_stats?.sharpe ?? 0,
        ret: w.oos_stats?.total_return_pct ?? 0,
        trades: w.oos_stats?.trades ?? 0,
        idx: w.window_idx,
        start: w.oos_start,
        end: w.oos_end,
      }))
      .sort((a, b) => b.sharpe - a.sharpe)
      .slice(0, 3);
  }, [windows, paramKeys]);

  const consensus = useMemo(() => {
    if (windows.length === 0 || searchSpace.length === 0) return null;
    const out = {};
    for (const spec of searchSpace) {
      const vals = windows
        .map((w) => w.best_params?.[spec.name])
        .filter((v) => typeof v === "number" && Number.isFinite(v));
      if (vals.length === 0) continue;
      const sorted = [...vals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      out[spec.name] = spec.type === "int" ? Math.round(median) : median;
    }
    return out;
  }, [windows, searchSpace]);

  if (topReal.length === 0) return null;

  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text">Top Combinations</div>
        <div className="text-xs text-muted">
          Full parameter sets ranked by OOS Sharpe — these combos were actually tested together.
          Click <span className="font-mono text-text">Copy</span> to paste into the dashboard / strategy config.
        </div>
      </div>

      <div className="space-y-2">
        {topReal.map((r, i) => (
          <ComboRow
            key={r.idx}
            rank={i}
            label={`Window #${r.idx} · ${fmtDate(r.start)} → ${fmtDate(r.end)}`}
            sharpe={r.sharpe}
            ret={r.ret}
            trades={r.trades}
            params={r.params}
            paramKeys={paramKeys}
          />
        ))}

        {consensus && (
          <ComboRow
            rank={-1}
            label="Synthesized consensus (median of each param across all windows)"
            params={consensus}
            paramKeys={paramKeys}
            warn="Untested as a combination — interactions between params were never validated together. Use as a starting point, not a guarantee."
          />
        )}
      </div>
    </section>
  );
}

function ComboRow({ rank, label, sharpe, ret, trades, params, paramKeys, warn }) {
  const [copied, setCopied] = useState(false);
  const medal = rank === 0 ? "🥇" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : rank === -1 ? "🧪" : `${rank + 1}.`;
  const sharpeTone = sharpe == null ? "text-muted" : sharpe >= 1 ? "text-profit" : sharpe >= 0 ? "text-text" : "text-loss";

  const cleanParams = useMemo(() => {
    const out = {};
    for (const k of paramKeys) {
      if (params[k] !== undefined) out[k] = params[k];
    }
    return out;
  }, [params, paramKeys]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(cleanParams, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — ignore silently
    }
  }

  const borderTone = warn ? "border-amber-400/40" : "border-line";
  return (
    <div className={`rounded-md border ${borderTone} bg-bg-elev/30 p-3 space-y-2`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px] font-mono text-text flex items-center gap-2 min-w-0">
          <span className="shrink-0">{medal}</span>
          <span className="truncate">{label}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono">
          {sharpe != null && (
            <>
              <span className={sharpeTone}>sharpe {fmtNum(sharpe)}</span>
              <span className={ret >= 0 ? "text-profit" : "text-loss"}>{fmtPct(ret ?? 0)}</span>
              <span className="text-muted">{fmtInt(trades ?? 0)}t</span>
            </>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="px-2 py-0.5 rounded border border-line bg-bg-panel/60 text-text hover:border-text/40 transition"
          >
            {copied ? "✓ copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 text-[11px] font-mono">
        {paramKeys.map((k) => {
          const v = params[k];
          if (v === undefined) return null;
          return (
            <span key={k} className="px-2 py-0.5 rounded bg-bg-elev/60 border border-line/40 text-muted">
              {k}=<span className="text-text">{typeof v === "number" ? fmtNum(v) : String(v)}</span>
            </span>
          );
        })}
      </div>
      {warn && (
        <div className="text-[10px] text-amber-400/90 font-mono">⚠ {warn}</div>
      )}
    </div>
  );
}

// -- Window Rankings ----------------------------------------------------------

export function WindowRankings({ windows }) {
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

// -- AI Insights (single-shot; A.4 will add a per-section endpoint) ----------

export function WalkForwardAIInsights({ result }) {
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

// -- Per-window heatmap (+ exposed useParamStats for the Parameters drift tab) -

export function useParamStats(windows, searchSpace) {
  return useMemo(() => {
    const cols = (searchSpace || []).filter((spec) =>
      (windows || []).some((w) => {
        const v = w.best_params?.[spec.name];
        return typeof v === "number" && Number.isFinite(v);
      })
    );
    const stats = {};
    for (const spec of cols) {
      const vals = (windows || [])
        .map((w) => w.best_params?.[spec.name])
        .filter((v) => typeof v === "number" && Number.isFinite(v));
      if (!vals.length) continue;
      const sorted = [...vals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
      const stdev = Math.sqrt(variance);
      stats[spec.name] = {
        median, mean, stdev,
        min: sorted[0],
        max: sorted[sorted.length - 1],
      };
    }
    return { cols, stats };
  }, [windows, searchSpace]);
}

export function WindowHeatmap({ windows, searchSpace }) {
  const [selectedIdx, setSelectedIdx] = useState(null);
  const { cols, stats } = useParamStats(windows, searchSpace);

  if (!windows.length) {
    return (
      <section className="rounded-xl border border-line bg-bg-panel/60 p-4">
        <div className="text-[11px] uppercase tracking-wider text-muted">Per-window results</div>
        <div className="text-sm text-muted mt-2">no windows</div>
      </section>
    );
  }
  if (!cols.length) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-muted">Per-window results</div>
        {windows.map((w) => <WindowCard key={w.window_idx} w={w} />)}
      </div>
    );
  }

  function colorFor(specName, value) {
    const s = stats[specName];
    if (!s || !Number.isFinite(value)) return null;
    if (s.stdev < 1e-9) return "rgba(120,120,140,0.06)";
    const z = (value - s.median) / s.stdev;
    const alpha = Math.min(0.7, Math.abs(z) * 0.32);
    if (alpha < 0.04) return null;
    return z >= 0
      ? `rgba(251, 191, 36, ${alpha.toFixed(3)})`
      : `rgba(96, 165, 250, ${alpha.toFixed(3)})`;
  }

  const fmtVal = (spec, v) => (spec.type === "int" ? fmtInt(v) : fmtNum(v));

  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-text">Per-window heatmap</div>
          <div className="text-xs text-muted mt-0.5">
            Rows = windows (chronological). Cells colored by deviation from each column's median:{" "}
            <span className="px-1.5 py-0.5 rounded text-text" style={{ backgroundColor: "rgba(251,191,36,0.45)" }}>warmer</span>
            {" "}above,{" "}
            <span className="px-1.5 py-0.5 rounded text-text" style={{ backgroundColor: "rgba(96,165,250,0.45)" }}>cooler</span>
            {" "}below. Solid block = robust; color swings = parameter drift. Click a row for details.
          </div>
        </div>
        {selectedIdx != null && (
          <button
            type="button"
            onClick={() => setSelectedIdx(null)}
            className="text-[11px] font-mono text-muted hover:text-text underline underline-offset-2"
          >
            clear selection
          </button>
        )}
      </div>

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="min-w-full text-[11px] font-mono border-separate" style={{ borderSpacing: "0 2px" }}>
          <thead>
            <tr className="text-muted">
              <th className="text-left px-2 py-1 sticky left-0 z-10 bg-bg-panel/95 backdrop-blur">Window</th>
              {cols.map((spec) => (
                <th key={spec.name} className="text-left px-2 py-1 whitespace-nowrap align-bottom">
                  <div className="text-text/90">{spec.name}</div>
                  <div className="text-[9px] text-muted/70 font-normal">
                    med {fmtVal(spec, stats[spec.name].median)} · σ {fmtNum(stats[spec.name].stdev)}
                  </div>
                </th>
              ))}
              <th className="text-right px-2 py-1 whitespace-nowrap">OOS %</th>
              <th className="text-right px-2 py-1 whitespace-nowrap">Sharpe</th>
              <th className="text-right px-2 py-1 whitespace-nowrap">t</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((w) => {
              const os = w.oos_stats || {};
              const ret = os.total_return_pct ?? 0;
              const pos = ret >= 0;
              const selected = selectedIdx === w.window_idx;
              const rowCls = selected
                ? "outline outline-1 outline-accent-blue/70 bg-accent-blue/5"
                : "hover:bg-bg-elev/40";
              return (
                <tr
                  key={w.window_idx}
                  className={`cursor-pointer transition-colors ${rowCls}`}
                  onClick={() => setSelectedIdx(selected ? null : w.window_idx)}
                >
                  <td className={`px-2 py-1 whitespace-nowrap sticky left-0 z-[1] ${selected ? "bg-bg-panel" : "bg-bg-panel/95"} backdrop-blur`}>
                    <span className="text-muted">#{w.window_idx}</span>{" "}
                    <span className="text-text/85">{fmtDate(w.oos_start)} → {fmtDate(w.oos_end)}</span>
                  </td>
                  {cols.map((spec) => {
                    const v = w.best_params?.[spec.name];
                    const numeric = typeof v === "number" && Number.isFinite(v);
                    const bg = numeric ? colorFor(spec.name, v) : null;
                    const s = stats[spec.name];
                    const z = numeric && s && s.stdev > 1e-9 ? (v - s.median) / s.stdev : 0;
                    return (
                      <td
                        key={spec.name}
                        className="px-2 py-1 text-text whitespace-nowrap"
                        style={bg ? { backgroundColor: bg } : undefined}
                        title={numeric ? `${spec.name} = ${fmtVal(spec, v)} · z=${fmtNum(z)} vs median ${fmtVal(spec, s.median)}` : spec.name}
                      >
                        {numeric ? fmtVal(spec, v) : "—"}
                      </td>
                    );
                  })}
                  <td className={`px-2 py-1 text-right whitespace-nowrap ${pos ? "text-profit" : "text-loss"}`}>{fmtPct(ret)}</td>
                  <td className="px-2 py-1 text-right text-text whitespace-nowrap">{fmtNum(os.sharpe ?? 0)}</td>
                  <td className="px-2 py-1 text-right text-muted whitespace-nowrap">{fmtInt(os.trades ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedIdx != null && (
        <div className="pt-2 border-t border-line/30">
          <WindowCard w={windows.find((w) => w.window_idx === selectedIdx)} />
        </div>
      )}
    </section>
  );
}

export function WindowCard({ w }) {
  if (!w) return null;
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
