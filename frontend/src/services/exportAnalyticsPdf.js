/**
 * TradeStation-style Performance Summary PDF export.
 * Opens a styled print window and triggers window.print() — the browser
 * renders it as a PDF when the user selects "Save as PDF" in the print dialog.
 * No external libraries required.
 */

// ── Formatters (self-contained, no external imports) ──────────────────────────

function usd(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v < 0 ? `-$${s}` : `$${s}`;
}

function pct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Number(v).toFixed(digits)}%`;
}

function num(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v).toFixed(digits);
}

function integer(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString("en-US");
}

function dateStr(epochSec) {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
}

function monthYear(epochSec) {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", timeZone: "UTC",
  });
}

// ── HTML builder helpers ───────────────────────────────────────────────────────

function row(label, all, long, short, cls = "") {
  return `
    <tr class="${cls}">
      <td class="label">${label}</td>
      <td class="val">${all}</td>
      <td class="val">${long}</td>
      <td class="val">${short}</td>
    </tr>`;
}

function row2(label, value, cls = "") {
  return `
    <tr class="${cls}">
      <td class="label">${label}</td>
      <td class="val" colspan="3">${value}</td>
    </tr>`;
}

function sectionHeader(title) {
  return `<tr class="section-head"><td colspan="4">${title}</td></tr>`;
}

// ── Main export function ───────────────────────────────────────────────────────

export function exportAnalyticsPdf(result) {
  const s  = result?.stats     ?? {};
  const a  = result?.analytics ?? {};
  const adv = a?.advanced      ?? {};
  const ts  = adv?.trade_stats ?? {};
  const ra  = adv?.risk_adjusted ?? {};
  const dd  = adv?.drawdown    ?? {};
  const di  = adv?.distribution ?? {};
  const rc  = result?.risk_config ?? {};

  const sl = s?.long  ?? {};
  const ss = s?.short ?? {};

  const dataYears = s.first_time && s.last_time
    ? ((s.last_time - s.first_time) / (365.25 * 86400)).toFixed(2)
    : null;

  const stratLabel = [
    result?.strategy_id ?? "Strategy",
    result?.symbol      ?? "",
    result?.timeframe   ?? "",
  ].filter(Boolean).join(" · ");

  const dateRange = s.first_time && s.last_time
    ? `${dateStr(s.first_time)} – ${dateStr(s.last_time)}`
    : "—";

  // ── Monthly returns mini-table ─────────────────────────────────────────────
  const monthly = a?.monthly_returns ?? [];
  let monthlyHtml = "";
  if (monthly.length) {
    const monthRows = monthly.map(m => {
      const cls = m.pnl_dollars >= 0 ? "pos" : "neg";
      return `<tr>
        <td>${monthYear(m.month_start ?? m.month)}</td>
        <td class="${cls}">${usd(m.pnl_dollars)}</td>
        <td class="${cls}">${pct(m.pnl_pct ?? (m.pnl_dollars / rc.starting_capital * 100))}</td>
        <td>${integer(m.trades)}</td>
      </tr>`;
    }).join("");
    monthlyHtml = `
      <h2>Monthly Returns</h2>
      <table class="simple">
        <thead><tr><th>Month</th><th>Net P&amp;L</th><th>Return %</th><th>Trades</th></tr></thead>
        <tbody>${monthRows}</tbody>
      </table>`;
  }

  // ── Session breakdown mini-table ───────────────────────────────────────────
  const sessions = a?.by_session ?? [];
  let sessionHtml = "";
  if (sessions.length) {
    const sessRows = sessions.map(se => {
      const cls = se.pnl_dollars >= 0 ? "pos" : "neg";
      return `<tr>
        <td>${se.session ?? se.name ?? "—"}</td>
        <td>${integer(se.trades)}</td>
        <td class="${cls}">${usd(se.pnl_dollars)}</td>
        <td>${pct(se.win_rate != null ? se.win_rate * 100 : null)}</td>
        <td class="${cls}">${usd(se.avg_pnl_dollars)}</td>
      </tr>`;
    }).join("");
    sessionHtml = `
      <h2>Session Breakdown</h2>
      <table class="simple">
        <thead><tr><th>Session</th><th>Trades</th><th>Net P&amp;L</th><th>Win Rate</th><th>Avg P&amp;L</th></tr></thead>
        <tbody>${sessRows}</tbody>
      </table>`;
  }

  // ── Main performance table rows ────────────────────────────────────────────
  const tableRows = [
    sectionHeader("P&amp;L Summary"),
    row("Total Net Profit",
        usd(s.total_return_dollars), usd(sl.pnl_dollars), usd(ss.pnl_dollars),
        s.total_return_dollars >= 0 ? "pos" : "neg"),
    row("Gross Profit",   usd(s.gross_profit), usd(sl.gross_profit ?? "—"), usd(ss.gross_profit ?? "—"), "pos"),
    row("Gross Loss",     usd(s.gross_loss != null ? -s.gross_loss : null), "—", "—", "neg"),
    row("Profit Factor",  num(s.profit_factor), num(sl.profit_factor), num(ss.profit_factor)),
    row("Commission Paid", usd(a.commission_dollars), "—", "—"),

    sectionHeader("Trade Statistics"),
    row("Total Trades",       integer(s.trades), integer(sl.trades), integer(ss.trades)),
    row("Percent Profitable", pct(s.win_rate * 100), pct(sl.win_rate * 100), pct(ss.win_rate * 100)),
    row("Winning Trades",     integer(s.wins),   integer(sl.wins),   integer(ss.wins),   "pos"),
    row("Losing Trades",      integer(s.losses), integer(sl.losses), integer(ss.losses), "neg"),
    row("Avg Trade Net P&amp;L", usd(s.avg_pnl_dollars), usd(sl.avg_pnl_dollars), usd(ss.avg_pnl_dollars),
        (s.avg_pnl_dollars ?? 0) >= 0 ? "pos" : "neg"),
    row("Avg Winning Trade",  usd(ts.avg_win),  "—", "—", "pos"),
    row("Avg Losing Trade",   usd(ts.avg_loss != null ? -Math.abs(ts.avg_loss) : null), "—", "—", "neg"),
    row("Payoff Ratio (W:L)", num(ts.payoff_ratio), "—", "—"),
    row("Expectancy ($)",     usd(ts.expectancy_dollars), "—", "—"),
    row("Expectancy (R)",     num(ts.expectancy_R, 3), "—", "—"),
    row("Max Win Streak",     integer(a.streaks?.max_win_streak), "—", "—", "pos"),
    row("Max Loss Streak",    integer(a.streaks?.max_loss_streak), "—", "—", "neg"),

    sectionHeader("Drawdown &amp; Risk"),
    row("Max Drawdown ($)",        usd(s.max_drawdown_dollars != null ? -Math.abs(s.max_drawdown_dollars) : null), "—", "—", "neg"),
    row("Max Drawdown (%)",        pct(s.max_drawdown_pct != null ? -Math.abs(s.max_drawdown_pct) : null), "—", "—", "neg"),
    row("Max DD Duration (bars)",  integer(a.max_drawdown_duration_bars), "—", "—"),
    row("Ulcer Index",             num(dd.ulcer_index, 4), "—", "—"),
    row("Open Drawdown (%)",       pct(dd.open_drawdown_pct != null ? -Math.abs(dd.open_drawdown_pct) : null), "—", "—"),

    sectionHeader("Risk-Adjusted Returns"),
    row("Sharpe Ratio (ann.)",     num(s.sharpe, 3), "—", "—"),
    row("Sortino Ratio",           num(ra.sortino, 3), "—", "—"),
    row("Calmar Ratio",            num(ra.calmar, 3), "—", "—"),
    row("CAGR (%)",                pct(ra.cagr_pct, 2), "—", "—"),
    row("Omega Ratio",             num(ra.omega, 3), "—", "—"),
    row("Gain-to-Pain Ratio",      num(ra.gain_to_pain, 3), "—", "—"),
    row("MAR Ratio",               num(ra.mar, 3), "—", "—"),
    row("K-Ratio",                 num(ra.k_ratio, 4), "—", "—"),

    sectionHeader("Distribution &amp; Statistical Edge"),
    row("Skewness",       num(di.skewness, 4), "—", "—"),
    row("Kurtosis (excess)", num(di.kurtosis_excess, 4), "—", "—"),
    row("Tail Ratio",     num(di.tail_ratio, 4), "—", "—"),
    row("T-Statistic",    num(di.t_stat, 4), "—", "—"),
    row("P-Value",        num(di.t_pvalue, 4), "—", "—"),
    row("Significant?",   di.significance != null ? (di.significance ? "YES" : "No") : "—", "—", "—"),
    row("Prob. of Ruin",  di.prob_ruin != null ? pct(di.prob_ruin * 100, 3) : "—", "—", "—"),

    sectionHeader("Data &amp; Execution"),
    row2("Data Period",    dataYears ? `${dateRange} (${dataYears} yrs)` : dateRange),
    row2("Trading Days",   `${integer(a.trading_days)} days with ≥1 trade`),
    row2("Exposure",       `${num(a.exposure_pct, 1)}% of bars in position`),
    row2("Starting Capital", usd(rc.starting_capital, 0)),
    row2("Final Equity",   usd(s.final_equity)),
    row2("Total Return",   `${pct(s.total_return_pct)} (${usd(s.total_return_dollars)})`,
         (s.total_return_dollars ?? 0) >= 0 ? "pos" : "neg"),
    row2("Commission Rate", `${num(rc.fee_pct, 3)}% + $${num(rc.fee_flat, 2)} flat · ${num(rc.slippage_bps, 1)} bps slippage`),
  ].join("");

  // ── Full HTML document ─────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Performance Summary — ${stratLabel}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Calibri", "Segoe UI", Arial, sans-serif; font-size: 10pt; color: #111; background: #fff; }

  .page { max-width: 900px; margin: 0 auto; padding: 24px 28px; }

  h1 { font-size: 15pt; font-weight: 700; margin-bottom: 2px; }
  .subtitle { font-size: 9pt; color: #555; margin-bottom: 18px; }

  h2 { font-size: 10.5pt; font-weight: 700; margin: 22px 0 6px; border-bottom: 1.5px solid #bbb; padding-bottom: 3px; }

  /* Main 4-column performance table */
  table.perf { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  table.perf th {
    background: #1c2333; color: #fff; padding: 5px 8px;
    text-align: left; font-weight: 600; letter-spacing: 0.02em;
  }
  table.perf th.val { text-align: right; }
  table.perf td { padding: 3.5px 8px; border-bottom: 1px solid #e8e8e8; }
  table.perf td.label { width: 42%; font-weight: 500; }
  table.perf td.val { text-align: right; font-family: "Courier New", monospace; font-size: 9pt; }
  table.perf tr:hover td { background: #f4f6fa; }
  table.perf tr.section-head td {
    background: #e8ecf5; font-weight: 700; font-size: 9pt;
    letter-spacing: 0.04em; text-transform: uppercase;
    padding: 5px 8px; color: #1c2333; border-bottom: 1px solid #c5cde0;
  }
  table.perf tr.pos td.label,
  table.perf tr.pos td.val { color: #1a7f44; }
  table.perf tr.neg td.label,
  table.perf tr.neg td.val { color: #b91c1c; }

  /* Simple 2-col tables for monthly/session */
  table.simple { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.simple th { background: #1c2333; color: #fff; padding: 4px 8px; text-align: right; font-weight: 600; }
  table.simple th:first-child { text-align: left; }
  table.simple td { padding: 3px 8px; border-bottom: 1px solid #e8e8e8; text-align: right; }
  table.simple td:first-child { text-align: left; }
  table.simple tr:nth-child(even) td { background: #f8f9fc; }
  .pos { color: #1a7f44; }
  .neg { color: #b91c1c; }

  .footer { margin-top: 28px; font-size: 8pt; color: #999; border-top: 1px solid #ddd; padding-top: 8px; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 10px 14px; }
    h2 { margin-top: 14px; }
    table.perf tr.section-head td { background: #e8ecf5 !important; }
    table.perf th { background: #1c2333 !important; color: #fff !important; }
    table.simple th { background: #1c2333 !important; color: #fff !important; }
  }
</style>
</head>
<body>
<div class="page">
  <h1>Performance Summary</h1>
  <div class="subtitle">${stratLabel} &nbsp;·&nbsp; ${dateRange}${dataYears ? ` &nbsp;·&nbsp; ${dataYears} yrs` : ""}</div>

  <table class="perf">
    <thead>
      <tr>
        <th style="width:42%">Metric</th>
        <th class="val" style="width:19%">All Trades</th>
        <th class="val" style="width:19%">Long Trades</th>
        <th class="val" style="width:19%">Short Trades</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>

  ${sessionHtml}
  ${monthlyHtml}

  <div class="footer">
    Generated by quant-laptop &nbsp;·&nbsp; ${new Date().toLocaleString("en-US")} &nbsp;·&nbsp;
    Percent-based stops · Risk: ${num(result?.params?.risk_pct ?? rc?.risk_pct, 1)}% per trade
  </div>
</div>
<script>
  window.onload = function() { window.print(); };
</script>
</body>
</html>`;

  const win = window.open("", "_blank", "width=960,height=800");
  if (!win) {
    alert("Pop-up blocked — please allow pop-ups for this site and try again.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
