import { useEffect, useRef, useState } from "react";
import { resolveWindowDates, epochToDateStr } from "./metrics.js";
import { fmtDateLong } from "../../services/format.js";

const RANGES = ["1Y", "2Y", "3Y", "5Y", "MAX"];

const pillCls = (active) =>
  `px-3 h-8 text-xs font-medium rounded-lg transition cursor-pointer ${
    active ? "bg-accent-grad text-white shadow" : "text-muted hover:text-text hover:bg-bg-elev/60"
  }`;

/**
 * Range pills (1Y / 2Y / 3Y / 5Y / MAX / Custom). Sets the pending window only —
 * the user still presses Run backtest explicitly (matches the Dashboard).
 *
 * "Custom" opens a dropdown popover with the start/end date inputs; it closes on
 * click-away, Escape, or once the end date is picked. `bounds`
 * ({firstTime,lastTime} epoch secs) drives the "?" hint and the inputs' min/max.
 * `customRange` ({start,end} as "YYYY-MM-DD") is the user's picked window.
 */
export default function RangeSelector({ value, onChange, bounds, customRange, onCustomChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const minStr = bounds?.firstTime != null ? epochToDateStr(bounds.firstTime) : undefined;
  const maxStr = bounds?.lastTime != null ? epochToDateStr(bounds.lastTime) : undefined;
  const inputCls =
    "px-2 h-8 text-xs font-mono rounded-md bg-bg-panel border border-line text-text focus:outline-none focus:border-accent-blue cursor-pointer";

  // Close the popover when leaving Custom, on click-away, or on Escape.
  useEffect(() => { if (value !== "CUSTOM") setOpen(false); }, [value]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const onCustomClick = () => {
    if (value !== "CUSTOM") { onChange("CUSTOM"); setOpen(true); }
    else setOpen((o) => !o);
  };

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <div className="flex items-center gap-1 h-11 px-1 rounded-xl border border-line bg-bg-panel/40">
        {RANGES.map((r) => (
          <button key={r} onClick={() => onChange(r)} className={pillCls(value === r)}>
            {r}
          </button>
        ))}
        <button onClick={onCustomClick} className={pillCls(value === "CUSTOM")}>
          Custom
        </button>
      </div>

      <RangeHint value={value} bounds={bounds} customRange={customRange} />

      {open && (
        <div className="absolute right-0 top-full mt-2 z-40 p-3 rounded-xl border border-line bg-bg-elev shadow-2xl flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-[0.14em] text-muted/80">Custom range (UTC)</div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customRange?.start || ""}
              min={minStr}
              max={customRange?.end || maxStr}
              onChange={(e) => onCustomChange({ ...customRange, start: e.target.value })}
              className={inputCls}
              aria-label="Custom range start"
            />
            <span className="text-muted text-xs">→</span>
            <input
              type="date"
              value={customRange?.end || ""}
              min={customRange?.start || minStr}
              max={maxStr}
              // End is the last pick in the natural flow, so committing it closes
              // the popover (start changes keep it open so you can pick end next).
              onChange={(e) => { onCustomChange({ ...customRange, end: e.target.value }); setOpen(false); }}
              className={inputCls}
              aria-label="Custom range end"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// "?" badge that reveals the concrete dates the current selection covers
// (e.g. "Feb 03, 2024 - Feb 04, 2026"). Shows on hover and toggles on click.
function RangeHint({ value, bounds, customRange }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const win = resolveWindowDates(value, bounds, customRange);
  const text = win
    ? `${fmtDateLong(win.start_time)} - ${fmtDateLong(win.end_time)}`
    : "Pick a symbol to see dates";

  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        onClick={() => setPinned((p) => !p)}
        aria-label="Show selected date range"
        className="w-5 h-5 flex items-center justify-center rounded-full border border-line text-[11px] leading-none text-muted hover:text-text hover:border-accent-blue/60 cursor-pointer"
      >
        ?
      </button>
      {(hover || pinned) && (
        <div className="absolute right-0 top-full mt-2 z-30 whitespace-nowrap px-3 py-1.5 rounded-lg border border-line bg-bg-elev shadow-xl text-[11px] font-mono text-text">
          {text}
        </div>
      )}
    </div>
  );
}
