import { useState, useRef, useEffect } from "react";
import SidebarStrategyCard from "./SidebarStrategyCard.jsx";
import BrandAtom from "../BrandAtom.jsx";

export const PORTFOLIO_ID = "__portfolio__";

/**
 * Left rail: a "Portfolio" aggregate entry + one card per active strategy +
 * an add control. Selection drives the whole main panel.
 *
 * props:
 *   active:       [{id, color, params}]      (from strategiesStore)
 *   catalogById:  {id: meta}
 *   selectedId:   string
 *   onSelect:     (id) => void
 *   onRemove:     (id) => void
 *   onAdd:        (id) => void
 *   onEdit:          (id) => void            (opens the param editor)
 *   sliceFor:        (id) => slice|null      (resolves portfolio result slice)
 *   pointsFor:       (id) => [{time,value}]|null
 *   strategySubtitle: string                 (shared symbol/asset label, same for all)
 */
export default function StrategySidebar({
  active, catalogById, selectedId, onSelect, onRemove, onAdd, onEdit, sliceFor, pointsFor, strategySubtitle,
}) {
  const portfolioSlice = sliceFor(PORTFOLIO_ID);
  const showPortfolio = active.length >= 2;

  return (
    <aside className="w-72 shrink-0 border-r border-line bg-bg-panel/40 flex flex-col h-full">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrandAtom size={16} />
          <span className="text-[10px] uppercase tracking-widest text-muted">Strategies</span>
        </div>
        <span className="text-[10px] font-mono text-muted">{active.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {showPortfolio && (
          <SidebarStrategyCard
            title="Portfolio"
            subtitle="Shared cash pool"
            color="#e5e7eb"
            selected={selectedId === PORTFOLIO_ID}
            onSelect={() => onSelect(PORTFOLIO_ID)}
            sharpe={portfolioSlice?.stats?.sharpe ?? null}
            points={pointsFor(PORTFOLIO_ID)}
          />
        )}

        {active.length === 0 && (
          <div className="text-xs text-muted px-1 py-6 text-center leading-relaxed">
            No strategies yet.<br />Add one below to build a portfolio.
          </div>
        )}

        {active.map((s) => {
          const meta = catalogById[s.id];
          const slice = sliceFor(s.id);
          return (
            <SidebarStrategyCard
              key={s.id}
              title={meta?.name || s.id}
              subtitle={strategySubtitle}
              color={s.color}
              selected={selectedId === s.id}
              onSelect={() => onSelect(s.id)}
              sharpe={slice?.stats?.sharpe ?? null}
              points={pointsFor(s.id)}
              onRemove={() => onRemove(s.id)}
              onEdit={onEdit ? () => onEdit(s.id) : undefined}
            />
          );
        })}
      </div>

      <AddStrategy catalog={Object.values(catalogById)} active={active} onAdd={onAdd} />
    </aside>
  );
}

function AddStrategy({ catalog, active, onAdd }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const activeIds = new Set(active.map((s) => s.id));
  const available = catalog
    .filter((m) => m && !m.archived && !activeIds.has(m.id))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="p-3 border-t border-line relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 rounded-lg border border-line bg-bg-elev text-sm text-text hover:border-accent-blue/50 transition"
      >
        + Add strategy
      </button>
      {open && (
        <div className="absolute bottom-full left-3 right-3 mb-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-bg-panel shadow-xl shadow-black/40 py-1 z-50">
          {available.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">All strategies added.</div>
          ) : (
            available.map((m) => (
              <button
                key={m.id}
                onClick={() => { onAdd(m.id); setOpen(false); }}
                className="block w-full text-left px-3 py-1.5 text-sm text-muted hover:text-text hover:bg-bg-elev/50 transition"
              >
                {m.name || m.id}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
