// Leaf widgets for the Walk-Forward page.
// Extracted from WalkForward.jsx so the page file can stay a thin tabbed shell.
// State (useState) lives in the widgets themselves where it was inline.

import { useMemo, useRef, useState } from "react";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtDateLong } from "../../services/format.js";
import { aiAnalyzeWalkForward } from "../../services/api.js";
import { resolveDefaultParams } from "../dashboardv2/metrics.js";
import { convertUtcHHmm, tzShort } from "../../services/timezone.js";
import { useDisplayTz } from "../../services/useDisplayTz.js";
import { getUserDefaults } from "../../services/strategiesStore.js";

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

// "372" -> "6:12", "3725" -> "1h 2m"
export function fmtDur(s) {
  if (s == null || !Number.isFinite(s)) return "—";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

// Per-core utilization bars + an overall CPU readout. `percore` is a list of %.
export function CpuMeter({ cpu = 0, percore = [], active = 0, workers = 0 }) {
  const barColor = (v) => (v >= 85 ? "bg-loss" : v >= 50 ? "bg-amber-400" : "bg-accent-blue");
  return (
    <div className="rounded-lg border border-line bg-bg-elev/40 p-3 space-y-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="uppercase tracking-wider text-muted">CPU</span>
        <span className="font-mono text-text">
          {Math.round(cpu)}%
          {workers > 0 && (
            <span className="text-muted"> · {active}/{workers} worker{workers === 1 ? "" : "s"} busy</span>
          )}
        </span>
      </div>
      {/* overall */}
      <div className="h-1.5 rounded bg-bg-elev/60 overflow-hidden">
        <div className={`h-full transition-all ${barColor(cpu)}`} style={{ width: `${Math.min(100, cpu)}%` }} />
      </div>
      {/* per-core */}
      {percore.length > 0 && (
        <div className="flex items-end gap-0.5 h-9 pt-1">
          {percore.map((c, i) => (
            <div key={i} className="flex-1 bg-bg-elev/60 rounded-sm overflow-hidden flex items-end" title={`core ${i}: ${Math.round(c)}%`}>
              <div className={`w-full rounded-sm ${barColor(c)}`} style={{ height: `${Math.max(3, Math.min(100, c))}%` }} />
            </div>
          ))}
        </div>
      )}
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
        <div className="text-xs font-mono text-muted">job {jobState?.job_id || "—"}</div>
      </div>

      {/* Elapsed / ETA / workers strip */}
      <div className="flex items-center gap-4 text-xs font-mono">
        <span className="text-muted">elapsed <span className="text-text">{fmtDur(jobState?.elapsed_seconds)}</span></span>
        <span className="text-muted">ETA <span className="text-text">{fmtDur(jobState?.eta_seconds)}</span></span>
        {jobState?.n_workers > 0 && (
          <span className="text-muted ml-auto">
            {jobState?.active_workers ?? 0}/{jobState.n_workers} cores
          </span>
        )}
      </div>

      <CpuMeter
        cpu={jobState?.cpu_percent}
        percore={jobState?.cpu_percent_percore || []}
        active={jobState?.active_workers}
        workers={jobState?.n_workers}
      />

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

// -- Multi-seed robustness (Seed Check tab) -----------------------------------

export function RobustnessProgress({ rbState }) {
  const { seed_idx = 0, n_seeds = 0, window_idx = 0, total_windows = 0 } = rbState || {};
  const cancelled = rbState?.state === "cancelled";
  const wFrac = total_windows ? window_idx / total_windows : 0;
  const seedPct = n_seeds ? (((Math.max(0, seed_idx - 1)) + wFrac) / n_seeds) * 100 : 0;
  const wPct = total_windows ? wFrac * 100 : 0;
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          {cancelled ? "Cancelled" : "Robustness running"}
        </div>
        <div className="text-xs font-mono text-muted">job {rbState?.job_id || "—"}</div>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono">
        <span className="text-muted">elapsed <span className="text-text">{fmtDur(rbState?.elapsed_seconds)}</span></span>
        <span className="text-muted">ETA <span className="text-text">{fmtDur(rbState?.eta_seconds)}</span></span>
        {rbState?.n_workers > 0 && (
          <span className="text-muted ml-auto">{rbState?.active_workers ?? 0}/{rbState.n_workers} cores</span>
        )}
      </div>
      <CpuMeter cpu={rbState?.cpu_percent} percore={rbState?.cpu_percent_percore || []}
                active={rbState?.active_workers} workers={rbState?.n_workers} />
      <div className="space-y-2">
        <ProgressBar label={`Seed ${seed_idx} / ${n_seeds}`} pct={seedPct} />
        <ProgressBar label={`Window ${window_idx} / ${total_windows} (current seed)`} pct={wPct} />
      </div>
    </section>
  );
}

const VERDICT_TONE = {
  robust: { box: "border-accent-cyan/40 bg-accent-cyan/5", text: "text-accent-cyan", label: "Robust" },
  mixed:  { box: "border-amber-400/40 bg-amber-400/5", text: "text-amber-400", label: "Mixed" },
  weak:   { box: "border-amber-400/40 bg-amber-400/5", text: "text-amber-400", label: "Weak" },
  fragile:{ box: "border-loss/40 bg-loss/10", text: "text-loss", label: "Fragile" },
  inconclusive: { box: "border-line bg-bg-elev/40", text: "text-muted", label: "Inconclusive" },
};

function SummaryStat({ label, s, fmt }) {
  if (!s) return null;
  return (
    <div className="rounded-lg border border-line bg-bg-elev/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted/70">{label}</div>
      <div className="text-sm font-mono text-text">{fmt(s.median)}</div>
      <div className="text-[10px] font-mono text-muted">
        {fmt(s.min)} … {fmt(s.max)} · σ {fmt(s.std)}
      </div>
    </div>
  );
}

export function RobustnessResults({ rbResult }) {
  const { per_seed = [], summary = {}, verdict = {} } = rbResult || {};
  const tone = VERDICT_TONE[verdict.label] || VERDICT_TONE.inconclusive;
  const pctF = (v) => (v == null ? "—" : fmtPct(v));
  const numF = (v) => (v == null ? "—" : fmtNum(v));
  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-4 ${tone.box}`}>
        <div className={`text-xs uppercase tracking-wider font-semibold ${tone.text}`}>
          {tone.label} · {per_seed.length} seed{per_seed.length === 1 ? "" : "s"}
        </div>
        <div className="text-sm text-text mt-1">{verdict.text}</div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryStat label="Return % (median)" s={summary.total_return_pct} fmt={pctF} />
        <SummaryStat label="Sharpe (median)" s={summary.sharpe} fmt={numF} />
        <SummaryStat label="Max DD % (median)" s={summary.max_drawdown_pct} fmt={pctF} />
        <SummaryStat label="Trades (median)" s={summary.trades} fmt={(v) => fmtInt(Math.round(v ?? 0))} />
      </div>

      <div className="rounded-xl border border-line bg-bg-panel/40 overflow-hidden">
        <div className="grid grid-cols-5 gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted/70 border-b border-line">
          <span>Seed</span><span className="text-right">Return %</span><span className="text-right">Sharpe</span>
          <span className="text-right">Max DD %</span><span className="text-right">Trades</span>
        </div>
        {per_seed.map((p) => (
          <div key={p.seed} className="grid grid-cols-5 gap-2 px-3 py-1.5 text-xs font-mono border-b border-line/30 last:border-b-0">
            <span className="text-muted">#{p.seed}</span>
            <span className={`text-right ${(p.total_return_pct ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>{pctF(p.total_return_pct)}</span>
            <span className="text-right text-text">{numF(p.sharpe)}</span>
            <span className="text-right text-loss">{pctF(p.max_drawdown_pct)}</span>
            <span className="text-right text-text">{fmtInt(p.trades)}</span>
          </div>
        ))}
      </div>
    </div>
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

// -- Verdict tab: the full validation gauntlet, gate by gate -----------------
// Each gate reads numbers ALREADY in the WF result (no new backend). Lights:
// pass / warn / fail / na. Two gates (holdout, cross-strategy) can't be judged
// from one run — they show as grey reminders so they're never faked green.
// Full methodology: docs/plans/validation-checklist.md.

const GATE_TONE = {
  pass: { dot: "🟢", cls: "border-profit/40 bg-profit/5",      label: "text-profit" },
  warn: { dot: "🟡", cls: "border-amber-400/40 bg-amber-400/5", label: "text-amber-400" },
  fail: { dot: "🔴", cls: "border-loss/40 bg-loss/5",          label: "text-loss" },
  na:   { dot: "⚪", cls: "border-line bg-bg-elev/20",          label: "text-muted" },
};

function GateCard({ light, title, value, plain }) {
  const t = GATE_TONE[light] || GATE_TONE.na;
  return (
    <div className={`rounded-lg border p-3 ${t.cls}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-text flex items-center gap-1.5">
          <span>{t.dot}</span>{title}
        </div>
        {value != null && <div className={`text-xs font-mono ${t.label}`}>{value}</div>}
      </div>
      <div className="text-[11px] text-muted mt-1 leading-relaxed">{plain}</div>
    </div>
  );
}

// Per-window green/red strip — see sub-period consistency at a glance.
function WindowConsistencyStrip({ windows }) {
  if (!windows.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {windows.map((w) => {
        const sh = w.oos_stats?.sharpe ?? 0;
        const good = sh > 0;
        return (
          <div
            key={w.window_idx}
            title={`Window ${w.window_idx}: OOS Sharpe ${fmtNum(sh)} · ${fmtPct(w.oos_stats?.total_return_pct ?? 0)}`}
            className={`w-4 h-4 rounded-sm ${good ? "bg-emerald-500/70" : "bg-loss/70"}`}
          />
        );
      })}
    </div>
  );
}

// Render one param value the way a human reads it (on/off, "long + short", etc.).
function fmtParamValue(v) {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return fmtNum(v);
  if (v && typeof v === "object") {
    const allBool = Object.values(v).every((x) => typeof x === "boolean");
    if (allBool) {
      const on = Object.entries(v).filter(([, x]) => x).map(([k]) => k);
      return on.length ? on.join(" + ") : "none";
    }
    return "custom";   // nested config (e.g. sessions) — too much to inline
  }
  return String(v);
}

function ParamGrid({ params, tunedNames }) {
  const names = Object.keys(params || {});
  const ordered = [...names.filter((n) => tunedNames.has(n)), ...names.filter((n) => !tunedNames.has(n))];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
      {ordered.map((n) => {
        const isTuned = tunedNames.has(n);
        return (
          <div key={n} className={`rounded-md border px-2.5 py-1.5 ${isTuned ? "border-line bg-bg-elev/40" : "border-line/40"}`}>
            <div className="text-[10px] text-muted font-mono truncate" title={n}>
              {n}{isTuned ? "" : " · fixed"}
            </div>
            <div className={`text-sm font-mono ${isTuned ? "text-text" : "text-muted"}`}>
              {fmtParamValue(params[n])}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One line of "what this set actually did" over the combined out-of-sample span.
function OosScoreLine({ stats, label, strong }) {
  if (!stats) return <div className="text-[11px] text-muted">{label}: not evaluated</div>;
  const ret = stats.total_return_pct ?? 0;
  return (
    <div className="text-[11px] font-mono flex flex-wrap items-center gap-x-3 gap-y-0.5">
      <span className={strong ? "text-text" : "text-muted"}>{label}</span>
      <span className={ret > 0 ? "text-profit" : "text-loss"}>{fmtPct(ret)}</span>
      <span className="text-muted">Sharpe <span className="text-text">{fmtNum(stats.sharpe ?? 0)}</span></span>
      <span className="text-muted">DD <span className="text-loss">{fmtPct(Math.abs(stats.max_drawdown_pct ?? 0), false)}</span></span>
      <span className="text-muted">{fmtInt(stats.trades ?? 0)} trades</span>
    </div>
  );
}

/**
 * "Deploy candidate" — the CONSENSUS parameter set (median of each tuned param
 * across every walk-forward window), shown with the number it actually scored
 * when backtested over the combined out-of-sample span (backend:
 * WalkForwardJob._build_deploy_candidate).
 *
 * This box used to show the LAST window's `best_params` under the title
 * "Recommended parameters to deploy". That was the single most overfit object
 * in the run — the argmax of one in-sample window, never validated — wearing a
 * trust note borrowed from a stability score that never looked at a parameter
 * value. Both the old set and the untuned baseline are now scored on the same
 * span beside it, so the gap is visible instead of implied.
 *
 * Falls back to the old display for results stored before deploy_candidate
 * existed — labelled for what it is, with no trust note.
 */
export function RecommendedParams({ result, stability }) {
  const [copied, setCopied] = useState(false);
  const windows = result.windows || [];
  const dc = result.deploy_candidate || null;
  const last = windows.length ? windows[windows.length - 1] : null;

  const params = dc?.params || last?.best_params || {};
  if (!Object.keys(params).length) return null;

  const tunedNames = new Set((result?.wf_spec?.search_space || []).map((s) => s.name));

  const copy = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(params, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — no-op */ }
  };

  const copyBtn = (
    <button onClick={copy} className="shrink-0 text-[11px] font-mono px-2.5 py-1 rounded border border-line text-muted hover:text-text hover:border-muted transition-colors">
      {copied ? "Copied ✓" : "Copy JSON"}
    </button>
  );

  // Legacy result: no consensus set was computed. Say so rather than dressing
  // one window's in-sample pick up as a recommendation.
  if (!dc) {
    return (
      <div className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-amber-400">
              Last window&apos;s in-sample pick · not validated
            </div>
            <div className="text-[11px] text-muted mt-0.5">
              Window {last?.window_idx} ({fmtDateLong(last?.oos_start)} – {fmtDateLong(last?.oos_end)}).
              This is the best-scoring config on that one tuning window — the verdict above judges the
              walk-forward procedure, not this set. Re-run to get a consensus set with a real out-of-sample number.
            </div>
          </div>
          {copyBtn}
        </div>
        <ParamGrid params={params} tunedNames={tunedNames} />
      </div>
    );
  }

  const st = dc.stats || null;
  const ret = st?.total_return_pct ?? null;
  const baseRet = dc.baseline?.stats?.total_return_pct ?? null;
  const verdict = ret == null ? { cls: "border-line", txt: null }
    : ret > 0
      ? { cls: "border-profit/40 bg-profit/5", txt: null }
      : { cls: "border-loss/40 bg-loss/5",
          txt: "This set LOSES money over the combined out-of-sample span. Do not deploy it — the verdict above is about the re-optimize-every-window procedure, not about any single fixed set." };

  // Widest per-param disagreement across windows, as a fraction of its range.
  // 0.289 is what uniform-random draws produce.
  const agree = dc.agreement || {};
  const spreads = Object.values(agree).map((a) => a.spread).filter((v) => typeof v === "number");
  const worstSpread = spreads.length ? Math.max(...spreads) : null;
  const RANDOM_SPREAD = 1 / Math.sqrt(12);

  const trust = stability == null ? null
    : stability >= 0.7 ? { cls: "text-profit", txt: "Neighbouring params score about the same — the optimum is flat, not a spike." }
    : stability >= 0.4 ? { cls: "text-amber-400", txt: "Nudging the params costs some performance — the edge partly depends on the exact numbers." }
    : { cls: "text-loss", txt: "Nudging the params collapses the score — the winners are lone spikes. Treat any single set as a starting point, not gospel." };

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${verdict.cls}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted">Deploy candidate · consensus of {fmtInt(dc.n_windows)} windows</div>
          <div className="text-[11px] text-muted mt-0.5">
            The median value each tuned param landed on across every window — then actually backtested over
            the combined out-of-sample span, {fmtDateLong(dc.oos_start)} – {fmtDateLong(dc.oos_end)}.
          </div>
        </div>
        {copyBtn}
      </div>

      <ParamGrid params={params} tunedNames={tunedNames} />

      <div className="rounded-lg border border-line bg-bg-elev/30 p-2.5 space-y-1">
        <OosScoreLine stats={st} label="This set, held fixed across the OOS span" strong />
        <OosScoreLine stats={dc.last_window?.stats} label={`Last window's in-sample pick (#${dc.last_window?.window_idx ?? "—"}), same span`} />
        <OosScoreLine stats={dc.baseline?.stats} label="Untuned base params, same span" />
        <div className="text-[10px] text-muted pt-1">
          None of these is the stitched curve above — that one re-tunes every window. These are what you&apos;d
          get holding one set fixed, which is what deploying actually means.
        </div>
      </div>

      {verdict.txt && <div className="text-[11px] text-loss">{verdict.txt}</div>}
      {ret != null && baseRet != null && baseRet > ret && (
        <div className="text-[11px] text-amber-400">
          The untuned base params beat this consensus set on the same span ({fmtPct(baseRet)} vs {fmtPct(ret)}).
          The search is not paying for itself here.
        </div>
      )}
      {trust && <div className={`text-[11px] ${trust.cls}`}>{trust.txt}</div>}
      {worstSpread != null && worstSpread >= RANDOM_SPREAD * 0.9 && (
        <div className="text-[11px] text-loss">
          Windows disagreed on at least one param as widely as random guessing would
          (spread {fmtNum(worstSpread * 100)}% of its search range; uniform-random is {fmtNum(RANDOM_SPREAD * 100)}%).
          The median is then an average of noise, not a consensus.
        </div>
      )}
      {worstSpread != null && worstSpread > 0.25 && worstSpread < RANDOM_SPREAD * 0.9 && (
        <div className="text-[11px] text-amber-400">
          Windows disagreed widely on at least one param (spread {fmtNum(worstSpread * 100)}% of its search range) —
          check Best Parameter Combinations before trusting the median.
        </div>
      )}
      <div className="text-[10px] text-muted">
        Honest caveat: this span is out-of-sample relative to each window&apos;s tuning, but you have now looked at
        it. The locked holdout is still the only untouched test.
      </div>
    </div>
  );
}

/**
 * "Currently used parameters" — the SAME defaults the strategy runs with on
 * Dashboard V2 (resolveDefaultParams: schema defaults → timeframe/symbol presets
 * → your saved overrides), shown next to RecommendedParams so you can compare
 * default-vs-recommended. Cells that DIFFER from the recommendation are highlighted
 * (amber) with the recommended value inline.
 */
export function CurrentParams({ result, strategies }) {
  const windows = result.windows || [];
  const last = windows.length ? windows[windows.length - 1] : null;
  // Compare against the same set the box above proposes — the consensus, when
  // the run produced one. Falling back to the last window would mean the two
  // panels disagreed about what "recommended" means.
  const recommended = result.deploy_candidate?.params || last?.best_params || {};
  const names = Object.keys(recommended);
  if (!names.length) return null;

  const strat = (strategies || []).find((s) => s.id === result.strategy_id);
  // Exactly what Dashboard V2 runs this strategy with for its symbol/timeframe.
  const current = resolveDefaultParams(
    strat, result.symbol, result.timeframe, getUserDefaults(result.strategy_id),
  );

  const tunedNames = new Set((result?.wf_spec?.search_space || []).map((s) => s.name));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ordered = [...names.filter((n) => tunedNames.has(n)), ...names.filter((n) => !tunedNames.has(n))];
  const nChanged = ordered.filter((n) => !same(current[n], recommended[n])).length;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">Currently used parameters</div>
      <div className="text-[11px] text-muted -mt-1.5">
        The defaults this strategy runs with on Dashboard V2 ({result.symbol} · {result.timeframe}) — compare against the recommendation above.
        {nChanged > 0 && <span className="text-amber-400"> · {nChanged} differ</span>}
        {nChanged === 0 && <span className="text-profit"> · already matches the recommendation</span>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {ordered.map((n) => {
          const isTuned = tunedNames.has(n);
          const cur = current[n];
          const rec = recommended[n];
          const changed = !same(cur, rec);
          const hasCur = cur !== undefined && cur !== null;
          return (
            <div key={n} className={`rounded-md border px-2.5 py-1.5 ${changed ? "border-amber-400/50 bg-amber-400/5" : isTuned ? "border-line bg-bg-elev/40" : "border-line/40"}`}>
              <div className="text-[10px] text-muted font-mono truncate" title={n}>{n}{isTuned ? "" : " · fixed"}</div>
              <div className={`text-sm font-mono ${changed ? "text-amber-400" : isTuned ? "text-text" : "text-muted"}`}>
                {hasCur ? fmtParamValue(cur) : "—"}
                {changed && <span className="text-muted/70"> → {fmtParamValue(rec)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WFVerdictPanel({ result, strategies }) {
  const s = result.stats || {};
  const windows = result.windows || [];
  const adv = result.analytics?.advanced || {};
  const rob = adv.robustness || {};
  const dist = adv.distribution || {};
  const tstats = adv.trade_stats || {};
  const hasSearchSpace = (result?.wf_spec?.search_space || []).length > 0;

  // --- Gate data ---
  const positiveWins = windows.filter((w) => (w.oos_stats?.sharpe ?? 0) > 0).length;
  const pctPositive = windows.length ? positiveWins / windows.length : 0;

  // Stitched buy-and-hold return (compound each window's B&H %).
  let bhVal = 100, hasBh = false;
  for (const w of windows) {
    if (w.bh_return_pct == null) continue;
    hasBh = true;
    bhVal *= (1 + w.bh_return_pct / 100);
  }
  const bhReturnPct = hasBh ? bhVal - 100 : null;
  const stratReturnPct = s.total_return_pct ?? 0;

  const nTrades = s.trades ?? 0;
  const stability = rob.parameter_stability_score;   // 0..1 or null
  const deflated = rob.deflated_sharpe_probability;  // 0..1 or null (only when metric=sharpe)
  const sig = dist.significance;                      // 'significant'|'marginal'|'not_significant'
  const pval = dist.t_pvalue;
  const top10 = tstats.top10_winners_share;          // 0..1 or null
  const luckWins = tstats.luck_dependent_wins;

  const gates = [];

  // 1 — Parameter plateau. Measured in PARAMETER space: for each window, how
  // well the configs within a small nudge of that window's winner hold up
  // against it (median across windows). The old score was the stdev of the top
  // decile of trial SCORES — it never looked at a parameter value, so it read
  // "stable" whenever many unrelated configs scored alike, which actually means
  // the metric can't tell them apart and the argmax is a coin flip.
  if (!hasSearchSpace) {
    gates.push({ light: "na", title: "Parameter plateau", value: "—",
      plain: "No parameters were optimized in this run, so there's nothing to be robust to. Add a search space to test plateau vs. spike." });
  } else if (stability == null) {
    gates.push({ light: "na", title: "Parameter plateau", value: "—",
      plain: "Not enough trials clustered near each window's winner to judge flatness. Run more trials per window." });
  } else {
    const light = stability >= 0.7 ? "pass" : stability >= 0.4 ? "warn" : "fail";
    const nw = rob.parameter_stability_windows;
    gates.push({ light, title: "Parameter plateau",
      value: `${fmtNum(stability)}${nw ? ` · ${fmtInt(nw)}w` : ""}`,
      plain: light === "pass"
        ? "Nudge the winning params and the score barely moves — neighbours perform similarly. That's a structural edge, not one lucky setting."
        : light === "warn"
        ? "Nudging the params costs real performance. The edge partly depends on the exact numbers — treat with caution."
        : "The winning params are a lone spike — nudge them and the score collapses. Classic curve-fit warning." });
  }

  // 1b — Did the windows agree on anything? Uniform-random draws over a search
  // range have std = 1/sqrt(12) = 0.289 of that range. At or above that, the
  // per-window "best" values are indistinguishable from guessing.
  {
    const disp = rob.param_pick_dispersion;
    const randomLevel = rob.param_pick_dispersion_random_level ?? 1 / Math.sqrt(12);
    if (!hasSearchSpace || disp == null) {
      gates.push({ light: "na", title: "Windows agree on the params", value: "—",
        plain: "Needs at least two windows with numeric parameter picks to compare." });
    } else {
      const ratio = disp / randomLevel;
      const light = ratio <= 0.5 ? "pass" : ratio < 0.9 ? "warn" : "fail";
      gates.push({ light, title: "Windows agree on the params",
        value: `${fmtNum(disp * 100)}% vs ${fmtNum(randomLevel * 100)}% random`,
        plain: light === "pass"
          ? "Independent windows keep landing on similar values. The search is finding something real and repeatable."
          : light === "warn"
          ? "Windows land on fairly different values from window to window — the optimum drifts, so any single set is shaky."
          : "The windows' picks are spread as widely as random guessing over the search range. The optimizer is not finding an optimum, it's sampling noise — and the median of those picks is an average of noise." });
    }
  }

  // 1c — Did tuning beat NOT tuning? The control arm: the same OOS windows
  // traded with the untuned base params. Every other gate is measured only on
  // the tuned arm, so all of them look identical whether the search found a real
  // optimum or not. This is the only gate that can tell the difference.
  {
    const tv = result.tuning_value;
    if (!tv || !tv.control) {
      gates.push({ light: "na", title: "Tuning beat not-tuning", value: "—",
        plain: "This run has no control arm. Re-run to compare the tuned picks against the untuned base params on the same windows." });
    } else {
      const edge = tv.tuning_edge_pct ?? 0;
      const corr = tv.is_oos_correlation;
      const light = edge > 0 && (corr == null || corr > 0.1) ? "pass"
        : edge > 0 ? "warn" : "fail";
      gates.push({ light, title: "Tuning beat not-tuning",
        value: `${fmtPct(tv.tuned.compounded_return_pct)} vs ${fmtPct(tv.control.compounded_return_pct)}`,
        plain: light === "pass"
          ? `Re-optimizing each window beat leaving the base params alone by ${fmtPct(edge)} compounded, and a good in-sample score does predict the next window (correlation ${fmtNum(corr)}). The search is earning its keep.`
          : light === "warn"
          ? `Tuning came out ${fmtPct(edge)} ahead of doing nothing, but a good in-sample score barely predicts the next window (correlation ${fmtNum(corr)}). The gain may be luck rather than skill.`
          : `Leaving the base params ALONE beat re-optimizing every window (${fmtPct(tv.control.compounded_return_pct)} vs ${fmtPct(tv.tuned.compounded_return_pct)}). The optimization step is costing you money — correlation between in-sample score and out-of-sample Sharpe is ${fmtNum(corr)}.` });
    }
  }

  // 1d — How thin a sample each window's winner was chosen on. A great
  // annualized Sharpe on 9 trades is noise wearing a good number.
  {
    const tv = result.tuning_value;
    const med = tv?.median_is_trades_behind_pick;
    if (med == null) {
      gates.push({ light: "na", title: "Picks rest on a real sample", value: "—",
        plain: "This run didn't record how many in-sample trades each winning config was chosen on. Re-run to capture it." });
    } else {
      const thin = tv.windows_picked_on_thin_sample ?? 0;
      const known = tv.n_picked_on_known || 1;
      const light = med >= 30 ? "pass" : med >= 15 ? "warn" : "fail";
      gates.push({ light, title: "Picks rest on a real sample",
        value: `median ${fmtInt(med)} trades`,
        plain: light === "pass"
          ? `Each window's winner was chosen on a median of ${fmtInt(med)} in-sample trades — enough for the score to mean something.`
          : light === "warn"
          ? `Each window's winner was chosen on a median of only ${fmtInt(med)} in-sample trades (${fmtInt(thin)} of ${fmtInt(known)} windows picked on under 20). Raise "Min IS trades" so picks rest on a real sample.`
          : `Each window's winner was chosen on a median of just ${fmtInt(med)} in-sample trades, and ${fmtInt(thin)} of ${fmtInt(known)} windows picked on under 20. At that sample size the winning Sharpe is noise — raise "Min IS trades".` });
    }
  }

  // 2 — Out-of-sample holds
  {
    const light = pctPositive >= 0.7 ? "pass" : pctPositive >= 0.5 ? "warn" : "fail";
    const wfe = rob.walk_forward_efficiency;
    gates.push({ light, title: "Holds out-of-sample",
      value: `${fmtInt(positiveWins)}/${fmtInt(windows.length)}${wfe != null ? ` · WFE ${fmtNum(wfe)}` : ""}`,
      plain: light === "pass"
        ? `${fmtNum(pctPositive * 100)}% of unseen windows made money. The edge generalizes past the data it was tuned on.`
        : light === "warn"
        ? `Only ${fmtNum(pctPositive * 100)}% of unseen windows were profitable — a coin-flip edge, not a reliable one.`
        : `Most unseen windows lost money (${fmtNum(pctPositive * 100)}% positive). The in-sample promise didn't survive out-of-sample.` });
  }

  // 3 — Enough trades
  {
    const light = nTrades >= 100 ? "pass" : nTrades >= 30 ? "warn" : "fail";
    gates.push({ light, title: "Enough trades", value: fmtInt(nTrades),
      plain: light === "pass"
        ? `${fmtInt(nTrades)} trades is a healthy sample — the stats above mean something.`
        : light === "warn"
        ? `${fmtInt(nTrades)} trades is a thin sample. Metrics can swing on a few trades — don't over-trust them yet.`
        : `Only ${fmtInt(nTrades)} trades. Any great-looking number here is likely noise, not skill.` });
  }

  // 4 — Statistically significant (average trade ≠ 0)
  if (sig == null) {
    gates.push({ light: "na", title: "Distinguishable from zero", value: "—",
      plain: "Not enough trades to run the significance test." });
  } else {
    const light = sig === "significant" ? "pass" : sig === "marginal" ? "warn" : "fail";
    gates.push({ light, title: "Distinguishable from zero",
      value: pval != null ? `p=${fmtNum(pval)}` : sig,
      plain: light === "pass"
        ? "The average trade is statistically different from zero — unlikely to be pure luck."
        : light === "warn"
        ? "Borderline significance. The edge might be real, might be chance — more data would settle it."
        : "The average trade is NOT statistically different from zero. This could easily be luck." });
  }

  // 5 — Beats buy-and-hold
  if (!hasBh) {
    gates.push({ light: "na", title: "Beats buy-and-hold", value: "—",
      plain: "No buy-and-hold benchmark available for these windows." });
  } else {
    const edge = stratReturnPct - bhReturnPct;
    const light = edge > Math.abs(bhReturnPct) * 0.1 && edge > 0 ? "pass" : edge >= 0 ? "warn" : "fail";
    gates.push({ light, title: "Beats buy-and-hold",
      value: `${fmtPct(stratReturnPct)} vs ${fmtPct(bhReturnPct)}`,
      plain: light === "pass"
        ? "The strategy beat simply holding the asset — the complexity earned its keep."
        : light === "warn"
        ? "Roughly ties buy-and-hold. All that machinery bought you little over just holding."
        : "Underperforms buy-and-hold. You'd have done better doing nothing — rethink or shelve it." });
  }

  // 6 — Survives the many-trials penalty (deflated Sharpe)
  if (deflated == null) {
    gates.push({ light: "na", title: "Survives trial-count penalty", value: "—",
      plain: "Deflated Sharpe only applies when optimizing on Sharpe. Switch the metric to Sharpe to judge this." });
  } else {
    const light = deflated >= 0.9 ? "pass" : deflated >= 0.6 ? "warn" : "fail";
    gates.push({ light, title: "Survives trial-count penalty", value: `${fmtNum(deflated * 100)}%`,
      plain: light === "pass"
        ? "Even after penalizing for how many parameter combos were tried, the Sharpe holds up as real."
        : light === "warn"
        ? "The Sharpe partly survives the many-trials penalty, but some of it may be luck-of-search."
        : "Once you account for how many combos were tested, this Sharpe is probably a lucky draw." });
  }

  // 7 — Not luck-dependent (P&L concentration)
  if (top10 == null) {
    gates.push({ light: "na", title: "Not carried by a few trades", value: "—",
      plain: "Not enough winning trades to measure concentration." });
  } else {
    const light = !luckWins && top10 <= 0.5 ? "pass" : top10 <= 0.7 ? "warn" : "fail";
    gates.push({ light, title: "Not carried by a few trades", value: `top10 = ${fmtNum(top10 * 100)}%`,
      plain: light === "pass"
        ? "Profit is spread across many trades, not a couple of jackpots. Repeatable, not lucky."
        : light === "warn"
        ? `The top 10 winners are ${fmtNum(top10 * 100)}% of all profit — leans a bit on a few big trades.`
        : `The top 10 winners are ${fmtNum(top10 * 100)}% of all profit. Remove those and the edge may vanish.` });
  }

  // 8 — Recent decay: are the LATEST windows as good as the earlier ones?
  // Distinct from "holds out-of-sample" (overall green rate): this compares the
  // most recent third of windows against the rest, to catch an edge that worked
  // for years but is fading now — the thing that kills a strategy live.
  if (windows.length < 6) {
    gates.push({ light: "na", title: "No recent decay", value: "—",
      plain: "Too few windows to compare recent vs. earlier performance — run over a longer range." });
  } else {
    const recentN = Math.max(4, Math.round(windows.length * 0.33));
    const earlier = windows.slice(0, windows.length - recentN);
    const recent = windows.slice(windows.length - recentN);
    const greens = (arr) => arr.filter((w) => (w.oos_stats?.sharpe ?? 0) > 0).length;
    const rWins = greens(recent), eWins = greens(earlier);
    const rRate = rWins / recent.length, eRate = eWins / earlier.length;
    const drop = eRate - rRate;
    const light = drop <= 0.1 ? "pass" : drop <= 0.25 ? "warn" : "fail";
    gates.push({ light, title: "No recent decay",
      value: `recent ${fmtNum(rRate * 100)}% vs ${fmtNum(eRate * 100)}%`,
      plain: light === "pass"
        ? `The most recent ${fmtInt(recent.length)} windows (${fmtInt(rWins)} green) hold up against the earlier ones. No sign the edge is fading.`
        : light === "warn"
        ? `The recent ${fmtInt(recent.length)} windows (${fmtInt(rWins)} green) are softer than the earlier stretch (${fmtNum(eRate * 100)}% green). The edge may be starting to fade — watch it.`
        : `The recent ${fmtInt(recent.length)} windows (only ${fmtInt(rWins)} green) are much weaker than the earlier ${fmtNum(eRate * 100)}%. The edge looks like it's decaying — a real red flag for trading it now.` });
  }

  // --- Overall verdict from the data-backed gates ---
  // Reading order matters. "Tuning beat not-tuning" and "Windows agree on the
  // params" can invalidate everything below them: if the search found nothing,
  // a green plateau or a green OOS rate is describing noise. So they lead, and
  // the two that qualify the sample come next. Sorting here rather than moving
  // the blocks keeps each gate's logic where it was written.
  const GATE_ORDER = [
    "Tuning beat not-tuning",
    "Windows agree on the params",
    "Picks rest on a real sample",
    "Parameter plateau",
    "Holds out-of-sample",
    "Enough trades",
    "Distinguishable from zero",
    "Beats buy-and-hold",
    "Survives trial-count penalty",
    "Not carried by a few trades",
    "No recent decay",
  ];
  gates.sort((a, b) => {
    const ia = GATE_ORDER.indexOf(a.title), ib = GATE_ORDER.indexOf(b.title);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const DECISIVE = new Set(GATE_ORDER.slice(0, 2));

  const scored = gates.filter((g) => g.light !== "na");
  const val = { pass: 1, warn: 0.5, fail: 0 };
  const ratio = scored.length ? scored.reduce((a, g) => a + val[g.light], 0) / scored.length : 0;
  const fails = scored.filter((g) => g.light === "fail").map((g) => g.title);
  const warns = scored.filter((g) => g.light === "warn").map((g) => g.title);

  let tone, headline;
  if (ratio >= 0.75 && fails.length === 0) { tone = "profit"; headline = "🟢 Looks Real — a deploy candidate worth the locked-holdout test"; }
  else if (ratio >= 0.5) { tone = "amber"; headline = "🟡 Fragile — has an edge but leans on something; size small and keep watching"; }
  else { tone = "loss"; headline = "🔴 Likely Overfit / Luck — most gates failed; kill or rework before trusting it"; }

  const toneClasses = {
    profit: "border-profit/40 bg-profit/5 text-profit",
    amber:  "border-amber-400/40 bg-amber-400/5 text-amber-400",
    loss:   "border-loss/40 bg-loss/5 text-loss",
  };

  return (
    <section className="space-y-4">
      {/* Too few windows to read a rate off. The green-rate gate is a binomial
          proportion: its standard error is sqrt(0.25/n), so 21 windows carries
          ~±11pp and 60% vs 71% is the same number. Say so before the verdict,
          not after — the Quick Iteration preset lands right in this range. */}
      {windows.length > 0 && windows.length < 30 && (
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-3 text-[11px]">
          <span className="text-amber-400">
            Only {fmtInt(windows.length)} out-of-sample windows — too few to read a verdict from.
          </span>
          <span className="text-muted">
            {" "}The per-window green rate carries a standard error of about
            ±{fmtNum(Math.sqrt(0.25 / windows.length) * 100)} percentage points at this sample size, so most of
            the gates below cannot distinguish a real edge from noise. Fine as a smoke test; re-run on
            Full History before believing any of it.
          </span>
        </div>
      )}

      {/* Headline */}
      <div className={`rounded-xl border p-4 ${toneClasses[tone]}`}>
        <div className="text-[10px] uppercase tracking-wider opacity-70">Overall verdict</div>
        <div className="text-base font-semibold mt-0.5">{headline}</div>
        {(fails.length > 0 || warns.length > 0) && (
          <div className="text-xs font-mono opacity-90 mt-1.5">
            {fails.length > 0 && <>Failing: {fails.join(", ")}. </>}
            {warns.length > 0 && <>Watch: {warns.join(", ")}.</>}
          </div>
        )}
        <div className="text-[11px] text-muted mt-2">
          A verdict, not a guarantee. Read the gates together — full method in docs/plans/validation-checklist.md.
        </div>
      </div>

      {/* Recommended params to deploy (latest re-tune) + current-vs-recommended */}
      <RecommendedParams result={result} stability={stability} />
      <CurrentParams result={result} strategies={strategies} />

      {/* The data-backed gates, most-decisive first */}
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-muted">
          Read these first — they can invalidate everything below
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {gates.filter((g) => DECISIVE.has(g.title)).map((g) => <GateCard key={g.title} {...g} />)}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {gates.filter((g) => !DECISIVE.has(g.title)).map((g) => <GateCard key={g.title} {...g} />)}
      </div>

      {/* When the edge lives — hour-of-day + calendar-month read */}
      <WhereItWorks analytics={result.analytics} />

      {/* Sub-period strip */}
      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-muted">Per-window consistency</div>
        <WindowConsistencyStrip windows={windows} />
        <div className="text-[11px] text-muted">
          Each square is one out-of-sample window, in time order. Green = made money, red = lost. You want a
          mostly-green row, not one green patch doing all the work.
        </div>
      </div>

      {/* The two gates a single run can't judge — reminders, never auto-green */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <GateCard light="na" title="Locked holdout (do this last)" value="manual"
          plain="Reserve the most recent ~6–12 months, never touch it during research, then run the finished strategy on it exactly once. The only data your tuning never saw — the strongest test there is." />
        <GateCard light="na" title="Cross-strategy honesty" value="manual"
          plain="Deflated Sharpe only penalizes trials within THIS run. It doesn't know how many other strategies / symbols / timeframes you tried. The more you've tested, the higher this winner must clear the bar." />
      </div>
    </section>
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

export function WindowHeatmap({ windows, searchSpace, onCheckMonteCarlo }) {
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
        <div className="pt-2 border-t border-line/30 space-y-2">
          <WindowCard w={windows.find((w) => w.window_idx === selectedIdx)} />
          {onCheckMonteCarlo && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onCheckMonteCarlo(windows.find((w) => w.window_idx === selectedIdx))}
                className="px-3 py-1.5 rounded-md text-xs font-semibold border border-accent-blue/50 text-accent-blue hover:bg-accent-blue/10 transition"
                title="Robustness-test this window's params over its OOS range in Monte Carlo"
              >
                Check Monte Carlo →
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// -- Hour-of-day / monthly performance ---------------------------------------

// Cells backed by fewer trades than this are drawn muted and excluded from the
// "where it works" summary: an hour with 2 trades and a great average is noise
// wearing a good number, and it would otherwise top every ranking.
const THIN_TRADES = 5;

/**
 * Collapse the backend's 7×24 [dow][hour] grids into 24 hourly buckets.
 * Returns [{hour, pnl, trades, avg}] where avg is $ per trade — the metric that
 * shows the real edge, rather than which hour simply traded most.
 */
export function useHourBuckets(pnlGrid, cntGrid) {
  return useMemo(() => {
    const out = Array.from({ length: 24 }, (_, hour) => ({ hour, pnl: 0, trades: 0, avg: 0 }));
    for (let d = 0; d < (pnlGrid?.length || 0); d++) {
      for (let h = 0; h < 24; h++) {
        out[h].pnl += Number(pnlGrid[d]?.[h] || 0);
        out[h].trades += Number(cntGrid?.[d]?.[h] || 0);
      }
    }
    for (const b of out) b.avg = b.trades > 0 ? b.pnl / b.trades : 0;
    return out;
  }, [pnlGrid, cntGrid]);
}

// Shared red↔green cell fill, scaled to the largest magnitude in the set.
function heatFill(v, max, thin) {
  if (!v) return "rgba(255,255,255,0.03)";
  const a = Math.min(1, Math.abs(v) / Math.max(1e-9, max));
  const alpha = (thin ? 0.06 : 0.15) + (thin ? 0.16 : 0.6) * a;
  return v > 0 ? `rgba(34,197,94,${alpha})` : `rgba(239,68,68,${alpha})`;
}

/**
 * Hour-of-day strip — 24 buckets, 00:00 → 23:59 UTC, coloured by AVERAGE P&L
 * per trade. Replaces the old Session Breakdown table, which needed a
 * hand-maintained session config to say anything and silently mislabelled
 * itself whenever that config drifted from what the strategy actually traded.
 * This needs no configuration and cannot disagree with the run.
 */
export function HourOfDayStrip({ pnlGrid, cntGrid }) {
  const buckets = useHourBuckets(pnlGrid, cntGrid);
  // Second header row in the reader's own timezone. Buckets stay UTC — this
  // only relabels them, so a PH reader can see that "14:00 UTC" is their 22:00.
  const tz = useDisplayTz();
  const localTz = tz && tz !== "Etc/UTC" ? tz : "Asia/Manila";
  const localLabel = tzShort(localTz);
  const maxAbs = Math.max(...buckets.filter((b) => b.trades >= THIN_TRADES).map((b) => Math.abs(b.avg)), 0);
  const totalTrades = buckets.reduce((a, b) => a + b.trades, 0);
  if (!totalTrades) return null;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 overflow-x-auto">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <span className="text-[11px] uppercase tracking-wider text-muted">
          Hour of day (UTC) — average P&amp;L per trade
        </span>
        <span className="text-[10px] text-muted/70">
          00:00 → 23:59 UTC · second row = {localLabel} · colour = $ per trade · hours under {fmtInt(THIN_TRADES)} trades are muted
        </span>
      </div>
      <table className="text-[10px] font-mono border-separate border-spacing-0.5 min-w-full">
        <thead>
          <tr>
            <th className="px-1 text-muted text-right w-14 font-normal">UTC</th>
            {buckets.map((b) => (
              <th key={b.hour} className="text-center text-muted w-9 font-normal">
                {String(b.hour).padStart(2, "0")}
              </th>
            ))}
          </tr>
          <tr>
            <th className="px-1 text-muted/50 text-right font-normal">{localLabel}</th>
            {buckets.map((b) => (
              <th key={b.hour} className="text-center text-muted/40 font-normal">
                {convertUtcHHmm(`${String(b.hour).padStart(2, "0")}:00`, localTz).slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-1 text-muted text-right">avg $</td>
            {buckets.map((b) => {
              const thin = b.trades < THIN_TRADES;
              return (
                <td
                  key={b.hour}
                  className={`text-center rounded h-9 align-middle ${thin ? "text-muted/40" : "text-text"}`}
                  style={{ backgroundColor: heatFill(b.avg, maxAbs, thin) }}
                  title={`${String(b.hour).padStart(2, "0")}:00–${String(b.hour).padStart(2, "0")}:59 UTC\n${fmtInt(b.trades)} trades\ntotal ${fmtUsd(b.pnl)}\navg ${fmtUsd(b.avg)}/trade${thin ? "\n(too few trades to trust)" : ""}`}
                >
                  {b.trades ? fmtNum(b.avg) : "·"}
                </td>
              );
            })}
          </tr>
          <tr>
            <td className="px-1 text-muted/60 text-right">trades</td>
            {buckets.map((b) => (
              <td key={b.hour} className="text-center text-muted/50">{b.trades || "·"}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Where this actually works" — a plain-English read of WHEN the edge lives,
 * from the same hour and month data the heatmaps draw.
 *
 * Deliberately conservative. Hours under THIN_TRADES trades are excluded
 * entirely, and the summary refuses to name a "best window" when the profitable
 * hours are scattered rather than adjacent — a strategy that makes money at
 * 03:00, 11:00 and 19:00 has no time-of-day edge, it has noise, and saying
 * otherwise would invite exactly the kind of curve-fit this page exists to catch.
 */
export function WhereItWorks({ analytics }) {
  const pnlGrid = analytics?.heatmap?.pnl || [];
  const cntGrid = analytics?.heatmap?.count || [];
  const buckets = useHourBuckets(pnlGrid, cntGrid);
  const m = useMonthlyMatrix(analytics?.monthly_returns);

  const usable = buckets.filter((b) => b.trades >= THIN_TRADES);
  const totalTrades = buckets.reduce((a, b) => a + b.trades, 0);
  if (!totalTrades) return null;

  const winners = usable.filter((b) => b.avg > 0).sort((a, b) => b.avg - a.avg);
  const losers = usable.filter((b) => b.avg < 0).sort((a, b) => a.avg - b.avg);
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;

  // Are the profitable hours clustered into one block, or scattered? Contiguous
  // (with wrap-around at midnight) is the only version worth calling a "window".
  const winSet = new Set(winners.map((b) => b.hour));
  let bestRun = { len: 0, start: null };
  if (winSet.size === 24) {
    // Every hour positive: there is no "start" to find (the ring has no gap),
    // so detect it directly rather than falling through to "scattered".
    bestRun = { len: 24, start: 0 };
  } else if (winSet.size) {
    for (let s = 0; s < 24; s++) {
      if (!winSet.has(s) || winSet.has((s + 23) % 24)) continue;   // only run starts
      let len = 0;
      while (len < 24 && winSet.has((s + len) % 24)) len++;
      if (len > bestRun.len) bestRun = { len, start: s };
    }
  }
  const allDay = bestRun.len === 24;
  const clustered = bestRun.len >= 3 && bestRun.len >= winSet.size * 0.6;

  // Share of gross profit earned inside that block — a run of hours that is
  // "positive" but contributes little is not where the strategy works.
  let blockShare = null;
  if (clustered) {
    const inBlock = (h) => {
      const d = (h - bestRun.start + 24) % 24;
      return d < bestRun.len;
    };
    const gross = buckets.reduce((a, b) => a + Math.max(0, b.pnl), 0);
    const got = buckets.filter((b) => inBlock(b.hour)).reduce((a, b) => a + b.pnl, 0);
    blockShare = gross > 0 ? got / gross : null;
  }

  const bestMonths = m
    ? m.seasonalAvg.map((v, i) => ({ i, v, n: m.seasonalN[i] })).filter((x) => x.v != null && x.n >= 2)
    : [];
  const goodMonths = bestMonths.filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const badMonths = bestMonths.filter((x) => x.v < 0).sort((a, b) => a.v - b.v);

  const posYears = m ? m.yearTotals.filter((v) => v != null && v > 0).length : 0;
  const totYears = m ? m.yearTotals.filter((v) => v != null).length : 0;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-muted">Where this actually works</div>

      {usable.length === 0 ? (
        <div className="text-[11px] text-amber-400">
          No hour of the day has at least {fmtInt(THIN_TRADES)} trades. The book is spread too thin to say
          when this works — that itself is a warning about sample size.
        </div>
      ) : allDay ? (
        <div className="text-[11px] text-text">
          Profitable in <span className="text-profit">every hour</span> of the day that has a usable
          sample. No time-of-day concentration — the edge, if real, is not a session effect.
        </div>
      ) : clustered ? (
        <div className="text-[11px] text-text">
          Concentrated in <span className="font-mono text-profit">
            {hh(bestRun.start)} – {hh((bestRun.start + bestRun.len) % 24)} UTC
          </span>{" "}
          — {fmtInt(bestRun.len)} consecutive hours, all profitable
          {blockShare != null && <> , carrying {fmtNum(blockShare * 100)}% of gross profit</>}.
          {" "}That is a real time-of-day pattern worth checking against a session you can actually trade.
        </div>
      ) : winners.length ? (
        <div className="text-[11px] text-amber-400">
          The profitable hours are <span className="text-text">scattered</span>, not clustered
          ({winners.slice(0, 5).map((b) => hh(b.hour)).join(", ")}
          {winners.length > 5 ? ", …" : ""}). With no contiguous block, there is no time-of-day edge here —
          just noise that happens to land on some hours. Don&apos;t build a session filter from this.
        </div>
      ) : (
        <div className="text-[11px] text-loss">
          No hour with a usable sample is profitable on average. There is no time of day where this works.
        </div>
      )}

      {losers.length > 0 && usable.length > 0 && (
        <div className="text-[11px] text-muted">
          Worst hours: {losers.slice(0, 3).map((b) => (
            <span key={b.hour} className="font-mono">
              {hh(b.hour)} ({fmtUsd(b.avg)}/trade, {fmtInt(b.trades)} trades){" "}
            </span>
          ))}
        </div>
      )}

      {totYears > 0 && (
        <div className="text-[11px] text-muted">
          Across calendar years: <span className="text-text">{fmtInt(posYears)} of {fmtInt(totYears)}</span> were
          profitable.
          {goodMonths.length > 0 && (
            <> Strongest months on average: <span className="text-profit font-mono">
              {goodMonths.slice(0, 3).map((x) => MONTH_ABBR[x.i]).join(", ")}</span>.</>
          )}
          {badMonths.length > 0 && (
            <> Weakest: <span className="text-loss font-mono">
              {badMonths.slice(0, 3).map((x) => MONTH_ABBR[x.i]).join(", ")}</span>.</>
          )}
          {bestMonths.length === 0 && <> Not enough years yet to say anything about seasonality.</>}
        </div>
      )}

      <div className="text-[10px] text-muted/60">
        Read this as a description of the past, not a filter to apply. Slicing a strategy down to its best
        hours after seeing which they were is curve-fitting — if you act on it, it needs its own walk-forward.
      </div>
    </div>
  );
}

/**
 * Build the year × month matrix from analytics.monthly_returns.
 *
 * Each month's % return is measured against the equity it OPENED with
 * (`equity_start`), not against starting capital — dividing by starting capital
 * inflates every month once the curve compounds. The backend already tracks
 * that per month; we only divide here.
 */
export function useMonthlyMatrix(monthlyReturns) {
  return useMemo(() => {
    const rows = (monthlyReturns || []).filter((m) => typeof m?.month === "string");
    if (!rows.length) return null;
    const byYear = new Map();
    const seasonal = Array.from({ length: 12 }, () => []);
    for (const r of rows) {
      const [ys, ms] = r.month.split("-");
      const y = parseInt(ys, 10);
      const mi = parseInt(ms, 10) - 1;
      if (!Number.isFinite(y) || mi < 0 || mi > 11) continue;
      const base = Number(r.equity_start) || 0;
      const pct = base > 0 ? (Number(r.pnl_dollars) || 0) / base * 100 : null;
      if (!byYear.has(y)) byYear.set(y, Array.from({ length: 12 }, () => null));
      byYear.get(y)[mi] = { pct, pnl: Number(r.pnl_dollars) || 0, trades: Number(r.trades) || 0 };
      if (pct != null) seasonal[mi].push(pct);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    // A year's total compounds its months — summing percentages would drift.
    const yearTotals = years.map((y) => {
      const cells = byYear.get(y);
      let v = 1, any = false;
      for (const c of cells) if (c && c.pct != null) { v *= 1 + c.pct / 100; any = true; }
      return any ? (v - 1) * 100 : null;
    });
    const seasonalAvg = seasonal.map((xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null));
    const seasonalN = seasonal.map((xs) => xs.length);
    return { years, byYear, yearTotals, seasonalAvg, seasonalN };
  }, [monthlyReturns]);
}

/** Year × month % returns, plus a seasonality row averaging each calendar month. */
export function MonthlyReturnsHeatmap({ monthlyReturns }) {
  const m = useMonthlyMatrix(monthlyReturns);
  if (!m || !m.years.length) return null;

  const all = [];
  for (const y of m.years) for (const c of m.byYear.get(y)) if (c && c.pct != null) all.push(Math.abs(c.pct));
  const maxAbs = Math.max(...all, 0);

  const cellCls = "text-center rounded h-8 align-middle w-14";

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 overflow-x-auto">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <span className="text-[11px] uppercase tracking-wider text-muted">Monthly performance</span>
        <span className="text-[10px] text-muted/70">
          each month vs. the equity it opened with · year totals compound their months
        </span>
      </div>
      <table className="text-[10px] font-mono border-separate border-spacing-0.5">
        <thead>
          <tr>
            <th className="px-1 text-muted text-right w-12 font-normal" />
            {MONTH_ABBR.map((mo) => (
              <th key={mo} className="text-center text-muted w-14 font-normal">{mo}</th>
            ))}
            <th className="text-center text-muted w-16 font-normal border-l border-line/40 pl-1">Year</th>
          </tr>
        </thead>
        <tbody>
          {m.years.map((y, yi) => (
            <tr key={y}>
              <td className="px-1 text-muted text-right">{y}</td>
              {m.byYear.get(y).map((c, mi) => (
                <td
                  key={mi}
                  className={`${cellCls} ${c && c.pct != null ? "text-text" : "text-muted/30"}`}
                  style={{ backgroundColor: c && c.pct != null ? heatFill(c.pct, maxAbs, false) : "transparent" }}
                  title={c && c.pct != null
                    ? `${MONTH_ABBR[mi]} ${y}\n${fmtPct(c.pct)}\n${fmtUsd(c.pnl)} over ${fmtInt(c.trades)} trades`
                    : `${MONTH_ABBR[mi]} ${y} — no trades`}
                >
                  {c && c.pct != null ? fmtNum(c.pct) : "·"}
                </td>
              ))}
              <td className={`${cellCls} border-l border-line/40 ${
                m.yearTotals[yi] == null ? "text-muted/30" : m.yearTotals[yi] >= 0 ? "text-profit" : "text-loss"}`}>
                {m.yearTotals[yi] == null ? "·" : fmtNum(m.yearTotals[yi])}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={14} className="pt-1">
              <div className="border-t border-line/40" />
            </td>
          </tr>
          <tr>
            <td className="px-1 text-muted text-right" title="Average of that calendar month across every year">avg</td>
            {m.seasonalAvg.map((v, mi) => (
              <td
                key={mi}
                className={`${cellCls} ${v == null ? "text-muted/30" : v >= 0 ? "text-profit" : "text-loss"}`}
                style={{ backgroundColor: v == null ? "transparent" : heatFill(v, maxAbs, m.seasonalN[mi] < 2) }}
                title={v == null
                  ? `${MONTH_ABBR[mi]} — no data`
                  : `${MONTH_ABBR[mi]} averaged over ${fmtInt(m.seasonalN[mi])} year(s)\n${fmtPct(v)}${m.seasonalN[mi] < 2 ? "\n(only one year — not seasonality yet)" : ""}`}
              >
                {v == null ? "·" : fmtNum(v)}
              </td>
            ))}
            <td className="border-l border-line/40" />
          </tr>
        </tbody>
      </table>
      <div className="text-[10px] text-muted/60 mt-2">
        The <span className="text-text">avg</span> row pools each calendar month across years. With only one or two
        years of data it is a coincidence, not a season — it needs several years before it means anything.
      </div>
    </div>
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
