const SPEEDS = [1, 10, 60, 300, 1000, 3000];

export default function SpeedControl({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Speed</span>
      <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => onChange(s)}
            className={`px-3 py-1.5 text-sm font-mono rounded-md transition ${
              value === s
                ? "bg-accent-grad text-white"
                : "text-muted hover:text-text"
            }`}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
