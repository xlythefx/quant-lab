// Shared analytics primitives — used by Analytics.jsx, WalkForward.jsx, MonteCarlo.jsx
// Extracted from Analytics.jsx so all three pages stay visually consistent.

export function KpiCard({ title, value, sub, positive }) {
  const cls = positive == null
    ? "text-text"
    : positive ? "text-profit" : "text-loss";
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className={`text-2xl font-mono mt-1 ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

export function KV({ label, value, valueClass = "text-text" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}

export function Section({ title, hint, children }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-text">{title}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// `rows` is an array of [label, key, sub, tone] tuples.
// tone is "profit" | "loss" | "neutral" (anything else => neutral).
export function InsightCard({ rows }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">Insights</div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-xs">
        {rows.map(([label, key, sub, tone], i) => {
          const toneCls = tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-text";
          return (
            <div key={i} className="flex flex-col">
              <span className="text-muted">{label}</span>
              <span className={`font-mono ${toneCls}`}>{key}</span>
              {sub && <span className="text-muted/80 font-mono text-[11px]">{sub}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// `tabs` is an array of { id, label, disabled? } objects.
// `active` is the currently selected id; `onSelect(id)` is called on click.
export function TabBar({ tabs, active, onSelect }) {
  return (
    <div className="flex items-center gap-1 border-b border-line overflow-x-auto">
      {tabs.map((t) => {
        const isActive = active === t.id;
        const disabled = !!t.disabled;
        return (
          <button
            key={t.id}
            onClick={() => !disabled && onSelect(t.id)}
            disabled={disabled}
            className={`px-4 py-2 text-sm transition border-b-2 -mb-px whitespace-nowrap ${
              isActive
                ? "border-accent-blue text-text"
                : disabled
                  ? "border-transparent text-muted/40 cursor-not-allowed"
                  : "border-transparent text-muted hover:text-text"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
