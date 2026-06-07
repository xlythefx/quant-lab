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
 * When `datasets` is provided, the component renders a dropdown listing each
 * asset class present in the data (Crypto / Commodities / Forex / Futures /
 * Stocks / Indices) and shows only the symbols matching the selected class.
 * Switching class auto-selects the first symbol of the new class. The active
 * class is persisted in localStorage and shared across pages that share the
 * same persistence key.
 */

const CLASS_META = {
  crypto:               { label: "Crypto",             order: 0 },
  commodity:            { label: "Commodities",        order: 1 },
  forex:                { label: "Forex",              order: 2 },
  futures:              { label: "Futures (Databento)",    order: 3 },   // CME via GLBX.MDP3
  equity_index_future:  { label: "Futures (TradeStation)", order: 3.5 }, // CSV import / legacy yfinance
  stock:                { label: "Stocks",             order: 4 },
  index:                { label: "Indices",            order: 5 },
};

function labelFor(cls) {
  return CLASS_META[cls]?.label || cls;
}

function compareClass(a, b) {
  const oa = CLASS_META[a]?.order ?? 99;
  const ob = CLASS_META[b]?.order ?? 99;
  return oa - ob;
}

export default function SymbolSelector({ value, options = [], datasets, onChange, broker = null }) {
  // CRITICAL: call ALL hooks unconditionally before any early return. React
  // detects hook count changes between renders as "Expected static flag was
  // missing" — which would fire here on first paint (datasets=[]) → second
  // paint (datasets=[...]) if we branched before the useMemo calls.
  const hasDatasets = !!datasets && datasets.length > 0;

  // Map every datasets row to its asset class.
  const classesPresent = useMemo(() => {
    if (!hasDatasets) return [];
    const seen = new Set();
    for (const d of datasets) seen.add(d.asset_class || "crypto");
    return Array.from(seen).sort(compareClass);
  }, [datasets, hasDatasets]);

  // Persisted active tab (shared across pages via the same key).
  const [activeClass, setActiveClass] = usePersistentState("ql.symbolSelector.assetClass", "crypto");

  // If the persisted class has no data in the current dataset list, fall back
  // to the first available class (e.g., user switched workspaces).
  const effectiveClass = classesPresent.includes(activeClass)
    ? activeClass
    : (classesPresent[0] || "crypto");

  // Rows belonging to the active asset class — driven off `datasets` so each
  // option carries its broker. The same symbol can exist under more than one
  // broker (e.g. ES on databento AND tradestation); we key options by
  // symbol+broker so they stay independently selectable, and label the broker
  // when a symbol is ambiguous within the class.
  const rowsForClass = useMemo(() => {
    if (!hasDatasets) return [];
    const seen = new Set();
    const rows = [];
    for (const d of datasets) {
      if ((d.asset_class || "crypto") !== effectiveClass) continue;
      const b = d.broker || "";
      const k = `${d.symbol}::${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ symbol: d.symbol, broker: b });
    }
    // Preserve the parent's `options` order when possible, then leftovers.
    const rank = new Map(options.map((s, i) => [s, i]));
    rows.sort((a, b2) => {
      const ra = rank.has(a.symbol) ? rank.get(a.symbol) : 1e9;
      const rb = rank.has(b2.symbol) ? rank.get(b2.symbol) : 1e9;
      if (ra !== rb) return ra - rb;
      return a.symbol.localeCompare(b2.symbol) || a.broker.localeCompare(b2.broker);
    });
    // Mark symbols that appear under more than one broker (need broker label).
    const counts = {};
    for (const r of rows) counts[r.symbol] = (counts[r.symbol] || 0) + 1;
    for (const r of rows) {
      r.id = `${r.symbol}::${r.broker}`;
      r.label = counts[r.symbol] > 1 ? `${r.symbol} · ${r.broker}` : r.symbol;
    }
    return rows;
  }, [datasets, effectiveClass, options, hasDatasets]);

  // The id of the currently-selected row. When the caller passes a `broker`,
  // match on (symbol, broker); otherwise match on symbol only (legacy callers).
  const selectedRow =
    rowsForClass.find((r) => r.symbol === value && (broker == null || r.broker === broker)) ||
    rowsForClass.find((r) => r.symbol === value) ||
    null;

  // When the user switches tabs and the current selection doesn't belong to
  // the new class, auto-select the first row so the dashboard never sits on a
  // stale symbol from another asset.
  useEffect(() => {
    if (!hasDatasets) return;
    if (rowsForClass.length > 0 && !selectedRow) {
      onChange(rowsForClass[0].symbol, rowsForClass[0].broker || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveClass, rowsForClass.map((r) => r.id).join(","), hasDatasets]);

  // Legacy path: no asset-class metadata, render the flat row of buttons.
  // Safe to branch here — all hooks above have already been called.
  if (!hasDatasets) {
    return <FlatSelector value={value} options={options} onChange={onChange} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Asset-class dropdown (only render if more than one class is available). */}
      {classesPresent.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted/70">Asset</span>
          <select
            value={effectiveClass}
            onChange={(e) => setActiveClass(e.target.value)}
            className="px-2.5 py-1 text-[11px] uppercase tracking-wider rounded-md border border-line bg-bg-panel/40 text-text hover:bg-bg-panel focus:outline-none focus:ring-1 focus:ring-accent-blue cursor-pointer"
          >
            {classesPresent.map((cls) => (
              <option key={cls} value={cls}>{labelFor(cls)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Symbol dropdown — filtered to the active asset class. */}
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Symbol</span>
        {rowsForClass.length === 0 ? (
          <span className="text-xs text-muted italic">
            no {labelFor(effectiveClass).toLowerCase()} datasets —{" "}
            <a href="#downloads" className="text-accent-blue hover:underline">download one</a>
          </span>
        ) : (
          <select
            value={selectedRow ? selectedRow.id : ""}
            onChange={(e) => {
              const row = rowsForClass.find((r) => r.id === e.target.value);
              if (row) onChange(row.symbol, row.broker || null);
            }}
            className="px-2.5 py-1.5 text-sm font-mono rounded-md border border-line bg-bg-panel text-text hover:bg-bg-elev focus:outline-none focus:border-accent-blue cursor-pointer"
          >
            {!selectedRow && <option value="">— pick —</option>}
            {rowsForClass.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
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
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="px-2.5 py-1.5 text-sm font-mono rounded-md border border-line bg-bg-panel text-text hover:bg-bg-elev focus:outline-none focus:border-accent-blue cursor-pointer"
        >
          {!value && <option value="">— pick —</option>}
          {options.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      )}
    </div>
  );
}
