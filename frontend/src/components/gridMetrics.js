import { fmtNum, fmtInt, fmtPct } from "../services/format.js";

/**
 * Shared grid-search metric definitions and helpers, used by
 * GridResultsPanel.jsx (table / 1D chart / 2D heatmap) and
 * GridPlateauPanel.jsx (per-param marginal tiles).
 *
 * Sign convention: every stat here is "numerically higher = better".
 * max_drawdown_pct is stored NEGATIVE (≤ 0, e.g. -9 is a worse drawdown
 * than -7.8), so no inverted color scale is needed for it.
 */

export const METRIC_COLUMNS = [
  { id: "sharpe",            label: "Sharpe",        fmt: (v) => fmtNum(v),       sortable: true,  signed: false },
  { id: "total_return_pct",  label: "Return %",      fmt: (v) => fmtPct(v),       sortable: true,  signed: true  },
  // Drawdown vs STARTING capital (the engine also computes a peak-relative
  // variant, max_drawdown_pct_peak, not shown here).
  { id: "max_drawdown_pct",  label: "Max DD %",      fmt: (v) => fmtPct(v, false),sortable: true,  signed: true,
    title: "Max drawdown as % of starting capital" },
  { id: "win_rate",          label: "Win Rate",      fmt: (v) => `${fmtNum((v ?? 0) * 100)}%`, sortable: true, signed: false },
  { id: "trades",            label: "Trades",        fmt: (v) => fmtInt(v),       sortable: true,  signed: false },
  { id: "profit_factor",     label: "Profit Factor", fmt: (v) => v == null ? "∞" : fmtNum(v), sortable: true, signed: false },
];

// Backend job metric id -> stats key (mirrors _METRIC_KEYS in
// backend/services/grid_search.py).
export const METRIC_TO_STAT = {
  sharpe: "sharpe",
  profit_factor: "profit_factor",
  total_return: "total_return_pct",
};

/** Red (worst) → neutral → green (best) ramp over the observed [vMin, vMax]. */
export function metricColor(v, vMin, vMax) {
  if (v == null || !Number.isFinite(v)) return "rgba(255,255,255,0.04)";
  const t = (v - vMin) / (vMax - vMin || 1);
  if (t < 0.5) {
    const a = t / 0.5;
    return `rgba(239, 68, 68, ${0.55 - a * 0.4})`;
  }
  const a = (t - 0.5) / 0.5;
  return `rgba(16, 185, 129, ${0.15 + a * 0.55})`;
}

/**
 * Stats value normalized for COMPARISON. Mirrors the backend's
 * _score_from_stats semantics for profit_factor: null means gross_loss == 0,
 * which is +Infinity when there was any gross profit, else 0 (no winners).
 * Returns null when genuinely missing (e.g. sharpe not computable).
 */
export function statValue(stats, metricId) {
  const v = stats?.[metricId];
  if (metricId === "profit_factor" && v == null) {
    return (Number(stats?.gross_profit) || 0) > 0 ? Infinity : 0;
  }
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}
