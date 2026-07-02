/**
 * Single source of truth for number formatting. Always grouped + 2 decimals.
 *   fmtUsd(1234567.89)      -> "$1,234,567.89"
 *   fmtNum(1234.5)          -> "1,234.50"
 *   fmtPct(3.456)           -> "+3.46%"
 *   fmtPct(-1.2, false)     -> "-1.20%"
 *   fmtInt(12345)           -> "12,345"
 */

const NF2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NF0 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const _isNum = (v) => v != null && typeof v === "number" && Number.isFinite(v);

export function fmtNum(v, dash = "—") {
  if (!_isNum(v)) return dash;
  return NF2.format(v);
}

export function fmtInt(v, dash = "—") {
  if (!_isNum(v)) return dash;
  return NF0.format(v);
}

export function fmtUsd(v, dash = "—") {
  if (!_isNum(v)) return dash;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${NF2.format(Math.abs(v))}`;
}

/** signed = true (default) prefixes "+" for non-negatives. */
export function fmtPct(v, signed = true, dash = "—") {
  if (!_isNum(v)) return dash;
  const s = NF2.format(Math.abs(v));
  if (signed) return `${v >= 0 ? "+" : "-"}${s}%`;
  return `${v < 0 ? "-" : ""}${s}%`;
}

export function fmtRatio(v, dash = "—") {
  if (!_isNum(v)) return dash;
  return NF2.format(v);
}

export function fmtTime(epochSec) {
  if (!_isNum(epochSec)) return "—";
  return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function fmtDate(epochSec) {
  if (!_isNum(epochSec)) return "—";
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable UTC date from epoch seconds, e.g. "Feb 03, 2026". */
export function fmtDateLong(epochSec) {
  if (!_isNum(epochSec)) return "—";
  const d = new Date(epochSec * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${day}, ${d.getUTCFullYear()}`;
}

/** Human-readable date from "YYYY-MM-DD" string, e.g. "Feb 03, 2026". */
export function fmtDateStr(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${MONTHS_SHORT[parseInt(m, 10) - 1]} ${d.padStart(2, "0")}, ${y}`;
}
