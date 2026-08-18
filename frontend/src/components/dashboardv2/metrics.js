/**
 * Derived-metric + date helpers for Dashboard V2.
 *
 * Everything here reads ONLY data the backtest already returns and degrades to
 * null/"" when a value can't be computed honestly — never fabricates numbers.
 *
 * A "slice" `r` is either the top-level portfolio result or one
 * `result.per_strategy[id]` block; both share the same
 * {stats, equity, trades, analytics, spec} shape.
 */

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

// ---- date helpers (lifted from Dashboard.jsx so the page imports from here) --
export function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0));
  return Math.floor(dt.getTime() / 1000);
}
export function epochToDateStr(sec) {
  if (!sec) return "";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

// ---- starting capital resolution --------------------------------------------
export function startingCapital(r, riskConfig) {
  return (
    r?.stats?.starting_capital ??
    r?.risk_config?.starting_capital ??
    riskConfig?.starting_capital ??
    100000
  );
}

// ---- range pills -> backtest window -----------------------------------------
// MAX → no window (let the backend use the full dataset). CUSTOM → the user's
// picked start/end (clamped to the dataset). Otherwise end at the dataset's last
// bar and start N years earlier, clamped to the first bar.
export function rangeToWindow(rangeKey, bounds, customRange) {
  if (rangeKey === "CUSTOM") {
    let start = customRange?.start ? dateStrToEpoch(customRange.start) : undefined;
    let end = customRange?.end ? dateStrToEpoch(customRange.end, true) : undefined;
    if (bounds) {
      if (start != null && bounds.firstTime != null) start = Math.max(start, bounds.firstTime);
      if (end != null && bounds.lastTime != null) end = Math.min(end, bounds.lastTime);
    }
    return { start_time: start, end_time: end };
  }
  if (rangeKey === "MAX" || !bounds || !bounds.lastTime) {
    return { start_time: undefined, end_time: undefined };
  }
  const years = { "1Y": 1, "2Y": 2, "3Y": 3, "5Y": 5 }[rangeKey];
  if (!years) return { start_time: undefined, end_time: undefined };
  const end = bounds.lastTime;
  const start = Math.max(bounds.firstTime ?? 0, end - Math.floor(years * SECONDS_PER_YEAR));
  return { start_time: start, end_time: end };
}

// Concrete {start_time, end_time} epochs a selection covers, for DISPLAY (the
// "?" hint). Unlike rangeToWindow, MAX resolves to the dataset's full span
// rather than `undefined`, and CUSTOM falls back to the dataset edges for any
// side the user hasn't picked. Returns null when the span can't be known yet.
export function resolveWindowDates(rangeKey, bounds, customRange) {
  if (rangeKey === "CUSTOM") {
    const start = customRange?.start ? dateStrToEpoch(customRange.start) : bounds?.firstTime;
    const end = customRange?.end ? dateStrToEpoch(customRange.end, true) : bounds?.lastTime;
    return start != null && end != null ? { start_time: start, end_time: end } : null;
  }
  if (!bounds || bounds.firstTime == null || bounds.lastTime == null) return null;
  if (rangeKey === "MAX") return { start_time: bounds.firstTime, end_time: bounds.lastTime };
  const w = rangeToWindow(rangeKey, bounds);
  return w.start_time != null && w.end_time != null ? w : null;
}

// ---- default-param resolution (mirrors Dashboard.jsx timeframe-defaults merge)
export function resolveDefaultParams(meta, symbol, timeframe, userSaved) {
  if (!meta) return {};
  const defaults = {};
  for (const spec of meta.schema || []) defaults[spec.name] = spec.default;
  for (const preset of [meta.timeframe_defaults?.[timeframe], meta.symbol_defaults?.[symbol]]) {
    if (!preset) continue;
    for (const [k, v] of Object.entries(preset)) {
      const base = defaults[k];
      defaults[k] =
        v && typeof v === "object" && !Array.isArray(v) && base && typeof base === "object" && !Array.isArray(base)
          ? { ...base, ...v }
          : v;
    }
  }
  return userSaved ? { ...defaults, ...userSaved } : defaults;
}

// ---- annualized volatility (derived from the equity % series) ----------------
export function annualizedVol(equity) {
  if (!Array.isArray(equity) || equity.length < 3) return null;
  const v = equity.map((e) => e.value).filter((x) => typeof x === "number" && x > 0);
  if (v.length < 3) return null;
  const rets = [];
  for (let i = 1; i < v.length; i++) rets.push(v[i] / v[i - 1] - 1);
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const dts = [];
  for (let i = 1; i < equity.length; i++) {
    const dt = equity[i].time - equity[i - 1].time;
    if (dt > 0) dts.push(dt);
  }
  // MEAN bar interval, matching the backend annualizer (infer_bars_per_year).
  // Mean is gap-aware (weekend/session gaps lengthen it and correctly lower
  // periods/year); the median would assume 24/7 trading and over-annualize.
  const meanDt = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : 0;
  if (!meanDt) return null;
  const periodsPerYear = SECONDS_PER_YEAR / meanDt;
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100; // annualized %
}

// ---- underwater / drawdown series --------------------------------------------
// Computed from the % series (value) so it works regardless of whether the
// backend attached a `drawdown` field. dd% = (value/runningPeak - 1) * 100 (≤ 0).
export function underwaterSeries(r) {
  const eq = r?.equity;
  if (!Array.isArray(eq) || eq.length === 0) return [];
  let peak = -Infinity;
  const out = [];
  for (const e of eq) {
    const v = e.value;
    if (typeof v !== "number") continue;
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v / peak - 1) * 100 : 0;
    out.push({ time: e.time, value: dd });
  }
  return out;
}

// ---- monthly returns grid (year rows × 12 months + YTD) ----------------------
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export { MONTH_LABELS };

// A month's % return must be measured against the equity at the START of that
// month, not the original starting capital — once the curve compounds the two
// diverge by (equity / starting capital), which turned a normal +22% month into
// "+2,052%". `equity_start` comes from the backend; older cached results without
// it fall back to the previous (starting-capital) behaviour.
function monthBase(m, sc) {
  return typeof m?.equity_start === "number" && m.equity_start > 0 ? m.equity_start : sc;
}

export function monthlyReturnsGrid(monthly, sc) {
  if (!Array.isArray(monthly) || !sc) return { rows: [], maxAbs: 0 };
  const byYear = new Map();
  let maxAbs = 0;
  for (const m of monthly) {
    if (!m?.month) continue;
    const [yStr, moStr] = m.month.split("-");
    const year = Number(yStr);
    const mo = Number(moStr); // 1..12
    if (!year || !mo) continue;
    const pct = (m.pnl_dollars / monthBase(m, sc)) * 100;
    if (!byYear.has(year)) byYear.set(year, { year, months: {}, ytdPct: 0 });
    const row = byYear.get(year);
    row.months[mo] = pct;
    row.ytdPct += pct;
    if (Math.abs(pct) > maxAbs) maxAbs = Math.abs(pct);
  }
  const rows = Array.from(byYear.values()).sort((a, b) => a.year - b.year);
  return { rows, maxAbs };
}

// ---- best / worst calendar month ---------------------------------------------
export function bestWorstMonth(monthly, sc) {
  if (!Array.isArray(monthly) || !monthly.length || !sc) return { best: null, worst: null };
  let best = null;
  let worst = null;
  for (const m of monthly) {
    if (!m?.month) continue;
    const pct = (m.pnl_dollars / monthBase(m, sc)) * 100;
    const cur = { month: m.month, pct };
    if (!best || pct > best.pct) best = cur;
    if (!worst || pct < worst.pct) worst = cur;
  }
  return { best, worst };
}

// ---- status pill (honest Sharpe heuristic, NOT a validation verdict) ---------
export function statusPill(stats) {
  const s = stats?.sharpe;
  if (typeof s !== "number" || !Number.isFinite(s)) return { label: "NO DATA", tone: "muted" };
  if (s >= 1) return { label: "STRONG", tone: "profit" };
  if (s > 0) return { label: "MODEST", tone: "neutral" };
  return { label: "WEAK", tone: "loss" };
}

// ---- rule-based interpretation -----------------------------------------------
// Each clause is gated on the underlying value being finite; we never invent.
export function interpretation(r, derived) {
  const st = r?.stats || {};
  const ra = r?.analytics?.advanced?.risk_adjusted || {};
  const clauses = [];
  const fin = (x) => typeof x === "number" && Number.isFinite(x);

  if (fin(st.sharpe)) {
    const q = st.sharpe >= 1.5 ? "excellent" : st.sharpe >= 1 ? "solid" : st.sharpe > 0 ? "modest" : "negative";
    clauses.push(`Risk-adjusted return is ${q} (Sharpe ${st.sharpe.toFixed(2)}).`);
  }
  if (fin(st.total_return_pct)) {
    clauses.push(
      `Total return over the tested window is ${st.total_return_pct >= 0 ? "+" : ""}${st.total_return_pct.toFixed(1)}%` +
        (fin(ra.cagr_pct) ? ` (${ra.cagr_pct.toFixed(1)}% CAGR).` : "."),
    );
  }
  if (fin(st.max_drawdown_pct_peak)) {
    const dd = Math.abs(st.max_drawdown_pct_peak);
    clauses.push(`The worst peak-to-trough drawdown was ${dd.toFixed(1)}%.`);
  }
  if (fin(derived?.vol)) {
    clauses.push(`Annualized volatility is ${derived.vol.toFixed(1)}%.`);
  }
  if (fin(st.win_rate) && fin(st.trades)) {
    clauses.push(`Across ${st.trades} trades, ${(st.win_rate * 100).toFixed(0)}% were winners.`);
  }
  if (fin(st.profit_factor)) {
    const pf = st.profit_factor;
    clauses.push(
      pf >= 1
        ? `Gross profit outweighs gross loss (profit factor ${pf.toFixed(2)}).`
        : `Gross loss exceeds gross profit (profit factor ${pf.toFixed(2)}).`,
    );
  }
  return clauses.join(" ") || "Run a backtest to generate an interpretation.";
}
