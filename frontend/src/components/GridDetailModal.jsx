import { useEffect } from "react";
import { fmtUsd, fmtNum, fmtInt, fmtPct, fmtDate } from "../services/format.js";

/**
 * In-depth analytics for a single grid-search combo.
 *
 * Grid search runs each combo with stats_only=True, so result.stats already
 * carries the full backtest stat block (overall + per-side long/short split) —
 * the table only surfaces six columns of it. This modal renders the rest:
 * returns, risk, trade distribution, and the long vs short breakdown, plus the
 * exact param values that produced them.
 *
 * Props:
 *   open        — bool
 *   onClose     — () => void
 *   row         — { combo_idx, params, stats }
 *   gridParams  — [{ name, type, values }]  (the swept params, for labeling)
 *   baseParams  — fixed params shared by every combo (optional, for context)
 */
export default function GridDetailModal({ open, onClose, row, gridParams = [], baseParams = {} }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !row) return null;

  const s = row.stats || {};
  const long = s.long || {};
  const short = s.short || {};
  const pf = s.profit_factor == null ? "∞" : fmtNum(s.profit_factor);
  const winPct = (v) => `${fmtNum((v ?? 0) * 100)}%`;

  // Swept params first (the ones that vary), then the rest of the combo's params.
  const sweptNames = new Set(gridParams.map((gp) => gp.name));
  const sweptEntries = gridParams.map((gp) => [gp.name, row.params?.[gp.name]]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-2xl border border-line bg-bg-panel shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-line sticky top-0 bg-bg-panel z-10">
          <div>
            <div className="text-sm font-semibold text-text">Combo #{row.combo_idx} — analytics</div>
            <div className="text-[11px] text-muted font-mono">
              {sweptEntries.length
                ? sweptEntries.map(([k, v]) => `${k}=${fmtParam(v)}`).join("  ·  ")
                : "single configuration"}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none px-2" title="Close">✕</button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Headline */}
          <div className="flex flex-wrap gap-4 rounded-xl border border-line/60 bg-bg-elev/30 p-4">
            <Stat label="Total Return" value={fmtPct(s.total_return_pct)}
                  cls={(s.total_return_pct ?? 0) >= 0 ? "text-profit" : "text-loss"}
                  sub={fmtUsd(s.total_return_dollars)} />
            <Stat label="Sharpe" value={fmtNum(s.sharpe)} />
            <Stat label="Profit Factor" value={pf} />
            <Stat label="Max DD" value={fmtPct(s.max_drawdown_pct, false)} cls="text-loss"
                  sub={fmtUsd(s.max_drawdown_dollars)} />
          </div>

          {/* Returns / equity */}
          <Section title="Returns">
            <KV k="Starting Capital" v={fmtUsd(s.starting_capital)} />
            <KV k="Final Equity"     v={fmtUsd(s.final_equity)} />
            <KV k="Net P&L"          v={fmtUsd(s.total_return_dollars)}
                cls={(s.total_return_dollars ?? 0) >= 0 ? "text-profit" : "text-loss"} />
            <KV k="Avg Trade P&L"    v={fmtUsd(s.avg_pnl_dollars)}
                cls={(s.avg_pnl_dollars ?? 0) >= 0 ? "text-profit" : "text-loss"} />
            <KV k="Gross Profit"     v={fmtUsd(s.gross_profit)} cls="text-profit" />
            <KV k="Gross Loss"       v={fmtUsd(s.gross_loss)} cls="text-loss" />
            <KV k="Avg Trade %"      v={fmtPct(s.avg_pnl_pct)} />
            <KV k="Peak-rel. Max DD" v={fmtPct(s.max_drawdown_pct_peak, false)} />
          </Section>

          {/* Trade distribution */}
          <Section title="Trades">
            <KV k="Total Trades" v={fmtInt(s.trades)} />
            <KV k="Win Rate"     v={winPct(s.win_rate)} />
            <KV k="Wins"         v={fmtInt(s.wins)} cls="text-profit" />
            <KV k="Losses"       v={fmtInt(s.losses)} cls="text-loss" />
            <KV k="Breakeven"    v={fmtInt(s.breakeven)} />
            <KV k="First Trade"  v={fmtDate(s.first_time)} />
            <KV k="Last Trade"   v={fmtDate(s.last_time)} />
          </Section>

          {/* Long vs short split */}
          <div className="rounded-xl border border-line/60 overflow-hidden">
            <div className="px-3 py-2 text-[10px] uppercase tracking-widest text-muted border-b border-line/60">
              Long vs Short
            </div>
            <table className="w-full text-xs font-mono">
              <thead className="text-[10px] uppercase tracking-wider text-muted bg-bg-elev/40">
                <tr>
                  <th className="text-left px-3 py-2">Side</th>
                  <th className="text-right px-3 py-2">Trades</th>
                  <th className="text-right px-3 py-2">Win Rate</th>
                  <th className="text-right px-3 py-2">Wins</th>
                  <th className="text-right px-3 py-2">Losses</th>
                  <th className="text-right px-3 py-2">P&L</th>
                  <th className="text-right px-3 py-2">Avg P&L</th>
                </tr>
              </thead>
              <tbody>
                <SideRow label="Long"  d={long} />
                <SideRow label="Short" d={short} />
              </tbody>
            </table>
          </div>

          {/* Param values */}
          <div className="rounded-xl border border-line/60 bg-bg-elev/30 p-4 flex flex-col gap-2">
            <div className="text-[11px] uppercase tracking-widest text-muted">Parameters</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px] font-mono">
              {Object.entries(row.params || {}).map(([k, v]) => (
                <div key={k}
                     className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${
                       sweptNames.has(k) ? "border-accent-blue/40 bg-accent-blue/5" : "border-line/30 bg-bg/40"}`}>
                  <span className="text-muted">{k}{sweptNames.has(k) && <span className="text-accent-blue"> *</span>}</span>
                  <span className="text-text">{fmtParam(v)}</span>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-muted/70">
              <span className="text-accent-blue">*</span> swept in this grid · others fixed across all combos
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SideRow({ label, d }) {
  const pnl = Number(d?.pnl_dollars);
  return (
    <tr className="border-t border-line/40">
      <td className="px-3 py-2 text-text">{label}</td>
      <td className="px-3 py-2 text-right">{fmtInt(d?.trades)}</td>
      <td className="px-3 py-2 text-right">{`${fmtNum((d?.win_rate ?? 0) * 100)}%`}</td>
      <td className="px-3 py-2 text-right text-profit">{fmtInt(d?.wins)}</td>
      <td className="px-3 py-2 text-right text-loss">{fmtInt(d?.losses)}</td>
      <td className={`px-3 py-2 text-right ${pnl >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(d?.pnl_dollars)}</td>
      <td className={`px-3 py-2 text-right ${Number(d?.avg_pnl_dollars) >= 0 ? "text-profit" : "text-loss"}`}>{fmtUsd(d?.avg_pnl_dollars)}</td>
    </tr>
  );
}

function Section({ title, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] uppercase tracking-widest text-muted">{title}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono">{children}</div>
    </div>
  );
}

function Stat({ label, value, cls = "text-text", sub }) {
  return (
    <div className="flex-1 min-w-[120px]">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono text-lg ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted/70 font-mono">{sub}</div>}
    </div>
  );
}

function KV({ k, v, cls = "text-text" }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-line/30 bg-bg/40 px-2 py-1">
      <span className="text-muted text-[10px] uppercase">{k}</span>
      <span className={cls}>{v}</span>
    </div>
  );
}

function fmtParam(v) {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? fmtInt(v) : fmtNum(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
