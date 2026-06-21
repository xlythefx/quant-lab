import { useMemo, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { KpiCard, Section, TabBar } from "../components/analytics/primitives.jsx";
import { HistogramChart, VBarChart } from "../components/marketlab/charts.jsx";
import { EquityCurve, DrawdownCurve, MonthlyHeatmap } from "../components/report/charts.jsx";
import { parseTradestationReport } from "../services/api.js";
import { fmtUsd, fmtPct, fmtInt, fmtNum, fmtRatio } from "../services/format.js";

// Epoch seconds -> "YYYY-MM-DD HH:MM" (UTC — parser anchors times to UTC).
function fmtDT(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
}
function fmtDay(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
// Compact USD for dense chart axes: 16992 -> "$17k", -980 -> "-$980".
function fmtUsdK(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(0)}`;
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "trades", label: "Trades" },
  { id: "reconcile", label: "Reconciliation" },
];

const PAGE = 100;

export default function ReportImport() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [capital, setCapital] = useState(100000);
  const [tab, setTab] = useState("overview");
  const inputRef = useRef(null);

  async function handleFile(file) {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const result = await parseTradestationReport(file);
      setData(result);
      setFileName(file.name);
      setCapital(result?.meta?.initial_capital || 100000);
      setTab("overview");
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Failed to parse report.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    handleFile(file);
  }

  // Re-scale equity/drawdown/return to the (editable) starting capital. P&L,
  // PF, win-rate etc. are capital-independent and read straight from recomputed.
  const view = useMemo(() => {
    if (!data) return null;
    const pnl = data.equity_curve || [];
    const equity = pnl.map((p) => ({ time: p.time, value: capital + p.pnl }));
    let peak = capital, maxDD = 0, maxDDpct = 0;
    const drawdown = equity.map((p) => {
      peak = Math.max(peak, p.value);
      const dd = p.value - peak;
      const ddPct = peak ? (dd / peak) * 100 : 0;
      maxDD = Math.min(maxDD, dd);
      maxDDpct = Math.min(maxDDpct, ddPct);
      return { time: p.time, value: dd };
    });
    const net = data.recomputed.net_profit;
    return {
      equity, drawdown, maxDD, maxDDpct,
      returnPct: capital ? (100 * net) / capital : null,
      finalEquity: capital + net,
    };
  }, [data, capital]);

  return (
    <div className="min-h-screen bg-bg text-text">
      <Navbar view="reportimport" />
      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Report Import</h1>
          <p className="text-sm text-muted">
            Drop a <span className="text-text">TradeStation Performance Report</span> CSV to turn it into a
            live dashboard. Every headline number is independently recomputed from the trade list and shown
            against TradeStation's own figures. Session-only — nothing is uploaded or stored.
          </p>
        </header>

        <Dropzone
          dragOver={dragOver}
          loading={loading}
          fileName={fileName}
          hasData={!!data}
          onPick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        />
        <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden"
               onChange={(e) => handleFile(e.target.files?.[0])} />

        {error && (
          <div className="rounded-xl border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
            {error}
          </div>
        )}

        {data && view && (
          <>
            <ReportHeader data={data} fileName={fileName} capital={capital} setCapital={setCapital} />
            <TabBar tabs={TABS} active={tab} onSelect={setTab} />
            {tab === "overview" && <Overview data={data} view={view} capital={capital} />}
            {tab === "trades" && <TradesTab trades={data.trades} />}
            {tab === "reconcile" && <Reconcile data={data} view={view} />}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Dropzone({ dragOver, loading, fileName, hasData, onPick, onDragOver, onDragLeave, onDrop }) {
  return (
    <div
      onClick={onPick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`rounded-2xl border-2 border-dashed cursor-pointer transition px-6 py-8 text-center ${
        dragOver ? "border-accent-blue bg-accent-blue/5" : "border-line hover:border-accent-blue/50 bg-bg-panel/40"
      }`}
    >
      {loading ? (
        <div className="text-sm text-muted animate-pulse">Parsing report…</div>
      ) : (
        <>
          <div className="text-sm text-text">
            {hasData ? "Drop another report" : "Drop your TradeStation report CSV here"}
            <span className="text-muted"> or click to browse</span>
          </div>
          <div className="text-xs text-muted mt-1">
            {fileName ? `Loaded: ${fileName}` : "Performance Report export (.csv) — the multi-section one with the Trades List"}
          </div>
        </>
      )}
    </div>
  );
}

function ReportHeader({ data, fileName, capital, setCapital }) {
  const m = data.meta;
  return (
    <div className="rounded-xl border border-line bg-bg-panel/60 p-4 flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-6 text-sm">
        <Meta label="File" value={fileName || m.name || "report.csv"} />
        <Meta label="Trades" value={fmtInt(m.trade_count)} />
        <Meta label="Period" value={`${fmtDay(m.first_trade_time)} → ${fmtDay(m.last_trade_time)}`} />
      </div>
      <div className="flex items-center gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted">Starting capital</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-muted text-sm">$</span>
            <input
              type="number"
              value={capital}
              min={1}
              step={1000}
              onChange={(e) => setCapital(Math.max(1, Number(e.target.value) || 0))}
              className="w-32 bg-bg-elev border border-line rounded-md px-2 py-1 text-sm font-mono text-text focus:outline-none focus:border-accent-blue"
            />
            {m.initial_capital != null && capital !== m.initial_capital && (
              <button onClick={() => setCapital(m.initial_capital)}
                      className="text-[11px] text-accent-blue hover:underline">reset</button>
            )}
          </div>
          <div className="text-[10px] text-muted/70 mt-0.5">{m.initial_capital_source}</div>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="font-mono text-text mt-0.5">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Overview({ data, view, capital }) {
  const rec = data.recomputed;
  const rep = data.reported;
  const tsSub = (v, fmt = (x) => x) => (v == null ? null : `TS ${fmt(v)}`);

  const yearBars = (data.yearly || []).map((y) => ({ label: `'${String(y.year).slice(2)}`, value: y.net_profit, n: y.trades }));
  const hist = data.pnl_histogram || {};

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <KpiCard title="Net Profit" value={fmtUsd(rec.net_profit)} positive={rec.net_profit >= 0}
                 sub={`${fmtPct(view.returnPct)} on capital`} />
        <KpiCard title="Final Equity" value={fmtUsd(view.finalEquity)} positive={rec.net_profit >= 0}
                 sub={`from ${fmtUsd(capital)}`} />
        <KpiCard title="Profit Factor" value={fmtRatio(rec.profit_factor)} positive={rec.profit_factor >= 1}
                 sub={tsSub(rep.profit_factor, fmtRatio)} />
        <KpiCard title="Win Rate" value={fmtPct(rec.percent_profitable, false)}
                 sub={`${fmtInt(rec.winning_trades)}W · ${fmtInt(rec.losing_trades)}L`} />
        <KpiCard title="Total Trades" value={fmtInt(rec.total_trades)}
                 sub={rec.trades_per_year ? `${fmtNum(rec.trades_per_year)}/yr` : null} />
        <KpiCard title="Max Drawdown" value={fmtUsd(view.maxDD)} positive={false}
                 sub={fmtPct(view.maxDDpct, false)} />
        <KpiCard title="Avg Trade" value={fmtUsd(rec.avg_trade)} positive={rec.avg_trade >= 0}
                 sub={`expectancy · payoff ${fmtRatio(rec.payoff_ratio)}`} />
        <KpiCard title="Sharpe (per-trade)" value={fmtRatio(rec.sharpe_trade)}
                 sub={tsSub(rep.sharpe, fmtRatio) ? `${tsSub(rep.sharpe, fmtRatio)} (monthly)` : null} />
      </div>

      <Section title="Equity curve" hint="Account equity walked trade-by-trade. Dashed line = starting capital.">
        <div className="rounded-xl border border-line bg-bg-panel/40 p-2">
          <EquityCurve points={view.equity} baseline={capital} height={320} />
        </div>
      </Section>

      <Section title="Drawdown (underwater)" hint="Distance below the running equity peak, in dollars.">
        <div className="rounded-xl border border-line bg-bg-panel/40 p-2">
          <DrawdownCurve points={view.drawdown} height={170} />
        </div>
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Monthly P&L" hint="Net profit by calendar month, recomputed from exit times.">
          <div className="rounded-xl border border-line bg-bg-panel/40 p-3">
            <MonthlyHeatmap grid={data.monthly_grid} />
          </div>
        </Section>
        <Section title="Yearly net P&L" hint="Recomputed per calendar year.">
          <div className="rounded-xl border border-line bg-bg-panel/40 p-2">
            <VBarChart bars={yearBars} height={260} colorMode="sign" fmt={fmtUsdK} />
          </div>
        </Section>
      </div>

      <Section title="Trade P&L distribution" hint="Net profit per trade, with a fitted normal overlay.">
        <div className="rounded-xl border border-line bg-bg-panel/40 p-2">
          <HistogramChart counts={hist.counts || []} binEdges={hist.bin_edges || []}
                          mean={hist.mean || 0} std={hist.std || 0} height={240} />
        </div>
      </Section>

      <Section title="Long vs Short" hint="Net contribution and hit rate by direction.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {["long", "short"].map((d) => {
            const s = rec.by_direction?.[d] || {};
            return (
              <div key={d} className="rounded-xl border border-line bg-bg-panel/40 p-4">
                <div className="text-[10px] uppercase tracking-wider text-muted">{d}</div>
                <div className={`text-2xl font-mono mt-1 ${s.net_profit >= 0 ? "text-profit" : "text-loss"}`}>
                  {fmtUsd(s.net_profit)}
                </div>
                <div className="text-xs text-muted mt-0.5 font-mono">
                  {fmtInt(s.trades)} trades · {fmtPct(s.win_rate, false)} win
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

const RECON_ROWS = [
  ["Total Net Profit", "net_profit", "net_profit", "usd"],
  ["Gross Profit", "gross_profit", "gross_profit", "usd"],
  ["Gross Loss", "gross_loss", "gross_loss", "usd"],
  ["Profit Factor", "profit_factor", "profit_factor", "ratio"],
  ["Total Trades", "total_trades", "total_trades", "int"],
  ["Percent Profitable", "percent_profitable", "percent_profitable", "pct"],
  ["Winning Trades", "winning_trades", "winning_trades", "int"],
  ["Losing Trades", "losing_trades", "losing_trades", "int"],
  ["Avg Trade", "avg_trade", "avg_trade", "usd"],
  ["Avg Winning Trade", "avg_win", "avg_win", "usd"],
  ["Avg Losing Trade", "avg_loss", "avg_loss", "usd"],
  ["Largest Win", "largest_win", "largest_win", "usd"],
  ["Largest Loss", "largest_loss", "largest_loss", "usd"],
  ["Max Consec Wins", "max_consec_win", "max_consec_win", "int"],
  ["Max Consec Losses", "max_consec_loss", "max_consec_loss", "int"],
  ["Max Drawdown (close)", "max_drawdown_close", "max_drawdown", "usd"],
  ["Payoff Ratio", "payoff_ratio", "payoff_ratio", "ratio"],
];

function fmtBy(kind, v) {
  if (v == null) return "—";
  if (kind === "usd") return fmtUsd(v);
  if (kind === "pct") return fmtPct(v, false);
  if (kind === "int") return fmtInt(v);
  return fmtRatio(v);
}

function Reconcile({ data }) {
  const rep = data.reported, rec = data.recomputed;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        TradeStation's printed figures vs the same metrics re-derived from the parsed trade list. A
        <span className="text-profit"> ✓</span> means they agree within rounding; <span className="text-amber-400">≈</span>{" "}
        flags a methodology difference (Sharpe is monthly-basis at TradeStation; commission is counted per round-turn
        there but appears on both legs in the trades list).
      </p>
      <div className="rounded-xl border border-line bg-bg-panel/40 overflow-hidden">
        <div className="grid grid-cols-[1.6fr_1fr_1fr_auto] gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-muted border-b border-line">
          <div>Metric</div><div className="text-right">TradeStation</div><div className="text-right">Recomputed</div><div className="text-center w-8">=</div>
        </div>
        {RECON_ROWS.map(([label, rk, ck, kind]) => {
          const tv = rep[rk], cv = rec[ck];
          const both = tv != null && cv != null;
          const agree = both && Math.abs(tv - cv) <= Math.max(0.02, Math.abs(tv) * 0.01);
          return (
            <div key={label} className="grid grid-cols-[1.6fr_1fr_1fr_auto] gap-2 px-4 py-1.5 text-sm border-b border-line/40 last:border-0">
              <div className="text-muted">{label}</div>
              <div className="text-right font-mono text-text/90">{fmtBy(kind, tv)}</div>
              <div className="text-right font-mono text-text/90">{fmtBy(kind, cv)}</div>
              <div className="text-center w-8">{!both ? <span className="text-muted">·</span> : agree ? <span className="text-profit">✓</span> : <span className="text-amber-400">≈</span>}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TradesTab({ trades = [] }) {
  const [dir, setDir] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return trades.filter((t) => {
      if (dir !== "all" && t.direction !== dir) return false;
      if (ql && !(`${t.entry_signal} ${t.exit_signal}`.toLowerCase().includes(ql))) return false;
      return true;
    });
  }, [trades, dir, q]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const cur = Math.min(page, pages - 1);
  const rows = filtered.slice(cur * PAGE, cur * PAGE + PAGE);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 p-1 rounded-lg border border-line bg-bg-elev">
          {["all", "long", "short"].map((d) => (
            <button key={d} onClick={() => { setDir(d); setPage(0); }}
                    className={`px-3 py-1 text-xs rounded-md transition ${dir === d ? "bg-accent-grad text-white" : "text-muted hover:text-text"}`}>
              {d}
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
               placeholder="filter by signal…"
               className="bg-bg-elev border border-line rounded-md px-3 py-1.5 text-sm text-text focus:outline-none focus:border-accent-blue" />
        <div className="text-xs text-muted ml-auto">{fmtInt(filtered.length)} trades</div>
      </div>

      <div className="rounded-xl border border-line bg-bg-panel/40 overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted border-b border-line">
              <th className="text-right px-3 py-2">#</th>
              <th className="text-left px-3 py-2">Dir</th>
              <th className="text-left px-3 py-2">Entry</th>
              <th className="text-left px-3 py-2">Exit</th>
              <th className="text-right px-3 py-2">Entry $</th>
              <th className="text-right px-3 py-2">Exit $</th>
              <th className="text-right px-3 py-2">Net</th>
              <th className="text-right px-3 py-2">Cum</th>
              <th className="text-left px-3 py-2">Exit signal</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.n} className="border-b border-line/30 hover:bg-bg-elev/40">
                <td className="text-right px-3 py-1.5 text-muted">{t.n}</td>
                <td className={`px-3 py-1.5 ${t.direction === "long" ? "text-accent-cyan" : "text-amber-400"}`}>{t.direction === "long" ? "L" : "S"}</td>
                <td className="px-3 py-1.5 text-text/80">{fmtDT(t.entry_time)}</td>
                <td className="px-3 py-1.5 text-text/80">{fmtDT(t.exit_time)}</td>
                <td className="text-right px-3 py-1.5">{fmtNum(t.entry_price)}</td>
                <td className="text-right px-3 py-1.5">{fmtNum(t.exit_price)}</td>
                <td className={`text-right px-3 py-1.5 ${t.net_profit >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(t.net_profit)}</td>
                <td className="text-right px-3 py-1.5 text-muted">{fmtUsd(t.cum_profit)}</td>
                <td className="px-3 py-1.5 text-text/70">{t.exit_signal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        <button disabled={cur === 0} onClick={() => setPage(cur - 1)}
                className="px-3 py-1 rounded-md border border-line disabled:opacity-30 hover:text-text">← Prev</button>
        <span>Page {cur + 1} / {pages}</span>
        <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}
                className="px-3 py-1 rounded-md border border-line disabled:opacity-30 hover:text-text">Next →</button>
      </div>
    </div>
  );
}
