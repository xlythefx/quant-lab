import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import EquityCurve from "./EquityCurve.jsx";
import { useEnterStagger, useDrawProgress } from "./animations.js";
import { getLiveAnalytics, getLiveJournal, getDeploymentExpectation, getLiveClosedPositions } from "./liveApi.js";
import { onLiveSignal, onAlertDispatched } from "./liveChannels.js";
import { fmtUsd, fmtNum, fmtPct, fmtInt, fmtRatio } from "../../services/format.js";

const PERIODS = ["7D", "30D", "ALL"];
const GROUPS = [["strategy", "STRATEGY"], ["symbol", "ASSET"], ["account", "ACCOUNT"]];

function Card({ label, value, sub, tone }) {
  return (
    <div style={{ background: "var(--lt-panel)", padding: "11px 13px" }}>
      <div className="lt-mono lt-muted" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
      <div className={`lt-mono ${tone || ""}`} style={{ fontSize: 17, fontWeight: 700, margin: "3px 0 2px" }}>{value}</div>
      {sub && <div className="lt-mono lt-dim" style={{ fontSize: 8.5 }}>{sub}</div>}
    </div>
  );
}

function holdLabel(min) {
  if (min == null) return "—";
  if (min < 90) return `${fmtNum(min)}m`;
  if (min < 60 * 36) return `${fmtNum(min / 60)}h`;
  return `${fmtNum(min / 1440)}d`;
}

/**
 * ANALYTICS workspace — live journal through the backtest engine's stats:
 * 8 stat cards, cumulative equity curve (progressive draw), breakdown with
 * drill-down, and a live-vs-expectation compare per deployment.
 */
export default function AnalyticsWorkspace({ deployments = [], account = "demo" }) {
  const ref = useRef(null);
  useEnterStagger("analytics", ref);
  const [period, setPeriod] = useState("ALL");
  const [group, setGroup] = useState("strategy");
  const [filter, setFilter] = useState(null); // {key, value, label}
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const progress = useDrawProgress(`${period}|${group}|${filter?.value || ""}`);

  const refresh = useCallback(() => {
    getLiveAnalytics({
      period, group,
      filter_key: filter?.key, filter_value: filter?.value,
    }).then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e?.response?.data?.error || e.message));
  }, [period, group, filter]);

  useEffect(() => {
    refresh();
    const offs = [onLiveSignal(refresh), onAlertDispatched(refresh)];
    return () => offs.forEach((f) => f());
  }, [refresh]);

  const s = data?.stats;
  const pf = s?.profit_factor;
  const cards = s ? [
    { label: "Net P&L (est)", value: `${s.total_return_dollars >= 0 ? "+" : ""}${fmtUsd(s.total_return_dollars)}`, sub: `${fmtInt(s.trades)} trades`, tone: s.total_return_dollars >= 0 ? "lt-green" : "lt-red" },
    { label: "Win Rate", value: fmtPct(s.win_rate * 100, false), sub: `${fmtInt(s.wins)}W / ${fmtInt(s.losses)}L`, tone: s.win_rate >= 0.5 ? "lt-green" : "lt-amber" },
    { label: "Profit Factor", value: pf == null ? "∞" : fmtRatio(pf), sub: "gross win / gross loss", tone: pf == null || pf >= 1.4 ? "lt-green" : pf >= 1 ? "lt-amber" : "lt-red" },
    { label: "Sharpe", value: s.sharpe == null ? "—" : fmtRatio(s.sharpe), sub: "trade-exit series, annualized", tone: s.sharpe == null ? "" : s.sharpe >= 1 ? "lt-green" : "lt-amber" },
    { label: "Max Drawdown", value: fmtPct(s.max_drawdown_pct_peak, false), sub: fmtUsd(s.max_drawdown_dollars), tone: s.max_drawdown_pct_peak > -12 ? "lt-green" : "lt-red" },
    { label: "Expectancy", value: `${s.expectancy_usd >= 0 ? "+" : ""}${fmtUsd(s.expectancy_usd)}`, sub: s.expectancy_r != null ? `${fmtRatio(s.expectancy_r)} R avg` : "avg / trade (est $)", tone: s.expectancy_usd >= 0 ? "lt-green" : "lt-red" },
    { label: "Avg Hold", value: holdLabel(s.avg_hold_min), sub: "entry → exit" },
    { label: "Trades", value: fmtInt(s.trades), sub: `${data.period} · ${filter ? filter.label : "all"}` },
  ] : [];

  return (
    <div ref={ref} className="lt-ws" style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--lt-border)", overflow: "auto" }}>
      {/* Header row: period + filter chip */}
      <div style={{ background: "var(--lt-chrome)", padding: "7px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <span className="lt-panel-title">Analytics · Performance (live journal)</span>
        {filter && (
          <button className="lt-btn small amber" onClick={() => setFilter(null)} title="Clear drill-down filter">
            {filter.label} ✕
          </button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
          {PERIODS.map((p) => (
            <button key={p} className="lt-mono" onClick={() => setPeriod(p)}
              style={{ background: p === period ? "var(--lt-border)" : "none", border: "none", color: p === period ? "#fff" : "var(--lt-muted)", fontSize: 9.5, fontWeight: 700, padding: "3px 9px", cursor: "pointer" }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="lt-warn-banner" style={{ position: "static" }}>⚠ {err}</div>}

      {/* 8 stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 1 }}>
        {cards.length
          ? cards.map((c) => <Card key={c.label} {...c} />)
          : Array.from({ length: 8 }, (_, i) => <Card key={i} label="…" value="—" />)}
      </div>

      {/* Equity curve */}
      <Panel title="Cumulative Equity (realized, est $)" style={{ flex: "none" }}>
        <div style={{ padding: "8px 6px" }}>
          <EquityCurve curve={data?.curve || []} baseline={s?.starting_capital ?? 0} progress={progress} height={170} />
        </div>
      </Panel>

      {/* Breakdown */}
      <Panel
        title="Breakdown"
        right={
          <div style={{ display: "flex", gap: 2 }}>
            {GROUPS.map(([id, label]) => (
              <button key={id} className="lt-mono" onClick={() => { setGroup(id); setFilter(null); }}
                style={{ background: id === group ? "var(--lt-border)" : "none", border: "none", color: id === group ? "#fff" : "var(--lt-muted)", fontSize: 9, fontWeight: 700, padding: "2px 8px", cursor: "pointer" }}>
                {label}
              </button>
            ))}
          </div>
        }
        style={{ flex: "none" }}
      >
        {(data?.breakdown || []).length === 0 ? (
          <div className="lt-empty">No realized trades in this window</div>
        ) : (
          <table className="lt-table">
            <thead>
              <tr><th>{GROUPS.find(([id]) => id === group)?.[1]}</th><th className="num">NET</th><th className="num">WIN%</th><th className="num">PF</th><th className="num">EXP/TRADE</th><th className="num">N</th></tr>
            </thead>
            <tbody>
              {data.breakdown.map((b) => (
                <tr key={b.key} style={{ cursor: "pointer" }} title="Click to drill down"
                    onClick={() => setFilter(filter?.value === b.key ? null : { key: group, value: b.key, label: b.label })}>
                  <td style={{ fontWeight: 600 }} className={filter?.value === b.key ? "lt-amber" : ""}>{b.label}</td>
                  <td className={`num ${b.net >= 0 ? "lt-green" : "lt-red"}`}>{b.net >= 0 ? "+" : ""}{fmtUsd(b.net)}</td>
                  <td className="num">{fmtPct(b.win, false)}</td>
                  <td className="num">{b.pf == null ? "∞" : fmtRatio(b.pf)}</td>
                  <td className={`num ${b.exp >= 0 ? "lt-green" : "lt-red"}`}>{fmtUsd(b.exp)}</td>
                  <td className="num lt-muted">{fmtInt(b.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {/* Live vs expectation */}
      <ExpectationCompare deployments={deployments} account={account} />
    </div>
  );
}

function ExpectationCompare({ deployments, account }) {
  const [sel, setSel] = useState("");
  const [expected, setExpected] = useState(null);
  const [liveStats, setLiveStats] = useState(null);
  const [broker, setBroker] = useState(null); // broker ACTUALS from WAMP
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const dep = useMemo(() => deployments.find((d) => d.name === sel), [deployments, sel]);

  const run = async () => {
    if (!dep) return;
    setBusy(true); setErr(null); setExpected(null); setLiveStats(null); setBroker(null);
    try {
      const [expRes, rows, closedRes] = await Promise.all([
        getDeploymentExpectation(dep.name),
        getLiveJournal({}),
        getLiveClosedPositions(account, 300).catch(() => null),
      ]);
      if (!expRes.ok) throw new Error(expRes.error || "expectation failed");
      setExpected(expRes.expected);
      const mine = rows.filter((r) => r.rule_name === dep.name);
      const wins = mine.filter((r) => (r.pnl_usd || 0) > 0).length;
      const gp = mine.reduce((s, r) => s + Math.max(0, r.pnl_usd || 0), 0);
      const gl = -mine.reduce((s, r) => s + Math.min(0, r.pnl_usd || 0), 0);
      setLiveStats({
        n: mine.length,
        win_rate: mine.length ? wins / mine.length : null,
        avg_pnl_pct: mine.length ? mine.reduce((s, r) => s + (r.pnl_pct || 0), 0) / mine.length : null,
        profit_factor: gl > 0 ? gp / gl : (gp > 0 ? null : 0),
      });
      // Broker ACTUAL realized P&L (WAMP *_pastpositions, matched by the
      // strategy alias the webhook sends) — the ground truth over our estimate.
      if (closedRes?.ok) {
        const actual = (closedRes.rows || []).filter(
          (c) => (c.strategy || "").toLowerCase() === (dep.strategy_alias || "").toLowerCase()
              && c.symbol?.toUpperCase() === dep.symbol?.toUpperCase());
        if (actual.length) {
          const awins = actual.filter((c) => (c.realized_pnl || 0) > 0).length;
          setBroker({
            n: actual.length,
            win_rate: awins / actual.length,
            net: actual.reduce((s, c) => s + (c.realized_pnl || 0), 0),
          });
        }
      }
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  const Row = ({ label, live, exp, act }) => (
    <tr>
      <td className="lt-muted">{label}</td>
      <td className="num">{live}</td>
      <td className="num lt-muted">{exp}</td>
      <td className="num lt-cyan">{act ?? "—"}</td>
    </tr>
  );

  return (
    <Panel
      title="Live vs Expectation (backtest of the same params)"
      right={
        <div style={{ display: "flex", gap: 6 }}>
          <select className="lt-select" style={{ minWidth: 180 }} value={sel} onChange={(e) => setSel(e.target.value)}>
            <option value="">— pick deployment —</option>
            {deployments.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
          <button className="lt-btn small cyan" disabled={!dep || busy} onClick={run}>{busy ? "RUNNING…" : "COMPARE"}</button>
        </div>
      }
      style={{ flex: "none" }}
    >
      {err && <div className="lt-warn-banner" style={{ position: "static" }}>⚠ {err}</div>}
      {!expected ? (
        <div className="lt-empty">
          Pick a deployment and COMPARE — runs the same strategy + params through the backtest engine
          and puts it next to the live results, so you can see whether reality is tracking the test.
          The BROKER column is the ACTUAL realized P&L from WAMP when trades match by alias.
        </div>
      ) : (
        <table className="lt-table" style={{ maxWidth: 680 }}>
          <thead>
            <tr>
              <th>METRIC</th>
              <th className="num">LIVE EST ({liveStats?.n ?? 0} trades)</th>
              <th className="num">BACKTEST ({fmtInt(expected.trades)} trades)</th>
              <th className="num">BROKER ACTUAL {broker ? `(${broker.n})` : ""}</th>
            </tr>
          </thead>
          <tbody>
            <Row label="WIN RATE"
                 live={liveStats?.win_rate != null ? fmtPct(liveStats.win_rate * 100, false) : "—"}
                 exp={expected.win_rate != null ? fmtPct(expected.win_rate * 100, false) : "—"}
                 act={broker ? fmtPct(broker.win_rate * 100, false) : null} />
            <Row label="PROFIT FACTOR"
                 live={liveStats?.profit_factor == null ? "∞" : fmtRatio(liveStats.profit_factor)}
                 exp={expected.profit_factor == null ? "∞" : fmtRatio(expected.profit_factor)} />
            <Row label="AVG TRADE %"
                 live={liveStats?.avg_pnl_pct != null ? fmtPct(liveStats.avg_pnl_pct) : "—"}
                 exp={expected.avg_pnl_pct != null ? fmtPct(expected.avg_pnl_pct) : "—"} />
            <Row label="NET P&L"
                 live="est (journal)"
                 exp="—"
                 act={broker ? `${broker.net >= 0 ? "+" : ""}${fmtUsd(broker.net)}` : null} />
            <Row label="MAX DD (PEAK)"
                 live="— (needs more history)"
                 exp={expected.max_drawdown_pct_peak != null ? fmtPct(expected.max_drawdown_pct_peak, false) : "—"} />
          </tbody>
        </table>
      )}
    </Panel>
  );
}
