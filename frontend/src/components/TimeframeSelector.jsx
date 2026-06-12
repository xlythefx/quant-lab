const TFS = ["1m", "3m", "5m", "6m", "10m", "12m", "15m", "23m", "30m", "46m", "1h", "2h", "4h", "1d"];

export default function TimeframeSelector({ value, onChange, available }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Timeframe</span>
      <select
        value={value || "15m"}
        onChange={(e) => onChange(e.target.value)}
        className="px-2.5 py-1.5 text-sm font-mono rounded-md border border-line bg-bg-panel text-text hover:bg-bg-elev focus:outline-none focus:border-accent-blue cursor-pointer"
      >
        {TFS.map((t) => {
          const enabled = !available || available.includes(t);
          return (
            <option key={t} value={t} disabled={!enabled}>
              {t}{!enabled ? " (no data)" : ""}
            </option>
          );
        })}
      </select>
    </div>
  );
}
