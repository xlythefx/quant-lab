const RANGES = ["1Y", "2Y", "3Y", "5Y", "MAX"];

/**
 * Range pills (1Y / 2Y / 3Y / 5Y / MAX). Sets the pending window only — the
 * user still presses Run backtest explicitly (matches the Dashboard).
 */
export default function RangeSelector({ value, onChange }) {
  return (
    <div className="flex items-center gap-1 h-11 px-1 rounded-xl border border-line bg-bg-panel/40">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-3 h-8 text-xs font-medium rounded-lg transition cursor-pointer ${
            value === r ? "bg-accent-grad text-white shadow" : "text-muted hover:text-text hover:bg-bg-elev/60"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
