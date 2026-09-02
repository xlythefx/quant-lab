import { useMemo, useState } from "react";
import { fmtDateLong, fmtInt } from "../../services/format.js";

/**
 * Visual walk-forward schedule — what the run actually does, in pictures.
 *
 * Geometry mirrors the backend exactly (services/walkforward.py `_do_run`,
 * which drives sklearn TimeSeriesSplit):
 *
 *   n_splits   = max(2, (rows - is_bars - embargo) // oos_bars)
 *   test_start = rows - n_splits*oos + i*oos
 *   test_end   = test_start + oos
 *   train_end  = test_start - embargo          (gap)
 *   train_start= max(0, train_end - is_bars)   (max_train_size)
 *   then purge_radius bars come off the RIGHT edge of train
 *
 * Working in bar-index space (not seconds) is what keeps this honest: it is
 * the same arithmetic the splitter does, so the picture cannot drift from the
 * run. Dates are derived for labelling only, from average bar spacing.
 */

const C = {
  train: "#3b82f6",      // blue  — where params are optimized
  purge: "#f59e0b",      // amber — trimmed off the train edge
  embargo: "#64748b",    // slate — skipped entirely
  test: "#22d3ee",       // cyan  — the only honest evidence
  unused: "rgba(255,255,255,0.05)",
};

export function computeSchedule({ rows, isBars, oosBars, embargoBars = 0, purgeRadius = 0 }) {
  if (!rows || rows < 2 || !isBars || !oosBars) return null;
  const emb = Math.max(0, embargoBars || 0);
  const purge = Math.max(0, purgeRadius || 0);
  const nSplits = Math.max(2, Math.floor((rows - isBars - emb) / oosBars));
  if (!Number.isFinite(nSplits) || nSplits < 2) return null;

  const windows = [];
  for (let i = 0; i < nSplits; i++) {
    const testStart = rows - nSplits * oosBars + i * oosBars;
    const testEnd = testStart + oosBars;
    const trainEnd = testStart - emb;
    const trainStart = Math.max(0, trainEnd - isBars);
    const trainEndPurged = Math.max(trainStart, trainEnd - purge);
    if (testStart < 0 || trainEnd <= trainStart) continue;
    windows.push({ i, trainStart, trainEndPurged, trainEnd, testStart, testEnd });
  }
  if (!windows.length) return null;
  return {
    rows, isBars, oosBars, emb, purge, nSplits: windows.length, windows,
    oosCoverStart: windows[0].testStart,
    oosCoverEnd: windows[windows.length - 1].testEnd,
  };
}

/** Pick which window rows to draw: the first three, an ellipsis, and the last. */
function pickRows(windows) {
  if (windows.length <= 5) return windows.map((w) => ({ w }));
  return [
    { w: windows[0] }, { w: windows[1] }, { w: windows[2] },
    { gap: windows.length - 4 },
    { w: windows[windows.length - 1] },
  ];
}

export default function ScheduleDiagram({ dataset, isBars, oosBars, embargoBars, purgeRadius }) {
  const [showManual, setShowManual] = useState(false);

  const sched = useMemo(
    () => computeSchedule({ rows: dataset?.rows, isBars, oosBars, embargoBars, purgeRadius }),
    [dataset?.rows, isBars, oosBars, embargoBars, purgeRadius],
  );

  const dateAt = useMemo(() => {
    const first = dataset?.first_time, last = dataset?.last_time, rows = dataset?.rows;
    if (!first || !last || !rows || rows < 2) return null;
    const secPerBar = (last - first) / (rows - 1);
    return (barIdx) => first + barIdx * secPerBar;
  }, [dataset?.first_time, dataset?.last_time, dataset?.rows]);

  if (!sched) {
    return (
      <div className="rounded-md border border-line bg-bg-elev/30 p-3 text-[11px] text-muted">
        Pick a dataset and window sizes to see the schedule.
      </div>
    );
  }

  const W = 1000, ROW_H = 26, BAR_H = 15, PAD_L = 58, PAD_R = 12;
  const inner = W - PAD_L - PAD_R;
  const x = (bar) => PAD_L + (bar / sched.rows) * inner;
  const rowsToDraw = pickRows(sched.windows);
  const height = 34 + rowsToDraw.length * ROW_H + 48;

  const Block = ({ from, to, fill, opacity = 1, y }) =>
    to > from ? (
      <rect x={x(from)} y={y} width={Math.max(1, x(to) - x(from))} height={BAR_H}
            rx="2" fill={fill} opacity={opacity} />
    ) : null;

  return (
    <div className="rounded-md border border-line bg-bg-elev/30 p-3 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted">
          How this run works · {fmtInt(sched.nSplits)} windows
        </span>
        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="text-[10px] px-2 py-0.5 rounded border border-line text-muted hover:text-text hover:border-accent-blue transition"
        >
          {showManual ? "Hide" : "What do embargo & purge mean?"}
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono">
        <Legend color={C.train} label="Train (IS) — params optimized here" />
        {sched.purge > 0 && <Legend color={C.purge} label={`Purge — ${fmtInt(sched.purge)} bars dropped`} />}
        {sched.emb > 0 && <Legend color={C.embargo} label={`Embargo — ${fmtInt(sched.emb)} bars skipped`} />}
        <Legend color={C.test} label="Test (OOS) — the honest evidence" />
      </div>

      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ minWidth: 520 }}>
        {/* Full dataset reference bar */}
        <text x="0" y="14" fill="#64748b" fontSize="11" fontFamily="monospace">all data</text>
        <rect x={PAD_L} y="3" width={inner} height="12" rx="2" fill={C.unused} />
        {dateAt && (
          <>
            <text x={PAD_L} y="28" fill="#64748b" fontSize="10" fontFamily="monospace">
              {fmtDateLong(dateAt(0))}
            </text>
            <text x={W - PAD_R} y="28" fill="#64748b" fontSize="10" fontFamily="monospace" textAnchor="end">
              {fmtDateLong(dateAt(sched.rows))}
            </text>
          </>
        )}

        {rowsToDraw.map((r, idx) => {
          const y = 34 + idx * ROW_H;
          if (r.gap) {
            return (
              <text key="gap" x={PAD_L + inner / 2} y={y + BAR_H - 3} fill="#475569"
                    fontSize="11" fontFamily="monospace" textAnchor="middle">
                ⋮ {fmtInt(r.gap)} more windows, each sliding {fmtInt(sched.oosBars)} bars later ⋮
              </text>
            );
          }
          const w = r.w;
          return (
            <g key={w.i}>
              <text x="0" y={y + BAR_H - 3} fill="#64748b" fontSize="11" fontFamily="monospace">
                #{w.i + 1}
              </text>
              <Block from={w.trainStart} to={w.trainEndPurged} fill={C.train} y={y} />
              <Block from={w.trainEndPurged} to={w.trainEnd} fill={C.purge} y={y} />
              <Block from={w.trainEnd} to={w.testStart} fill={C.embargo} opacity={0.65} y={y} />
              <Block from={w.testStart} to={w.testEnd} fill={C.test} y={y} />
            </g>
          );
        })}

        {/* Stitched OOS coverage — the report you actually read */}
        <line x1={PAD_L} y1={34 + rowsToDraw.length * ROW_H + 4}
              x2={W - PAD_R} y2={34 + rowsToDraw.length * ROW_H + 4}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        <text x="0" y={34 + rowsToDraw.length * ROW_H + 30} fill="#22d3ee" fontSize="11" fontFamily="monospace">
          report
        </text>
        <rect x={x(sched.oosCoverStart)} y={34 + rowsToDraw.length * ROW_H + 18}
              width={Math.max(1, x(sched.oosCoverEnd) - x(sched.oosCoverStart))} height={BAR_H}
              rx="2" fill={C.test} opacity="0.85" />
        {dateAt && (
          <text x={x(sched.oosCoverStart)} y={34 + rowsToDraw.length * ROW_H + 46}
                fill="#64748b" fontSize="10" fontFamily="monospace">
            {fmtDateLong(dateAt(sched.oosCoverStart))} → {fmtDateLong(dateAt(sched.oosCoverEnd))}
          </text>
        )}
      </svg>

      <div className="text-[11px] text-muted/80">
        Every cyan slice is data the optimizer never saw when it chose that window&apos;s params. Chained
        end to end they form the stitched report — the only part of this run that is out-of-sample.
        The blue block slides forward {fmtInt(sched.oosBars)} bars each step and re-optimizes from scratch.
      </div>

      {showManual && <RigorManual sched={sched} />}
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/** Inline manual for the two leak guards, each with its own picture. */
function RigorManual({ sched }) {
  const cell = (fill, n, key) => (
    <span key={key} className="inline-block h-3 rounded-[1px]" style={{ width: 9, backgroundColor: fill }} />
  );
  const strip = (spec) => (
    <span className="inline-flex gap-[2px] align-middle">
      {spec.flatMap(([fill, n], gi) =>
        Array.from({ length: n }, (_, i) => cell(fill, n, `${gi}-${i}`)))}
    </span>
  );

  return (
    <div className="rounded-md border border-line bg-bg-panel/50 p-3 space-y-3 text-[11px]">
      <div>
        <div className="text-text font-medium mb-1">Embargo — a gap between train and test</div>
        <div className="mb-1.5">{strip([[C.train, 8], [C.embargo, 3], [C.test, 6]])}</div>
        <div className="text-muted">
          A trade opened near the <span className="text-text">end</span> of training may still be open when
          testing begins. Without a gap, the same price action sits on both sides of the boundary and the
          test is no longer clean. Embargo skips that many bars entirely — they belong to neither side.
          Currently <span className="font-mono text-text">{fmtInt(sched.emb)}</span>.
          {sched.emb === 0 && (
            <span className="text-amber-400"> At 0 there is no gap at all. Set it to roughly the length of
              your typical trade (in bars).</span>
          )}
        </div>
      </div>

      <div>
        <div className="text-text font-medium mb-1">Purge — trim the end of the training window</div>
        <div className="mb-1.5">{strip([[C.train, 6], [C.purge, 2], [C.embargo, 3], [C.test, 6]])}</div>
        <div className="text-muted">
          Trades opened in the last bars of training would <span className="text-text">exit inside the test
          period</span>. Scoring them lets the optimizer take credit for knowing what happens next. Purge
          drops that many bars off the right edge of training before any scoring happens — the bars are cut,
          not the trades, which is the simpler and stricter version.
          Currently <span className="font-mono text-text">{fmtInt(sched.purge)}</span>.
          {sched.purge === 0 && (
            <span className="text-amber-400"> At 0 nothing is trimmed.</span>
          )}
        </div>
      </div>

      <div className="text-muted/70 border-t border-line/40 pt-2">
        Both default to 0, which is the permissive setting. They cost you a little data and buy a cleaner
        boundary — if turning them on materially changes your result, that difference <em>was</em> leakage.
      </div>
    </div>
  );
}
