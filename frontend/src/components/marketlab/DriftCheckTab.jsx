import { useEffect, useMemo, useState } from "react";
import { KpiCard, Section } from "../analytics/primitives.jsx";
import { MultiLineChart, VBarChart } from "./charts.jsx";
import { marketLabDriftCheck, marketLabDriftUniverse, marketLabDriftOpenHoldout } from "../../services/api.js";
import { usePersistentState } from "../../services/usePersistentState.js";
import { fmtNum, fmtPct, fmtInt, fmtDateLong } from "../../services/format.js";

// Drift Check — when a coin pulls away from BTC, does the gap keep growing?
// Research data only: the sealed months (from Nov 06, 2025) never enter these
// numbers, and open once per anchor + timeframe. services/drift_check.py has the math.

export const DRIFT_DEFAULTS = {
  window_days: 30, entry_z: 2, cooldown_hours: 24, min_events: 10,
  fee_pct: 0, slippage_bps: 0, coins: "",
};

const NUM_FIELDS = [
  ["window_days", "Window (days)", 1, "How much recent history measures the normal gap between the coin and the anchor."],
  ["entry_z", "Drift z", 0.1, "How unusual the gap must get to count as a drift: this many normal-sized gaps away from average."],
  ["cooldown_hours", "Cooldown (h)", 1, "After a drift is counted, ignore the same direction for this long, so one long drift counts once."],
  ["min_events", "Min events", 1, "A coin needs at least this many drifts to get its own result."],
  ["fee_pct", "Fee % / side", 0.01, "Only affects the equity line. 0 = no fees."],
  ["slippage_bps", "Slippage bp", 0.5, "Only affects the equity line. 1bp = 0.01%. 0 = none."],
];

const DIR_LABEL = { up: "Pulls ahead", dn: "Falls behind", both: "Both" };
const MODE_LABEL = { hedged: "Hedged (coin vs anchor)", coin: "Coin only" };
const TONE = {
  profit: "border-profit/40 bg-profit/5 text-profit",
  amber: "border-amber-400/40 bg-amber-400/5 text-amber-400",
  loss: "border-loss/40 bg-loss/5 text-loss",
};

function Panel({ title, hint, children }) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <Section title={title} hint={hint}>{children}</Section>
    </section>
  );
}

const selCls = "px-2.5 py-1.5 text-sm font-mono rounded-md border border-line bg-bg-panel text-text focus:outline-none focus:border-accent-blue cursor-pointer";

export default function DriftCheckTab({ datasets = [] }) {
  const [anchor, setAnchor] = usePersistentState("ql.mlab.drift.anchor", "BTCUSDT");
  const [timeframe, setTimeframe] = usePersistentState("ql.mlab.drift.tf", "1h");
  const [saved, setParams] = usePersistentState("ql.mlab.drift.params", DRIFT_DEFAULTS);
  const [universe, setUniverse] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const p = { ...DRIFT_DEFAULTS, ...saved };
  const set = (k, v) => setParams({ ...p, [k]: v });
  const anchors = useMemo(
    () => [...new Set(datasets.filter((d) => d.broker === "binance" && ["5m", "15m", "1h"].includes(d.timeframe)).map((d) => d.symbol))].sort(),
    [datasets],
  );

  const refreshUniverse = () =>
    marketLabDriftUniverse({ anchor, timeframe }).then(setUniverse).catch(() => setUniverse(null));
  useEffect(() => { setData(null); refreshUniverse(); }, [anchor, timeframe]);   // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => ({ anchor, timeframe, params: { ...p, coins: p.coins } });

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setData(await marketLabDriftCheck(body()));
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  const holdout = data?.holdout || universe?.holdout;
  const nCoins = p.coins.trim() ? p.coins.split(",").filter((s) => s.trim()).length : universe?.coins?.length;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">Anchor</span>
            <select value={anchor} onChange={(e) => setAnchor(e.target.value)} className={selCls}>
              {!anchors.includes(anchor) && <option value={anchor}>{anchor}</option>}
              {anchors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">Timeframe</span>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className={selCls}>
              <option value="5m">5m</option>
              <option value="1h">1h</option>
            </select>
          </label>
          <label className="flex items-center gap-2 flex-1 min-w-[260px]">
            <span className="text-xs uppercase tracking-wider text-muted whitespace-nowrap">Only these coins</span>
            <input value={p.coins} onChange={(e) => set("coins", e.target.value.toUpperCase())}
              placeholder={`blank = all ${universe?.coins?.length ?? "…"} coins with ${timeframe} data`}
              className="flex-1 px-2 py-1.5 rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue" />
          </label>
          <button onClick={run} disabled={loading}
            className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-medium shadow disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? "Running…" : "Run Drift Check"}
          </button>
        </div>
        <div className="text-[11px] text-muted">
          Each coin is measured against {anchor}. {nCoins != null ? `${fmtInt(nCoins)} coins` : ""}
          {timeframe === "5m" ? " · 5m over many years takes a minute or two." : " · 1h is built from 15m where needed; takes about a minute."}
        </div>
      </section>

      {holdout && <SealBanner holdout={holdout} anchor={anchor} timeframe={timeframe} />}

      <Settings p={p} set={set} onReset={() => setParams(DRIFT_DEFAULTS)} />

      {error && <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>}

      {!data ? (
        <div className="rounded-xl border border-line bg-bg-panel/40 p-10 text-center text-sm text-muted">
          {loading ? "Measuring every coin… this can take a minute or two." : "Click Run Drift Check."}
        </div>
      ) : (
        <>
          <div className="text-lg font-semibold">Research data</div>
          <Result r={data.research} meta={data.meta} anchor={anchor} />
          <HoldoutPanel holdout={data.holdout} anchor={anchor} timeframe={timeframe} body={body}
            onOpened={(rec) => setData({ ...data, holdout: { ...data.holdout, opened: rec } })} />
          <p className="text-[11px] text-muted">{data.meta.caveat}</p>
        </>
      )}
    </div>
  );
}

function SealBanner({ holdout, anchor, timeframe }) {
  const opened = holdout.opened;
  return (
    <div className={`rounded-xl border p-3 text-xs ${opened ? "border-amber-400/40 bg-amber-400/5" : "border-accent-blue/40 bg-accent-blue/5"}`}>
      {opened ? (
        <span className="text-amber-400">
          The {anchor} {timeframe} holdout was opened on {fmtDateLong(opened.opened_at)}. Its result is frozen below the
          research results; changing settings here only changes the research part.
        </span>
      ) : (
        <span className="text-text/90">
          🔒 Sealed: everything from {fmtDateLong(holdout.sealed_from)} to today. Nothing on this page uses those
          months until you open the holdout, once, at the bottom.
        </span>
      )}
    </div>
  );
}

function Settings({ p, set, onReset }) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">Drift Check settings</div>
        <button onClick={onReset} className="text-[11px] text-muted hover:text-text underline underline-offset-2">reset</button>
      </div>
      <div className="flex flex-wrap gap-4">
        {NUM_FIELDS.map(([k, label, step, help]) => (
          <label key={k} className="flex items-center gap-2" title={help}>
            <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
            <input type="number" step={step} value={p[k] ?? ""}
              onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) set(k, n); }}
              className="w-20 px-2 py-1.5 text-right rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue" />
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted">
        Hover a setting for what it does. Every change you try is another look at the same research data, so
        decide what you want to test before you test it.
      </p>
    </section>
  );
}

export function Result({ r, anchor, frozen = false }) {
  const [h, setH] = useState(r.headline);
  const [mode, setMode] = useState("hedged");
  const cell = r.cells[h]?.hedged?.both;
  const fromAnchor = r.cells[h]?.anchor?.both;
  const head = r.cells[r.headline].hedged.both;
  const sorted = [...r.coins].filter((c) => c.hedged_both_pct != null).sort((a, b) => b.hedged_both_pct - a.hedged_both_pct);
  const eq = r.equity[h];

  return (
    <div className="space-y-5">
      <div className={`rounded-xl border p-4 ${TONE[r.verdict.tone]}`}>
        <div className="text-[10px] uppercase tracking-wider opacity-70">
          {frozen ? "Holdout verdict (frozen)" : "Does the drift keep going?"} · headline test: 1 day, both directions, hedged
        </div>
        <div className="text-base font-semibold mt-0.5">{r.verdict.label}</div>
        <div className="text-sm mt-1 text-text/90">{r.verdict.text}</div>
        <div className="text-[11px] text-muted mt-2">
          {fmtInt(r.coins_used)} coins · {fmtDateLong(r.first_time)} – {fmtDateLong(r.last_time)} ·{" "}
          {fmtInt(head.events)} drifts counted at 1 day
          {r.skipped?.length ? ` · ${fmtInt(r.skipped.length)} coins skipped (too little history)` : ""}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Look</span>
        {r.horizons.map((k) => (
          <button key={k} onClick={() => setH(k)}
            className={`px-3 py-1 rounded-md text-xs border ${h === k ? "border-accent-blue text-text bg-accent-blue/10" : "border-line text-muted hover:text-text"}`}>
            {k} later{k === r.headline ? " ★" : ""}
          </button>
        ))}
      </div>

      {cell && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard title={`Extra move after a drift (${h})`} value={fmtPct(cell.avg_coin_edge_pct)}
            sub="hedged, vs a random moment" positive={cell.avg_coin_edge_pct == null ? null : cell.avg_coin_edge_pct > 0} />
          <KpiCard title="t-stat, week by week" value={fmtNum(cell.t_weeks)}
            sub={`the honest one · coin by coin ${fmtNum(cell.t_coins)}`}
            positive={cell.t_weeks == null ? null : cell.t_weeks >= 3 ? true : cell.t_weeks <= -3 ? false : null} />
          <KpiCard title="Weeks where it kept going" value={fmtPct(cell.weeks_positive_pct, false)}
            sub={`of ${fmtInt(cell.weeks)} weeks · luck ≈ 50%`} />
          <KpiCard title="Coins where it kept going" value={`${fmtInt(cell.coins_positive)} of ${fmtInt(cell.coins)}`}
            sub={`${fmtPct(cell.breadth_pct, false)} · luck ≈ 50%`} />
          <KpiCard title={`Came from ${anchor}'s own move`} value={fmtPct(fromAnchor?.avg_event_edge_pct)}
            sub={`of ${fmtPct(cell.avg_event_edge_pct)} per drift`} />
        </div>
      )}
      <p className="text-[11px] text-muted -mt-2">
        Why week by week: one big {anchor} move makes dozens of coins drift on the same day, and they all share that
        move. Coin by coin, that looks like dozens of separate wins. Week by week, it counts once. Trust the
        week-by-week t-stat; above 3 is hard to get by luck.
      </p>

      <Panel title="Every cell at a glance"
        hint={`Extra move after a drift vs a random moment, averaged over coins; in brackets, the week-by-week t-stat. + = the drift kept going, − = it snapped back. ★ is the test chosen in advance; the other cells are exploration and carry more luck.`}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-muted text-[10px] uppercase tracking-wider">
                <th className="text-left font-normal py-1">Later</th>
                {["up", "dn", "both"].map((d) => <th key={d} className="text-right font-normal">{DIR_LABEL[d]} · hedged</th>)}
                <th className="text-right font-normal">Both · coin only</th>
              </tr>
            </thead>
            <tbody>
              {r.horizons.map((k) => (
                <tr key={k} className={`border-t border-line/50 ${k === h ? "bg-accent-blue/5" : ""}`}>
                  <td className="py-1.5 font-sans">{k}{k === r.headline ? " ★" : ""}</td>
                  {[["hedged", "up"], ["hedged", "dn"], ["hedged", "both"], ["coin", "both"]].map(([m, d]) => {
                    const c = r.cells[k][m][d];
                    return (
                      <td key={m + d} className={`text-right ${(c.avg_coin_edge_pct ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>
                        {fmtPct(c.avg_coin_edge_pct)} <span className="text-muted">(t {fmtNum(c.t_weeks)})</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted">Measure</span>
        {["hedged", "coin"].map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-3 py-1 rounded-md text-xs border ${mode === m ? "border-accent-blue text-text bg-accent-blue/10" : "border-line text-muted hover:text-text"}`}>
            {MODE_LABEL[m]}
          </button>
        ))}
        <span className="text-[11px] text-muted ml-2">
          Hedged = buy the coin and sell {anchor} (or the reverse), so only the gap counts. Coin only = just the coin.
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Panel title={`Year by year · ${h} later`}
          hint="Average extra move per drift, by the year the drift happened. A real effect should be green in most years, not carried by one.">
          <VBarChart height={200} colorMode="sign" yLabel="%" fmt={(v) => fmtNum(v)}
            bars={(r.years[h]?.[mode] || []).map((y) => ({ label: String(y.year), value: y.avg_edge_pct, n: y.events }))} />
        </Panel>
        <Panel title={`Equity line · follow every drift, hold ${h}`}
          hint={`An equal-weight basket: each coin gets the same slice of capital and trades every one of its drifts. In % of starting capital, not compounded.${r.has_costs ? ` Costs ${fmtPct(r.cost_round_trip_pct, false)} per side pair.` : " No costs."}`}>
          <MultiLineChart height={200} yLabel="% of capital" fmt={(v) => fmtNum(v)}
            hLines={[{ value: 0, color: "#475569", dashed: false }]}
            series={[
              ...(r.has_costs ? [{ label: `${MODE_LABEL[mode]}, before costs`, points: eq[mode].gross, color: "#22c55e", opacity: 0.5 }] : []),
              { label: r.has_costs ? `${MODE_LABEL[mode]}, after costs` : MODE_LABEL[mode], points: eq[mode].net, color: "#60a5fa", width: 2 },
            ]} />
        </Panel>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <CoinList title="Strongest drift continuation · 1 day, hedged" rows={sorted.slice(0, 10)} />
        <CoinList title="Strongest snap-back · 1 day, hedged" rows={sorted.slice(-10).reverse()} />
      </div>
      <p className="text-[11px] text-muted">
        With this many coins, the top and bottom of a list are partly luck. A coin standing out here is a reason to
        look, not a result.
      </p>
    </div>
  );
}

function CoinList({ title, rows }) {
  return (
    <Panel title={title}>
      <ul className="space-y-1 text-xs font-mono">
        {rows.map((c) => (
          <li key={c.symbol} className="flex justify-between gap-3">
            <span className="text-text">{c.symbol}</span>
            <span className="text-muted">
              <span className={c.hedged_both_pct >= 0 ? "text-profit" : "text-loss"}>{fmtPct(c.hedged_both_pct)}</span>
              {" "}· {fmtInt(c.events_up + c.events_dn)} drifts
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function HoldoutPanel({ holdout, anchor, timeframe, body, onOpened }) {
  const [typed, setTyped] = useState("");
  const [opening, setOpening] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState(null);
  const rec = holdout?.opened;

  async function open() {
    setOpening(true);
    setError(null);
    try {
      onOpened(await marketLabDriftOpenHoldout({ ...body(), confirm: typed }));
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setOpening(false);
    }
  }

  if (rec) {
    const s = rec.settings;
    return (
      <div className="space-y-3 pt-4">
        <div className="text-lg font-semibold">Holdout · opened {fmtDateLong(rec.opened_at)}</div>
        <p className="text-xs text-muted">
          Frozen with the settings used that day: window {fmtNum(s.window_days)} days, drift z {fmtNum(s.entry_z)},
          cooldown {fmtNum(s.cooldown_hours)} h, min events {fmtInt(s.min_events)}, {fmtInt(s.coins.length)} coins.
          It can't be re-run, so this is the only untouched test this idea gets.
        </p>
        <Result r={rec.result} anchor={anchor} frozen />
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-5 space-y-3">
      <div className="text-sm font-semibold text-amber-400">🔒 Holdout · {anchor} {timeframe}</div>
      <p className="text-xs text-text/90">
        The months from {fmtDateLong(holdout?.sealed_from)} on are sealed. Open them only when you've decided the
        rules and won't change them again. It runs once, with the settings above, and the result is frozen. After
        that there's no untouched data left for this idea on {timeframe}.
      </p>
      {!askOpen ? (
        <button onClick={() => setAskOpen(true)}
          className="px-3 py-1.5 rounded-md border border-amber-400/50 text-amber-400 text-xs hover:bg-amber-400/10">
          Open holdout…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted">Type OPEN to confirm:</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)}
            className="w-24 px-2 py-1.5 rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-amber-400" />
          <button onClick={open} disabled={typed !== "OPEN" || opening}
            className="px-3 py-1.5 rounded-md bg-amber-500/80 text-black text-xs font-semibold disabled:opacity-40">
            {opening ? "Running the holdout…" : "Open it, once"}
          </button>
          <button onClick={() => { setAskOpen(false); setTyped(""); }} className="text-xs text-muted underline">cancel</button>
        </div>
      )}
      {error && <div className="text-xs text-loss">{error}</div>}
    </section>
  );
}
