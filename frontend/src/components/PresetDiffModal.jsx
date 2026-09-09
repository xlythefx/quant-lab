import { useMemo } from "react";
import { fmtParamValue, diffParams } from "../services/paramFormat.js";
import { fmtPct, fmtDateLong } from "../services/format.js";

/**
 * "Here's what loading this preset changes" — shown before a preset is applied.
 *
 * Why it exists: applying a preset used to silently overwrite every param at
 * once, so a set you'd carefully tuned could vanish with no record of what moved.
 * This makes the swap legible — `vwma_length 30 → 45` — before you commit to it.
 *
 * It also carries the preset's PROVENANCE. A param set is only evidence about
 * the instrument and timeframe it was tuned on; loading a BTCUSDT 15m set onto
 * ES 5m is not a shortcut, it's a different (untested) strategy. When the
 * preset's origin doesn't match where you're about to apply it, that's an amber
 * warning here rather than a silent success.
 *
 * Props:
 *   open        bool
 *   name        preset name
 *   before      current params (the draft you're replacing)
 *   after       the preset's params
 *   meta        provenance {symbol, timeframe, source, created, oos_return_pct}
 *   symbol/timeframe  where it's about to be applied (for the mismatch check)
 *   onConfirm() / onCancel()
 */
export default function PresetDiffModal({
  open, name, before, after, meta, symbol, timeframe, onConfirm, onCancel,
}) {
  const changes = useMemo(() => diffParams(before, after), [before, after]);

  if (!open) return null;

  const unchanged = Object.keys(after || {}).length - changes.length;
  const m = meta || {};
  // Only flag a mismatch when we actually know both sides — an untagged preset
  // (saved before provenance existed) gets no warning it can't justify.
  const symMismatch = !!(m.symbol && symbol && m.symbol !== symbol);
  const tfMismatch = !!(m.timeframe && timeframe && m.timeframe !== timeframe);
  const mismatch = symMismatch || tfMismatch;
  const origin = [m.symbol, m.timeframe].filter(Boolean).join(" · ");
  const here = [symbol, timeframe].filter(Boolean).join(" · ");

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-[520px] max-w-[94vw] rounded-xl border border-line bg-bg-panel shadow-2xl flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-line">
          <h3 className="text-base font-semibold">
            Load preset <span className="font-mono text-accent-blue">{name}</span>
          </h3>
          <p className="text-[11px] text-muted mt-0.5">
            {changes.length === 0
              ? "Nothing changes — the current params already match this preset."
              : `${changes.length} param${changes.length === 1 ? "" : "s"} change${unchanged > 0 ? `, ${unchanged} stay the same` : ""}.`}
          </p>
        </div>

        {/* Provenance strip — where this preset came from, and what it earned. */}
        {(origin || m.source || m.oos_return_pct != null) && (
          <div className="px-5 py-2.5 border-b border-line/60 bg-bg-elev/30 text-[11px] space-y-1">
            <div className="text-muted">
              {m.source === "walkforward" ? "Walk-forward deploy candidate" : "Saved preset"}
              {origin && <> · tuned on <span className="font-mono text-text">{origin}</span></>}
              {m.created ? <> · {fmtDateLong(m.created)}</> : null}
            </div>
            {m.oos_return_pct != null && (
              <div className={m.oos_return_pct > 0 ? "text-profit" : "text-loss"}>
                Held fixed over its out-of-sample span it returned {fmtPct(m.oos_return_pct)}.
              </div>
            )}
          </div>
        )}

        {mismatch && (
          <div className="px-5 py-2.5 border-b border-line/60 bg-amber-400/5 text-[11px] text-amber-400">
            This preset was tuned on <span className="font-mono">{origin}</span> — you are applying it to{" "}
            <span className="font-mono">{here}</span>. Those numbers are evidence about the instrument they
            were fitted on, not this one. Re-validate before trusting it here.
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {changes.length === 0 ? (
            <div className="text-sm text-muted text-center py-6">No differences.</div>
          ) : (
            <div className="space-y-1.5">
              {changes.map((c) => (
                <div key={c.name} className="flex items-center gap-3 rounded-md border border-line/60 bg-bg-elev/30 px-3 py-2">
                  <div className="text-[11px] font-mono text-muted flex-1 min-w-0 truncate" title={c.name}>{c.name}</div>
                  <div className="flex items-center gap-2 shrink-0 font-mono text-sm">
                    <span className="text-muted/70">{c.added ? "unset" : fmtParamValue(c.from)}</span>
                    <span className="text-muted/50">→</span>
                    <span className="text-amber-400">{fmtParamValue(c.to)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-line flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-1.5 rounded-md border border-line text-sm text-muted hover:text-text">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-semibold"
          >
            {changes.length === 0 ? "Load anyway" : "Apply changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
