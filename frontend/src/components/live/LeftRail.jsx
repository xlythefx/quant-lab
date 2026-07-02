/** Left icon rail (52px) — brand diamond, 6 workspace icons, ⌘K at the bottom. */

export const WORKSPACES = [
  { id: "trading",    label: "TRADING" },
  { id: "markets",    label: "MARKETS" },
  { id: "risk",       label: "RISK" },
  { id: "blotter",    label: "BLOTTER" },
  { id: "strategies", label: "STRATEGIES" },
  { id: "analytics",  label: "ANALYTICS" },
];

const S = { width: 19, height: 19, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };

const ICONS = {
  trading: () => (
    <svg {...S}>
      <line x1="7" y1="3" x2="7" y2="8" /><rect x="5" y="8" width="4" height="8" /><line x1="7" y1="16" x2="7" y2="21" />
      <line x1="17" y1="2" x2="17" y2="6" /><rect x="15" y="6" width="4" height="10" /><line x1="17" y1="16" x2="17" y2="22" />
    </svg>
  ),
  markets: () => (
    <svg {...S}><line x1="5" y1="20" x2="5" y2="12" /><line x1="10" y1="20" x2="10" y2="6" /><line x1="15" y1="20" x2="15" y2="10" /><line x1="20" y1="20" x2="20" y2="4" /></svg>
  ),
  risk: () => (
    <svg {...S}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
  ),
  blotter: () => (
    <svg {...S}><line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="14" y2="18" /></svg>
  ),
  strategies: () => (
    <svg {...S}><circle cx="6" cy="6" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" /><line x1="7.6" y1="7.6" x2="10.8" y2="16" /><line x1="16.4" y1="7.6" x2="13.2" y2="16" /><line x1="8.4" y1="6" x2="15.6" y2="6" /></svg>
  ),
  analytics: () => (
    <svg {...S}><path d="M3 3v18h18" /><path d="M6.5 14.5 11 9.5l3.5 3.5 5-6.5" /></svg>
  ),
  search: () => (
    <svg {...S}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></svg>
  ),
};

export default function LeftRail({ active, onSelect, onCommand }) {
  return (
    <div className="lt-rail">
      <div className="lt-rail-brand" title="XlytheAI Terminal" />
      {WORKSPACES.map((w) => {
        const Icon = ICONS[w.id];
        return (
          <button
            key={w.id}
            className={`lt-rail-btn ${active === w.id ? "active" : ""}`}
            title={w.label}
            onClick={() => onSelect(w.id)}
          >
            <Icon />
          </button>
        );
      })}
      <div className="lt-rail-spacer" />
      <button className="lt-rail-btn" title="Command palette (Ctrl+K)" onClick={onCommand}>
        {ICONS.search()}
      </button>
    </div>
  );
}
