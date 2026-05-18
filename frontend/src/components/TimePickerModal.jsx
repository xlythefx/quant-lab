import { useEffect, useRef, useState } from "react";
import { convertUtcHHmm, getTz, tzShort } from "../services/timezone.js";

const ITEM_H = 36;
const VISIBLE = 5;          // odd → center row is the selection
const HALF = (VISIBLE - 1) / 2;
const CONTAINER_H = ITEM_H * VISIBLE;

const HOURS   = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

const pad = (n) => String(n).padStart(2, "0");

/**
 * iOS-style two-column scroll-wheel time picker.
 *
 * - value: "HH:MM" in UTC (the canonical stored value)
 * - onChange("HH:MM"): called on OK
 * - label: subtitle shown above the wheels (e.g. "Tokyo · Start")
 */
export default function TimePickerModal({ open, value, onChange, onClose, label }) {
  const [h, setH] = useState(0);
  const [m, setM] = useState(0);
  const userTz = getTz();

  // Initialize from value whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    const mm = /^(\d{1,2}):(\d{2})$/.exec(value || "00:00");
    setH(mm ? Math.min(23, Math.max(0, parseInt(mm[1], 10))) : 0);
    setM(mm ? Math.min(59, Math.max(0, parseInt(mm[2], 10))) : 0);
  }, [open, value]);

  if (!open) return null;

  const hhmm = `${pad(h)}:${pad(m)}`;
  const inUser = convertUtcHHmm(hhmm, userTz);
  const inNy   = convertUtcHHmm(hhmm, "America/New_York");
  const inPh   = convertUtcHHmm(hhmm, "Asia/Manila");

  const commit = () => { onChange?.(hhmm); onClose?.(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
         onClick={onClose}>
      <div className="w-[320px] max-w-[92vw] rounded-2xl bg-bg-panel border border-line shadow-2xl p-5"
           onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold">{label || "Pick time"}</h3>
          <span className="text-[10px] uppercase tracking-wider text-muted">UTC</span>
        </div>
        <p className="text-[11px] text-muted/70 mb-4">
          Stored as UTC. Times convert live below.
        </p>

        <div className="flex items-center justify-center gap-2 select-none">
          <Wheel values={HOURS}   value={h} onChange={setH} />
          <span className="text-xl font-mono text-muted -mt-0.5">:</span>
          <Wheel values={MINUTES} value={m} onChange={setM} />
        </div>

        <div className="mt-4 rounded-lg border border-line/60 bg-bg-elev/30 px-3 py-2 space-y-1 font-mono text-xs">
          <ConvRow label="UTC" value={hhmm} primary />
          {userTz !== "Etc/UTC" && userTz !== "America/New_York" && userTz !== "Asia/Manila" && (
            <ConvRow label={tzShort(userTz)} value={inUser} />
          )}
          <ConvRow label="NY"  value={inNy} />
          <ConvRow label="PH"  value={inPh} />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose}
                  className="px-3 py-1.5 text-xs rounded-md border border-line text-muted hover:text-text hover:border-accent-blue">
            Cancel
          </button>
          <button onClick={commit}
                  className="px-4 py-1.5 text-xs rounded-md bg-accent-grad text-white font-semibold">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ConvRow({ label, value, primary }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-[10px] uppercase tracking-wider ${primary ? "text-text" : "text-muted"}`}>{label}</span>
      <span className={primary ? "text-text" : "text-muted"}>{value}</span>
    </div>
  );
}

/**
 * Single vertical scroll-wheel column. Selection is whatever sits in the
 * center row (highlighted band). Commits on scroll-end.
 */
function Wheel({ values, value, onChange }) {
  const ref = useRef(null);
  const programmaticScroll = useRef(false);
  const settleTimer = useRef(null);

  // Snap to the current value (jump, not animate, to avoid feedback loops).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = values.indexOf(value);
    if (idx < 0) return;
    const target = idx * ITEM_H;
    if (el.scrollTop !== target) {
      programmaticScroll.current = true;
      el.scrollTop = target;
      // release the guard on next frame
      requestAnimationFrame(() => { programmaticScroll.current = false; });
    }
  }, [value, values]);

  const onScroll = () => {
    if (programmaticScroll.current) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const idx = Math.round(el.scrollTop / ITEM_H);
      const next = values[Math.max(0, Math.min(values.length - 1, idx))];
      if (next !== value) onChange(next);
      // snap precisely after settle
      const target = idx * ITEM_H;
      if (el.scrollTop !== target) {
        programmaticScroll.current = true;
        el.scrollTop = target;
        requestAnimationFrame(() => { programmaticScroll.current = false; });
      }
    }, 90);
  };

  return (
    <div className="relative" style={{ width: 64, height: CONTAINER_H }}>
      {/* selection band */}
      <div className="absolute left-0 right-0 pointer-events-none border-y border-accent-blue/60 bg-accent-blue/5 rounded-sm"
           style={{ top: ITEM_H * HALF, height: ITEM_H }} />
      <div
        ref={ref}
        onScroll={onScroll}
        className="overflow-y-scroll h-full no-scrollbar"
        style={{
          scrollSnapType: "y mandatory",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          paddingTop:    ITEM_H * HALF,
          paddingBottom: ITEM_H * HALF,
        }}
      >
        {values.map((v) => {
          const selected = v === value;
          return (
            <div
              key={v}
              onClick={() => onChange(v)}
              className={`text-center font-mono cursor-pointer transition ${
                selected ? "text-text text-lg" : "text-muted/70 text-base hover:text-text"
              }`}
              style={{ height: ITEM_H, lineHeight: `${ITEM_H}px`, scrollSnapAlign: "center" }}
            >
              {pad(v)}
            </div>
          );
        })}
      </div>
      <style>{`.no-scrollbar::-webkit-scrollbar{display:none;}`}</style>
    </div>
  );
}
