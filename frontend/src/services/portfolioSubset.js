/**
 * Client-side "subset aggregate" recompute for the Analytics page.
 *
 * Given a full portfolio result and a set of selected strategy ids, returns
 * a synthesized result in the same shape as a single-strategy result —
 * trades, equity curve, headline stats, and the basic analytics blocks
 * (heatmap, monthly, drawdown curve, distribution, streaks, best/worst,
 * exposure, commission, trading days).
 *
 * Mirrors backtest_engine._compute_stats and _compute_analytics in JS.
 *
 * Limitations:
 * - by_session is left empty: different strategies may have different
 *   session configs; merging them is ambiguous in subset mode.
 * - analytics.advanced (Sortino, Calmar, Omega, deflated Sharpe, etc.)
 *   is NOT recomputed — it requires the Python quant_metrics module.
 *   In subset mode it's set to null; tabs that depend on it (Gaussian,
 *   T-Test, Trade Quality, Risk & Robustness) should fall back gracefully.
 */

export function computeSubset(portfolio, selectedSids) {
  if (!portfolio?.per_strategy) return null;
  const ids = Array.isArray(selectedSids) ? selectedSids : Array.from(selectedSids);
  if (ids.length === 0) return null;

  const rc = portfolio.risk_config || {};
  const starting = Number(rc.starting_capital) || 100000;

  // ---- Concatenate trades from selected strategies, sort by entry_time.
  const trades = [];
  for (const sid of ids) {
    const psd = portfolio.per_strategy[sid];
    if (!psd) continue;
    for (const t of psd.trades || []) trades.push({ ...t, strategy_id: sid });
  }
  trades.sort((a, b) => a.entry_time - b.entry_time);

  // ---- Build per-sid {time -> equity} lookups so we can stitch the
  // subset's synthetic equity curve onto the aggregate timeline.
  const eqMaps = {};
  for (const sid of ids) {
    const psd = portfolio.per_strategy[sid];
    if (!psd?.equity) continue;
    const m = new Map();
    for (const p of psd.equity) m.set(p.time, p.equity);
    eqMaps[sid] = m;
  }

  // ---- Subset synthetic equity curve.
  //   subset_eq[t] = starting + Σ_selected (per_strategy[sid].equity[t] - starting)
  // That is: starting capital + the sum of per-strategy attributions at t.
  // For ts where a strategy has no point, contribute 0 (its last known is
  // implicitly its starting capital; cumulative pnl unchanged).
  const baseline = portfolio.equity || [];
  const lastSeen = Object.fromEntries(ids.map((sid) => [sid, starting]));
  let peak = starting;
  const equity_curve = baseline.map((p) => {
    let sumContrib = 0;
    for (const sid of ids) {
      const eq = eqMaps[sid]?.get(p.time);
      if (eq != null) lastSeen[sid] = eq;
      sumContrib += (lastSeen[sid] - starting);
    }
    const eq = starting + sumContrib;
    if (eq > peak) peak = eq;
    return {
      time: p.time,
      equity: eq,
      value: (eq / starting) * 100.0,
      drawdown: ((eq - peak) / starting) * 100.0,
      drawdown_dollars: eq - peak,
    };
  });

  const final_equity = equity_curve.length
    ? equity_curve[equity_curve.length - 1].equity
    : starting;

  // ---- Stats (matches backtest_engine._compute_stats).
  const stats = computeStats(trades, final_equity, equity_curve, starting);

  // ---- Basic analytics blocks (matches backtest_engine._compute_analytics
  // minus by_session and the heavy advanced quant_metrics module).
  const analytics = computeAnalytics(trades, equity_curve, starting);

  // ---- Skipped signals filtered by selection.
  const selected = new Set(ids);
  const skipped_signals = (portfolio.skipped_signals || [])
    .filter((sk) => selected.has(sk.strategy_id));

  // ---- Result envelope.
  const firstSpec = portfolio.strategies?.[0] || {};
  return {
    strategy_id: ids.length === 1 ? ids[0] : `Portfolio (${ids.length})`,
    symbol: firstSpec.symbol,
    timeframe: firstSpec.timeframe,
    risk_config: rc,
    params: {},
    candles: [],
    overlays: [],
    trades,
    equity: equity_curve,
    stats,
    analytics,
    skipped_signals,
    _subset: true,                  // marker so tabs can adjust
    _selected_sids: ids,
  };
}

// ---------------------------------------------------------------------------
// Stats — port of backtest_engine._compute_stats
// ---------------------------------------------------------------------------

function computeStats(trades, final_equity, equity_curve, starting_capital) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const losses = n - wins;
  const win_rate = n ? wins / n : 0;

  const pnls = trades.map((t) => Number(t.pnl_dollars) || 0);
  const gross_profit = pnls.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const gross_loss   = -pnls.filter((v) => v < 0).reduce((a, b) => a + b, 0);
  const profit_factor = gross_loss > 0 ? gross_profit / gross_loss
                       : gross_profit > 0 ? null : 0;

  // Sharpe from per-bar MTM equity returns.
  let sharpe = 0;
  if (equity_curve.length >= 3) {
    const eq = equity_curve.map((p) => p.equity);
    const rets = [];
    for (let i = 1; i < eq.length; i++) {
      const denom = Math.abs(eq[i - 1]) < 1e-9 ? 1e-9 : eq[i - 1];
      const r = (eq[i] - eq[i - 1]) / denom;
      if (Number.isFinite(r)) rets.push(r);
    }
    if (rets.length >= 2) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
      const std = Math.sqrt(variance);
      if (std > 0) {
        // Annualize. Infer bars-per-year from median interval.
        const times = equity_curve.map((p) => p.time);
        const bars_per_year = inferBarsPerYear(times);
        if (bars_per_year > 0) sharpe = (mean / std) * Math.sqrt(bars_per_year);
      }
    }
  }

  const dd_dollars = equity_curve.map((p) => p.drawdown_dollars);
  const max_dd_dollars = dd_dollars.length ? Math.min(...dd_dollars) : 0;

  // Peak-relative max DD %.
  let max_dd_pct_peak = 0;
  if (equity_curve.length) {
    for (const p of equity_curve) {
      const peakAtT = p.equity - p.drawdown_dollars; // dd <= 0, peak >= equity
      const denom = peakAtT > 1e-9 ? peakAtT : starting_capital;
      const ddPct = (p.drawdown_dollars / denom) * 100;
      if (ddPct < max_dd_pct_peak) max_dd_pct_peak = ddPct;
    }
  }

  const longs  = trades.filter((t) => t.side === "long");
  const shorts = trades.filter((t) => t.side === "short");

  const pct_arr = trades.map((t) => Number(t.pnl_pct) || 0);

  const time_first = trades.length ? trades[0].entry_time : null;
  const time_last  = equity_curve.length
    ? equity_curve[equity_curve.length - 1].time
    : (trades.length ? trades[trades.length - 1].exit_time : null);

  return {
    starting_capital,
    final_equity,
    total_return_dollars: final_equity - starting_capital,
    total_return_pct: ((final_equity / starting_capital) - 1) * 100,
    trades: n,
    wins, losses, win_rate,
    profit_factor,
    sharpe,
    gross_profit,
    gross_loss,
    max_drawdown_pct: (max_dd_dollars / starting_capital) * 100,
    max_drawdown_pct_peak: max_dd_pct_peak,
    max_drawdown_dollars: max_dd_dollars,
    avg_pnl_dollars: n ? pnls.reduce((a, b) => a + b, 0) / n : 0,
    avg_pnl_pct:     n ? pct_arr.reduce((a, b) => a + b, 0) / n : 0,
    long:  sideBlock(longs),
    short: sideBlock(shorts),
    first_time: time_first,
    last_time: time_last,
  };
}

function sideBlock(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const pnl = trades.reduce((a, t) => a + (Number(t.pnl_dollars) || 0), 0);
  return {
    trades: n, wins, losses: n - wins,
    pnl_dollars: pnl,
    win_rate: n ? wins / n : 0,
    avg_pnl_dollars: n ? pnl / n : 0,
  };
}

function inferBarsPerYear(times) {
  if (times.length < 2) return 0;
  // Median gap (seconds) → bars per year.
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (!median || median <= 0) return 0;
  return (365.25 * 24 * 3600) / median;
}

// ---------------------------------------------------------------------------
// Analytics — port of backtest_engine._compute_analytics (minus advanced)
// ---------------------------------------------------------------------------

function computeAnalytics(trades, equity_curve, starting_capital) {
  // ---- Heatmap: PnL + count by dow × hour-of-day (UTC).
  const heat_pnl   = Array.from({ length: 7 }, () => Array(24).fill(0));
  const heat_count = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of trades) {
    const d = new Date(Number(t.entry_time) * 1000);
    const dow = (d.getUTCDay() + 6) % 7;   // 0 = Mon
    const hr = d.getUTCHours();
    heat_pnl[dow][hr]   += Number(t.pnl_dollars) || 0;
    heat_count[dow][hr] += 1;
  }

  // ---- Monthly returns (sum PnL by YYYY-MM).
  const monthlyMap = new Map();
  for (const t of trades) {
    const d = new Date(Number(t.entry_time) * 1000);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const cur = monthlyMap.get(ym) || { pnl: 0, trades: 0 };
    cur.pnl += Number(t.pnl_dollars) || 0;
    cur.trades += 1;
    monthlyMap.set(ym, cur);
  }
  const monthly_returns = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, pnl_dollars: v.pnl, trades: v.trades }));

  // ---- Streaks.
  let cur_w = 0, cur_l = 0, max_w = 0, max_l = 0;
  for (const t of trades) {
    if (t.win) { cur_w++; cur_l = 0; max_w = Math.max(max_w, cur_w); }
    else       { cur_l++; cur_w = 0; max_l = Math.max(max_l, cur_l); }
  }

  // ---- Drawdown curve + max duration.
  const drawdown_curve = equity_curve.map((p) => ({ time: p.time, drawdown: p.drawdown }));
  let dd_peak = -Infinity, cur_under = 0, max_under = 0;
  for (const p of equity_curve) {
    if (p.equity >= dd_peak) { dd_peak = p.equity; cur_under = 0; }
    else { cur_under++; max_under = Math.max(max_under, cur_under); }
  }

  // ---- Distribution (% of starting capital, 20 bins).
  let distribution_pnl_pct = [];
  if (trades.length) {
    const arr = trades.map((t) => Number(t.pnl_pct_equity) || 0);
    distribution_pnl_pct = histogram(arr, 20);
  }
  let distribution_duration_min = [];
  if (trades.length) {
    const arr = trades.map((t) => Number(t.duration_min) || 0);
    distribution_duration_min = histogram(arr, 12);
  }

  // ---- Best / worst single trade.
  let best = null, worst = null;
  for (const t of trades) {
    const v = Number(t.pnl_dollars) || 0;
    if (best === null  || v > best.pnl_dollars)  best = t;
    if (worst === null || v < worst.pnl_dollars) worst = t;
  }

  // ---- Exposure %. Approximated from trade [entry, exit] intervals against
  // the equity-curve time grid, union-counted.
  let exposure_pct = 0;
  if (trades.length && equity_curve.length) {
    const tg = equity_curve.map((p) => p.time);
    const idxOf = new Map();
    for (let i = 0; i < tg.length; i++) idxOf.set(tg[i], i);
    const intervals = [];
    for (const t of trades) {
      const lo = nearestIdx(idxOf, tg, t.entry_time);
      const hi = nearestIdx(idxOf, tg, t.exit_time);
      if (lo != null && hi != null && hi >= lo) intervals.push([lo, hi]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let pos = 0, cl = -1, ch = -1;
    for (const [lo, hi] of intervals) {
      if (lo > ch) {
        if (ch >= cl) pos += ch - cl + 1;
        cl = lo; ch = hi;
      } else {
        ch = Math.max(ch, hi);
      }
    }
    if (ch >= cl) pos += ch - cl + 1;
    exposure_pct = (pos / tg.length) * 100;
  }

  const commission_dollars = trades.reduce((a, t) => a + (Number(t.fees) || 0), 0);
  const trading_days = new Set(
    trades.map((t) => new Date(Number(t.entry_time) * 1000).toISOString().slice(0, 10))
  ).size;

  return {
    by_session: [],            // not recomputed in subset mode
    heatmap: { pnl: heat_pnl, count: heat_count },
    monthly_returns,
    streaks: { max_win_streak: max_w, max_loss_streak: max_l },
    drawdown_curve,
    max_drawdown_duration_bars: max_under,
    distribution_pnl_pct,
    distribution_duration_min,
    best_trade: best,
    worst_trade: worst,
    exposure_pct,
    commission_dollars,
    trading_days,
    advanced: null,            // not recomputed in subset mode
  };
}

function histogram(arr, bins) {
  if (!arr.length) return [];
  let lo = Math.min(...arr);
  let hi = Math.max(...arr);
  if (hi <= lo) hi = lo + 1e-6;
  const step = (hi - lo) / bins;
  const counts = Array(bins).fill(0);
  for (const v of arr) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / step)));
    counts[i]++;
  }
  return Array.from({ length: bins }, (_, i) => ({
    bin_lo: lo + i * step,
    bin_hi: lo + (i + 1) * step,
    count: counts[i],
  }));
}

function nearestIdx(idxOf, tg, t) {
  // Exact match first (the time grid is the aggregate equity curve so most
  // entries should hit). Otherwise binary search for nearest <= t.
  const exact = idxOf.get(t);
  if (exact != null) return exact;
  let lo = 0, hi = tg.length - 1;
  if (t < tg[0] || t > tg[hi]) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tg[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
