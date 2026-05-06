const OPTS = [
  { id: "hindsight", label: "Hindsight" },
  { id: "replay",    label: "Replay"    },
];

export default function BacktestKindToggle({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Kind</span>
      <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel">
        {OPTS.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={`px-3 py-1.5 text-sm rounded-md transition ${
              value === o.id
                ? "bg-accent-grad text-white"
                : "text-muted hover:text-text"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
