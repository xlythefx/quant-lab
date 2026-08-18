// Shared candle-chart marker builders. Used by Dashboard (v1) and DashboardV2 so
// the entry/exit arrows stay identical between the two. Keep this the single
// source of truth — don't re-implement makeMarker/tradesToMarkers per page.

export const COLOR_WIN   = "#22c55e";
export const COLOR_LOSS  = "#ef4444";
export const COLOR_MIXED = "#f59e0b"; // amber — a collapsed exit stack with both wins and losses

// One lightweight-charts marker for an entry or exit signal.
//   signal: { kind: "entry"|"exit", side: "long"|"short", time: <epoch seconds> }
//   win:    boolean — colors the marker green (win) or red (loss).
export function makeMarker(signal, win) {
  const isEntry = signal.kind === "entry";
  const long = signal.side === "long";
  return {
    time: signal.time,
    position: isEntry ? (long ? "belowBar" : "aboveBar") : (long ? "aboveBar" : "belowBar"),
    shape: isEntry ? (long ? "arrowUp" : "arrowDown") : "square",
    color: win ? COLOR_WIN : COLOR_LOSS,
    text: isEntry ? (long ? "L" : "S") : "X",
    size: 1,
  };
}

// Expand a list of trade records into entry+exit markers.
export function tradesToMarkers(trades) {
  const out = [];
  for (const t of trades || []) {
    const win = !!t.win || (t.pnl_dollars != null ? t.pnl_dollars >= 0 : false);
    out.push(makeMarker({ kind: "entry", side: t.side, time: t.entry_time }, win));
    out.push(makeMarker({ kind: "exit",  side: t.side, time: t.exit_time  }, win));
  }
  return out;
}

// Collapse vertically-stacked exit markers into ONE square per bar.
//
// With pyramiding/increments, every open tranche closes on the same bar, so the
// raw markers pile up into a tall column of identical "X" squares. This folds
// each same-bar exit stack into a single square (entry arrows pass through
// untouched — they're staggered across bars, so they don't clutter). A stack
// that's all wins stays green / all losses stays red; a *mixed* stack turns amber
// so we never paint a partly-losing exit as a clean win.
//
// Returns { markers, counts } where `counts` maps exit bar-time -> { count, wins,
// losses } for the stacks that were actually folded (count > 1) — the chart uses
// it to show "N exits (xW / yL)" on hover.
export function collapseMarkers(markers) {
  const stacks = new Map();   // `${time}|${position}` -> group (square/exit markers only)
  const out = [];             // entry arrows + one square per exit stack
  for (const m of markers || []) {
    if (m.shape !== "square") { out.push(m); continue; } // entries: keep every one
    const key = `${m.time}|${m.position}`;
    let g = stacks.get(key);
    if (!g) { g = { marker: { ...m }, count: 0, wins: 0, losses: 0 }; stacks.set(key, g); }
    g.count += 1;
    if (m.color === COLOR_WIN) g.wins += 1; else g.losses += 1;
  }

  const counts = new Map();   // time -> { count, wins, losses } (only folded stacks)
  for (const g of stacks.values()) {
    const m = g.marker;
    if (g.count > 1 && g.wins > 0 && g.losses > 0) m.color = COLOR_MIXED;
    out.push(m);
    if (g.count > 1) {
      const prev = counts.get(m.time) || { count: 0, wins: 0, losses: 0 };
      prev.count += g.count; prev.wins += g.wins; prev.losses += g.losses;
      counts.set(m.time, prev);
    }
  }
  out.sort((a, b) => a.time - b.time);
  return { markers: out, counts };
}
