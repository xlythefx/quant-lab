/**
 * Small auto-generated interpretation note. `text` is built by
 * metrics.interpretation() from finite values only — never fabricated.
 */
export default function InterpretationCard({ text }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-violet">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span className="text-[10px] uppercase tracking-widest text-muted">Interpretation</span>
      </div>
      <p className="text-sm text-text/85 leading-relaxed">{text}</p>
      <p className="text-[10px] text-muted/70 mt-2 italic">
        Auto-generated from computed metrics — a descriptive summary, not investment advice.
      </p>
    </div>
  );
}
