import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { useLastResult } from "../services/lastResultStore.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtTime } from "../services/format.js";
import { downloadTradesCsv } from "../services/exportTrades.js";
import { runMonteCarlo, aiAnalyzeMonteCarlo, aiAnalyzeBacktestSection } from "../services/api.js";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getKey() {
  // Hash like #analytics?key=vwma_reversion|BTCUSDT|15m
  const m = window.location.hash.match(/key=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const TABS = [
  { id: "overview",     label: "Overview" },
  { id: "sessions",     label: "Sessions" },
  { id: "heatmap",      label: "Heatmap" },
  { id: "monthly",      label: "Monthly" },
  { id: "drawdown",     label: "Drawdown" },
  { id: "distribution", label: "Distribution" },
  { id: "advanced",     label: "Advanced" },
  { id: "montecarlo",   label: "Monte Carlo" },
  { id: "trades",       label: "Trades" },
  { id: "ai",           label: "AI Analysis" },
];

export default function Analytics() {
  const [tab, setTab] = useState("overview");
  const [key, setKey] = useState(getKey());
  useEffect(() => {
    const onHash = () => setKey(getKey());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const result = useLastResult(key);

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="analytics" />

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-5">
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Backtest Analytics</h1>
            {result && (
              <div className="text-xs text-muted font-mono mt-0.5">
                {result.strategy_id} · {result.symbol} · {result.timeframe}
              </div>
            )}
          </div>
          <a href="#dashboard" className="text-xs text-accent-blue hover:underline">← Dashboard</a>
        </header>

        {!result && (
          <div className="rounded-xl border border-line bg-bg-panel/60 p-10 text-center text-muted">
            <div className="text-base text-text mb-1">No backtest result loaded</div>
            <div className="text-xs">Run a strategy on the Dashboard first.</div>
            <a href="#dashboard" className="inline-block mt-4 px-4 py-2 rounded-md bg-accent-grad text-white text-sm">
              Open Dashboard →
            </a>
          </div>
        )}

        {result && (
          <>
            <div className="flex items-center gap-1 border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 text-sm transition border-b-2 -mb-px ${
                    tab === t.id
                      ? "border-accent-blue text-text"
                      : "border-transparent text-muted hover:text-text"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "overview"     && <OverviewTab     result={result} />}
            {tab === "sessions"     && <SessionsTab     result={result} />}
            {tab === "heatmap"      && <HeatmapTab      result={result} />}
            {tab === "monthly"      && <MonthlyTab      result={result} />}
            {tab === "drawdown"     && <DrawdownTab     result={result} />}
            {tab === "distribution" && <DistributionTab result={result} />}
            {tab === "advanced"     && <AdvancedTab     result={result} />}
            {tab === "montecarlo"   && <MonteCarloTab   result={result} />}
            {tab === "trades"       && <TradesTab       result={result} />}
            {tab === "ai"           && <AITab            result={result} />}
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------------------

function OverviewTab({ result }) {
  const s = result.stats;
  const a = result.analytics;
  const rc = result.risk_config;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <KpiCard title="Final Equity"      value={fmtUsd(s.final_equity)} sub={`from ${fmtUsd(s.starting_capital)}`} />
      <KpiCard title="Total Return"      value={fmtPct(s.total_return_pct)} sub={fmtUsd(s.total_return_dollars)}
               positive={s.total_return_dollars >= 0} />
      <KpiCard title="Profit Factor"     value={s.profit_factor == null ? "∞" : fmtNum(s.profit_factor)} sub="gross profit / gross loss" />
      <KpiCard title="Sharpe (annualized)" value={fmtNum(s.sharpe)} sub="per-bar MTM equity returns" />
      <KpiCard title="Win Rate"          value={`${fmtNum(s.win_rate * 100)}%`} sub={`${fmtInt(s.wins)} W / ${fmtInt(s.losses)} L`} />
      <KpiCard title="Trades"            value={fmtInt(s.trades)} sub={`avg ${fmtUsd(s.avg_pnl_dollars)}`} />
      <KpiCard title="Max Drawdown"      value={fmtPct(s.max_drawdown_pct, false)} sub={fmtUsd(s.max_drawdown_dollars)}
               positive={false} />
      <KpiCard title="Max DD Duration"   value={fmtBarsDuration(a.max_drawdown_duration_bars, result.timeframe)} sub="time underwater" />
      <KpiCard title="Exposure"          value={`${fmtNum(a.exposure_pct)}%`} sub="bars in position" />
      <KpiCard title="Best Trade"        value={a.best_trade ? fmtUsd(a.best_trade.pnl_dollars) : "—"}
               sub={a.best_trade ? `${a.best_trade.side} · ${fmtPct(a.best_trade.pnl_pct_equity ?? a.best_trade.pnl_pct)} of capital` : ""} positive />
      <KpiCard title="Worst Trade"       value={a.worst_trade ? fmtUsd(a.worst_trade.pnl_dollars) : "—"}
               sub={a.worst_trade ? `${a.worst_trade.side} · ${fmtPct(a.worst_trade.pnl_pct_equity ?? a.worst_trade.pnl_pct)} of capital` : ""} positive={false} />
      <KpiCard title="Streaks"           value={`${a.streaks.max_win_streak}W / ${a.streaks.max_loss_streak}L`} sub="max consecutive" />
      <KpiCard title="Gross Profit"      value={fmtUsd(s.gross_profit)} sub="sum of winning trades" positive />
      <KpiCard title="Gross Loss"        value={fmtUsd(-s.gross_loss)} sub="sum of losing trades" positive={false} />
      <KpiCard title="Commission"        value={fmtUsd(a.commission_dollars)} sub="total fees paid" />
      <KpiCard title="Trading Days"      value={fmtInt(a.trading_days)} sub="days with at least 1 trade" />

      <div className="lg:col-span-3 grid grid-cols-2 gap-4">
        <SidePanel title="Long" b={s.long} />
        <SidePanel title="Short" b={s.short} />
      </div>

      <div className="lg:col-span-3 rounded-xl border border-line bg-bg-panel/40 p-4">
        <div className="text-xs uppercase tracking-wider text-muted mb-2">Risk config in effect for this run</div>
        <div className="grid grid-cols-6 gap-3 text-xs font-mono">
          <KV label="Capital"    value={fmtUsd(rc?.starting_capital)} />
          <KV label="Risk%"      value={`${fmtNum(rc?.risk_pct)}%`} />
          <KV label="Fee flat"   value={fmtUsd(rc?.fee_flat)} />
          <KV label="Fee %"      value={`${fmtNum(rc?.fee_pct)}%`} />
          <KV label="Slippage"   value={`${fmtNum(rc?.slippage_bps)} bps`} />
          <KV label="Pyramiding" value={fmtInt(rc?.pyramiding)} />
        </div>
      </div>

      <div className="lg:col-span-3">
        <ParamsCard params={result.params} />
      </div>
    </div>
  );
}

function ParamsCard({ params }) {
  if (!params) return null;
  // Group by likely groups: scalars vs sessions vs sides.
  const scalars = [];
  let sessions = null, sides = null;
  for (const [k, v] of Object.entries(params)) {
    if (k === "sessions" && v && typeof v === "object") sessions = v;
    else if (k === "sides" && v && typeof v === "object") sides = v;
    else scalars.push([k, v]);
  }
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="text-xs uppercase tracking-wider text-muted mb-2">Parameters used</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
        {scalars.map(([k, v]) => (
          <KV key={k} label={k} value={typeof v === "number" ? fmtNum(v) : String(v)} />
        ))}
      </div>
      {sessions && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Sessions</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-mono">
            {Object.entries(sessions).map(([name, cfg]) => (
              <div key={name} className={`px-2 py-1 rounded border ${cfg?.enabled ? "border-accent-blue/40 bg-accent-blue/5 text-text" : "border-line bg-bg-elev/30 text-muted line-through"}`}>
                {name} · {cfg?.start}–{cfg?.end}
              </div>
            ))}
          </div>
        </div>
      )}
      {sides && (
        <div className="mt-3 flex gap-3 text-xs font-mono">
          <div className={`px-2 py-1 rounded border ${sides.long ? "border-profit/40 bg-profit/5 text-profit" : "border-line text-muted line-through"}`}>long</div>
          <div className={`px-2 py-1 rounded border ${sides.short ? "border-loss/40 bg-loss/5 text-loss" : "border-line text-muted line-through"}`}>short</div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ title, value, sub, positive }) {
  const cls = positive == null
    ? "text-text"
    : positive ? "text-profit" : "text-loss";
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className={`text-2xl font-mono mt-1 ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5 font-mono">{sub}</div>}
    </div>
  );
}

function SidePanel({ title, b }) {
  const positive = (b?.pnl_dollars ?? 0) >= 0;
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title} side</div>
      <div className="grid grid-cols-3 gap-3 mt-2 text-sm font-mono">
        <KV label="PnL"      value={fmtUsd(b?.pnl_dollars)} valueClass={positive ? "text-profit" : "text-loss"} />
        <KV label="Trades"   value={fmtInt(b?.trades)} />
        <KV label="Win rate" value={`${fmtNum((b?.win_rate ?? 0) * 100)}%`} />
        <KV label="Wins"     value={fmtInt(b?.wins)} />
        <KV label="Losses"   value={fmtInt(b?.losses)} />
        <KV label="Avg trade" value={fmtUsd(b?.avg_pnl_dollars)} />
      </div>
    </div>
  );
}

function KV({ label, value, valueClass = "text-text" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 ${valueClass}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SESSIONS
// ---------------------------------------------------------------------------

function SessionsTab({ result }) {
  const rows = result.analytics.by_session || [];
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elev/40">
          <tr>
            <th className="text-left px-4 py-2">Session</th>
            <th className="text-right px-4 py-2">Trades</th>
            <th className="text-right px-4 py-2">Win%</th>
            <th className="text-right px-4 py-2">PnL</th>
            <th className="text-right px-4 py-2">Avg PnL</th>
            <th className="text-right px-4 py-2 border-l border-line/40">Long #</th>
            <th className="text-right px-4 py-2">Long PnL</th>
            <th className="text-right px-4 py-2 border-l border-line/40">Short #</th>
            <th className="text-right px-4 py-2">Short PnL</th>
          </tr>
        </thead>
        <tbody className="font-mono text-sm">
          {rows.length === 0 && (
            <tr><td colSpan={9} className="px-4 py-6 text-center text-muted">no trades</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.session} className="border-t border-line/40 hover:bg-bg-elev/30">
              <td className="px-4 py-2 text-text">{r.session}</td>
              <td className="px-4 py-2 text-right">{fmtInt(r.trades)}</td>
              <td className="px-4 py-2 text-right">{fmtNum(r.win_rate * 100)}%</td>
              <td className={`px-4 py-2 text-right ${r.pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(r.pnl_dollars)}</td>
              <td className="px-4 py-2 text-right">{fmtUsd(r.avg_pnl_dollars)}</td>
              <td className="px-4 py-2 text-right border-l border-line/40">{fmtInt(r.long_trades)}</td>
              <td className={`px-4 py-2 text-right ${r.long_pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(r.long_pnl_dollars)}</td>
              <td className="px-4 py-2 text-right border-l border-line/40">{fmtInt(r.short_trades)}</td>
              <td className={`px-4 py-2 text-right ${r.short_pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(r.short_pnl_dollars)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HEATMAP — Hour-of-day × Day-of-week
// ---------------------------------------------------------------------------

function HeatmapTab({ result }) {
  const [metric, setMetric] = useState("pnl");
  const pnlGrid = result.analytics.heatmap.pnl || [];
  const cntGrid = result.analytics.heatmap.count || [];
  const heat = metric === "pnl" ? pnlGrid : cntGrid;

  let min = Infinity, max = -Infinity;
  for (const row of heat) for (const v of row) { if (v < min) min = v; if (v > max) max = v; }
  if (min === Infinity) { min = 0; max = 0; }

  // ---- Insights ----
  const insights = useMemo(() => {
    let bestCell = null, worstCell = null, busiestCell = null;
    let pnlByHour = Array(24).fill(0);
    let cntByHour = Array(24).fill(0);
    let pnlByDow  = Array(7).fill(0);
    let cntByDow  = Array(7).fill(0);
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const p = pnlGrid[d]?.[h] ?? 0;
        const c = cntGrid[d]?.[h] ?? 0;
        if (c > 0 && (bestCell  == null || p > bestCell.pnl))  bestCell  = { dow: d, hour: h, pnl: p, count: c };
        if (c > 0 && (worstCell == null || p < worstCell.pnl)) worstCell = { dow: d, hour: h, pnl: p, count: c };
        if (busiestCell == null || c > busiestCell.count)      busiestCell = { dow: d, hour: h, pnl: p, count: c };
        pnlByHour[h] += p; cntByHour[h] += c;
        pnlByDow[d]  += p; cntByDow[d]  += c;
      }
    }
    const argMax = (arr) => arr.reduce((b, v, i) => (v > arr[b] ? i : b), 0);
    const argMin = (arr) => arr.reduce((b, v, i) => (v < arr[b] ? i : b), 0);
    const bestHour  = argMax(pnlByHour);
    const worstHour = argMin(pnlByHour);
    const bestDow   = argMax(pnlByDow);
    const worstDow  = argMin(pnlByDow);
    const busyHour  = argMax(cntByHour);
    const busyDow   = argMax(cntByDow);
    return { bestCell, worstCell, busiestCell, bestHour, worstHour, bestDow, worstDow, busyHour, busyDow,
             pnlByHour, pnlByDow, cntByHour, cntByDow };
  }, [pnlGrid, cntGrid]);

  const colorOf = (v) => {
    if (metric === "pnl") {
      if (v === 0) return "rgba(255,255,255,0.03)";
      if (v > 0) {
        const a = Math.min(1, v / Math.max(1e-9, max));
        return `rgba(34,197,94,${0.15 + 0.55 * a})`;
      } else {
        const a = Math.min(1, v / Math.min(-1e-9, min));
        return `rgba(239,68,68,${0.15 + 0.55 * a})`;
      }
    }
    if (v === 0) return "rgba(255,255,255,0.03)";
    const a = Math.min(1, v / Math.max(1, max));
    return `rgba(59,130,246,${0.15 + 0.55 * a})`;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs uppercase tracking-wider text-muted">Metric</span>
        <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-panel">
          {["pnl", "count"].map((m) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`px-3 py-1 text-xs rounded-md transition ${metric === m ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}>
              {m === "pnl" ? "PnL ($)" : "Trade count"}
            </button>
          ))}
        </div>
      </div>

      <InsightCard rows={[
        insights.bestCell  && [`Best slot`,    `${DOW[insights.bestCell.dow]} ${insights.bestCell.hour}:00 UTC`,
                               `${fmtUsd(insights.bestCell.pnl)} on ${fmtInt(insights.bestCell.count)} trades`, "profit"],
        insights.worstCell && [`Worst slot`,   `${DOW[insights.worstCell.dow]} ${insights.worstCell.hour}:00 UTC`,
                               `${fmtUsd(insights.worstCell.pnl)} on ${fmtInt(insights.worstCell.count)} trades`, "loss"],
        insights.busiestCell && [`Busiest slot`, `${DOW[insights.busiestCell.dow]} ${insights.busiestCell.hour}:00 UTC`,
                                 `${fmtInt(insights.busiestCell.count)} trades · ${fmtUsd(insights.busiestCell.pnl)}`, "neutral"],
        [`Best hour overall`,  `${insights.bestHour}:00`,  fmtUsd(insights.pnlByHour[insights.bestHour]),  "profit"],
        [`Worst hour overall`, `${insights.worstHour}:00`, fmtUsd(insights.pnlByHour[insights.worstHour]), "loss"],
        [`Best weekday`,       DOW[insights.bestDow],      fmtUsd(insights.pnlByDow[insights.bestDow]),    "profit"],
        [`Worst weekday`,      DOW[insights.worstDow],     fmtUsd(insights.pnlByDow[insights.worstDow]),   "loss"],
        [`Busiest weekday`,    DOW[insights.busyDow],      `${fmtInt(insights.cntByDow[insights.busyDow])} trades`, "neutral"],
      ].filter(Boolean)} />

      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 overflow-x-auto">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
          Hour of Day (UTC) × Day of Week — {metric === "pnl" ? "PnL in $" : "trade count"}
        </div>
        <table className="text-[11px] font-mono border-separate border-spacing-0.5">
          <thead>
            <tr>
              <th className="px-2 py-1 text-muted text-right"></th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="px-1 text-muted text-center w-8">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DOW.map((dow, di) => (
              <tr key={dow}>
                <td className="px-2 text-muted text-right pr-2">{dow}</td>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = heat[di]?.[h] ?? 0;
                  return (
                    <td key={h} className="w-8 h-8 text-center"
                        style={{ background: colorOf(v) }}
                        title={`${dow} ${h}:00 — ${metric === "pnl" ? fmtUsd(v) : fmtInt(v)}`}>
                      {v !== 0 && (
                        <span className="text-[9px] text-text/80">
                          {metric === "pnl" ? (Math.abs(v) >= 1000 ? `${Math.round(v/1000)}k` : Math.round(v)) : v}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MONTHLY
// ---------------------------------------------------------------------------

function MonthlyTab({ result }) {
  const rows = result.analytics.monthly_returns || [];
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.pnl_dollars)));

  const insights = useMemo(() => {
    if (!rows.length) return null;
    const best   = rows.reduce((b, r) => (r.pnl_dollars > b.pnl_dollars ? r : b), rows[0]);
    const worst  = rows.reduce((b, r) => (r.pnl_dollars < b.pnl_dollars ? r : b), rows[0]);
    const busiest = rows.reduce((b, r) => (r.trades > b.trades ? r : b), rows[0]);
    const calmest = rows.reduce((b, r) => (r.trades < b.trades ? r : b), rows[0]);
    const wins = rows.filter((r) => r.pnl_dollars > 0);
    const losses = rows.filter((r) => r.pnl_dollars < 0);
    const totalPnl = rows.reduce((s, r) => s + r.pnl_dollars, 0);
    const avgPnl = totalPnl / rows.length;
    const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
    const avgPerMonth = totalTrades / rows.length;

    // Trades vs PnL: "more trades = better PnL?" → simple correlation sign.
    const xs = rows.map((r) => r.trades);
    const ys = rows.map((r) => r.pnl_dollars);
    const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
    const ym = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - xm, dy = ys[i] - ym;
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    const corr = denom > 0 ? num / denom : 0;
    const corrLabel = Math.abs(corr) < 0.15
      ? "no clear relationship between trade count & PnL"
      : corr > 0
        ? `more trades tends to MORE PnL (corr ${fmtNum(corr)})`
        : `more trades tends to LESS PnL (corr ${fmtNum(corr)})`;

    return { best, worst, busiest, calmest, wins, losses, totalPnl, avgPnl, avgPerMonth, corrLabel, monthCount: rows.length };
  }, [rows]);

  return (
    <div className="space-y-3">
      {insights && (
        <InsightCard rows={[
          [`Best month`,    insights.best.month,    fmtUsd(insights.best.pnl_dollars),  "profit"],
          [`Worst month`,   insights.worst.month,   fmtUsd(insights.worst.pnl_dollars), "loss"],
          [`Busiest month`, insights.busiest.month, `${fmtInt(insights.busiest.trades)} trades · ${fmtUsd(insights.busiest.pnl_dollars)}`, "neutral"],
          [`Calmest month`, insights.calmest.month, `${fmtInt(insights.calmest.trades)} trades · ${fmtUsd(insights.calmest.pnl_dollars)}`, "neutral"],
          [`Win/loss months`, `${insights.wins.length} W / ${insights.losses.length} L`, `${fmtNum(insights.wins.length / insights.monthCount * 100)}% green`, insights.wins.length >= insights.losses.length ? "profit" : "loss"],
          [`Avg per month`,   `${fmtUsd(insights.avgPnl)}`, `${fmtNum(insights.avgPerMonth)} trades`, insights.avgPnl >= 0 ? "profit" : "loss"],
          [`Trades ↔ PnL`,    insights.corrLabel, "", "neutral"],
        ]} />
      )}

      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-muted">Monthly P&amp;L</div>
        {rows.length === 0 && <div className="text-sm text-muted py-4">no trades</div>}
        <div className="space-y-1">
          {rows.map((r) => {
            const pos = r.pnl_dollars >= 0;
            const pct = (Math.abs(r.pnl_dollars) / max) * 100;
            return (
              <div key={r.month} className="flex items-center gap-3 text-xs font-mono">
                <span className="w-20 text-muted">{r.month}</span>
                <div className="flex-1 h-5 bg-bg-elev/40 rounded relative">
                  <div
                    className={`absolute top-0 bottom-0 left-1/2 ${pos ? "bg-profit/40" : "bg-loss/40"}`}
                    style={{ width: `${pct / 2}%`, transform: pos ? "" : "translateX(-100%)" }}
                  />
                </div>
                <span className={`w-28 text-right ${pos ? "text-profit" : "text-loss"}`}>{fmtUsd(r.pnl_dollars)}</span>
                <span className="w-14 text-right text-muted">{fmtInt(r.trades)} t</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InsightCard({ rows }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">Insights</div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-xs">
        {rows.map(([label, key, sub, tone], i) => {
          const toneCls = tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-text";
          return (
            <div key={i} className="flex flex-col">
              <span className="text-muted">{label}</span>
              <span className={`font-mono ${toneCls}`}>{key}</span>
              {sub && <span className="text-muted/80 font-mono text-[11px]">{sub}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DRAWDOWN
// ---------------------------------------------------------------------------

function DrawdownTab({ result }) {
  const dd = result.analytics?.drawdown_curve || [];
  const startingCapital = result.stats?.starting_capital ?? result.risk_config?.starting_capital ?? 100000;

  // Outer panel has padding; the SVG lives in an inner ref-tracked box
  // that excludes padding so width math never overflows.
  const innerRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 320 });
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 320 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 64, r: 16, t: 12, b: 26 };
  const innerW = Math.max(1, size.w - pad.l - pad.r);
  const innerH = Math.max(1, size.h - pad.t - pad.b);

  const sampled = useMemo(() => {
    if (dd.length === 0) return [];
    const max = Math.min(dd.length, Math.max(800, innerW * 2));
    if (dd.length <= max) return dd;
    const step = Math.max(1, Math.floor(dd.length / max));
    const out = [];
    for (let i = 0; i < dd.length; i += step) out.push(dd[i]);
    if (out[out.length - 1] !== dd[dd.length - 1]) out.push(dd[dd.length - 1]);
    return out;
  }, [dd, innerW]);

  if (dd.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        no drawdown data — run a backtest with trades
      </div>
    );
  }

  const tMin = sampled[0].time, tMax = sampled[sampled.length - 1].time;
  const dMin = Math.min(0, ...sampled.map((p) => p.drawdown));
  const dMax = 0;
  const xOf = (t) => pad.l + ((t - tMin) / (tMax - tMin || 1)) * innerW;
  const yOf = (v) => pad.t + (1 - (v - dMin) / (dMax - dMin || 1)) * innerH;

  let path = "";
  for (let i = 0; i < sampled.length; i++) {
    path += (i === 0 ? "M" : "L") + xOf(sampled[i].time).toFixed(1) + "," + yOf(sampled[i].drawdown).toFixed(1);
  }
  const area = `${path} L${xOf(tMax).toFixed(1)},${yOf(0).toFixed(1)} L${xOf(tMin).toFixed(1)},${yOf(0).toFixed(1)} Z`;

  // X-axis date ticks (5).
  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const t = tMin + ((tMax - tMin) * i) / 4;
    const isFirst = i === 0;
    const isLast = i === 4;
    return { t, x: xOf(t), anchor: isFirst ? "start" : isLast ? "end" : "middle" };
  });

  const onMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < pad.l || x > size.w - pad.r) { setHover(null); return; }
    const t = tMin + ((x - pad.l) / innerW) * (tMax - tMin);
    // Nearest by time (binary search).
    let lo = 0, hi = sampled.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sampled[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    setHover({ x, point: sampled[lo] });
  };

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 w-full overflow-hidden">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
        Drawdown (%) · max {fmtNum(dMin)}% ({fmtUsd(dMin / 100 * startingCapital)}) · {sampled.length} pts
      </div>
      <div ref={innerRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block"
             onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>
          <line x1={pad.l} x2={size.w - pad.r} y1={yOf(0)} y2={yOf(0)}
                stroke="rgba(229,231,235,0.3)" strokeWidth="0.6" />
          <path d={area} fill="rgba(239,68,68,0.18)" />
          <path d={path} fill="none" stroke="#ef4444" strokeWidth="1.5" />

          {/* Y axis labels */}
          <text x={pad.l - 6} y={yOf(0) + 3} textAnchor="end"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">0%</text>
          <text x={pad.l - 6} y={yOf(dMin) + 3} textAnchor="end"
                className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">{fmtNum(dMin)}%</text>

          {/* X axis */}
          {xTicks.map((tk, i) => (
            <g key={i}>
              <line x1={tk.x} x2={tk.x} y1={size.h - pad.b} y2={size.h - pad.b + 4}
                    stroke="rgba(107,114,128,0.6)" strokeWidth="0.6" />
              <text x={tk.x} y={size.h - 8} textAnchor={tk.anchor}
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {new Date(tk.t * 1000).toISOString().slice(0, 10)}
              </text>
            </g>
          ))}

          {/* Hover crosshair */}
          {hover && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={pad.t} y2={size.h - pad.b}
                    stroke="rgba(229,231,235,0.3)" strokeDasharray="2 3" />
              <circle cx={xOf(hover.point.time)} cy={yOf(hover.point.drawdown)} r={3.5} fill="#ef4444" />
            </g>
          )}
        </svg>

        {/* Hover tooltip */}
        {hover && (
          <div
            className="absolute z-20 px-2 py-1 rounded-md border border-line bg-bg-panel/95 text-[11px] font-mono pointer-events-none whitespace-nowrap"
            style={{ left: Math.min(hover.x + 10, size.w - 200), top: pad.t + 4 }}
          >
            <div className="text-muted">{new Date(hover.point.time * 1000).toISOString().replace("T", " ").slice(0, 16)}Z</div>
            <div className="text-loss">{fmtNum(hover.point.drawdown)}%</div>
            <div className="text-loss/80">{fmtUsd(hover.point.drawdown / 100 * startingCapital)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DISTRIBUTION
// ---------------------------------------------------------------------------

function DistributionTab({ result }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <DistributionPanel
        title="Per-trade Equity Impact (% of starting capital)"
        bins={result.analytics.distribution_pnl_pct || []}
        formatBin={(b) => `${fmtNum(b.bin_lo)}…${fmtNum(b.bin_hi)}%`}
        positiveCenter={0}
      />
      <DistributionPanel
        title="Trade Duration (minutes)"
        bins={result.analytics.distribution_duration_min || []}
        formatBin={(b) => `${fmtInt(b.bin_lo)}…${fmtInt(b.bin_hi)} min`}
      />
    </div>
  );
}

function DistributionPanel({ title, bins, formatBin, positiveCenter }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-2">{title}</div>
      <div className="space-y-1">
        {bins.length === 0 && <div className="text-sm text-muted py-4">no trades</div>}
        {bins.map((b, i) => {
          const w = (b.count / max) * 100;
          const center = positiveCenter == null
            ? false
            : (b.bin_lo + b.bin_hi) / 2 >= positiveCenter;
          const cls = positiveCenter == null
            ? "bg-accent-blue/40"
            : center ? "bg-profit/40" : "bg-loss/40";
          return (
            <div key={i} className="flex items-center gap-2 text-[11px] font-mono">
              <span className="w-44 text-muted">{formatBin(b)}</span>
              <div className="flex-1 h-4 bg-bg-elev/40 rounded">
                <div className={`h-4 rounded ${cls}`} style={{ width: `${w}%` }} />
              </div>
              <span className="w-10 text-right text-muted">{fmtInt(b.count)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ADVANCED — adversarial quant metrics (edge, significance, robustness)
// ---------------------------------------------------------------------------

function AdvancedTab({ result }) {
  const adv = result?.analytics?.advanced;
  if (!adv) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        No advanced metrics in this result. Re-run the backtest to populate.
      </div>
    );
  }

  const ts = adv.trade_stats || {};
  const ra = adv.risk_adjusted || {};
  const dd = adv.drawdown || {};
  const di = adv.distribution || {};
  const edge = adv.edge;
  const rob = adv.robustness;

  const sigTone = di.significance === "significant" ? "text-profit"
    : di.significance === "marginal" ? "text-amber-400"
    : "text-loss";
  const sigLabel = di.significance === "significant" ? "Significant (p<0.01)"
    : di.significance === "marginal" ? "Marginal (p<0.05)"
    : "Not significant";

  return (
    <div className="space-y-4">
      {/* Edge & concentration */}
      <Section title="Edge & Concentration"
               hint="Is the edge real and broadly distributed, or did 10 lucky trades carry the run?">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <KpiCard title="Expectancy / trade" value={fmtUsd(ts.expectancy_dollars)}
                   sub={ts.expectancy_R != null ? `${fmtNum(ts.expectancy_R)} R` : "—"}
                   positive={(ts.expectancy_dollars ?? 0) >= 0} />
          <KpiCard title="Avg win / loss" value={`${fmtUsd(ts.avg_win)} / ${fmtUsd(ts.avg_loss)}`}
                   sub={ts.payoff_ratio != null ? `payoff ${fmtNum(ts.payoff_ratio)}×` : "—"} />
          <KpiCard title="Top-10 winners share"
                   value={ts.top10_winners_share != null ? `${fmtNum(ts.top10_winners_share * 100)}%` : "—"}
                   sub={ts.luck_dependent_wins ? "⚠ heavy luck dependency" : "of gross profit"}
                   positive={ts.luck_dependent_wins === false} />
          <KpiCard title="Top-10 losers share"
                   value={ts.top10_losers_share != null ? `${fmtNum(ts.top10_losers_share * 100)}%` : "—"}
                   sub={ts.luck_dependent_losses ? "⚠ concentrated tail risk" : "of gross loss"}
                   positive={ts.luck_dependent_losses === false} />
          <KpiCard title="Skewness" value={di.skewness != null ? fmtNum(di.skewness) : "—"}
                   sub="positive = right-tail wins"
                   positive={(di.skewness ?? 0) >= 0} />
          <KpiCard title="Excess kurtosis" value={di.kurtosis_excess != null ? fmtNum(di.kurtosis_excess) : "—"}
                   sub="high = fat tails"
                   positive={(di.kurtosis_excess ?? 0) < 3} />
          <KpiCard title="Tail ratio" value={di.tail_ratio != null ? fmtNum(di.tail_ratio) : "—"}
                   sub=">1 = right-fat (good)"
                   positive={(di.tail_ratio ?? 0) >= 1} />
          <KpiCard title="Winners / Losers" value={`${fmtInt(ts.n_winners)} W / ${fmtInt(ts.n_losers)} L`}
                   sub={`${fmtNum((ts.win_rate ?? 0) * 100)}% win rate`} />
        </div>
      </Section>

      {/* Statistical significance */}
      <Section title="Statistical Significance"
               hint="Is mean trade return greater than zero with statistical confidence?">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard title="T-statistic" value={di.t_stat != null ? fmtNum(di.t_stat) : "—"}
                   sub="higher = more evidence of edge" />
          <KpiCard title="P-value" value={fmtTinyProb(di.t_pvalue)}
                   sub={sigLabel} positive={di.significance === "significant"} />
          <KpiCard title="Trades sampled" value={fmtInt(di.n_trades)}
                   sub={di.n_trades < 30 ? "⚠ small sample" : "n ≥ 30"} />
          <KpiCard title="Prob of ruin"
                   value={fmtTinyProb(di.prob_ruin)}
                   sub="closed-form, fixed bet size"
                   positive={(di.prob_ruin ?? 1) < 0.01} />
        </div>
        <div className={`mt-2 text-xs font-mono ${sigTone}`}>{sigLabel}</div>
      </Section>

      {/* Risk-adjusted return metrics */}
      <Section title="Risk-Adjusted Returns"
               hint="How much return per unit of pain? Multiple lenses on the same equity curve.">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <KpiCard title="CAGR" value={`${fmtNum(ra.cagr_pct)}%`}
                   sub="compound annual" positive={(ra.cagr_pct ?? 0) >= 0} />
          <KpiCard title="Sortino" value={ra.sortino != null ? fmtNum(ra.sortino) : "—"}
                   sub="downside-only volatility" positive={(ra.sortino ?? 0) >= 1} />
          <KpiCard title="Calmar / MAR" value={ra.calmar != null ? fmtNum(ra.calmar) : "—"}
                   sub="CAGR / max DD" positive={(ra.calmar ?? 0) >= 0.5} />
          <KpiCard title="Omega" value={ra.omega != null ? fmtNum(ra.omega) : "—"}
                   sub="gains / losses (τ=0)" positive={(ra.omega ?? 0) >= 1} />
          <KpiCard title="Gain-to-Pain" value={ra.gain_to_pain != null ? fmtNum(ra.gain_to_pain) : "—"}
                   sub="Σ positive / |Σ negative|" positive={(ra.gain_to_pain ?? 0) >= 1.5} />
          <KpiCard title="K-Ratio" value={ra.k_ratio != null ? fmtNum(ra.k_ratio) : "—"}
                   sub="equity curve smoothness" positive={(ra.k_ratio ?? 0) >= 0} />
          <KpiCard title="Ulcer Index" value={dd.ulcer_index != null ? fmtNum(dd.ulcer_index) : "—"}
                   sub="RMS drawdown depth %" positive={false} />
          <KpiCard title="Pain Ratio" value={dd.pain_ratio != null ? fmtNum(dd.pain_ratio) : "—"}
                   sub="CAGR / Ulcer" positive={(dd.pain_ratio ?? 0) >= 0} />
        </div>
      </Section>

      {/* Drawdown shape */}
      <Section title="Drawdown Shape"
               hint="Depth alone is misleading. How long underwater? Did we ever recover to the all-time high?">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard title="Max DD (peak-rel)" value={`${fmtNum(dd.max_drawdown_pct)}%`}
                   sub="deepest point, % of peak" positive={false} />
          <KpiCard title="DD duration"
                   value={fmtBarsDuration(dd.max_drawdown_duration_bars, result.timeframe)}
                   sub="longest underwater stretch" />
          <KpiCard title="Time to recover"
                   value={dd.time_to_recovery_bars != null
                     ? fmtBarsDuration(dd.time_to_recovery_bars, result.timeframe)
                     : "—"}
                   sub={dd.recovered_from_deepest_dd === false
                     ? "did not regain pre-DD peak"
                     : "from deepest trough"}
                   positive={dd.recovered_from_deepest_dd !== false} />
          <KpiCard title="DD at backtest end"
                   value={(dd.open_drawdown_pct ?? 0) >= -0.01
                     ? "at ATH"
                     : `${fmtNum(dd.open_drawdown_pct)}%`}
                   sub={dd.final_equity_above_start
                     ? "(profitable run, % below ATH)"
                     : "below starting capital"}
                   positive={(dd.open_drawdown_pct ?? 0) > -3
                     && dd.final_equity_above_start !== false} />
        </div>
      </Section>

      {/* MAE / MFE edge analysis */}
      {edge && (
        <Section title="Maximum Adverse / Favorable Excursion"
                 hint="How deep did winning trades dip before working? How much profit did losers leave on the table?">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard title="Avg MAE" value={`${fmtNum(edge.avg_mae_pct)}%`}
                     sub="worst intra-trade adverse move" positive={false} />
            <KpiCard title="Avg MFE" value={`${fmtNum(edge.avg_mfe_pct)}%`}
                     sub="best intra-trade favorable move" positive />
            <KpiCard title="Convexity" value={edge.convexity != null ? `${fmtNum(edge.convexity)}×` : "—"}
                     sub="MFE / |MAE| ratio"
                     positive={(edge.convexity ?? 0) >= 1.5} />
          </div>
        </Section>
      )}

      {/* Robustness — only when WF result is loaded */}
      {rob && (
        <Section title="Robustness (Walk-Forward)"
                 hint="Does the strategy survive parameter drift and out-of-sample testing?">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <KpiCard title="Parameter stability"
                     value={rob.parameter_stability_score != null ? `${fmtNum(rob.parameter_stability_score * 100)}%` : "—"}
                     sub="flatness of top-decile params"
                     positive={(rob.parameter_stability_score ?? 0) >= 0.5} />
            <KpiCard title="Deflated Sharpe prob"
                     value={rob.deflated_sharpe_probability != null ? `${fmtNum(rob.deflated_sharpe_probability * 100)}%` : "—"}
                     sub="P(best Sharpe > null)"
                     positive={(rob.deflated_sharpe_probability ?? 0) >= 0.95} />
            <KpiCard title="Walk-Forward Efficiency"
                     value={rob.walk_forward_efficiency != null ? `${fmtNum(rob.walk_forward_efficiency)}×` : "—"}
                     sub="median OOS / IS"
                     positive={(rob.walk_forward_efficiency ?? 0) >= 0.5} />
            <KpiCard title="OOS positive windows"
                     value={rob.pct_windows_positive_oos != null ? `${fmtNum(rob.pct_windows_positive_oos * 100)}%` : "—"}
                     sub={`${fmtInt(rob.n_windows)} windows`}
                     positive={(rob.pct_windows_positive_oos ?? 0) >= 0.5} />
            <KpiCard title="Trials evaluated" value={fmtInt(rob.n_trials)}
                     sub="across all windows" />
          </div>
        </Section>
      )}
    </div>
  );
}

function fmtTinyProb(v) {
  // Format a probability cleanly. Avoids scientific notation in the UI for
  // values that are still readable as decimals; collapses negligibly-small
  // values to "≈ 0".
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (v < 1e-6) return "≈ 0";
  if (v < 1e-4) return "< 0.0001";
  if (v < 0.01)  return v.toFixed(4);
  if (v < 1)     return v.toFixed(3);
  return v.toFixed(2);
}

// Parse "15m" / "1h" / "4h" / "1d" → seconds per bar.
function tfSeconds(tf) {
  const m = String(tf || "").match(/^(\d+)([smhd])$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[u] || 0);
}

// Render a bar count as a human duration based on the result's timeframe.
function fmtBarsDuration(bars, tf) {
  if (bars == null || !Number.isFinite(bars)) return "—";
  const sec = bars * tfSeconds(tf);
  if (!sec) return `${fmtInt(bars)} bars`;
  const days = sec / 86400;
  let primary;
  if (days < 1)        primary = `${fmtNum(sec / 3600)} hr`;
  else if (days < 14)  primary = `${fmtNum(days)} days`;
  else if (days < 70)  primary = `${fmtNum(days / 7)} weeks`;
  else if (days < 730) primary = `${fmtNum(days / 30.44)} months`;
  else                 primary = `${fmtNum(days / 365.25)} yrs`;
  return `${primary} (${fmtInt(bars)} bars)`;
}

function Section({ title, hint, children }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-text">{title}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TRADES
// ---------------------------------------------------------------------------

function TradesTab({ result }) {
  const [sortBy, setSortBy] = useState("entry_time");
  const [dir, setDir] = useState("desc");
  const trades = useMemo(() => {
    const t = [...(result.trades || [])];
    t.sort((a, b) => {
      const va = a[sortBy], vb = b[sortBy];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * (dir === "desc" ? -1 : 1);
    });
    return t;
  }, [result, sortBy, dir]);

  const flip = (k) => {
    if (sortBy === k) setDir(dir === "asc" ? "desc" : "asc");
    else { setSortBy(k); setDir("desc"); }
  };

  const Th = ({ k, children, right = false }) => (
    <th
      onClick={() => flip(k)}
      className={`px-3 py-2 cursor-pointer select-none ${right ? "text-right" : "text-left"} hover:text-text`}
    >
      {children}{sortBy === k && <span className="ml-1 text-[9px]">{dir === "asc" ? "▲" : "▼"}</span>}
    </th>
  );

  const tradeCount = (result.trades || []).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted font-mono">
          {fmtInt(tradeCount)} trade{tradeCount === 1 ? "" : "s"}
        </div>
        <button
          onClick={() => downloadTradesCsv(result)}
          disabled={tradeCount === 0}
          className="px-3 py-1.5 text-xs rounded-md bg-accent-grad text-white disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
          title="Export trades to CSV (TradingView format)"
        >
          ⬇ Export CSV
        </button>
      </div>

    <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
      <div className="overflow-x-auto max-h-[70vh]">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elev/40 sticky top-0">
            <tr>
              <Th k="entry_time">Entry</Th>
              <Th k="exit_time">Exit</Th>
              <Th k="side">Side</Th>
              <Th k="entry_price" right>Entry $</Th>
              <Th k="exit_price"  right>Exit $</Th>
              <Th k="duration_min" right>Duration (min)</Th>
              <Th k="pnl_pct" right>PnL %</Th>
              <Th k="pnl_dollars" right>PnL $</Th>
              <Th k="mae_pct" right>MAE %</Th>
              <Th k="mfe_pct" right>MFE %</Th>
              <Th k="fees" right>Fees</Th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {trades.length === 0 && (
              <tr><td colSpan={11} className="px-3 py-6 text-center text-muted">no trades</td></tr>
            )}
            {trades.map((t, i) => (
              <tr key={i} className="border-t border-line/40 hover:bg-bg-elev/30">
                <td className="px-3 py-1.5 text-muted">{fmtTime(t.entry_time)}</td>
                <td className="px-3 py-1.5 text-muted">{fmtTime(t.exit_time)}</td>
                <td className={`px-3 py-1.5 ${t.side === "long" ? "text-profit" : "text-loss"}`}>{t.side}</td>
                <td className="px-3 py-1.5 text-right">{fmtNum(t.entry_price)}</td>
                <td className="px-3 py-1.5 text-right">{fmtNum(t.exit_price)}</td>
                <td className="px-3 py-1.5 text-right">{fmtInt(t.duration_min)}</td>
                <td className={`px-3 py-1.5 text-right ${t.pnl_pct >= 0 ? "text-profit" : "text-loss"}`}>{fmtPct(t.pnl_pct)}</td>
                <td className={`px-3 py-1.5 text-right ${t.pnl_dollars >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(t.pnl_dollars)}</td>
                <td className="px-3 py-1.5 text-right text-loss/80">{t.mae_pct != null ? fmtNum(t.mae_pct) : "—"}</td>
                <td className="px-3 py-1.5 text-right text-profit/80">{t.mfe_pct != null ? fmtNum(t.mfe_pct) : "—"}</td>
                <td className="px-3 py-1.5 text-right text-muted">{fmtUsd(t.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI ANALYSIS — per-section Claude analysis (Haiku)
// ---------------------------------------------------------------------------

const AI_SECTIONS = [
  { id: "overview",     label: "Overview",     hint: "Headline stats — did it work?" },
  { id: "sessions",     label: "Sessions",     hint: "Which trading sessions carry the result?" },
  { id: "heatmap",      label: "Heatmap",      hint: "Hour × weekday PnL patterns." },
  { id: "monthly",      label: "Monthly",      hint: "Monthly stability and outliers." },
  { id: "drawdown",     label: "Drawdown",     hint: "DD shape, recovery, psychological load." },
  { id: "distribution", label: "Distribution", hint: "PnL skew, duration spread, fat tails." },
  { id: "advanced",     label: "Advanced",     hint: "Significance, concentration, robustness." },
  { id: "trades",       label: "Trades",       hint: "Best/worst sample + MAE/MFE patterns." },
];

function AITab({ result }) {
  // Cache analyses per section so flipping back and forth doesn't re-spend.
  const [byId, setById] = useState({});         // { [section]: {text, model, usage} }
  const [loadingId, setLoadingId] = useState(null);
  const [errorId, setErrorId] = useState(null);
  const [selected, setSelected] = useState("overview");

  async function runSection(id) {
    setLoadingId(id); setErrorId(null);
    try {
      const data = await aiAnalyzeBacktestSection(result, id);
      setById((m) => ({ ...m, [id]: data }));
    } catch (e) {
      setErrorId(id);
      setById((m) => ({ ...m, [id]: { error: e?.response?.data?.error || e.message || "AI analysis failed" } }));
    } finally {
      setLoadingId(null);
    }
  }

  async function runAll() {
    for (const sec of AI_SECTIONS) {
      // Skip sections we already have (and didn't error).
      if (byId[sec.id] && !byId[sec.id].error) continue;
      await runSection(sec.id);
    }
  }

  const current = byId[selected];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-accent-blue/30 bg-accent-blue/5 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-accent-blue">AI Analysis · Claude Haiku 4.5</div>
            <div className="text-xs text-muted mt-0.5">
              Each section gives a focused 2–4 paragraph read of that tab's data. Pick one, or run them all.
            </div>
          </div>
          <button onClick={runAll} disabled={loadingId != null}
            className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50">
            {loadingId ? `Running ${loadingId}…` : "Run all sections"}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {AI_SECTIONS.map((sec) => {
            const has = byId[sec.id] && !byId[sec.id].error;
            const err = byId[sec.id] && byId[sec.id].error;
            const isLoading = loadingId === sec.id;
            const isSelected = selected === sec.id;
            return (
              <button key={sec.id}
                onClick={() => { setSelected(sec.id); if (!has && !isLoading) runSection(sec.id); }}
                disabled={isLoading}
                className={`text-left px-3 py-2 rounded-md border text-xs transition ${
                  isSelected
                    ? "border-accent-blue bg-accent-blue/10 text-text"
                    : "border-line bg-bg-elev/30 text-muted hover:text-text hover:border-accent-blue/40"
                }`}
                title={sec.hint}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text">{sec.label}</span>
                  <span className="text-[10px] font-mono">
                    {isLoading ? "…" : has ? "✓" : err ? "✗" : ""}
                  </span>
                </div>
                <div className="text-[10px] text-muted/80 mt-0.5">{sec.hint}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-bg-panel/60 p-5 min-h-[200px]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-text">
            {AI_SECTIONS.find((s) => s.id === selected)?.label} — Analysis
          </div>
          {current && !current.error && (
            <button onClick={() => runSection(selected)} disabled={loadingId === selected}
              className="text-[11px] text-accent-blue hover:underline disabled:opacity-50">
              Re-run
            </button>
          )}
        </div>

        {loadingId === selected && (
          <div className="text-xs text-muted font-mono">
            Claude Haiku is analyzing — usually 5–10s…
          </div>
        )}

        {!current && loadingId !== selected && (
          <div className="text-sm text-muted">
            Click a section above to generate analysis.
          </div>
        )}

        {current?.error && (
          <div className="text-sm text-loss font-mono">{current.error}</div>
        )}

        {current?.text && (
          <div className="space-y-2 text-sm text-text leading-relaxed whitespace-pre-wrap">
            {current.text}
          </div>
        )}

        {current?.usage && (
          <div className="text-[10px] text-muted font-mono pt-3 mt-3 border-t border-line/30">
            {current.model} · in {current.usage.input_tokens}t · out {current.usage.output_tokens}t
            {current.usage.cache_read_input_tokens > 0 && ` · cache hit ${current.usage.cache_read_input_tokens}t`}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MONTE CARLO
// ---------------------------------------------------------------------------

const MC_METHODS = [
  { id: "trade_bootstrap", label: "Trade-order bootstrap",
    blurb: "Resamples the order of THIS run's trades. Answers: how much of the equity curve was the luck of trade sequencing?" },
  { id: "block_bootstrap", label: "Block bootstrap (returns)",
    blurb: "Resamples per-bar equity returns in blocks (preserves short-term autocorrelation). Path-dependent risk distribution." },
  { id: "synthetic", label: "Synthetic price paths",
    blurb: "Bootstraps OHLC bar structure to build synthetic price series, re-runs the strategy on each. Tests robustness — slowest." },
];

function MonteCarloTab({ result }) {
  const [method, setMethod] = useState("trade_bootstrap");
  const [nSims, setNSims] = useState(1000);
  const [blockSize, setBlockSize] = useState("");   // empty = auto
  const [seed, setSeed] = useState(42);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mc, setMc] = useState(null);

  const tradesCount = result?.trades?.length || 0;

  async function onRun() {
    setLoading(true); setError(null);
    try {
      const data = await runMonteCarlo({
        strategy_id: result.strategy_id,
        symbol: result.symbol,
        timeframe: result.timeframe,
        params: result.params,
        method,
        n_sims: Number(nSims) || 1000,
        block_size: blockSize === "" ? undefined : Number(blockSize),
        seed: Number(seed) || 42,
      });
      setMc(data);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || "MC run failed");
    } finally {
      setLoading(false);
    }
  }

  const effNSims = method === "synthetic" ? Math.min(Number(nSims) || 1000, 200) : (Number(nSims) || 1000);
  const methodDef = MC_METHODS.find((m) => m.id === method);

  return (
    <div className="space-y-4">
      {/* ---------- Controls ---------- */}
      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[260px]">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Method</div>
            <div className="flex gap-1 p-1 rounded-lg border border-line bg-bg-elev/30">
              {MC_METHODS.map((m) => (
                <button key={m.id} onClick={() => setMethod(m.id)}
                  className={`px-3 py-1.5 text-xs rounded-md transition flex-1 ${method === m.id ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <NumField label="Simulations" value={nSims} onChange={setNSims} step={100} min={10} />
          {method !== "trade_bootstrap" && (
            <NumField label="Block size (blank=auto)" value={blockSize} onChange={setBlockSize}
                       step={1} min={1} placeholder="auto" />
          )}
          <NumField label="Seed" value={seed} onChange={setSeed} step={1} />

          <button onClick={onRun} disabled={loading}
            className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50">
            {loading ? "Running…" : "Run"}
          </button>
        </div>
        <div className="text-xs text-muted">{methodDef.blurb}</div>
        {method === "synthetic" && effNSims < (Number(nSims) || 0) && (
          <div className="text-xs text-amber-400/80">
            Synthetic re-runs the engine per path; capped at {effNSims} sims.
          </div>
        )}
        {method === "trade_bootstrap" && tradesCount === 0 && (
          <div className="text-xs text-loss">This run has no trades — pick another method or run a strategy that trades.</div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-loss/40 bg-loss/5 p-3 text-sm text-loss">{error}</div>
      )}

      {!mc && !loading && !error && (
        <div className="rounded-xl border border-line bg-bg-panel/40 p-10 text-center text-muted text-sm">
          Click <span className="text-text">Run</span> to simulate {Number(nSims) || 1000}× variations of this strategy.
        </div>
      )}

      {mc && <MonteCarloResults mc={mc} />}
    </div>
  );
}

function AIInsightsPanel({ fetcher, label, contextHint }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  async function onRun() {
    setLoading(true); setErr(null);
    try {
      setData(await fetcher());
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "AI analysis failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-accent-blue/30 bg-accent-blue/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-accent-blue">AI Insights · Claude Haiku 4.5</div>
          <div className="text-xs text-muted mt-0.5">{contextHint}</div>
        </div>
        <button onClick={onRun} disabled={loading}
          className="px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50">
          {loading ? "Analyzing…" : (data ? `Re-run ${label}` : `Run ${label}`)}
        </button>
      </div>

      {err && <div className="text-sm text-loss font-mono">{err}</div>}
      {loading && (
        <div className="text-xs text-muted font-mono">
          Claude Haiku is analyzing — usually 5–10s…
        </div>
      )}
      {data?.text && (
        <div className="space-y-2 text-sm text-text leading-relaxed whitespace-pre-wrap">
          {data.text}
        </div>
      )}
      {data?.usage && (
        <div className="text-[10px] text-muted font-mono pt-1 border-t border-line/30">
          {data.model} · in {data.usage.input_tokens}t · out {data.usage.output_tokens}t
          {data.usage.cache_read_input_tokens > 0 && ` · cache hit ${data.usage.cache_read_input_tokens}t`}
        </div>
      )}
    </div>
  );
}

function NumField({ label, value, onChange, step = 1, min, placeholder }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{label}</div>
      <input type="number" step={step} min={min} placeholder={placeholder}
        value={value} onChange={(e) => onChange(e.target.value)}
        className="w-28 px-2 py-1.5 text-sm font-mono bg-bg-elev/30 border border-line rounded-md focus:border-accent-blue outline-none" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MC Verdict — one-line traffic-light judgement based on robustness signals.
// ---------------------------------------------------------------------------

function MCVerdict({ mc }) {
  const dist = mc.distribution || {};
  const ret = dist.total_return_pct || {};
  const dd  = dist.max_drawdown_pct || {};
  const orig = mc.original || {};

  const probProfit = mc.prob_profit ?? 0;
  const probRuin   = mc.prob_ruin   ?? 0;
  const p05Ret     = ret.p05 ?? 0;
  const p95Ret     = ret.p95 ?? 0;
  const p50Ret     = ret.p50 ?? 0;
  const p05DD      = dd.p05 ?? 0;    // worst-case (most negative)
  const origRet    = orig.total_return_pct ?? 0;

  // Where does the original sit inside the distribution?
  let origPercentile = null;
  if (ret.p95 != null && ret.p05 != null && ret.p95 !== ret.p05) {
    const span = (origRet - ret.p05) / (ret.p95 - ret.p05);
    origPercentile = Math.max(0, Math.min(1, span)) * 100;
  }

  let score = 0;
  if (probProfit >= 0.9) score += 3; else if (probProfit >= 0.75) score += 2; else if (probProfit >= 0.55) score += 1;
  if (probRuin <= 0.001) score += 2; else if (probRuin <= 0.01) score += 1; else if (probRuin > 0.05) score -= 2;
  if (p05Ret >= 0) score += 2; else if (p05Ret >= -10) score += 1;
  if (p50Ret >= 25) score += 1;
  if (Math.abs(p05DD) <= 15) score += 1;

  let tier, tone, label;
  if (score >= 7)      { tier = "Robust";   tone = "profit"; label = "🟢 Edge survives resampling — strong robustness"; }
  else if (score >= 4) { tier = "Decent";   tone = "profit"; label = "🟡 Edge holds in most scenarios — workable"; }
  else if (score >= 1) { tier = "Fragile";  tone = "amber";  label = "🟠 Edge sensitive to trade order / sequencing"; }
  else                 { tier = "Risky";    tone = "loss";   label = "🔴 Result is mostly luck — high tail risk"; }

  const lines = [
    `${fmtNum(probProfit * 100)}% prob profit`,
    `${fmtNum(probRuin * 100)}% prob ruin`,
    `worst-5% return ${fmtPct(p05Ret)}`,
    `worst-5% DD ${fmtPct(p05DD, false)}`,
  ];

  const toneClasses = {
    profit: "border-profit/40 bg-profit/5 text-profit",
    amber:  "border-amber-400/40 bg-amber-400/5 text-amber-400",
    loss:   "border-loss/40 bg-loss/5 text-loss",
  };

  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone]}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-wider opacity-70">MC Verdict · {tier}</div>
          <div className="text-base font-semibold mt-0.5">{label}</div>
        </div>
        <div className="text-xs font-mono opacity-90">{lines.join(" · ")}</div>
      </div>
      {origPercentile != null && (
        <div className="text-[11px] font-mono opacity-75 mt-2 pt-2 border-t border-current/20">
          Your original backtest ({fmtPct(origRet)}) sits at the
          <span className="font-bold"> {fmtNum(origPercentile)}th percentile </span>
          of simulated paths — {origPercentile >= 75 ? "above average (possibly luck-favored)"
            : origPercentile >= 25 ? "typical for this distribution"
            : "below average (possibly unlucky)"}.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plain-English explainer for the MC distribution.
// ---------------------------------------------------------------------------

function MCInterpretation({ mc }) {
  const dist = mc.distribution || {};
  const ret = dist.total_return_pct || {};
  const dd  = dist.max_drawdown_pct || {};
  const fe  = dist.final_equity || {};

  const items = [
    {
      label: "Best 5% of paths",
      icon: "🏆",
      text: `Returns ≥ ${fmtPct(ret.p95)} — best case, equity reaches ${fmtUsd(fe.p95)}.`,
      tone: "text-profit",
    },
    {
      label: "Median outcome",
      icon: "⚖",
      text: `Returns ${fmtPct(ret.p50)} — typical case, equity ${fmtUsd(fe.p50)} with ${fmtPct(dd.p50, false)} drawdown.`,
      tone: "text-text",
    },
    {
      label: "Worst 5% of paths",
      icon: "📉",
      text: `Returns ≤ ${fmtPct(ret.p05)} and drawdown of ${fmtPct(dd.p05, false)} — plan for this scenario.`,
      tone: "text-loss",
    },
  ];

  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">How to read this</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {items.map((it) => (
          <div key={it.label} className="space-y-0.5">
            <div className={`text-xs font-semibold ${it.tone}`}>{it.icon} {it.label}</div>
            <div className="text-[11px] text-muted leading-relaxed">{it.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Path Rankings — best / median / worst single paths from the sampled set.
// ---------------------------------------------------------------------------

function PathRankings({ mc }) {
  const paths = mc.paths || [];
  const sc = mc.starting_capital;
  const rankings = useMemo(() => {
    if (paths.length < 3) return null;
    const scored = paths.map((p, i) => {
      const final = p[p.length - 1]?.equity ?? sc;
      let peak = -Infinity, maxDD = 0;
      for (const pt of p) {
        if (pt.equity > peak) peak = pt.equity;
        const ddPct = peak > 0 ? (pt.equity - peak) / peak * 100 : 0;
        if (ddPct < maxDD) maxDD = ddPct;
      }
      const ret = sc > 0 ? (final / sc - 1) * 100 : 0;
      return { idx: i, final, ret, maxDD };
    }).sort((a, b) => b.ret - a.ret);
    return {
      best: scored[0],
      median: scored[Math.floor(scored.length / 2)],
      worst: scored[scored.length - 1],
    };
  }, [paths, sc]);

  if (!rankings) return null;

  const cards = [
    { ...rankings.best,   label: "🏆 Luckiest path",   tone: "profit", hint: "best return out of sampled paths" },
    { ...rankings.median, label: "⚖ Typical path",    tone: "text",   hint: "median return — most realistic" },
    { ...rankings.worst,  label: "📉 Unluckiest path", tone: "loss",   hint: "worst return — your stress test" },
  ];

  const toneOf = (t) => t === "profit" ? "text-profit" : t === "loss" ? "text-loss" : "text-text";

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text">Path Rankings</div>
        <div className="text-xs text-muted">
          A spread of {paths.length} sampled equity paths — the gap between luckiest and unluckiest tells you how much sequencing matters.
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-md border border-line bg-bg-elev/30 p-3 space-y-1">
            <div className={`text-xs font-semibold ${toneOf(c.tone)}`}>{c.label}</div>
            <div className="text-[10px] text-muted">{c.hint}</div>
            <div className="text-xs font-mono mt-1">
              <div>final: <span className="text-text">{fmtUsd(c.final)}</span></div>
              <div>return: <span className={toneOf(c.ret >= 0 ? "profit" : "loss")}>{fmtPct(c.ret)}</span></div>
              <div>max DD: <span className="text-loss">{fmtPct(c.maxDD, false)}</span></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonteCarloResults({ mc }) {
  const sc = mc.starting_capital;
  const dist = mc.distribution || {};
  const fe = dist.final_equity || {};
  const ret = dist.total_return_pct || {};
  const dd = dist.max_drawdown_pct || {};
  const sharpe = dist.sharpe || {};
  const orig = mc.original || {};

  return (
    <div className="space-y-4">
      <MCVerdict mc={mc} />

      <MCInterpretation mc={mc} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KpiCard title="Prob. of profit" value={`${fmtNum(mc.prob_profit * 100)}%`}
                 sub={`${fmtInt(mc.n_sims)} sims`} positive={mc.prob_profit >= 0.5} />
        <KpiCard title="Prob. of ruin" value={`${fmtNum(mc.prob_ruin * 100)}%`}
                 sub="equity ≤ 0" positive={mc.prob_ruin <= 0.01} />
        <KpiCard title="Median final" value={fmtUsd(fe.p50)}
                 sub={`p05 ${fmtUsd(fe.p05)} · p95 ${fmtUsd(fe.p95)}`} />
        <KpiCard title="Median return" value={`${fmtNum(ret.p50)}%`}
                 sub={`p05 ${fmtNum(ret.p05)}% · p95 ${fmtNum(ret.p95)}%`}
                 positive={(ret.p50 || 0) >= 0} />
        <KpiCard title="Median max DD" value={`${fmtNum(dd.p50)}%`}
                 sub={`p05 ${fmtNum(dd.p05)}% · p95 ${fmtNum(dd.p95)}%`} positive={false} />
        <KpiCard title="Median Sharpe" value={fmtNum(sharpe.p50)}
                 sub={`p05 ${fmtNum(sharpe.p05)} · p95 ${fmtNum(sharpe.p95)}`}
                 positive={(sharpe.p50 || 0) >= 1} />
      </div>

      <PathRankings mc={mc} />

      {/* Fan chart */}
      <FanChart mc={mc} startingCapital={sc} />

      {/* Distributions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <HistPanel title="Final equity ($)" dist={fe} unit="usd" original={orig.final_equity} />
        <HistPanel title="Total return (%)" dist={ret} unit="pct" original={orig.total_return_pct} />
        <HistPanel title="Max drawdown (%)" dist={dd} unit="pct" original={orig.max_drawdown_pct} />
      </div>

      {/* AI analysis — click to run */}
      <AIInsightsPanel
        label="AI Analysis"
        contextHint="Claude interprets robustness, tail risk, and what this MC method can (and can't) tell you."
        fetcher={() => aiAnalyzeMonteCarlo(mc)}
      />
    </div>
  );
}

function FanChart({ mc, startingCapital }) {
  const innerRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 360 });

  useEffect(() => {
    const el = innerRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: 360 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const env = mc.envelopes || {};
  const p05 = env.p05 || [], p25 = env.p25 || [], p50 = env.p50 || [],
        p75 = env.p75 || [], p95 = env.p95 || [];

  if (p50.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        no Monte Carlo paths produced
      </div>
    );
  }

  const pad = { l: 64, r: 16, t: 12, b: 26 };
  const innerW = Math.max(1, size.w - pad.l - pad.r);
  const innerH = Math.max(1, size.h - pad.t - pad.b);

  const allX = p50.map((p) => p.x);
  const xMin = allX[0], xMax = allX[allX.length - 1];

  // Y range: combine envelopes + sampled paths so nothing clips.
  let yMin = Infinity, yMax = -Infinity;
  for (const series of [p05, p95, ...(mc.paths || [])]) {
    for (const pt of series) {
      if (pt.equity < yMin) yMin = pt.equity;
      if (pt.equity > yMax) yMax = pt.equity;
    }
  }
  if (!isFinite(yMin)) { yMin = startingCapital * 0.5; yMax = startingCapital * 1.5; }
  const yPad = (yMax - yMin) * 0.05 || startingCapital * 0.05;
  yMin -= yPad; yMax += yPad;

  const xOf = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * innerW;
  const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * innerH;

  const lineOf = (series) => series.map((p, i) =>
    `${i === 0 ? "M" : "L"}${xOf(p.x).toFixed(1)},${yOf(p.equity).toFixed(1)}`
  ).join("");

  const bandOf = (lo, hi) => {
    const up = lo.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.x).toFixed(1)},${yOf(p.equity).toFixed(1)}`).join("");
    const dn = hi.slice().reverse().map((p, i) => `L${xOf(p.x).toFixed(1)},${yOf(p.equity).toFixed(1)}`).join("");
    return `${up}${dn}Z`;
  };

  // Y ticks (5)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = yMin + ((yMax - yMin) * i) / 4;
    return { v, y: yOf(v) };
  });
  // X ticks (5)
  const xLabelFor = (xv) => mc.x_label === "trade #"
    ? `#${xv}`
    : new Date(xv * 1000).toISOString().slice(0, 10);
  const xTicks = Array.from({ length: 5 }, (_, i) => {
    const xv = xMin + ((xMax - xMin) * i) / 4;
    return { xv, x: xOf(xv), anchor: i === 0 ? "start" : i === 4 ? "end" : "middle" };
  });

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-muted">
          Equity fan · {mc.method} · {mc.n_sims} sims
        </div>
        <div className="text-[10px] text-muted flex items-center gap-3 font-mono">
          <LegendSwatch color="rgba(59,130,246,0.15)" label="p05–p95" />
          <LegendSwatch color="rgba(59,130,246,0.3)" label="p25–p75" />
          <LegendSwatch color="#3b82f6" label="median" line />
        </div>
      </div>
      <div ref={innerRef} className="relative w-full">
        <svg width={size.w} height={size.h} className="block">
          {/* Starting capital line */}
          <line x1={pad.l} x2={size.w - pad.r} y1={yOf(startingCapital)} y2={yOf(startingCapital)}
                stroke="rgba(229,231,235,0.25)" strokeWidth="0.6" strokeDasharray="2 3" />

          <path d={bandOf(p05, p95)} fill="rgba(59,130,246,0.12)" />
          <path d={bandOf(p25, p75)} fill="rgba(59,130,246,0.25)" />

          {/* sampled paths */}
          {(mc.paths || []).map((s, i) => (
            <path key={i} d={lineOf(s)} fill="none" stroke="rgba(229,231,235,0.18)" strokeWidth="0.6" />
          ))}

          <path d={lineOf(p50)} fill="none" stroke="#3b82f6" strokeWidth="1.6" />

          {/* Axes */}
          {yTicks.map((tk, i) => (
            <g key={i}>
              <line x1={pad.l} x2={size.w - pad.r} y1={tk.y} y2={tk.y}
                    stroke="rgba(229,231,235,0.06)" />
              <text x={pad.l - 6} y={tk.y + 3} textAnchor="end"
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {fmtUsd(tk.v)}
              </text>
            </g>
          ))}
          {xTicks.map((tk, i) => (
            <text key={i} x={tk.x} y={size.h - 8} textAnchor={tk.anchor}
                  className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {xLabelFor(tk.xv)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function LegendSwatch({ color, label, line }) {
  return (
    <span className="flex items-center gap-1">
      <span className="inline-block w-3 h-3 rounded-sm" style={{
        background: line ? "transparent" : color,
        borderTop: line ? `2px solid ${color}` : "none",
      }} />
      {label}
    </span>
  );
}

function HistPanel({ title, dist, unit, original }) {
  const fmt = unit === "usd"
    ? (v) => fmtUsd(v)
    : (v) => `${fmtNum(v)}%`;
  const hist = dist.histogram || [];
  const max = Math.max(1, ...hist.map((b) => b.count));

  // Where does the "original" backtest's metric land?
  const origBin = (original != null && hist.length)
    ? hist.findIndex((b) => original >= b.bin_lo && original <= b.bin_hi)
    : -1;

  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{title}</div>
      <div className="text-xs font-mono text-muted">
        mean {fmt(dist.mean)} · σ {fmt(dist.std)} · min {fmt(dist.min)} · max {fmt(dist.max)}
      </div>
      <div className="space-y-0.5 mt-2">
        {hist.length === 0 && <div className="text-sm text-muted py-4">no data</div>}
        {hist.map((b, i) => {
          const w = (b.count / max) * 100;
          const isOrig = i === origBin;
          return (
            <div key={i} className="flex items-center gap-2 text-[10px] font-mono">
              <span className="w-24 text-muted text-right">{fmt(b.bin_lo)}</span>
              <div className="flex-1 h-3 bg-bg-elev/30 rounded">
                <div className={`h-3 rounded ${isOrig ? "bg-accent-blue" : "bg-accent-blue/30"}`}
                     style={{ width: `${w}%` }} />
              </div>
              <span className="w-10 text-right text-muted">{b.count}</span>
            </div>
          );
        })}
      </div>
      {original != null && (
        <div className="text-[11px] font-mono text-accent-blue mt-2">
          ▸ Original = {fmt(original)}
        </div>
      )}
    </div>
  );
}
