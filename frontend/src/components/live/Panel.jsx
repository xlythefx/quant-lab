/**
 * Terminal panel chrome: header (muted uppercase label + optional badges/right
 * content), scrollable body, optional footer. Every workspace panel uses this.
 */

/** Honest labeling for any panel not driven by a real feed. */
export function SimulatedBadge({ show = true }) {
  if (!show) return null;
  return <span className="lt-sim-badge" title="Client-side simulated data — not a real feed">SIMULATED</span>;
}

export function LiveBadge() {
  return <span className="lt-live-chip" title="Real feed">LIVE</span>;
}

export default function Panel({ title, simulated = false, live = false, right, foot, children, style }) {
  return (
    <div className="lt-panel" style={style}>
      <div className="lt-panel-head">
        <span className="lt-panel-title">{title}</span>
        {simulated && <SimulatedBadge />}
        {live && <LiveBadge />}
        {right && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>{right}</div>}
      </div>
      <div className="lt-panel-body">{children}</div>
      {foot != null && <div className="lt-panel-foot">{foot}</div>}
    </div>
  );
}
