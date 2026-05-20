import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { useLastResult } from "../services/lastResultStore.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtTime } from "../services/format.js";
import { downloadTradesCsv } from "../services/exportTrades.js";
import { aiAnalyzeBacktestSection } from "../services/api.js";

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
  { id: "gaussian",     label: "Gaussian Fit" },
  { id: "ttest",        label: "T-Test" },
  { id: "tradequality", label: "Trade Quality" },
  { id: "advanced",     label: "Risk & Robustness" },
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
            {tab === "gaussian"     && <GaussianTab     result={result} />}
            {tab === "ttest"        && <TTestTab        result={result} />}
            {tab === "tradequality" && <TradeQualityTab result={result} />}
            {tab === "advanced"     && <AdvancedTab     result={result} />}
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
  const ddShape = result.analytics?.advanced?.drawdown || {};
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
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Max DD (peak-rel)" value={`${fmtNum(ddShape.max_drawdown_pct)}%`}
                 sub="deepest point, % of peak" positive={false} />
        <KpiCard title="DD duration"
                 value={fmtBarsDuration(ddShape.max_drawdown_duration_bars, result.timeframe)}
                 sub="longest underwater stretch" />
        <KpiCard title="Time to recover"
                 value={ddShape.time_to_recovery_bars != null
                   ? fmtBarsDuration(ddShape.time_to_recovery_bars, result.timeframe)
                   : "—"}
                 sub={ddShape.recovered_from_deepest_dd === false
                   ? "did not regain pre-DD peak"
                   : "from deepest trough"}
                 positive={ddShape.recovered_from_deepest_dd !== false} />
        <KpiCard title="DD at backtest end"
                 value={(ddShape.open_drawdown_pct ?? 0) >= -0.01
                   ? "at ATH"
                   : `${fmtNum(ddShape.open_drawdown_pct)}%`}
                 sub={ddShape.final_equity_above_start
                   ? "(profitable run, % below ATH)"
                   : "below starting capital"}
                 positive={(ddShape.open_drawdown_pct ?? 0) > -3
                   && ddShape.final_equity_above_start !== false} />
      </div>

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// DISTRIBUTION PANEL — shared histogram bar-row component
// ---------------------------------------------------------------------------

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
// GAUSSIAN FIT — empirical distribution vs Normal, fat-tail detection
// ---------------------------------------------------------------------------

function GaussianTab({ result }) {
  const adv = result?.analytics?.advanced?.distribution;
  const bins = result?.analytics?.distribution_pnl_pct || [];

  const moments = useMemo(() => {
    const trades = result?.trades || [];
    if (trades.length < 2) return null;
    const xs = trades.map((t) => Number(t.pnl_pct_equity) || 0);
    const n = xs.length;
    const mean = xs.reduce((s, v) => s + v, 0) / n;
    const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);
    return { n, mean, std };
  }, [result]);

  if (!adv || !moments || bins.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        Not enough trade data for distribution fit (need ≥ 2 trades).
      </div>
    );
  }

  const skew = adv.skewness;
  const kurt = adv.kurtosis_excess;
  const tail = adv.tail_ratio;
  const { mean, std, n } = moments;

  const isFatTailed  = kurt != null && kurt > 1;
  const isThinTailed = kurt != null && kurt < -1;
  const isSkewed     = skew != null && Math.abs(skew) > 1;
  const verdict = isFatTailed
    ? `Fat-tailed — extreme outcomes ${skew != null && skew < 0 ? "skew toward losses" : "more likely than Normal"}`
    : isThinTailed
      ? "Thin-tailed — more concentrated than Normal"
      : isSkewed
        ? `Skewed ${skew > 0 ? "right (winners outweigh losers)" : "left (tail risk on the loss side)"}`
        : "Approximately Gaussian";
  const verdictTone = (isFatTailed && skew != null && skew < 0) || (isSkewed && skew < 0)
    ? "text-loss"
    : (isFatTailed && skew >= 0) || (isSkewed && skew > 0)
      ? "text-profit"
      : "text-text";

  // SVG geometry
  const W = 800, H = 280;
  const pad = { l: 40, r: 16, t: 12, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const binMin = bins[0].bin_lo;
  const binMax = bins[bins.length - 1].bin_hi;
  const binWidth = bins[0].bin_hi - bins[0].bin_lo;
  const maxCount = Math.max(1, ...bins.map((b) => b.count));

  // Scale a Normal PDF to histogram counts: expected count in a bin of
  // width `binWidth` is n * binWidth * pdf(x).
  const gaussCount = (x) => {
    if (std <= 0) return 0;
    const z = (x - mean) / std;
    return n * binWidth * (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * z * z);
  };

  const xOf = (v) => pad.l + ((v - binMin) / (binMax - binMin || 1)) * innerW;
  const yOf = (c) => pad.t + (1 - c / maxCount) * innerH;

  const samples = 120;
  let gaussPath = "";
  for (let i = 0; i <= samples; i++) {
    const x = binMin + ((binMax - binMin) * i) / samples;
    const c = Math.min(gaussCount(x), maxCount * 1.15);
    gaussPath += (i === 0 ? "M" : "L") + xOf(x).toFixed(1) + "," + yOf(c).toFixed(1);
  }

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const v = binMin + (binMax - binMin) * p;
    return { v, x: xOf(v) };
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          Distribution Fit · per-trade equity returns vs Normal
        </div>
        <div className={`text-2xl font-mono ${verdictTone}`}>{verdict}</div>
        <div className="text-xs text-muted mt-1 font-mono">
          μ = {fmtNum(mean)}% · σ = {fmtNum(std)}% · n = {fmtInt(n)} trades
        </div>
      </div>

      <div className="rounded-xl border border-line bg-bg-panel/60 p-4 overflow-x-auto">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-2 flex gap-4">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-profit/40" /> empirical (winners)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-loss/40" /> empirical (losers)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-accent-blue" /> Normal(μ, σ)
          </span>
        </div>
        <svg width={W} height={H} className="block w-full" viewBox={`0 0 ${W} ${H}`}>
          {bins.map((b, i) => {
            const x = xOf(b.bin_lo);
            const w = Math.max(1, xOf(b.bin_hi) - x - 1);
            const y = yOf(b.count);
            const h = (H - pad.b) - y;
            const center = (b.bin_lo + b.bin_hi) / 2;
            const cls = center >= 0 ? "fill-profit/40" : "fill-loss/40";
            return <rect key={i} x={x} y={y} width={w} height={Math.max(0, h)} className={cls} />;
          })}
          <path d={gaussPath} fill="none" stroke="#3b82f6" strokeWidth="2" />
          {binMin <= 0 && binMax >= 0 && (
            <line x1={xOf(0)} x2={xOf(0)} y1={pad.t} y2={H - pad.b}
                  stroke="rgba(229,231,235,0.4)" strokeDasharray="2 3" />
          )}
          <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b}
                stroke="rgba(107,114,128,0.4)" />
          {xTicks.map((t, i) => (
            <g key={i}>
              <line x1={t.x} x2={t.x} y1={H - pad.b} y2={H - pad.b + 4}
                    stroke="rgba(107,114,128,0.6)" />
              <text x={t.x} y={H - 10} textAnchor="middle"
                    className="fill-muted" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {fmtNum(t.v)}%
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Skewness" value={skew != null ? fmtNum(skew) : "—"}
                 sub={skew == null ? "—"
                   : Math.abs(skew) < 0.5 ? "symmetric"
                   : skew > 0 ? "right-skewed (good)"
                   : "left-skewed (tail risk)"}
                 positive={(skew ?? 0) >= 0} />
        <KpiCard title="Excess kurtosis" value={kurt != null ? fmtNum(kurt) : "—"}
                 sub={kurt == null ? "—"
                   : kurt > 1 ? "fat tails vs Normal"
                   : kurt < -1 ? "thin tails"
                   : "near Normal"}
                 positive={(kurt ?? 0) < 1} />
        <KpiCard title="Tail ratio" value={tail != null ? fmtNum(tail) : "—"}
                 sub=">1 = right-fat (good)"
                 positive={(tail ?? 0) >= 1} />
        <KpiCard title="Sample size" value={fmtInt(n)}
                 sub={n < 30 ? "⚠ small sample" : "n ≥ 30"} />
      </div>

      <div className="rounded-xl border border-line bg-bg-panel/40 p-4 text-xs text-muted space-y-1.5">
        <div className="text-text font-semibold">How to read this</div>
        <div>· Bars are your actual per-trade equity-return distribution. The blue curve is Normal(μ, σ) — what a Gaussian with the same mean and std would predict.</div>
        <div>· <span className="text-text">Skewness</span> &gt; 0 → long right tail (occasional big winners). &lt; 0 → long left tail (occasional big losers).</div>
        <div>· <span className="text-text">Excess kurtosis</span> &gt; 0 → fatter tails than Normal — extreme outcomes happen more often. Positive skew + fat tails is ideal; negative skew + fat tails is dangerous.</div>
        <div>· If the histogram visibly diverges from the blue curve, metrics that assume Normal returns (Sharpe, prob-of-ruin) may overstate quality.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// T-TEST — statistical significance of average trade vs zero
// ---------------------------------------------------------------------------

function TTestTab({ result }) {
  const di = result?.analytics?.advanced?.distribution;
  const ts = result?.analytics?.advanced?.trade_stats;
  if (!di) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        No T-test data available. Re-run the backtest to populate.
      </div>
    );
  }

  const sig = di.significance;
  const sigTone = sig === "significant" ? "text-profit"
    : sig === "marginal" ? "text-amber-400"
    : "text-loss";
  const sigLabel = sig === "significant" ? "Significant — edge is real (p < 0.01)"
    : sig === "marginal" ? "Marginal — suggestive but not conclusive (p < 0.05)"
    : "Not significant — indistinguishable from noise";

  // Map p-value to [0, 1] on a log scale [1e-6 .. 1]. Lower p = further left.
  const p = di.t_pvalue;
  const pLog = p == null || !Number.isFinite(p) || p <= 0
    ? null
    : Math.max(0, Math.min(1, (Math.log10(Math.max(p, 1e-6)) + 6) / 6));
  const thr01 = (Math.log10(0.01) + 6) / 6;
  const thr05 = (Math.log10(0.05) + 6) / 6;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          One-sample T-test · H₁: mean trade return &gt; 0
        </div>
        <div className={`text-2xl font-mono ${sigTone}`}>{sigLabel}</div>
        <div className="text-xs text-muted mt-1">
          Tests whether the mean per-trade return is statistically greater than zero, against the null hypothesis that it's ≤ 0.
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="T-statistic" value={di.t_stat != null ? fmtNum(di.t_stat) : "—"}
                 sub="higher = stronger evidence of edge"
                 positive={(di.t_stat ?? 0) > 0} />
        <KpiCard title="P-value" value={fmtTinyProb(p)}
                 sub={sig === "significant" ? "< 0.01" : sig === "marginal" ? "0.01 ≤ p < 0.05" : "≥ 0.05"}
                 positive={sig === "significant"} />
        <KpiCard title="Sample size" value={fmtInt(di.n_trades)}
                 sub={di.n_trades < 30 ? "⚠ small sample (n < 30)" : "n ≥ 30, CLT valid"} />
        <KpiCard title="Mean trade" value={fmtUsd(ts?.expectancy_dollars)}
                 sub={ts?.expectancy_R != null ? `${fmtNum(ts.expectancy_R)} R per trade` : "expectancy per trade"}
                 positive={(ts?.expectancy_dollars ?? 0) >= 0} />
      </div>

      {pLog != null && (
        <div className="rounded-xl border border-line bg-bg-panel/60 p-4">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-6">
            P-value on log scale (lower is better)
          </div>
          <div className="relative h-10 mx-2 mb-6">
            <div className="absolute inset-0 rounded-md"
                 style={{
                   background: "linear-gradient(to right, rgba(34,197,94,0.5), rgba(245,158,11,0.4) 50%, rgba(239,68,68,0.5))",
                 }} />
            {[
              { label: "0.01", left: thr01 * 100 },
              { label: "0.05", left: thr05 * 100 },
            ].map((t) => (
              <div key={t.label} className="absolute top-0 bottom-0 border-l border-dashed border-white/50"
                   style={{ left: `${t.left}%` }}>
                <span className="absolute -top-5 -translate-x-1/2 text-[10px] text-muted font-mono">
                  p={t.label}
                </span>
              </div>
            ))}
            <div className="absolute top-0 bottom-0 w-0.5 bg-white"
                 style={{ left: `${pLog * 100}%` }}>
              <span className={`absolute -bottom-5 -translate-x-1/2 text-[10px] font-mono ${sigTone}`}>
                {fmtTinyProb(p)}
              </span>
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-muted font-mono">
            <span>← strong evidence of edge</span>
            <span>indistinguishable from noise →</span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-line bg-bg-panel/40 p-4 text-xs text-muted space-y-1.5">
        <div className="text-text font-semibold">How to read this</div>
        <div>· The <span className="text-text">T-statistic</span> measures how many standard errors the mean trade is above zero. Larger = stronger evidence.</div>
        <div>· The <span className="text-text">P-value</span> is the probability of seeing this result by chance if your true edge were zero. Lower = more confidence.</div>
        <div>· P &lt; 0.01 → reject the "no edge" hypothesis at 99% confidence. P &lt; 0.05 → 95% confidence.</div>
        <div>· This test assumes trades are independent. Heavy autocorrelation (overlapping holds, pyramided exits) inflates significance — interpret with caution and cross-check with the Permutation Test.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TRADE QUALITY — win/loss profile, streaks, expectancy, concentration
// ---------------------------------------------------------------------------

function TradeQualityTab({ result }) {
  const ts = result?.analytics?.advanced?.trade_stats;
  const streaks = result?.analytics?.streaks;
  const a = result?.analytics;
  const s = result?.stats;

  const durStats = useMemo(() => {
    const ds = (result?.trades || []).map((t) => Number(t.duration_min) || 0).filter((d) => d > 0);
    if (ds.length === 0) return null;
    const sorted = [...ds].sort((x, y) => x - y);
    const avg = ds.reduce((acc, v) => acc + v, 0) / ds.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    return { avg, median, min: sorted[0], max: sorted[sorted.length - 1] };
  }, [result]);

  if (!ts || !s) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6 text-sm text-muted text-center">
        No trade-quality data available. Re-run the backtest to populate.
      </div>
    );
  }

  const wr = (s.win_rate ?? 0) * 100;
  const payoff = ts.payoff_ratio;
  // Kelly: f* = (p·R − (1−p)) / R, where p = win rate, R = payoff ratio.
  const kelly = payoff != null && payoff > 0
    ? ((s.win_rate * payoff - (1 - s.win_rate)) / payoff)
    : null;

  const exp = ts.expectancy_dollars ?? 0;
  const luck = ts.luck_dependent_wins || ts.luck_dependent_losses;
  const verdict = exp <= 0
    ? "Negative expectancy — strategy loses money on average"
    : luck
      ? "Profitable but luck-dependent — a few outliers carry the result"
      : payoff != null && payoff < 1 && wr < 50
        ? "Marginal — small payoff with sub-50% win rate"
        : "Healthy — broad-based edge across many trades";
  const verdictTone = exp <= 0 ? "text-loss"
    : luck ? "text-amber-400"
    : "text-profit";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-bg-panel/60 p-6">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          Trade Quality · win/loss profile and edge concentration
        </div>
        <div className={`text-2xl font-mono ${verdictTone}`}>{verdict}</div>
        <div className="text-xs text-muted mt-1 font-mono">
          {fmtInt(ts.n_winners)} winners · {fmtInt(ts.n_losers)} losers · expectancy {fmtUsd(exp)} per trade
        </div>
      </div>

      <Section title="Win / Loss Profile" hint="The basic mechanics of how the strategy makes (or loses) money.">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard title="Win rate" value={`${fmtNum(wr)}%`}
                   sub={`${fmtInt(ts.n_winners)}W / ${fmtInt(ts.n_losers)}L`}
                   positive={wr >= 50} />
          <KpiCard title="Payoff ratio" value={payoff != null ? `${fmtNum(payoff)}×` : "—"}
                   sub="avg win / |avg loss|"
                   positive={(payoff ?? 0) >= 1} />
          <KpiCard title="Avg win" value={fmtUsd(ts.avg_win)} sub="per winning trade" positive />
          <KpiCard title="Avg loss" value={fmtUsd(ts.avg_loss)} sub="per losing trade" positive={false} />
          <KpiCard title="Expectancy" value={fmtUsd(exp)}
                   sub={ts.expectancy_R != null ? `${fmtNum(ts.expectancy_R)} R per trade` : "per trade"}
                   positive={exp >= 0} />
          <KpiCard title="Profit factor" value={s.profit_factor == null ? "∞" : fmtNum(s.profit_factor)}
                   sub="gross profit / gross loss"
                   positive={(s.profit_factor ?? 0) >= 1.5} />
          <KpiCard title="Kelly fraction" value={kelly != null ? `${fmtNum(kelly * 100)}%` : "—"}
                   sub="optimal risk per trade"
                   positive={(kelly ?? 0) > 0} />
          <KpiCard title="Total trades" value={fmtInt(s.trades)} sub="sample size" />
        </div>
      </Section>

      <Section title="Streaks & Extremes" hint="How bad can losing runs get? What does the best (and worst) single trade look like?">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard title="Max win streak" value={fmtInt(streaks?.max_win_streak)}
                   sub="consecutive winning trades" positive />
          <KpiCard title="Max loss streak" value={fmtInt(streaks?.max_loss_streak)}
                   sub="consecutive losing trades" positive={false} />
          <KpiCard title="Best trade"
                   value={a?.best_trade ? fmtUsd(a.best_trade.pnl_dollars) : "—"}
                   sub={a?.best_trade ? `${fmtPct(a.best_trade.pnl_pct_equity ?? a.best_trade.pnl_pct)} of capital` : ""}
                   positive />
          <KpiCard title="Worst trade"
                   value={a?.worst_trade ? fmtUsd(a.worst_trade.pnl_dollars) : "—"}
                   sub={a?.worst_trade ? `${fmtPct(a.worst_trade.pnl_pct_equity ?? a.worst_trade.pnl_pct)} of capital` : ""}
                   positive={false} />
        </div>
      </Section>

      <Section title="Edge Concentration" hint="Is the edge broad, or carried by a few lucky outliers?">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCard title="Top-10 winners share"
                   value={ts.top10_winners_share != null ? `${fmtNum(ts.top10_winners_share * 100)}%` : "—"}
                   sub={ts.luck_dependent_wins ? "⚠ heavy luck dependency" : "of gross profit"}
                   positive={ts.luck_dependent_wins === false} />
          <KpiCard title="Top-10 losers share"
                   value={ts.top10_losers_share != null ? `${fmtNum(ts.top10_losers_share * 100)}%` : "—"}
                   sub={ts.luck_dependent_losses ? "⚠ concentrated tail risk" : "of gross loss"}
                   positive={ts.luck_dependent_losses === false} />
          <KpiCard title="Gross profit / loss"
                   value={`${fmtUsd(s.gross_profit)} / ${fmtUsd(-s.gross_loss)}`}
                   sub={`PF ${s.profit_factor == null ? "∞" : fmtNum(s.profit_factor)}`} />
        </div>
      </Section>

      {durStats && (
        <Section title="Trade Duration" hint="How long do trades typically stay open?">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard title="Median duration" value={fmtDurationMin(durStats.median)} sub="typical trade length" />
            <KpiCard title="Avg duration"    value={fmtDurationMin(durStats.avg)}    sub="across all trades" />
            <KpiCard title="Shortest"        value={fmtDurationMin(durStats.min)} />
            <KpiCard title="Longest"         value={fmtDurationMin(durStats.max)} />
          </div>
          {(a?.distribution_duration_min || []).length > 0 && (
            <div className="mt-3">
              <DistributionPanel
                title="Trade Duration histogram"
                bins={a.distribution_duration_min}
                formatBin={(b) => `${fmtInt(b.bin_lo)}…${fmtInt(b.bin_hi)} min`}
              />
            </div>
          )}
        </Section>
      )}

      <div className="rounded-xl border border-line bg-bg-panel/40 p-4 text-xs text-muted space-y-1.5">
        <div className="text-text font-semibold">How to read this</div>
        <div>· <span className="text-text">Expectancy</span> is the average $ outcome per trade. Multiply by trade frequency to estimate annual return.</div>
        <div>· <span className="text-text">Top-10 share</span> &gt; 50% means a handful of trades carried most of the P&amp;L. Red flag — replication depends on rare events.</div>
        <div>· <span className="text-text">Kelly fraction</span> is the theoretically-optimal risk per trade given your win rate and payoff. Many practitioners use ¼-Kelly to reduce drawdowns.</div>
        <div>· A healthy strategy has positive expectancy AND broad participation — many small winners, not one giant outlier.</div>
      </div>
    </div>
  );
}

function fmtDurationMin(mins) {
  if (mins == null || !Number.isFinite(mins)) return "—";
  if (mins < 60) return `${fmtNum(mins)} min`;
  if (mins < 1440) return `${fmtNum(mins / 60)} hr`;
  return `${fmtNum(mins / 1440)} days`;
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

  const ra = adv.risk_adjusted || {};
  const dd = adv.drawdown || {};
  const edge = adv.edge;
  const rob = adv.robustness;

  return (
    <div className="space-y-4">
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
  { id: "distribution", label: "Distribution & Stats", hint: "Gaussian fit, t-test, trade-quality concentration." },
  { id: "advanced",     label: "Risk & Robustness",    hint: "Risk-adjusted returns, MAE/MFE, walk-forward." },
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
