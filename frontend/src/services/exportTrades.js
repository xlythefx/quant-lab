/**
 * TradingView-style "List of Trades" CSV export.
 *
 * Columns mirror TradingView's export so users can drop the file into the
 * same downstream tooling (spreadsheets, journals, R/Python notebooks).
 *
 *   Trade # | Type | Date and time | Signal | Price USDT | Size (qty) |
 *   Size (value) | Net P&L USD | Net P&L % | Favorable excursion USD |
 *   Favorable excursion % | Adverse excursion USD | Adverse excursion % |
 *   Cumulative P&L USD | Cumulative P&L %
 *
 * Each trade emits TWO rows (Exit row first, then Entry row — matches TV).
 * MFE/MAE are computed from the candles array using highs/lows between
 * entry_time and exit_time.
 */

function fmtDateMDY(epochSec) {
  const d = new Date(epochSec * 1000);
  const M = d.getUTCMonth() + 1;
  const D = d.getUTCDate();
  const Y = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${M}/${D}/${Y} ${hh}:${mm}`;
}

function num(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return "";
  return Number(v).toFixed(digits).replace(/\.?0+$/, (s) => (s.startsWith(".") ? "" : s));
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Compute Maximum Favorable Excursion and Maximum Adverse Excursion for one
 * trade by scanning candles within [entry_time, exit_time]. Returns USD values
 * (per-unit price move × units); long uses high for MFE / low for MAE, short
 * the opposite.
 */
function computeExcursion(trade, candles, startIdx) {
  const { side, entry_price, entry_time, exit_time, units } = trade;
  let mfePrice = entry_price;   // best (most favorable) price reached
  let maePrice = entry_price;   // worst (most adverse) price reached
  let i = startIdx;
  while (i < candles.length && candles[i].time < entry_time) i++;
  const firstIdx = i;
  while (i < candles.length && candles[i].time <= exit_time) {
    const c = candles[i];
    if (side === "long") {
      if (c.high > mfePrice) mfePrice = c.high;
      if (c.low  < maePrice) maePrice = c.low;
    } else {
      if (c.low  < mfePrice) mfePrice = c.low;
      if (c.high > maePrice) maePrice = c.high;
    }
    i++;
  }
  const sign = side === "long" ? 1 : -1;
  const mfeUsd = (mfePrice - entry_price) * sign * units;   // ≥ 0
  const maeUsd = (maePrice - entry_price) * sign * units;   // ≤ 0
  return { mfeUsd, maeUsd, nextStart: firstIdx };
}

export function buildTradesCsv(result) {
  const trades = [...(result?.trades || [])].sort((a, b) => a.entry_time - b.entry_time);
  const candles = result?.candles || [];
  const startingCapital = result?.stats?.starting_capital
    ?? result?.risk_config?.starting_capital
    ?? 0;

  const headers = [
    "Trade #", "Type", "Date and time", "Signal",
    "Price USDT", "Size (qty)", "Size (value)",
    "Net P&L USD", "Net P&L %",
    "Favorable excursion USD", "Favorable excursion %",
    "Adverse excursion USD", "Adverse excursion %",
    "Cumulative P&L USD", "Cumulative P&L %",
  ];

  const rows = [headers];
  let cumUsd = 0;
  let candleCursor = 0;

  trades.forEach((t, idx) => {
    const tradeNum = idx + 1;
    const { mfeUsd, maeUsd, nextStart } = computeExcursion(t, candles, candleCursor);
    candleCursor = nextStart;

    const netUsd = t.pnl_dollars;
    const netPct = startingCapital > 0 ? (netUsd / startingCapital) * 100 : 0;
    const mfePct = startingCapital > 0 ? (mfeUsd / startingCapital) * 100 : 0;
    const maePct = startingCapital > 0 ? (maeUsd / startingCapital) * 100 : 0;
    cumUsd += netUsd;
    const cumPct = startingCapital > 0 ? (cumUsd / startingCapital) * 100 : 0;

    const sideCap = t.side === "long" ? "long" : "short";
    const entryNotional = t.entry_price * t.units;
    const exitNotional  = t.exit_price  * t.units;
    const exitSignal  = t.side === "long" ? "EXIT_LONG" : "EXIT_SHORT";
    const entrySignal = t.side === "long" ? "BUY"       : "SELL";

    // Exit row first (matches TV ordering).
    rows.push([
      tradeNum, `Exit ${sideCap}`, fmtDateMDY(t.exit_time), exitSignal,
      num(t.exit_price), num(t.units), num(exitNotional),
      num(netUsd, 2), num(netPct, 2),
      num(mfeUsd, 2), num(mfePct, 2),
      num(maeUsd, 2), num(maePct, 2),
      num(cumUsd, 2), num(cumPct, 2),
    ]);
    rows.push([
      tradeNum, `Entry ${sideCap}`, fmtDateMDY(t.entry_time), entrySignal,
      num(t.entry_price), num(t.units), num(entryNotional),
      num(netUsd, 2), num(netPct, 2),
      num(mfeUsd, 2), num(mfePct, 2),
      num(maeUsd, 2), num(maePct, 2),
      num(cumUsd, 2), num(cumPct, 2),
    ]);
  });

  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function downloadTradesCsv(result) {
  const csv = buildTradesCsv(result);
  const filename = [
    "trades",
    result?.strategy_id || "strategy",
    result?.symbol || "",
    result?.timeframe || "",
  ].filter(Boolean).join("_") + ".csv";

  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
