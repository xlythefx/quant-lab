// Shared candle-chart marker builders. Used by Dashboard (v1) and DashboardV2 so
// the entry/exit arrows stay identical between the two. Keep this the single
// source of truth — don't re-implement makeMarker/tradesToMarkers per page.

export const COLOR_WIN  = "#22c55e";
export const COLOR_LOSS = "#ef4444";

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
