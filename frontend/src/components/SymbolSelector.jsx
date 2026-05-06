export default function SymbolSelector({ value, options = [], onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Symbol</span>
      {options.length === 0 ? (
        <span className="text-xs text-muted italic">
          no datasets — <a href="#downloads" className="text-accent-blue hover:underline">download one</a>
        </span>
      ) : (
        <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel max-w-[60vw] overflow-x-auto">
          {options.map((s) => (
            <button
              key={s}
              onClick={() => onChange(s)}
              className={`px-3 py-1.5 text-sm font-mono rounded-md transition whitespace-nowrap ${
                value === s
                  ? "bg-accent-grad text-white"
                  : "text-muted hover:text-text"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
