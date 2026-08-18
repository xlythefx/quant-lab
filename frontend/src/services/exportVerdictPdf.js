/**
 * Overnight Run "verdict" PDF — a plain-language, non-technical summary of the
 * best parameters found per asset, and whether they're trustworthy.
 *
 * Same library-free technique as exportAnalyticsPdf.js: build an HTML string,
 * open a print window, and let the browser "Save as PDF". Leads with the
 * TRUSTWORTHY signal (out-of-sample result / plateau), not the in-sample peak.
 */
import { fmtNum, fmtInt, fmtPct, fmtDateLong } from "./format.js";
import { assetTrust, METRIC_LABEL } from "./overnightVerdict.js";

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function metricValue(metric, v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return metric === "total_return" ? fmtPct(v) : fmtNum(v);
}

// Plain-English one-liners for the key numbers a non-technical reader cares about.
function keyNumbers(stats) {
  const s = stats || {};
  const pf = s.profit_factor == null ? "∞" : fmtNum(s.profit_factor);
  const win = s.win_rate != null ? `${fmtNum(s.win_rate * 100)}%` : "—";
  return [
    ["Return", s.total_return_pct != null ? fmtPct(s.total_return_pct) : "—", "how much the account grew over the whole test"],
    ["Sharpe", s.sharpe != null ? fmtNum(s.sharpe) : "—", "return earned per unit of bumpiness — higher is a smoother ride (above 1 is good)"],
    ["Worst dip", s.max_drawdown_pct != null ? fmtPct(s.max_drawdown_pct, false) : "—", "the deepest drop from a high point along the way"],
    ["Win rate", win, "share of trades that made money"],
    ["Trades", s.trades != null ? fmtInt(s.trades) : "—", "how many round-trip trades — very few trades means less trustworthy"],
    ["Profit factor", pf, "dollars won for every dollar lost (above 1 makes money)"],
  ];
}

const PLATEAU_TEXT = {
  plateau:      ["✓", "#1a7f44", "stable — nearby values behave similarly, so this is trustworthy"],
  moderate:     ["·", "#5b6472", "fairly stable across nearby values"],
  sensitive:    ["⚠", "#b45309", "sensitive — a small change flips the result, a sign of over-fitting"],
  noeffect:     ["∅", "#5b6472", "made no difference here"],
  insufficient: ["—", "#5b6472", "not enough data to judge"],
  single:       ["·", "#5b6472", "fixed (not swept)"],
};

function robustnessBlock(rec) {
  // grid_then_wf / walkforward → lead with out-of-sample
  if (rec.wf && typeof rec.wf.pct_windows_positive === "number") {
    const pct = Math.round(rec.wf.pct_windows_positive * 100);
    const oos = rec.wf.oos_return_pct != null ? fmtPct(rec.wf.oos_return_pct) : "—";
    return `<p class="note"><b>Out-of-sample check:</b> profitable on <b>${pct}%</b> of the
      ${fmtInt(rec.wf.n_windows)} time windows it was never tuned on (stitched return ${oos}).
      This is the number to trust — it's from data the optimizer never saw.</p>`;
  }
  // grid-only → lean on the plateau
  const params = (rec.plateau?.params || []).filter((p) => !p.single);
  if (!params.length) return "";
  const items = params.map((p) => {
    const [icon, color, text] = PLATEAU_TEXT[p.verdict] || PLATEAU_TEXT.moderate;
    return `<li><span style="color:${color}">${icon}</span> <b>${esc(p.name)}</b> — ${text}</li>`;
  }).join("");
  return `<p class="note"><b>Are these settings stable?</b> (a stable "plateau" is trustworthy;
    a lone "spike" usually won't repeat)</p><ul class="plateau">${items}</ul>`;
}

function nextStep(rec) {
  if (rec.wf) {
    return `<p class="next">✓ Already validated out-of-sample above.</p>`;
  }
  const swept = (rec.grid_params || []).filter((g) => (g.values || []).length >= 2);
  if (!swept.length) return "";
  const ranges = swept.map((g) => {
    const vs = g.values.slice().sort((a, b) => a - b);
    return `${esc(g.name)} ${vs[0]}–${vs[vs.length - 1]}`;
  }).join(", ");
  return `<p class="next"><b>Next step:</b> confirm this on data the tuning never saw — run
    Walk-Forward over these ranges: <span class="mono">${ranges}</span>.</p>`;
}

function assetSection(rec, metric, rank) {
  const trust = assetTrust(rec);
  const params = Object.entries(rec.best?.params || {})
    .map(([k, v]) => `<span class="chip">${esc(k)} = <b>${v}</b></span>`).join(" ");
  const nums = keyNumbers(rec.best?.stats).map(([label, val, why]) =>
    `<tr><td class="k">${label}</td><td class="v">${val}</td><td class="why">${why}</td></tr>`).join("");
  return `
    <div class="asset">
      <div class="asset-head">
        <span class="rank">#${rank}</span>
        <span class="sym">${esc(rec.symbol)}</span>
        <span class="badge" style="color:${trust.tone};border-color:${trust.tone}">
          ${trust.emoji} ${trust.label}
        </span>
        <span class="headline">${METRIC_LABEL[metric] || metric}: <b>${metricValue(metric, rec.headline_metric_value)}</b></span>
      </div>
      <p class="reason">${esc(trust.reason)}</p>
      <div class="settings"><span class="settings-label">Best settings found:</span> ${params}</div>
      <table class="nums"><tbody>${nums}</tbody></table>
      ${robustnessBlock(rec)}
      ${nextStep(rec)}
    </div>`;
}

export function exportVerdictPdf(result) {
  if (!result || !(result.per_asset || []).length) {
    alert("Nothing to export yet — run an overnight batch first.");
    return;
  }
  const metric = result.metric;
  const ranked = [...result.per_asset].sort(
    (a, b) => (b.headline_metric_value ?? -Infinity) - (a.headline_metric_value ?? -Infinity)
  );

  const modeLabel = { grid: "Grid Search", walkforward: "Walk-Forward",
                      grid_then_wf: "Grid → Walk-Forward" }[result.mode] || result.mode;
  const runDate = fmtDateLong(result.finished_at || result.started_at);

  // Cover summary table
  const coverRows = ranked.map((rec, i) => {
    const t = assetTrust(rec);
    const st = rec.best?.stats || {};
    return `<tr>
      <td>#${i + 1}</td>
      <td class="mono">${esc(rec.symbol)}</td>
      <td class="r mono">${metricValue(metric, rec.headline_metric_value)}</td>
      <td class="r mono">${st.total_return_pct != null ? fmtPct(st.total_return_pct) : "—"}</td>
      <td class="r mono">${st.trades != null ? fmtInt(st.trades) : "—"}</td>
      <td style="color:${t.tone}">${t.emoji} ${t.label}</td>
    </tr>`;
  }).join("");

  const skippedHtml = (result.skipped || []).length
    ? `<p class="skip"><b>Skipped:</b> ${result.skipped.map((s) => `${esc(s.symbol)} (${esc(s.reason)})`).join(" · ")}</p>`
    : "";

  const oosMode = result.mode !== "grid";
  const caveat = oosMode
    ? `Each verdict below is backed by a Walk-Forward check — the numbers come from time windows the tuning never saw, which is the honest test of whether an edge is real.`
    : `These results are <b>in-sample</b> (the tuning saw all the data), so they look better than reality. Use them to find promising ranges, then confirm each with Walk-Forward before trusting it.`;

  const sections = ranked.map((rec, i) => assetSection(rec, metric, i + 1)).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Strategy Verdict — ${esc(result.strategy_id)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1c2333; margin: 0; font-size: 10pt; line-height: 1.45; }
  .page { padding: 22px 26px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 18pt; margin: 0 0 2px; }
  .subtitle { color: #5b6472; font-size: 9.5pt; margin-bottom: 12px; }
  .intro { background: #f4f6fa; border: 1px solid #e2e7f0; border-radius: 6px; padding: 10px 12px; font-size: 9.5pt; margin-bottom: 16px; }
  h2 { font-size: 12pt; border-bottom: 2px solid #1c2333; padding-bottom: 3px; margin: 20px 0 8px; }
  table.cover { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  table.cover th { background: #1c2333; color: #fff; padding: 5px 8px; text-align: left; }
  table.cover th.r, table.cover td.r { text-align: right; }
  table.cover td { padding: 5px 8px; border-bottom: 1px solid #e8e8e8; }
  table.cover tr:nth-child(even) td { background: #f8f9fc; }
  .mono { font-family: "Courier New", monospace; }
  .asset { border: 1px solid #e2e7f0; border-radius: 8px; padding: 12px 14px; margin: 12px 0; page-break-inside: avoid; }
  .asset-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .rank { color: #9aa3b2; font-weight: 700; }
  .sym { font-family: "Courier New", monospace; font-size: 13pt; font-weight: 700; }
  .badge { border: 1.5px solid; border-radius: 999px; padding: 1px 9px; font-size: 9pt; font-weight: 700; }
  .headline { margin-left: auto; font-size: 10pt; }
  .reason { color: #414b5a; font-size: 9.5pt; margin: 6px 0 8px; }
  .settings { font-size: 9.5pt; margin-bottom: 8px; }
  .settings-label { color: #5b6472; text-transform: uppercase; font-size: 8pt; letter-spacing: .04em; }
  .chip { display: inline-block; background: #eef2fb; border: 1px solid #dbe3f4; border-radius: 5px; padding: 1px 7px; margin: 2px 3px 2px 0; font-family: "Courier New", monospace; font-size: 9pt; }
  table.nums { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin: 6px 0; }
  table.nums td { padding: 3px 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  table.nums td.k { width: 20%; font-weight: 600; }
  table.nums td.v { width: 15%; text-align: right; font-family: "Courier New", monospace; }
  table.nums td.why { color: #6b7280; font-size: 9pt; }
  .note { font-size: 9.5pt; margin: 8px 0 4px; }
  ul.plateau { margin: 4px 0 6px; padding-left: 18px; font-size: 9.5pt; }
  ul.plateau li { margin: 2px 0; }
  .next { background: #f0f7f2; border-left: 3px solid #1a7f44; padding: 6px 10px; font-size: 9.5pt; margin: 8px 0 0; }
  .skip { color: #6b7280; font-size: 9pt; }
  .footer { margin-top: 26px; font-size: 8pt; color: #999; border-top: 1px solid #ddd; padding-top: 8px; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    table.cover th { background: #1c2333 !important; color: #fff !important; } .asset { page-break-inside: avoid; } }
</style></head>
<body><div class="page">
  <h1>Strategy Verdict</h1>
  <div class="subtitle">${esc(result.strategy_id)} &nbsp;·&nbsp; ${esc(result.timeframe)} &nbsp;·&nbsp;
    ${modeLabel} &nbsp;·&nbsp; ranked by ${METRIC_LABEL[metric] || metric} &nbsp;·&nbsp; ${runDate}</div>
  <div class="intro">${caveat}</div>

  <h2>At a glance — ${ranked.length} asset${ranked.length === 1 ? "" : "s"}</h2>
  <table class="cover"><thead><tr>
    <th>#</th><th>Asset</th><th class="r">${METRIC_LABEL[metric] || metric}</th>
    <th class="r">Return</th><th class="r">Trades</th><th>Verdict</th>
  </tr></thead><tbody>${coverRows}</tbody></table>
  ${skippedHtml}

  <h2>Details</h2>
  ${sections}

  <div class="footer">Generated by QuantLab · ${runDate} · A verdict is a starting point, not a guarantee — position-size responsibly.</div>
</div>
<script>window.onload = function(){ window.print(); };</script>
</body></html>`;

  const win = window.open("", "_blank", "width=980,height=820");
  if (!win) { alert("Pop-up blocked — allow pop-ups for this site and try again."); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
