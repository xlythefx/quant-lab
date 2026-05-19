import { useMemo, useState } from "react";
import { fmtNum, fmtInt, fmtPct } from "../services/format.js";

/**
 * Grid-search results visualization.
 *
 * Always renders a sortable table. If the run gridded exactly one param,
 * also renders a line chart (metric vs param value). If exactly two,
 * renders a heatmap.
 *
 * Props:
 *   result: { results: [{combo_idx, params, stats}], grid_params, metric, ... }
 */

const METRIC_COLUMNS = [
  { id: "sharpe",            label: "Sharpe",        fmt: (v) => fmtNum(v),       sortable: true,  signed: false },
  { id: "total_return_pct",  label: "Return %",      fmt: (v) => fmtPct(v),       sortable: true,  signed: true  },
  { id: "max_drawdown_pct",  label: "Max DD %",      fmt: (v) => fmtPct(v, false),sortable: true,  signed: false, lowerIsBetter: true },
  { id: "win_rate",          label: "Win Rate",      fmt: (v) => `${fmtNum((v ?? 0) * 100)}%`, sortable: true, signed: false },
  { id: "trades",            label: "Trades",        fmt: (v) => fmtInt(v),       sortable: true,  signed: false },
  { id: "profit_factor",     label: "Profit Factor", fmt: (v) => v == null ? "∞" : fmtNum(v), sortable: true, signed: false },
];

const CHART_METRICS = METRIC_COLUMNS;

export default function GridResultsPanel({ result }) {
  const rows = result?.results || [];
  const gridParams = result?.grid_params || [];
  const dims = gridParams.length;

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-line bg-bg-panel/60 p-6 text-center text-sm text-muted">
        No results yet.
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        Grid Result · {rows.length} of {result.total_combos} backtests
        {result.partial && <span className="text-amber-400"> · partial (cancelled)</span>}
        {" · "}default metric = <span className="font-mono">{result.metric}</span>
      </div>

      {dims === 1 && <Grid1DChart rows={rows} gridParams={gridParams} defaultMetric={result.metric} />}
      {dims === 2 && <Grid2DHeatmap rows={rows} gridParams={gridParams} defaultMetric={result.metric} />}
      {dims >= 3 && (
        <div className="rounded-md border border-line/40 bg-bg-elev/20 px-4 py-3 text-xs text-muted">
          Heatmap available when sweeping 1 or 2 params at a time. Use the table below to explore the {dims}-D grid.
        </div>
      )}

      <ResultsTable rows={rows} gridParams={gridParams} defaultMetric={result.metric} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sortable table
// ---------------------------------------------------------------------------

function ResultsTable({ rows, gridParams, defaultMetric }) {
  const [sortKey, setSortKey] = useState(defaultMetric);
  const [sortDir, setSortDir] = useState("desc"); // desc by default for metrics
  const [expanded, setExpanded] = useState(null); // combo_idx

  const sorted = useMemo(() => {
    const isParam = gridParams.some((gp) => gp.name === sortKey);
    const get = (r) => isParam ? r.params[sortKey] : r.stats[sortKey];
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = get(a), bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [rows, sortKey, sortDir, gridParams]);

  const clickHeader = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead className="bg-bg-elev/40 text-muted">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              {gridParams.map((gp) => (
                <SortHeader key={gp.name} active={sortKey === gp.name} dir={sortDir} onClick={() => clickHeader(gp.name)}>
                  {gp.name}
                </SortHeader>
              ))}
              {METRIC_COLUMNS.map((c) => (
                <SortHeader key={c.id} active={sortKey === c.id} dir={sortDir} onClick={() => clickHeader(c.id)} align="right">
                  {c.label}
                </SortHeader>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <Row
                key={r.combo_idx}
                row={r}
                gridParams={gridParams}
                expanded={expanded === r.combo_idx}
                onClick={() => setExpanded(expanded === r.combo_idx ? null : r.combo_idx)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortHeader({ children, active, dir, onClick, align = "left" }) {
  const arrow = !active ? "" : dir === "asc" ? " ▲" : " ▼";
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 cursor-pointer select-none hover:text-text ${align === "right" ? "text-right" : "text-left"} ${active ? "text-text" : ""}`}
    >
      {children}{arrow}
    </th>
  );
}

function Row({ row, gridParams, expanded, onClick }) {
  const s = row.stats || {};
  const ret = s.total_return_pct ?? 0;
  return (
    <>
      <tr
        onClick={onClick}
        className={`border-t border-line/30 cursor-pointer hover:bg-bg-elev/30 ${expanded ? "bg-bg-elev/40" : ""}`}
      >
        <td className="px-3 py-1.5 text-muted">{row.combo_idx}</td>
        {gridParams.map((gp) => (
          <td key={gp.name} className="px-3 py-1.5 text-text">
            {gp.type === "int" ? fmtInt(row.params[gp.name]) : fmtNum(row.params[gp.name])}
          </td>
        ))}
        {METRIC_COLUMNS.map((c) => {
          const v = s[c.id];
          let cls = "text-text";
          if (c.signed && typeof v === "number") {
            cls = v >= 0 ? "text-profit" : "text-loss";
          }
          if (c.lowerIsBetter && typeof v === "number" && v > 0) {
            cls = "text-loss";
          }
          return (
            <td key={c.id} className={`px-3 py-1.5 text-right ${cls}`}>
              {c.fmt(v)}
            </td>
          );
        })}
      </tr>
      {expanded && <ExpandedRow row={row} gridParams={gridParams} />}
    </>
  );
}

function ExpandedRow({ row, gridParams }) {
  const s = row.stats || {};
  return (
    <tr className="border-t border-line/30 bg-bg-elev/20">
      <td colSpan={gridParams.length + METRIC_COLUMNS.length + 1} className="px-4 py-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono">
          <KV k="Final Equity"   v={fmtNum(s.final_equity)} />
          <KV k="Total $"         v={fmtNum(s.total_return_dollars)} />
          <KV k="Avg Trade $"     v={fmtNum(s.avg_pnl_dollars)} />
          <KV k="Gross Profit"    v={fmtNum(s.gross_profit)} />
          <KV k="Gross Loss"      v={fmtNum(s.gross_loss)} />
          <KV k="Max DD $"        v={fmtNum(s.max_drawdown_dollars)} />
          <KV k="Wins"            v={fmtInt(s.wins)} />
          <KV k="Losses"          v={fmtInt(s.losses)} />
        </div>
      </td>
    </tr>
  );
}

function KV({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-line/30 bg-bg/40 px-2 py-1">
      <span className="text-muted text-[10px] uppercase">{k}</span>
      <span className="text-text">{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1D line chart (one param sweep)
// ---------------------------------------------------------------------------

function Grid1DChart({ rows, gridParams, defaultMetric }) {
  const [metricId, setMetricId] = useState(defaultMetric);
  const gp = gridParams[0];
  const points = useMemo(() => {
    return rows
      .map((r) => ({ x: r.params[gp.name], y: r.stats?.[metricId] }))
      .filter((p) => typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.y))
      .sort((a, b) => a.x - b.x);
  }, [rows, gp.name, metricId]);

  if (points.length === 0) return null;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const W = 600, H = 220, PAD_L = 48, PAD_R = 16, PAD_T = 12, PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const sx = (x) => PAD_L + ((x - xMin) / xRange) * innerW;
  const sy = (y) => PAD_T + (1 - (y - yMin) / yRange) * innerH;
  const zeroY = sy(0);

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-text">
          {METRIC_COLUMNS.find((m) => m.id === metricId)?.label || metricId} vs <span className="font-mono">{gp.name}</span>
        </div>
        <select
          value={metricId}
          onChange={(e) => setMetricId(e.target.value)}
          className="px-2 py-1 text-xs font-mono rounded bg-bg border border-line focus:outline-none focus:border-accent-blue"
        >
          {CHART_METRICS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[220px]">
        <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeDasharray="2 3" />
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="rgba(255,255,255,0.2)" />
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="rgba(255,255,255,0.2)" />
        <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth="1.75" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r="3" fill={p.y >= 0 ? "#10b981" : "#ef4444"} />
            <title>{`${gp.name}=${p.x}  ·  ${metricId}=${fmtNum(p.y)}`}</title>
          </g>
        ))}
        <text x={PAD_L} y={H - 6} fontSize="10" fill="rgba(255,255,255,0.6)">{fmtNum(xMin)}</text>
        <text x={W - PAD_R} y={H - 6} fontSize="10" textAnchor="end" fill="rgba(255,255,255,0.6)">{fmtNum(xMax)}</text>
        <text x={PAD_L - 4} y={PAD_T + 8} fontSize="10" textAnchor="end" fill="rgba(255,255,255,0.6)">{fmtNum(yMax)}</text>
        <text x={PAD_L - 4} y={H - PAD_B} fontSize="10" textAnchor="end" fill="rgba(255,255,255,0.6)">{fmtNum(yMin)}</text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2D heatmap (two-param sweep)
// ---------------------------------------------------------------------------

function Grid2DHeatmap({ rows, gridParams, defaultMetric }) {
  const [metricId, setMetricId] = useState(defaultMetric);
  const [gpX, gpY] = gridParams; // x-axis = first param, y-axis = second
  const xVals = useMemo(() => [...gpX.values].sort((a, b) => a - b), [gpX]);
  const yVals = useMemo(() => [...gpY.values].sort((a, b) => a - b), [gpY]);

  // Build a quick lookup by `${x}|${y}` -> metric value.
  const valueAt = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.params[gpX.name]}|${r.params[gpY.name]}`;
      m.set(k, r.stats?.[metricId]);
    }
    return m;
  }, [rows, gpX.name, gpY.name, metricId]);

  // Color scale: red (worst) → neutral → green (best). Center at 0 when metric is signed.
  const metricMeta = METRIC_COLUMNS.find((m) => m.id === metricId);
  const allValues = Array.from(valueAt.values()).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (allValues.length === 0) return null;
  const vMin = Math.min(...allValues);
  const vMax = Math.max(...allValues);
  const lowerBetter = !!metricMeta?.lowerIsBetter;

  const color = (v) => {
    if (v == null || !Number.isFinite(v)) return "rgba(255,255,255,0.04)";
    // Normalize to 0..1 within observed range.
    let t = (v - vMin) / (vMax - vMin || 1);
    if (lowerBetter) t = 1 - t;
    // 0 = red, 0.5 = neutral, 1 = green
    if (t < 0.5) {
      const a = t / 0.5;       // 0..1
      return `rgba(239, 68, 68, ${0.55 - a * 0.4})`;
    } else {
      const a = (t - 0.5) / 0.5;
      return `rgba(16, 185, 129, ${0.15 + a * 0.55})`;
    }
  };

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-text">
          {METRIC_COLUMNS.find((m) => m.id === metricId)?.label || metricId} heatmap
          &nbsp;<span className="text-muted text-xs">({gpX.name} × {gpY.name})</span>
        </div>
        <select
          value={metricId}
          onChange={(e) => setMetricId(e.target.value)}
          className="px-2 py-1 text-xs font-mono rounded bg-bg border border-line focus:outline-none focus:border-accent-blue"
        >
          {CHART_METRICS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono border-collapse">
          <thead>
            <tr>
              <th className="px-2 py-1 text-right text-muted">
                {gpY.name} \ {gpX.name}
              </th>
              {xVals.map((x) => (
                <th key={x} className="px-2 py-1 text-center text-muted">{fmtNum(x)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {yVals.map((y) => (
              <tr key={y}>
                <td className="px-2 py-1 text-right text-muted">{fmtNum(y)}</td>
                {xVals.map((x) => {
                  const v = valueAt.get(`${x}|${y}`);
                  const bg = color(v);
                  const display = v == null || !Number.isFinite(v) ? "—" : fmtNum(v);
                  return (
                    <td
                      key={x}
                      className="px-2 py-1 text-center text-text border border-line/20"
                      style={{ background: bg, minWidth: 56 }}
                      title={`${gpX.name}=${x}  ·  ${gpY.name}=${y}  ·  ${metricId}=${display}`}
                    >
                      {display}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[10px] text-muted/70 font-mono">
        Color: <span className="text-loss">red</span> = worst, <span className="text-profit">green</span> = best
        {lowerBetter && <> (inverted — lower is better for this metric)</>}
        &nbsp;· range {fmtNum(vMin)} → {fmtNum(vMax)}
      </div>
    </div>
  );
}
