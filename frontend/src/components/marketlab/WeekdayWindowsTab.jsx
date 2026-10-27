import { useEffect, useMemo, useState } from "react";
import { KpiCard, Section } from "../analytics/primitives.jsx";
import { VBarChart, LineChart } from "./charts.jsx";
import { fmtNum, fmtPct, fmtInt, fmtDateLong } from "../../services/format.js";

// Weekday Windows — every entry-day → exit-day window (7×7) at fixed UTC hours.
// Cells are in-sample only; click one to see how it did in the held-out months,
// year by year, and against plain drift. Same fills as Weekday Swing V2 (filter off).

const MIN_TRADES = 20;

function cellKey(c) { return `${c.entry_day}-${c.exit_day}`; }

function Panel({ title, hint, children }) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <Section title={title} hint={hint}>{children}</Section>
    </section>
  );
}

export default function WeekdayWindowsTab({ data, loading }) {
  const [side, setSide] = useState("long");
  const [selected, setSelected] = useState(null);

  const cells = data?.sides?.[side] || [];
  const luck = data?.luck_t ?? 3.3;
  const score = (c) => (c.is.n >= MIN_TRADES ? c.is.t_vs_drift ?? -99 : -99);

  // Default selection: the strongest in-sample cell for this side.
  useEffect(() => {
    if (!cells.length) return;
    if (!selected || !cells.some((c) => cellKey(c) === selected)) {
      setSelected(cellKey([...cells].sort((a, b) => score(b) - score(a))[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, side]);

  const maxAbs = useMemo(() => {
    const v = cells.filter((c) => c.is.n >= MIN_TRADES && c.is.avg_net_pct != null).map((c) => Math.abs(c.is.avg_net_pct));
    return v.length ? Math.max(...v) : 1;
  }, [cells]);

  if (!data) {
    return (
      <div className="rounded-xl border border-line bg-bg-panel/40 p-10 text-center text-sm text-muted">
        {loading ? "Computing…" : "Pick a symbol (1h or lower) and click Run Analysis."}
      </div>
    );
  }

  const days = data.days || [];
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  const m = data.meta?.method || {};
  const sel = cells.find((c) => cellKey(c) === selected);
  const splitLabel = fmtDateLong(data.split_time);

  const colorOf = (c) => {
    if (c.is.n < MIN_TRADES || c.is.avg_net_pct == null) return "rgba(148,163,184,0.06)";
    const a = Math.min(1, Math.abs(c.is.avg_net_pct) / (maxAbs || 1));
    return c.is.avg_net_pct >= 0 ? `rgba(34,197,94,${0.1 + 0.6 * a})` : `rgba(239,68,68,${0.1 + 0.6 * a})`;
  };
  const markOf = (c) => {
    const t = c.is.t_vs_drift;
    if (t == null || c.is.n < MIN_TRADES) return "";
    return t >= luck ? " ●" : t >= 2 ? " ○" : "";
  };

  return (
    <div className="space-y-5">
      <Panel
        title={`Entry day → exit day · ${hh(m.entry_hour ?? 0)} → ${hh(m.exit_hour ?? 0)} UTC · in-sample until ${splitLabel}`}
        hint={`Each cell = average NET % per trade (after ${fmtPct(data.cost_pct, false)} round-trip costs), in-sample only. ● beats plain drift by more than luck allows for ${data.n_windows} windows (t ≥ ${fmtNum(luck)}); ○ t ≥ 2 — worth a look, could be luck. Click a cell.`}
      >
        <div className="flex items-center gap-2">
          {["long", "short"].map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className={`px-3 py-1 rounded-md text-xs border ${side === s
                ? "border-accent-blue text-text bg-accent-blue/10" : "border-line text-muted hover:text-text"}`}>
              {s === "long" ? "Long" : "Short"}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="text-[11px] font-mono border-separate" style={{ borderSpacing: "3px" }}>
            <thead>
              <tr>
                <th className="text-muted text-right pr-2 font-normal">entry ＼ exit</th>
                {days.map((d) => <th key={d} className="text-muted text-center font-normal w-20">{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {days.map((d, ei) => (
                <tr key={d}>
                  <td className="text-muted text-right pr-2">{d}</td>
                  {cells.filter((c) => c.entry_day === ei + 1).map((c) => {
                    const active = cellKey(c) === selected;
                    return (
                      <td key={cellKey(c)} onClick={() => setSelected(cellKey(c))}
                        className={`w-20 h-9 text-center rounded-sm cursor-pointer text-text/90 ${active ? "ring-2 ring-accent-blue" : ""}`}
                        style={{ background: colorOf(c) }}
                        title={`${days[c.entry_day - 1]} ${hh(m.entry_hour ?? 0)} → ${days[c.exit_day - 1]} ${hh(m.exit_hour ?? 0)} · hold ${fmtInt(c.hold_hours)} h\nin-sample ${fmtPct(c.is.avg_net_pct)} / trade · t vs drift ${fmtNum(c.is.t_vs_drift)} · n=${fmtInt(c.is.n)}`}>
                        {c.is.n < MIN_TRADES || c.is.avg_net_pct == null ? "·" : fmtPct(c.is.avg_net_pct)}{markOf(c)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {sel && <WindowDetail cell={sel} side={side} days={days} m={m} luck={luck} splitLabel={splitLabel} hh={hh} />}

      <p className="text-[11px] text-muted">{data.meta?.caveat}</p>
    </div>
  );
}

function WindowDetail({ cell, side, days, m, luck, splitLabel, hh }) {
  const { is, oos } = cell;
  const greenYears = cell.years.filter((y) => (y.sum_pct ?? 0) > 0).length;
  const checks = [
    [is.t_vs_drift != null && is.t_vs_drift >= luck,
      `Beats plain drift by more than luck (t vs drift ${fmtNum(is.t_vs_drift)}, needs ${fmtNum(luck)})`],
    [cell.years.length > 0 && greenYears / cell.years.length >= 0.7,
      `Green in most years (${greenYears} of ${cell.years.length})`],
    [oos.n >= 10 && (oos.avg_net_pct ?? 0) > 0,
      oos.n ? `Still profitable after ${splitLabel} (${fmtPct(oos.avg_net_pct)} / trade on ${fmtInt(oos.n)} trades)` : "No held-out trades"],
  ];
  const label = `${days[cell.entry_day - 1]} ${hh(m.entry_hour ?? 0)} → ${days[cell.exit_day - 1]} ${hh(m.exit_hour ?? 0)} UTC`;
  const sideKey = side === "long" ? "long" : "short";

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="In-sample / trade" value={fmtPct(is.avg_net_pct)}
          sub={`${fmtInt(is.n)} trades · win ${fmtPct(is.win_rate, false)}`} positive={is.avg_net_pct == null ? null : is.avg_net_pct > 0} />
        <KpiCard title="Out-of-sample / trade" value={fmtPct(oos.avg_net_pct)}
          sub={`${fmtInt(oos.n)} trades · win ${fmtPct(oos.win_rate, false)}`} positive={oos.avg_net_pct == null ? null : oos.avg_net_pct > 0} />
        <KpiCard title="Drift (just holding)" value={fmtPct(is.drift_pct)}
          sub={`out-of-sample ${fmtPct(oos.drift_pct)}`} />
        <KpiCard title="t vs drift (in-sample)" value={fmtNum(is.t_vs_drift)}
          sub={`profit factor ${fmtNum(is.profit_factor)}`} positive={is.t_vs_drift == null ? null : is.t_vs_drift >= luck} />
      </div>

      <Panel title={`${label} · ${side} · hold ${fmtInt(cell.hold_hours)} h`}
        hint="The three things a real pattern should pass. Green = passed.">
        <ul className="space-y-1 text-sm">
          {checks.map(([ok, text], i) => (
            <li key={i} className={ok ? "text-profit" : "text-loss"}>{ok ? "✓" : "✗"} {text}</li>
          ))}
        </ul>
        <p className="text-[11px] text-muted font-mono">
          Weekday Swing V2: sides {sideKey} · {sideKey}_entry_day {cell.entry_day} · {sideKey}_entry_hour {m.entry_hour ?? 0} ·{" "}
          {sideKey}_exit_day {cell.exit_day} · {sideKey}_exit_hour {m.exit_hour ?? 0} · trend filter off
        </p>
      </Panel>

      <div className="grid md:grid-cols-2 gap-5">
        <Panel title="Net % by year" hint="Sum of per-trade net % in each year. * = year includes held-out months.">
          <VBarChart bars={cell.years.map((y) => ({ label: `${y.year}${y.has_oos ? "*" : ""}`, value: y.sum_pct, n: y.n }))}
                     colorMode="sign" height={200} yLabel="net %" fmt={(x) => fmtNum(x)} />
        </Panel>
        <Panel title="Cumulative net %" hint={`Per-trade net % added up (no compounding, sizing-free). Held out from ${splitLabel}.`}>
          <LineChart points={cell.equity} height={200} color="#60a5fa" yLabel="net %" fmt={(x) => fmtNum(x)} />
        </Panel>
      </div>
    </div>
  );
}
