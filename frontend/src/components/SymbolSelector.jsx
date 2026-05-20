import { useEffect, useMemo } from "react";
import { usePersistentState } from "../services/usePersistentState.js";

/**
 * Symbol picker with optional asset-class tabs.
 *
 * Old usage (backwards-compatible):
 *   <SymbolSelector value={symbol} options={["BTCUSDT", ...]} onChange={...} />
 *
 * New usage with tabs (preferred):
 *   <SymbolSelector
 *     value={symbol}
 *     options={["BTCUSDT", ..., "XAUUSD"]}
 *     datasets={[{symbol:"BTCUSDT", asset_class:"crypto"}, ...]}
 *     onChange={...}
 *   />
 *
 * When `datasets` is provided, the component renders a tab strip for each
 * asset class present in the data (Crypto / Commodities / Forex / Stocks /
 * Indices) and shows only the symbols matching the active tab. Switching tabs
 * auto-selects the first symbol of the new class. The active tab is
 * persisted in localStorage and shared across pages that share the same
 * persistence key.
 */

const CLASS_META = {
  crypto:    { label: "Crypto",      order: 0 },
  commodity: { label: "Commodities", order: 1 },
  forex:     { label: "Forex",       order: 2 },
  stock:     { label: "Stocks",      order: 3 },
  index:     { label: "Indices",     order: 4 },
};

function labelFor(cls) {
  return CLASS_META[cls]?.label || cls;
}

function compareClass(a, b) {
  const oa = CLASS_META[a]?.order ?? 99;
  const ob = CLASS_META[b]?.order ?? 99;
  return oa - ob;
}

export default function SymbolSelector({ value, options = [], datasets, onChange }) {
  // Legacy path: no asset-class metadata, render the flat row of buttons
  // exactly like before.
  if (!datasets || datasets.length === 0) {
    return <FlatSelector value={value} options={options} onChange={onChange} />;
  }

  // Map every datasets row to its asset class.
  const classesPresent = useMemo(() => {
    const seen = new Set();
    for (const d of datasets) seen.add(d.asset_class || "crypto");
    return Array.from(seen).sort(compareClass);
  }, [datasets]);

  // Persisted active tab (shared across pages via the same key).
  const [activeClass, setActiveClass] = usePersistentState("ql.symbolSelector.assetClass", "crypto");

  // If the persisted class has no data in the current dataset list, fall back
  // to the first available class (e.g., user switched workspaces).
  const effectiveClass = classesPresent.includes(activeClass)
    ? activeClass
    : (classesPresent[0] || "crypto");

  // Symbols belonging to the active asset class — driven off `datasets` so a
  // symbol that appears in `options` but isn't in any catalog is dropped
  // (shouldn't happen in practice).
  const symbolsForClass = useMemo(() => {
    const set = new Set();
    for (const d of datasets) {
      if ((d.asset_class || "crypto") === effectiveClass) {
        set.add(d.symbol);
      }
    }
    // Preserve order from the parent's `options` array when possible (it may
    // already be sorted in a meaningful way), append any leftovers sorted.
    const ordered = options.filter((s) => set.has(s));
    for (const s of Array.from(set).sort()) {
      if (!ordered.includes(s)) ordered.push(s);
    }
    return ordered;
  }, [datasets, effectiveClass, options]);

  // When the user switches tabs and the current `value` doesn't belong to
  // the new class, auto-select the first symbol of the new class so the
  // dashboard / backtest never sits on a stale symbol from another asset.
  useEffect(() => {
    if (symbolsForClass.length > 0 && !symbolsForClass.includes(value)) {
      onChange(symbolsForClass[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveClass, symbolsForClass.join(",")]);

  return (
    <div className="flex flex-col gap-2">
      {/* Asset-class tabs (only render if more than one class is available). */}
      {classesPresent.length > 1 && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted/70 mr-1">Asset</span>
          <div className="flex gap-0.5 p-0.5 rounded-md border border-line bg-bg-panel/40">
            {classesPresent.map((cls) => {
              const isActive = cls === effectiveClass;
              return (
                <button
                  key={cls}
                  onClick={() => setActiveClass(cls)}
                  className={`px-2.5 py-1 text-[11px] uppercase tracking-wider rounded transition ${
                    isActive
                      ? "bg-accent-blue/20 text-accent-blue"
                      : "text-muted hover:text-text"
                  }`}
                >
                  {labelFor(cls)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Symbol buttons — filtered to the active asset class. */}
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Symbol</span>
        {symbolsForClass.length === 0 ? (
          <span className="text-xs text-muted italic">
            no {labelFor(effectiveClass).toLowerCase()} datasets —{" "}
            <a href="#downloads" className="text-accent-blue hover:underline">download one</a>
          </span>
        ) : (
          <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel max-w-[60vw] overflow-x-auto">
            {symbolsForClass.map((s) => (
              <button
                key={s}
                onClick={() => onChange(s)}
                className={`px-3 py-1.5 text-sm font-mono rounded-md transition whitespace-nowrap ${
                  value === s
                    ? "bg-accent-grad text-white"
                    : "text-muted hover:text-text"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FlatSelector({ value, options, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">Symbol</span>
      {options.length === 0 ? (
        <span className="text-xs text-muted italic">
          no datasets — <a href="#downloads" className="text-accent-blue hover:underline">download one</a>
        </span>
      ) : (
        <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel max-w-[60vw] overflow-x-auto">
          {options.map((s) => (
            <button
              key={s}
              onClick={() => onChange(s)}
              className={`px-3 py-1.5 text-sm font-mono rounded-md transition whitespace-nowrap ${
                value === s
                  ? "bg-accent-grad text-white"
                  : "text-muted hover:text-text"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
