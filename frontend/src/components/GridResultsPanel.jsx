import { useEffect, useMemo, useState } from "react";
import { fmtNum, fmtInt } from "../services/format.js";
import { METRIC_COLUMNS, METRIC_TO_STAT, metricColor, statValue } from "./gridMetrics.js";
import GridPlateauPanel from "./GridPlateauPanel.jsx";
import CostAssumptions from "./CostAssumptions.jsx";
import GridDetailModal from "./GridDetailModal.jsx";

/**
 * Grid-search results visualization.
 *
 * Always renders the per-param plateau tiles and a sortable table. If the run
 * gridded exactly one param, also renders a line chart (metric vs param
 * value). If exactly two, a heatmap. One shared metric selector drives the
 * chart, heatmap, and plateau tiles together; the table sorts independently.
 *
 * Props:
 *   result: { results: [{combo_idx, params, stats}], grid_params, metric,
 *             risk_config?, ... }
 */

function exportCsv(rows, gridParams) {
  const colHeaders = METRIC_COLUMNS.map((c) => c.label);
  const headers = ["#", ...gridParams.map((gp) => gp.name), ...colHeaders];
  const lines = rows.map((r) => {
    const s = r.stats || {};
    const cells = [
      r.combo_idx,
      ...gridParams.map((gp) => r.params[gp.name] ?? ""),
      s.sharpe?.toFixed(3) ?? "",
      s.total_return_pct?.toFixed(2) ?? "",
      s.max_drawdown_pct?.toFixed(2) ?? "",
      ((s.win_rate ?? 0) * 100).toFixed(1),
      s.trades ?? "",
      s.profit_factor == null ? "inf" : (s.profit_factor?.toFixed(3) ?? ""),
    ];
    return cells.join(",");
  });
  const csv = [headers.join(","), ...lines].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: "grid_results.csv",
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function GridResultsPanel({ result }) {
  const rows = result?.results || [];
  const gridParams = result?.grid_params || [];
  const dims = gridParams.length;

  // The backend's metric id ("total_return") is not always the stats key
  // ("total_return_pct") — map it before using it as a default sort/chart key.
  const defaultStatKey = METRIC_TO_STAT[result?.metric] || result?.metric || "sharpe";

  // One metric selector shared by the chart, heatmap, and plateau tiles.
  const [metricId, setMetricId] = useState(defaultStatKey);
  useEffect(() => { setMetricId(defaultStatKey); }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows.length === 0) {
    return (
      <section className="rounded-xl border border-line bg-bg-panel/60 p-6 text-center text-sm text-muted">
        No results yet.
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          Grid Result · {rows.length} of {result.total_combos} backtests
          {result.partial && <span className="text-amber-400"> · partial (cancelled)</span>}
          {" · "}default metric = <span className="font-mono">{result.metric}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={metricId}
            onChange={(e) => setMetricId(e.target.value)}
            className="px-2 py-1 text-xs font-mono rounded bg-bg border border-line focus:outline-none focus:border-accent-blue"
            title="Metric shown in the chart / heatmap / plateau tiles"
          >
            {METRIC_COLUMNS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button
            onClick={() => exportCsv(rows, gridParams)}
            className="flex items-center gap-1.5 px-3 py-1 text-xs rounded-md border border-line text-muted hover:text-text hover:border-accent-blue transition"
            title="Export results as CSV"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 2v8M5 7l3 3 3-3M3 12h10" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            CSV
          </button>
        </div>
      </div>

      {result.risk_config ? (
        <CostAssumptions rc={result.risk_config} title="Costs used for this run" showEditLink={false} />
      ) : (
        <div className="text-[11px] text-muted/70 font-mono">
          Cost snapshot unavailable for this result — re-run to capture the fees used.
        </div>
      )}

      {dims === 1 && <Grid1DChart rows={rows} gridParams={gridParams} metricId={metricId} />}
      {dims === 2 && <Grid2DHeatmap rows={rows} gridParams={gridParams} metricId={metricId} />}

      <GridPlateauPanel rows={rows} gridParams={gridParams} metricId={metricId} />

      <ResultsTable
        rows={rows}
        gridParams={gridParams}
        defaultMetric={defaultStatKey}
        baseParams={result?.base_params || {}}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sortable table
// ---------------------------------------------------------------------------

function ResultsTable({ rows, gridParams, defaultMetric, baseParams }) {
  const [sortKey, setSortKey] = useState(defaultMetric);
  const [sortDir, setSortDir] = useState("desc"); // desc by default for metrics
  const [detail, setDetail] = useState(null); // row object shown in the modal

  const sorted = useMemo(() => {
    const isParam = gridParams.some((gp) => gp.name === sortKey);
    // statValue() maps profit_factor null -> Infinity (it displays as "∞"),
    // so zero-loss combos sort as best instead of falling to the bottom.
    const get = (r) => isParam ? r.params[sortKey] : statValue(r.stats, sortKey);
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = get(a), bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return 0; // avoid Infinity - Infinity = NaN
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
      <div className="px-3 py-2 text-[10px] text-muted/70 border-b border-line/30">
        Click any row for full analytics (trade counts, long/short split, drawdown…).
      </div>
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
                <SortHeader key={c.id} active={sortKey === c.id} dir={sortDir} onClick={() => clickHeader(c.id)} align="right" title={c.title}>
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
                active={detail?.combo_idx === r.combo_idx}
                onClick={() => setDetail(r)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <GridDetailModal
        open={!!detail}
        onClose={() => setDetail(null)}
        row={detail}
        gridParams={gridParams}
        baseParams={baseParams}
      />
    </div>
  );
}

function SortHeader({ children, active, dir, onClick, align = "left", title }) {
  const arrow = !active ? "" : dir === "asc" ? " ▲" : " ▼";
  return (
    <th
      onClick={onClick}
      title={title}
      className={`px-3 py-2 cursor-pointer select-none hover:text-text ${align === "right" ? "text-right" : "text-left"} ${active ? "text-text" : ""}`}
    >
      {children}{arrow}
    </th>
  );
}

function Row({ row, gridParams, active, onClick }) {
  const s = row.stats || {};
  return (
    <tr
      onClick={onClick}
      className={`border-t border-line/30 cursor-pointer hover:bg-bg-elev/30 ${active ? "bg-bg-elev/40" : ""}`}
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
        return (
          <td key={c.id} className={`px-3 py-1.5 text-right ${cls}`}>
            {c.fmt(v)}
          </td>
        );
      })}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// 1D line chart (one param sweep)
// ---------------------------------------------------------------------------

function Grid1DChart({ rows, gridParams, metricId }) {
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
      <div className="text-sm font-semibold text-text">
        {METRIC_COLUMNS.find((m) => m.id === metricId)?.label || metricId} vs <span className="font-mono">{gp.name}</span>
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

function Grid2DHeatmap({ rows, gridParams, metricId }) {
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

  // All stats are numerically-higher-is-better (max_drawdown_pct is negative:
  // -9 is a worse drawdown than -7.8), so the plain ramp needs no inversion.
  const allValues = Array.from(valueAt.values()).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (allValues.length === 0) return null;
  const vMin = Math.min(...allValues);
  const vMax = Math.max(...allValues);

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div className="text-sm font-semibold text-text">
        {METRIC_COLUMNS.find((m) => m.id === metricId)?.label || metricId} heatmap
        &nbsp;<span className="text-muted text-xs">({gpX.name} × {gpY.name})</span>
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
                  const bg = metricColor(v, vMin, vMax);
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
        &nbsp;· range {fmtNum(vMin)} → {fmtNum(vMax)}
      </div>
    </div>
  );
}
