import { WORKSPACES } from "./LeftRail.jsx";

/** Workspace tab strip (32px). Active tab = white text + amber underline. */
export default function WorkspaceTabs({ active, onSelect, onCommand }) {
  return (
    <div className="lt-tabs">
      {WORKSPACES.map((w) => (
        <button
          key={w.id}
          className={`lt-tab ${active === w.id ? "active" : ""}`}
          onClick={() => onSelect(w.id)}
        >
          {w.label}
        </button>
      ))}
      <div className="lt-tabs-right">
        <button className="lt-cmdk-hint" onClick={onCommand}>Ctrl+K COMMAND</button>
      </div>
    </div>
  );
}
