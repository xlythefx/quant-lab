import { useEffect, useMemo, useRef, useState } from "react";
import { WORKSPACES } from "./LeftRail.jsx";

/**
 * Ctrl+K command palette: jump to a workspace, open Alerts, jump to a symbol.
 * Type to filter, ↑/↓ + Enter to run, Esc closes.
 */
export default function CommandPalette({ open, onClose, onWorkspace, onAlerts, symbols = [], onSymbol }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);

  const items = useMemo(() => {
    const all = [
      ...WORKSPACES.map((w) => ({ kind: "WORKSPACE", label: w.label, run: () => onWorkspace(w.id) })),
      { kind: "ACTION", label: "OPEN ALERTS", run: onAlerts },
      ...symbols.map((s) => ({ kind: "SYMBOL", label: s, run: () => onSymbol?.(s) })),
    ];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((it) => it.label.toLowerCase().includes(needle)) : all;
  }, [q, symbols, onWorkspace, onAlerts, onSymbol]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => setSel(0), [q]);

  if (!open) return null;

  const run = (it) => { it.run(); onClose(); };

  const onKey = (e) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && items[sel]) run(items[sel]);
  };

  let lastKind = null;
  return (
    <div className="lt-cmdk" onMouseDown={onClose}>
      <div className="lt-cmdk-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="lt-cmdk-input"
          placeholder="Type a command or symbol…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="lt-cmdk-list">
          {items.length === 0 && <div className="lt-empty">No matches</div>}
          {items.map((it, i) => {
            const header = it.kind !== lastKind ? <div key={`k${it.kind}`} className="lt-cmdk-kind">{it.kind}</div> : null;
            lastKind = it.kind;
            return (
              <div key={`${it.kind}:${it.label}`}>
                {header}
                <button
                  className={`lt-cmdk-item ${i === sel ? "sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(it)}
                >
                  <span>{it.label}</span>
                  <span className="lt-dim">{it.kind === "SYMBOL" ? "chart" : "↵"}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
