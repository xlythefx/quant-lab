import { useEffect, useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { useLastResult } from "../services/lastResultStore.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtTime } from "../services/format.js";

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
  { id: "trades",       label: "Trades" },
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
            {tab === "trades"       && <TradesTab       result={result} />}
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
      <KpiCard title="Sharpe (trade)"    value={fmtNum(s.sharpe)} sub="mean / std × √n" />
      <KpiCard title="Win Rate"          value={`${fmtNum(s.win_rate * 100)}%`} sub={`${fmtInt(s.wins)} W / ${fmtInt(s.losses)} L`} />
      <KpiCard title="Trades"            value={fmtInt(s.trades)} sub={`avg ${fmtUsd(s.avg_pnl_dollars)}`} />
      <KpiCard title="Max Drawdown"      value={fmtPct(s.max_drawdown_pct, false)} sub={fmtUsd(s.max_drawdown_dollars)}
               positive={false} />
      <KpiCard title="Max DD Duration"   value={`${fmtInt(a.max_drawdown_duration_bars)} bars`} sub="time underwater" />
      <KpiCard title="Exposure"          value={`${fmtNum(a.exposure_pct)}%`} sub="bars in position" />
      <KpiCard title="Best Trade"        value={a.best_trade ? fmtUsd(a.best_trade.pnl_dollars) : "—"}
               sub={a.best_trade ? `${a.best_trade.side} · ${fmtPct(a.best_trade.pnl_pct)}` : ""} positive />
      <KpiCard title="Worst Trade"       value={a.worst_trade ? fmtUsd(a.worst_trade.pnl_dollars) : "—"}
               sub={a.worst_trade ? `${a.worst_trade.side} · ${fmtPct(a.worst_trade.pnl_pct)}` : ""} positive={false} />
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
        title="Per-trade Return Distribution (%)"
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

  return (
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
              <Th k="fees" right>Fees</Th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {trades.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted">no trades</td></tr>
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
                <td className="px-3 py-1.5 text-right text-muted">{fmtUsd(t.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
