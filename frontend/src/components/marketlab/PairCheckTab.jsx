import { useMemo, useState } from "react";
import { KpiCard, Section } from "../analytics/primitives.jsx";
import DateRangePicker from "../DateRangePicker.jsx";
import { RegimeRibbon, MultiLineChart, VBarChart } from "./charts.jsx";
import { marketLabPairCheck } from "../../services/api.js";
import { usePersistentState } from "../../services/usePersistentState.js";
import { fmtNum, fmtPct, fmtInt, fmtDateLong } from "../../services/format.js";

// Pair Check — is there a "leash" between two coins? A rolling cointegration
// test, the hedge ratio, the half-life, and what trading the gap would have
// done, each shown next to a fake pair (what luck alone gives). Read-only
// research: services/pair_check.py has the math.

export const PAIR_DEFAULTS = {
  window_days: 30, test_every_hours: 24, hedge: "rolling", level: 0.05,
  use_gate: true, exit_on_fail: false,
  entry_z: 2, exit_z: 0, stop_z: 4, max_hold_days: 3,
  fee_pct: 0, slippage_bps: 0, zoom_days: 90,
};

const NUM_FIELDS = [
  ["window_days", "Window (days)", 1, "How much recent history each fit and each test uses."],
  ["test_every_hours", "Test every (h)", 1, "How often the cointegration test is re-run."],
  ["entry_z", "Entry z", 0.1, "Open a trade when the gap is this many normal-sized gaps away from its average."],
  ["exit_z", "Exit z", 0.1, "Close when the gap is back to this level. 0 = back to its average."],
  ["stop_z", "Stop z", 0.1, "Close if the gap stretches this far: the leash broke. Never opens past it."],
  ["max_hold_days", "Max hold (days)", 0.5, "Close a trade that has been open this long."],
  ["fee_pct", "Fee % / side", 0.01, "Charged on both legs, at entry and at exit. 0 = no fees."],
  ["slippage_bps", "Slippage bp", 0.5, "Price slip per fill in basis points (1bp = 0.01%). 0 = none."],
  ["zoom_days", "Zoom (days)", 1, "How many recent days the gap chart shows in detail."],
];

const TFS = ["15m", "1h"];
const USABLE = { "1h": ["1h", "15m", "5m", "1m"], "15m": ["15m", "5m", "1m"] };

const STRIP_COLORS = {
  "Fails": "#334155",
  "Passes at 10%": "#a16207",
  "Passes at 5%": "#16a34a",
  "Passes at 1%": "#4ade80",
};

const TONE = {
  profit: "border-profit/40 bg-profit/5 text-profit",
  amber: "border-amber-400/40 bg-amber-400/5 text-amber-400",
  loss: "border-loss/40 bg-loss/5 text-loss",
};

function dateStrToEpoch(s, endOfDay = false) {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0) / 1000);
}

function Panel({ title, hint, children }) {
  return (
    <section className="rounded-xl border border-line bg-bg-panel/60 p-5 space-y-3">
      <Section title={title} hint={hint}>{children}</Section>
    </section>
  );
}

function CoinSelect({ label, value, options, onChange }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}
        className="px-2.5 py-1.5 text-sm font-mono rounded-md border border-line bg-bg-panel text-text focus:outline-none focus:border-accent-blue cursor-pointer">
        {!options.includes(value) && <option value={value}>{value || "—"}</option>}
        {options.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </label>
  );
}

export default function PairCheckTab({ datasets = [] }) {
  const [pair, setPair] = usePersistentState("ql.mlab.pair", { y: "ETHUSDT", x: "BTCUSDT" });
  const [timeframe, setTimeframe] = usePersistentState("ql.mlab.pair.tf", "1h");
  const [range, setRange] = usePersistentState("ql.mlab.pair.range", { start: "", end: "" });
  const [saved, setParams] = usePersistentState("ql.mlab.pair.params", PAIR_DEFAULTS);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const p = { ...PAIR_DEFAULTS, ...saved };
  const set = (k, v) => setParams({ ...p, [k]: v });

  const coins = useMemo(
    () => [...new Set(datasets.filter((d) => USABLE["1h"].includes(d.timeframe)).map((d) => d.symbol))].sort(),
    [datasets],
  );
  const hasData = (sym) => datasets.some((d) => d.symbol === sym && USABLE[timeframe].includes(d.timeframe));
  const problem = !pair.y || !pair.x ? "Pick two coins."
    : pair.y === pair.x ? "Pick two different coins."
    : !hasData(pair.y) ? `${pair.y} has no ${timeframe} data (or finer) cached.`
    : !hasData(pair.x) ? `${pair.x} has no ${timeframe} data (or finer) cached.`
    : null;

  async function run() {
    if (problem || loading) return;
    setLoading(true);
    setError(null);
    try {
      setData(await marketLabPairCheck({
        symbol_y: pair.y, symbol_x: pair.x, timeframe,
        start_time: dateStrToEpoch(range.start),
        end_time: dateStrToEpoch(range.end, true),
        params: p,
      }));
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-line bg-bg-panel/60 p-4 space-y-2">
        <div className="flex flex-wrap items-end gap-4">
          <CoinSelect label="Coin Y" value={pair.y} options={coins} onChange={(v) => setPair({ ...pair, y: v })} />
          <button onClick={() => setPair({ y: pair.x, x: pair.y })} title="Swap the two coins"
            className="px-2 py-1.5 text-sm rounded-md border border-line text-muted hover:text-text">⇄</button>
          <CoinSelect label="vs coin X" value={pair.x} options={coins} onChange={(v) => setPair({ ...pair, x: v })} />
          <label className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">Timeframe</span>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}
              className="px-2.5 py-1.5 text-sm font-mono rounded-md border border-line bg-bg-panel text-text focus:outline-none focus:border-accent-blue cursor-pointer">
              {TFS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
          <button onClick={run} disabled={!!problem || loading}
            className="px-4 py-1.5 rounded-md bg-accent-grad text-white text-sm font-medium shadow disabled:opacity-40 disabled:cursor-not-allowed">
            {loading ? "Running…" : "Run Pair Check"}
          </button>
        </div>
        <div className="text-[11px] text-muted">
          {problem || "Leave the range empty to use every bar both coins share. 1h is built from 15m data when that reaches further back than a 1h file."}
          {(range.start || range.end) && (
            <button onClick={() => setRange({ start: "", end: "" })} className="ml-2 underline underline-offset-2 hover:text-text">use full history</button>
          )}
        </div>
      </section>

      <Settings p={p} set={set} onReset={() => setParams(PAIR_DEFAULTS)} />

      {error && (
        <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>
      )}

      {!data ? (
        <div className="rounded-xl border border-line bg-bg-panel/40 p-10 text-center text-sm text-muted">
          {loading ? "Computing… (15m over many years takes a few seconds)" : "Pick two coins and click Run Pair Check."}
        </div>
      ) : (
        <Results data={data} />
      )}
    </div>
  );
}

function Settings({ p, set, onReset }) {
  const sel = "px-2 py-1.5 rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue";
  return (
    <section className="rounded-xl border border-line bg-bg-panel/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">Pair Check settings</div>
        <button onClick={onReset} className="text-[11px] text-muted hover:text-text underline underline-offset-2">reset</button>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2" title="Rolling: the ratio is re-fitted on every bar from the window. Equal: always the same dollars in each coin (spread = Y / X).">
          <span className="text-xs uppercase tracking-wider text-muted">Hedge</span>
          <select value={p.hedge} onChange={(e) => set("hedge", e.target.value)} className={sel}>
            <option value="rolling">Rolling ratio</option>
            <option value="equal">Equal dollars</option>
          </select>
        </label>
        <label className="flex items-center gap-2" title="How sure the test must be. 5% = would wrongly pass about 1 window in 20 by luck.">
          <span className="text-xs uppercase tracking-wider text-muted">Test level</span>
          <select value={p.level} onChange={(e) => set("level", parseFloat(e.target.value))} className={sel}>
            <option value={0.01}>1% (strict)</option>
            <option value={0.05}>5%</option>
            <option value={0.1}>10% (loose)</option>
          </select>
        </label>
        {NUM_FIELDS.map(([k, label, step, help]) => (
          <label key={k} className="flex items-center gap-2" title={help}>
            <span className="text-xs uppercase tracking-wider text-muted">{label}</span>
            <input type="number" step={step} value={p[k] ?? ""}
              onChange={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) set(k, n); }}
              className="w-20 px-2 py-1.5 text-right rounded-md bg-bg-panel border border-line font-mono text-sm focus:outline-none focus:border-accent-blue" />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-5 text-xs text-muted">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!p.use_gate} onChange={(e) => set("use_gate", e.target.checked)} className="accent-accent-blue" />
          Only open trades while the test passes
        </label>
        <label className={`flex items-center gap-2 ${p.use_gate ? "cursor-pointer" : "opacity-40"}`}>
          <input type="checkbox" checked={!!p.exit_on_fail} disabled={!p.use_gate}
            onChange={(e) => set("exit_on_fail", e.target.checked)} className="accent-accent-blue" />
          Close a trade when the test stops passing
        </label>
      </div>
      <p className="text-[11px] text-muted">
        Hover a setting for what it does. Costs are 0 unless you set them here. The run always adds the
        same rules with the gate flipped and on a fake pair, so you can compare.
      </p>
    </section>
  );
}

export function Results({ data }) {
  const { meta, summary: s, rolling, zoom, trading: tr } = data;
  const p = meta.params;
  const Y = meta.symbol_y, X = meta.symbol_x;
  const lvl = `${fmtInt(p.level * 100)}%`;
  const lvlKey = String(Math.round(p.level * 100));
  const hoursFmt = (v) => (v == null ? "—" : `${fmtNum(v)} h`);

  const zLines = [
    { value: p.entry_z, color: "#f59e0b", label: `sell ${Y} / buy ${X}` },
    { value: -p.entry_z, color: "#f59e0b", label: `buy ${Y} / sell ${X}` },
    { value: p.stop_z, color: "#ef4444", label: "stop" },
    { value: -p.stop_z, color: "#ef4444", label: "stop" },
    { value: p.exit_z, color: "#64748b", label: "exit" },
    ...(p.exit_z !== 0 ? [{ value: -p.exit_z, color: "#64748b" }] : []),
  ];
  const zMarkers = zoom.markers.map((m) => ({
    time: m.time, value: m.value,
    color: m.kind === "entry" ? "#60a5fa" : "#e2e8f0",
    title: m.kind === "entry"
      ? `${fmtDateLong(m.time)} · open: ${m.side === "long" ? `buy ${Y} / sell ${X}` : `sell ${Y} / buy ${X}`} at z ${fmtNum(m.value)}`
      : `${fmtDateLong(m.time)} · close at z ${fmtNum(m.value)} (${m.reason})`,
  }));

  const rows = [tr.main, tr.alt, tr.fake];

  return (
    <div className="space-y-5">
      <div className={`rounded-xl border p-4 ${TONE[s.verdict.tone]}`}>
        <div className="text-[10px] uppercase tracking-wider opacity-70">Is there a leash?</div>
        <div className="text-base font-semibold mt-0.5">{s.verdict.label}</div>
        <div className="text-sm mt-1 text-text/90">{s.verdict.text}</div>
        <div className="text-[11px] text-muted mt-2">
          {Y} vs {X} · {meta.timeframe} · {fmtDateLong(meta.first_time)} – {fmtDateLong(meta.last_time)} ·{" "}
          {fmtInt(meta.bars)} bars · {fmtInt(meta.tests)} tests ({meta.test_name}, {fmtNum(p.window_days)}-day window,
          5% cutoff {fmtNum(meta.crit_5pct)})
          {meta.sources && (meta.sources.y !== meta.timeframe || meta.sources.x !== meta.timeframe)
            ? ` · ${Y}: ${meta.sources.y}, ${X}: ${meta.sources.x}` : ""}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title={`Passes the test (${lvl})`} value={fmtPct(s.pass_pct[lvlKey], false)}
          sub={`fake pair ${fmtPct(s.fake_pass_pct[lvlKey], false)}`}
          positive={s.pass_pct[lvlKey] >= 2 * Math.max(s.fake_pass_pct[lvlKey], 5)} />
        <KpiCard title="Move together (correlation)" value={fmtNum(s.corr_median)}
          sub="median over windows · 1 = always the same way" />
        <KpiCard title="Hedge ratio" value={fmtNum(s.beta_median)}
          sub={`usually ${fmtNum(s.beta_p10)} – ${fmtNum(s.beta_p90)}`} />
        <KpiCard title="Half-life (when passing)" value={hoursFmt(s.halflife_median_hours)}
          sub={`all windows ${hoursFmt(s.halflife_all_median_hours)}`} />
      </div>

      <Panel title="Both prices, rebased to 100"
        hint="Where both coins would be if each started at 100. Two lines that drift apart for months have no leash, however closely they wiggle together.">
        <MultiLineChart height={220} yLabel="rebased" fmt={(v) => fmtNum(v)}
          series={[{ label: Y, points: data.prices.y, color: "#60a5fa" },
                   { label: X, points: data.prices.x, color: "#f59e0b" }]} />
      </Panel>

      <Panel title="Is the leash there? The rolling test"
        hint={`Each stripe is one test over the past ${fmtNum(p.window_days)} days. Green = the gap was being pulled back; grey = no sign of a leash. A fake pair passes ${fmtPct(s.fake_pass_pct[lvlKey], false)} of the time at ${lvl} by luck alone.`}>
        <RegimeRibbon segments={rolling.strip} colors={STRIP_COLORS} height={44} />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          {Object.entries(STRIP_COLORS).map(([k, c]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: c }} />
              {k} ({fmtPct(k === "Fails" ? 100 - s.pass_pct["10"] : s.pass_pct[k.match(/\d+/)[0]], false)}
              {k === "Fails" ? "" : " or stricter"})
            </span>
          ))}
        </div>
      </Panel>

      <div className="grid md:grid-cols-2 gap-5">
        <Panel title="Correlation over time"
          hint="Do they move the same way day to day? This can stay high while the test above keeps failing: moving together is not the same as staying together.">
          <MultiLineChart height={180} legend={false} fmt={(v) => fmtNum(v)}
            series={[{ label: "correlation", points: rolling.corr, color: "#a78bfa" }]} />
        </Panel>
        <Panel title="Hedge ratio over time"
          hint={`How much ${Y} moves per 1% move in ${X}, re-fitted every window. A flat line = a stable leash; a wandering one = the leash keeps changing length.`}>
          <MultiLineChart height={180} legend={false} fmt={(v) => fmtNum(v)}
            hLines={[{ value: 1, color: "#64748b", label: "1 : 1" }]}
            series={[{ label: "hedge ratio", points: rolling.beta, color: "#38bdf8" }]} />
        </Panel>
      </div>

      <Panel title="Half-life over time"
        hint={`After a gap opens, hours until half of it closes. Capped at the window length (${hoursFmt(rolling.halflife_cap_hours)}); at the cap the gap wasn't closing at all.`}>
        <MultiLineChart height={160} legend={false} fmt={(v) => fmtNum(v)}
          series={[{ label: "half-life (h)", points: rolling.halflife_hours, color: "#14b8a6" }]} />
      </Panel>

      <Panel title={`The gap (z-score) · last ${fmtNum(p.zoom_days)} days`}
        hint="How many normal-sized gaps the spread is from its average. Blue dots = trades opened, white = closed (hover a dot). Orange = entry lines, red = stop lines.">
        <MultiLineChart height={240} fmt={(v) => fmtNum(v)} hLines={zLines} markers={zMarkers}
          series={[{ label: "gap z-score", points: zoom.z, color: "#cbd5e1", width: 1 }]} legend={false} />
      </Panel>

      <div className="pt-2">
        <div className="text-lg font-semibold">If you had traded the gap</div>
        <p className="text-xs text-muted mt-0.5">
          One trade at a time, 1× capital split across both legs, signal on a bar&apos;s close and filled at the next
          bar&apos;s open. Nothing compounds, so every number is in % of starting capital.{" "}
          {tr.has_costs ? `Costs: ${fmtPct(tr.cost_round_trip_pct, false)} per round trip.` : "No costs (fee and slippage are 0)."}
        </p>
      </div>

      <div className={`rounded-xl border p-4 text-sm ${TONE[tr.verdict.tone]}`}>{tr.verdict.text}</div>

      <Panel title="This pair against two baselines"
        hint="Same rules three ways. If this pair doesn't clearly beat the fake pair, the profit isn't coming from a leash. If the gate-off row is just as good, the test isn't adding anything.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-muted text-[10px] uppercase tracking-wider">
                <th className="text-left font-normal py-1">Setup</th>
                <th className="text-right font-normal">Trades</th>
                <th className="text-right font-normal">Total</th>
                <th className="text-right font-normal">Avg / trade</th>
                <th className="text-right font-normal">Win rate</th>
                <th className="text-right font-normal">t-stat</th>
                <th className="text-right font-normal">Max drawdown</th>
                <th className="text-right font-normal">In market</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={`border-t border-line/50 ${i === 0 ? "text-text" : "text-muted"}`}>
                  <td className="py-1.5 font-sans">{r.label}</td>
                  <td className="text-right">{fmtInt(r.trades)}</td>
                  <td className={`text-right ${(r.total_net_pct ?? 0) >= 0 ? "text-profit" : "text-loss"}`}>{fmtPct(r.total_net_pct)}</td>
                  <td className="text-right">{fmtPct(r.avg_net_pct)}</td>
                  <td className="text-right">{fmtPct(r.win_rate, false)}</td>
                  <td className="text-right">{fmtNum(r.t_stat)}</td>
                  <td className="text-right">{fmtPct(r.max_dd_pct, false)}</td>
                  <td className="text-right">{fmtPct(r.time_in_market_pct, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted">
          t-stat: how far the average trade is from zero, in units of its own noise. Above 2 is the usual bar
          for &quot;probably not luck&quot;. Max drawdown: deepest drop from a high, in % of starting capital.
        </p>
      </Panel>

      <Panel title="Equity line" hint="Cumulative result in % of starting capital, marked to market every bar (open trades included).">
        <MultiLineChart height={240} yLabel="% of capital" fmt={(v) => fmtNum(v)}
          hLines={[{ value: 0, color: "#475569", dashed: false }]}
          series={[
            ...(tr.has_costs ? [{ label: `${tr.main.label}, before costs`, points: tr.equity.gross, color: "#22c55e", opacity: 0.5 }] : []),
            { label: tr.alt.label, points: tr.equity.alt_net, color: "#a78bfa", dashed: true },
            { label: tr.fake.label, points: tr.equity.fake_net, color: "#94a3b8", dashed: true },
            { label: tr.has_costs ? `${tr.main.label}, after costs` : tr.main.label, points: tr.equity.net, color: "#60a5fa", width: 2 },
          ]} />
      </Panel>

      <div className="grid md:grid-cols-2 gap-5">
        <Panel title="Where the money came from"
          hint={`${tr.main.label}, before costs. A real pair trade makes it from the gap closing, so neither line should carry it alone. If one leg makes all the money, it's a hidden bet on that coin's direction.`}>
          <MultiLineChart height={200} yLabel="% of capital" fmt={(v) => fmtNum(v)}
            hLines={[{ value: 0, color: "#475569", dashed: false }]}
            series={[{ label: `${Y} leg`, points: tr.legs.y, color: "#60a5fa" },
                     { label: `${X} leg`, points: tr.legs.x, color: "#f59e0b" }]} />
        </Panel>
        <Panel title="Does it ignore market direction?"
          hint="The strategy's daily result against each coin's daily move. Near 0 = market-neutral, which is the point of a pair trade.">
          <div className="grid grid-cols-2 gap-3">
            <KpiCard title={`Correlation with ${X}`} value={fmtNum(tr.neutrality.corr_x)}
              sub={`beta ${fmtNum(tr.neutrality.beta_x)}`}
              positive={tr.neutrality.corr_x == null ? null : Math.abs(tr.neutrality.corr_x) < 0.2} />
            <KpiCard title={`Correlation with ${Y}`} value={fmtNum(tr.neutrality.corr_y)}
              sub={`beta ${fmtNum(tr.neutrality.beta_y)}`}
              positive={tr.neutrality.corr_y == null ? null : Math.abs(tr.neutrality.corr_y) < 0.2} />
            <KpiCard title="Median hold" value={hoursFmt(tr.median_hold_hours)} sub="per trade" />
            <KpiCard title="Half-life at entry" value={hoursFmt(tr.median_halflife_at_entry_hours)}
              sub="median, from the latest test" />
          </div>
        </Panel>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Panel title="Why trades closed" hint={`${tr.main.label}. Many "leash broke" exits = the gaps it bets on keep widening.`}>
          {tr.exit_reasons.length ? (
            <ul className="space-y-1.5 text-sm">
              {tr.exit_reasons.map((r) => (
                <li key={r.reason} className="flex justify-between gap-3 font-mono text-xs">
                  <span className="font-sans text-text">{r.reason}</span>
                  <span className="text-muted">
                    {fmtInt(r.n)} trades · avg <span className={r.avg_net_pct >= 0 ? "text-profit" : "text-loss"}>{fmtPct(r.avg_net_pct)}</span>
                    {" "}· total {fmtPct(r.sum_net_pct)}
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="text-xs text-muted">No closed trades.</div>}
        </Panel>
        <Panel title="Result by year" hint={`${tr.main.label}: sum of trade results per year (by entry date). A real edge should be green in most years, not carried by one.`}>
          <VBarChart height={180} colorMode="sign" yLabel="% of capital" fmt={(v) => fmtNum(v)}
            bars={tr.years.map((y) => ({ label: String(y.year), value: y.sum_net_pct, n: y.n }))} />
        </Panel>
      </div>

      <p className="text-[11px] text-muted">{meta.caveat}</p>
    </div>
  );
}
