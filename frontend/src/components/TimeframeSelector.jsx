const TFS = ["1m", "5m", "15m", "1h"];

export default function TimeframeSelector({ value, onChange, available }) {
  // `available` (optional) restricts which TFs are clickable.
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Timeframe</span>
      <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel">
        {TFS.map((t) => {
          const enabled = !available || available.includes(t);
          return (
            <button
              key={t}
              onClick={() => enabled && onChange(t)}
              disabled={!enabled}
              title={enabled ? "" : "no dataset downloaded for this timeframe"}
              className={`px-3 py-1.5 text-sm font-mono rounded-md transition ${
                value === t
                  ? "bg-accent-grad text-white"
                  : enabled
                  ? "text-muted hover:text-text"
                  : "text-muted/30 cursor-not-allowed"
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
}
