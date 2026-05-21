import { useMemo, useState } from "react";
import { TrashIcon } from "./ConfirmModal.jsx";
import StrategyEditor from "./StrategyEditor.jsx";

/**
 * MCStrategyPicker — pick 1..N strategies for a Monte Carlo run.
 *
 * The picker is ephemeral (no persistence — fresh on every page visit) and
 * independent from the Dashboard's `strategiesStore`. Each row carries its
 * own params; row order = priority.
 *
 * Props:
 *   catalog:    [{id, name, schema, ...}]  full strategy catalog from /api/strategies
 *   strategies: [{id, params}]             current selection (priority = index + 1)
 *   onChange:   (next) => void             called whenever the selection changes
 *
 * Add row → opens a dropdown to pick an id; defaults params from the catalog
 * entry's PARAM_SCHEMA defaults.
 */
export default function MCStrategyPicker({ catalog, strategies, onChange }) {
  const [editingIdx, setEditingIdx] = useState(null);
  const [adding, setAdding] = useState(false);

  const byId = useMemo(() => {
    const m = {};
    for (const c of catalog || []) m[c.id] = c;
    return m;
  }, [catalog]);

  // Strategies not yet in the picker (offered in the Add dropdown).
  const available = useMemo(() => {
    const taken = new Set(strategies.map((s) => s.id));
    return (catalog || []).filter((c) => !taken.has(c.id));
  }, [catalog, strategies]);

  const defaultsFor = (schema) => {
    const out = {};
    for (const spec of schema || []) out[spec.name] = spec.default;
    return out;
  };

  const onAdd = (id) => {
    const meta = byId[id];
    if (!meta) return;
    onChange([...strategies, { id, params: defaultsFor(meta.schema) }]);
    setAdding(false);
  };

  const onRemove = (i) => {
    const next = strategies.slice();
    next.splice(i, 1);
    onChange(next);
  };

  const onMove = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= strategies.length) return;
    const next = strategies.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const onApplyParams = (i, params) => {
    const next = strategies.slice();
    next[i] = { ...next[i], params };
    onChange(next);
    setEditingIdx(null);
  };

  const editingMeta = editingIdx != null ? byId[strategies[editingIdx]?.id] : null;

  return (
    <div className="space-y-2">
      {strategies.length === 0 && (
        <div className="text-[11px] text-muted italic px-1">
          No strategies yet — add one below.
        </div>
      )}

      {strategies.map((s, i) => {
        const meta = byId[s.id];
        return (
          <div
            key={`${s.id}-${i}`}
            className="flex items-center gap-2 rounded-md border border-line bg-bg-panel/50 px-3 py-2"
          >
            <span className="text-[10px] font-mono text-muted shrink-0 w-6">#{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text truncate">{meta?.name || s.id}</div>
              <div className="text-[10px] text-muted font-mono truncate">{s.id}</div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button onClick={() => onMove(i, -1)} disabled={i === 0}
                      title="Increase priority"
                      className="text-muted hover:text-text disabled:opacity-30 text-xs px-1">▲</button>
              <button onClick={() => onMove(i, +1)} disabled={i === strategies.length - 1}
                      title="Decrease priority"
                      className="text-muted hover:text-text disabled:opacity-30 text-xs px-1">▼</button>
              <button onClick={() => setEditingIdx(i)} title="Edit params"
                      className="text-muted hover:text-text text-xs px-1.5 py-0.5">⚙</button>
              <button onClick={() => onRemove(i)} title="Remove"
                      className="text-muted hover:text-loss p-1">
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}

      {/* Add row */}
      {!adding && available.length > 0 && (
        <button
          onClick={() => setAdding(true)}
          className="w-full text-xs text-muted hover:text-text px-3 py-2 border border-dashed border-line rounded-md"
        >
          + Add strategy
        </button>
      )}
      {adding && (
        <div className="rounded-md border border-line bg-bg-panel/60 p-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted px-1 pb-1">
            Pick a strategy
          </div>
          {available.map((c) => (
            <button
              key={c.id}
              onClick={() => onAdd(c.id)}
              className="w-full text-left text-xs text-text hover:bg-bg-elev rounded px-2 py-1.5"
            >
              <div>{c.name}</div>
              <div className="text-[10px] text-muted font-mono">{c.id}</div>
            </button>
          ))}
          <button
            onClick={() => setAdding(false)}
            className="w-full text-[11px] text-muted hover:text-text px-2 py-1"
          >
            cancel
          </button>
        </div>
      )}
      {!adding && available.length === 0 && strategies.length > 0 && (
        <div className="text-[10px] text-muted italic px-1">
          All available strategies added.
        </div>
      )}

      {/* Per-strategy params editor flyout */}
      {editingIdx != null && editingMeta && (
        <StrategyEditor
          open
          schema={editingMeta.schema}
          params={strategies[editingIdx].params}
          onChange={() => { /* draft kept inside editor; apply on close */ }}
          onApply={(p) => onApplyParams(editingIdx, p)}
          onClose={() => setEditingIdx(null)}
          onResetDefaults={() => onApplyParams(editingIdx, defaultsFor(editingMeta.schema))}
        />
      )}
    </div>
  );
}
