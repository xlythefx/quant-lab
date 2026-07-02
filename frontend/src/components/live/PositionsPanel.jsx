import Panel from "./Panel.jsx";

/**
 * Positions & PnL — REAL data lands in phase 09 (read-only from the
 * sinegu-api WAMP tables). Until then: honest empty state.
 */
export default function PositionsPanel({ account = "demo", compact = false }) {
  return (
    <Panel title={`Positions & PnL · ${account.toUpperCase()}`}>
      <div className="lt-empty">No positions — real broker positions wired in phase 09</div>
    </Panel>
  );
}
