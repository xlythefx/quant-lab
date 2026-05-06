export default function DateRangePicker({ start, end, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Range</span>
      <input
        type="date"
        value={start || ""}
        onChange={(e) => onChange({ start: e.target.value, end })}
        className="px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
      />
      <span className="text-xs text-muted">→</span>
      <input
        type="date"
        value={end || ""}
        onChange={(e) => onChange({ start, end: e.target.value })}
        className="px-2 py-1.5 text-sm font-mono rounded-md bg-bg-panel border border-line focus:outline-none focus:border-accent-blue"
      />
    </div>
  );
}
