import { useMemo, useRef, useState } from "react";
import { fmtInt } from "../services/format.js";

/**
 * Deterministic Walk-Forward test presets — no AI, no hallucinations.
 *
 * Each preset computes range / IS / OOS / trials / metric directly from the
 * active dataset's first_time / last_time and the chosen timeframe. The values
 * are previewed in the modal before the user clicks "Use this", so they can
 * see exactly what the strategy will do.
 *
 * Props:
 *   dataset:    {symbol, timeframe, rows, first_time, last_time} | null
 *   timeframe:  "1m" | "5m" | "15m" | "1h" | ...
 *   onApply:    ({start, end, isBars, oosBars, nTrials, metric}) => void
 *   disabled:   bool — true while a job is running
 */
export default function WalkForwardPresetPicker({ dataset, timeframe, onApply, disabled }) {
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const computedPresets = useMemo(() => {
    if (!dataset || !timeframe) return [];
    return PRESETS.map((p) => ({ ...p, values: p.compute(dataset, timeframe) }))
      .filter((p) => p.values);
  }, [dataset, timeframe]);

  const activePreset = computedPresets.find((p) => p.id === openId) || null;

  const handleApply = (preset, values) => {
    onApply(values);
    setOpenId(null);
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), name: preset.name });
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  };

  if (!dataset) {
    return (
      <div className="rounded-md border border-line/40 bg-bg-elev/30 px-3 py-2 text-xs text-muted">
        Pick a symbol + timeframe with downloaded data to see test presets.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">Test Presets · deterministic, no AI</div>
        <div className="text-[10px] font-mono text-muted/70">
          {fmtInt(dataset.rows)} bars available
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {computedPresets.map((p) => (
          <PresetCard
            key={p.id}
            preset={p}
            disabled={disabled}
            onOpenModal={() => setOpenId(p.id)}
            onQuickApply={(e) => handleApply(p, p.values, e)}
          />
        ))}
      </div>

      {activePreset && (
        <PresetModal
          preset={activePreset}
          onClose={() => setOpenId(null)}
          onApply={() => handleApply(activePreset, activePreset.values)}
          disabled={disabled}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          className="preset-toast pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-accent-blue/40 bg-bg-panel shadow-2xl text-sm font-medium text-text"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-accent-blue shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.78 4.923a.75.75 0 0 0-1.06 0L6.75 8.89 5.28 7.423a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5a.75.75 0 0 0 0-1.06Z" />
          </svg>
          Preset applied: <span className="text-accent-blue">{toast.name}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PresetCard({ preset, disabled, onOpenModal, onQuickApply }) {
  const v = preset.values;
  const [ripples, setRipples] = useState([]);

  const handleClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = Date.now();
    setRipples((prev) => [...prev, { id, x, y }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 600);
    onQuickApply(e);
  };

  return (
    <div className="rounded-md border border-line/60 bg-bg-elev/30 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-text leading-tight">{preset.name}</div>
        <button
          onClick={onOpenModal}
          className="shrink-0 w-5 h-5 rounded-full bg-accent-blue/15 text-accent-blue text-[10px] font-bold flex items-center justify-center hover:bg-accent-blue/25"
          title="What does this do?"
        >
          ?
        </button>
      </div>
      <div className="text-[11px] text-muted leading-snug min-h-[2.5em]">{preset.tagline}</div>
      <div className="text-[10px] font-mono text-muted/80 pt-1 border-t border-line/30 space-y-0.5">
        <div>IS {fmtInt(v.isBars)}b · OOS {fmtInt(v.oosBars)}b</div>
        <div>~{fmtInt(v.expectedWindows)} windows · {v.nTrials} trials</div>
      </div>
      <button
        onClick={handleClick}
        disabled={disabled}
        className="relative overflow-hidden w-full mt-1 px-2 py-1 rounded text-[11px] font-semibold bg-accent-grad text-white disabled:opacity-40"
      >
        Use this
        {ripples.map((r) => (
          <span
            key={r.id}
            className="ripple-circle"
            style={{ left: r.x, top: r.y }}
          />
        ))}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PresetModal({ preset, onClose, onApply, disabled }) {
  const v = preset.values;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[560px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-xl border border-line bg-bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-accent-blue">Test Preset</div>
            <h3 className="text-base font-semibold mt-0.5">{preset.name}</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-text leading-relaxed">{preset.description}</p>

          <Section title="When to use">
            <ul className="text-xs text-muted leading-relaxed list-disc pl-4 space-y-0.5">
              {preset.whenToUse.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          </Section>

          {preset.whenNotToUse?.length > 0 && (
            <Section title="When NOT to use">
              <ul className="text-xs text-muted leading-relaxed list-disc pl-4 space-y-0.5">
                {preset.whenNotToUse.map((it, i) => <li key={i}>{it}</li>)}
              </ul>
            </Section>
          )}

          <Section title="Exact values this preset will apply">
            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
              <KV k="Range start" v={v.start || "—"} />
              <KV k="Range end"   v={v.end || "—"} />
              <KV k="IS bars"     v={fmtInt(v.isBars)} />
              <KV k="OOS bars"    v={fmtInt(v.oosBars)} />
              <KV k="Trials/win"  v={fmtInt(v.nTrials)} />
              <KV k="Metric"      v={v.metric} />
              <KV k="Expected windows" v={`~${fmtInt(v.expectedWindows)}`} />
              <KV k="Backtest range"   v={`~${v.rangeDays} days`} />
            </div>
          </Section>
        </div>

        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md text-muted hover:text-text">
            Cancel
          </button>
          <button
            onClick={onApply}
            disabled={disabled}
            className="px-4 py-2 text-sm rounded-md font-semibold bg-accent-grad text-white disabled:opacity-40"
          >
            Use this preset
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{title}</div>
      {children}
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-line/40 bg-bg-elev/30 px-2 py-1">
      <span className="text-muted text-[10px] uppercase">{k}</span>
      <span className="text-text">{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset definitions — pure functions of (dataset, timeframe).
// ---------------------------------------------------------------------------

const TF_BARS_PER_DAY = {
  "1m": 1440, "5m": 288, "15m": 96, "30m": 48, "1h": 24, "2h": 12,
  "4h": 6, "6h": 4, "8h": 3, "12h": 2, "1d": 1,
};

function barsForDays(days, tf) {
  const perDay = TF_BARS_PER_DAY[tf] || 96;
  return Math.max(1, Math.round(days * perDay));
}

function epochToDateStr(epoch) {
  if (epoch == null || !Number.isFinite(epoch)) return "";
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

function daysBetween(startEpoch, endEpoch) {
  return Math.max(0, Math.round((endEpoch - startEpoch) / 86400));
}

const PRESETS = [
  {
    id: "full",
    name: "Full History",
    tagline: "Train on everything. Most regimes, most windows. Best first-pass discovery.",
    description:
      "Uses the entire downloaded dataset. Walk-Forward rolls a 180-day in-sample window across the full span, evaluating each on the next 30 days out-of-sample. Captures bull, bear, and chop regimes — at the cost of including possibly-stale early data.",
    whenToUse: [
      "First time testing this strategy — you want to see how it behaves across all market regimes.",
      "You want maximum statistical power (more OOS windows = tighter confidence on results).",
    ],
    whenNotToUse: [
      "You believe early-era data (e.g. pre-2022 crypto, low liquidity) doesn't reflect today's market.",
      "You want a fast iteration loop — this runs the most windows.",
    ],
    compute: (ds, tf) => {
      const isBars = barsForDays(180, tf);
      const oosBars = barsForDays(30, tf);
      const totalDays = daysBetween(ds.first_time, ds.last_time);
      const windows = Math.max(2, Math.floor((ds.rows - isBars) / oosBars));
      return {
        start: epochToDateStr(ds.first_time),
        end:   epochToDateStr(ds.last_time),
        isBars, oosBars,
        nTrials: 50,
        metric: "sharpe",
        expectedWindows: windows,
        rangeDays: totalDays,
      };
    },
  },
  {
    id: "holdout",
    name: "Live-Test Holdout",
    tagline: "Reserve the last 90 days as a final unseen check. Most honest pre-deploy test.",
    description:
      "Uses all data except the most recent 90 days, which you reserve as a hold-out. Run WF normally, then run a one-shot backtest on the held-out tail (do this manually after) to see how the strategy would have behaved on data the optimizer *never saw*. This is the closest thing a backtest gets to a live-deploy estimate.",
    whenToUse: [
      "You're close to deploying live and want one final honest gut-check.",
      "You suspect you may be implicitly tuning to recent market conditions.",
    ],
    whenNotToUse: [
      "You want to use every bit of data for the optimizer (e.g. shorter datasets).",
      "You're still in early experimentation — save this for the final pass.",
    ],
    compute: (ds, tf) => {
      const isBars = barsForDays(180, tf);
      const oosBars = barsForDays(30, tf);
      const holdoutDays = 90;
      const adjustedEnd = ds.last_time - holdoutDays * 86400;
      if (adjustedEnd <= ds.first_time) return null;  // dataset too small
      const totalDays = daysBetween(ds.first_time, adjustedEnd);
      const usableBars = ds.rows - barsForDays(holdoutDays, tf);
      const windows = Math.max(2, Math.floor((usableBars - isBars) / oosBars));
      return {
        start: epochToDateStr(ds.first_time),
        end:   epochToDateStr(adjustedEnd),
        isBars, oosBars,
        nTrials: 50,
        metric: "sharpe",
        expectedWindows: windows,
        rangeDays: totalDays,
      };
    },
  },
  {
    id: "recent",
    name: "Recent Regime",
    tagline: "Last 3 years only. Skips early thin-volume era. More relevant to today's market.",
    description:
      "Uses only the last 3 years of data, with a tighter 90-day IS / 14-day OOS to keep window count up. Skips pre-2022 crypto market structure (thin liquidity, missing perp markets, pre-ETF flow patterns). Trade-off: less regime diversity, smaller statistical sample.",
    whenToUse: [
      "You believe pre-2022 crypto behavior is fundamentally different from now.",
      "You want results that reflect post-FTX, post-ETF market structure.",
      "You're testing on a recently-listed asset where early data is sparse.",
    ],
    whenNotToUse: [
      "Your dataset is already <3 years — this collapses into Full History.",
      "You want to see how the strategy held up across bear cycles.",
    ],
    compute: (ds, tf) => {
      const years = 3;
      const adjustedStart = Math.max(ds.first_time, ds.last_time - years * 365.25 * 86400);
      const isBars = barsForDays(90, tf);
      const oosBars = barsForDays(14, tf);
      const totalDays = daysBetween(adjustedStart, ds.last_time);
      const usableBars = barsForDays(totalDays, tf);
      const windows = Math.max(2, Math.floor((usableBars - isBars) / oosBars));
      return {
        start: epochToDateStr(adjustedStart),
        end:   epochToDateStr(ds.last_time),
        isBars, oosBars,
        nTrials: 50,
        metric: "sharpe",
        expectedWindows: windows,
        rangeDays: totalDays,
      };
    },
  },
  {
    id: "quick",
    name: "Quick Iteration",
    tagline: "Last 12 months, fewer trials. Fast feedback while you tune the search space.",
    description:
      "Last 12 months only. 60-day IS / 14-day OOS, 20 trials per window — designed for tight iteration loops. Useful when you're actively experimenting with the search space or fixed parameters and need answers in 1-2 minutes. Don't trust the result as final — the sample is small.",
    whenToUse: [
      "You're tuning the search space and want fast directional answers.",
      "You're sanity-checking a code change you made to the strategy.",
    ],
    whenNotToUse: [
      "Final pre-deploy validation — too little data, too few windows.",
      "Claiming the strategy is 'profitable' — 12 months can be one favorable regime.",
    ],
    compute: (ds, tf) => {
      const adjustedStart = Math.max(ds.first_time, ds.last_time - 365 * 86400);
      const isBars = barsForDays(60, tf);
      const oosBars = barsForDays(14, tf);
      const totalDays = daysBetween(adjustedStart, ds.last_time);
      const usableBars = barsForDays(totalDays, tf);
      const windows = Math.max(2, Math.floor((usableBars - isBars) / oosBars));
      return {
        start: epochToDateStr(adjustedStart),
        end:   epochToDateStr(ds.last_time),
        isBars, oosBars,
        nTrials: 20,
        metric: "sharpe",
        expectedWindows: windows,
        rangeDays: totalDays,
      };
    },
  },
];
