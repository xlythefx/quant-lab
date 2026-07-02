import { useEffect, useMemo, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import { SimulatedBadge } from "./Panel.jsx";
import { useEnterStagger } from "./animations.js";
import { useDataMode } from "./dataMode.jsx";
import { getLiveMarkets } from "./liveApi.js";
import * as sim from "./simFeed.js";
import { fmtNum, fmtPct, fmtUsd } from "../../services/format.js";

function Spark({ points = [], w = 84, h = 20 }) {
  if (points.length < 2) return <svg width={w} height={h} />;
  const lo = Math.min(...points), hi = Math.max(...points);
  const span = Math.max(1e-9, hi - lo);
  const up = points[points.length - 1] >= points[0];
  const d = points.map((p, i) =>
    `${i === 0 ? "M" : "L"}${((w - 2) * i) / (points.length - 1) + 1},${h - 2 - (h - 4) * ((p - lo) / span)}`).join(" ");
  return (
    <svg width={w} height={h}>
      <path d={d} fill="none" stroke={up ? "#00d4a1" : "#ff4d6d"} strokeWidth="1.1" />
    </svg>
  );
}

const COLS = [
  ["symbol", "SYMBOL", false],
  ["last", "LAST", true],
  ["chg24h", "24H %", true],
  ["funding", "FUNDING", true],
  ["volume", "24H VOLUME", true],
  ["spark", "TREND", false],
];

/**
 * MARKETS workspace — sortable instruments table. LAST / 24H% / VOLUME /
 * TREND are REAL (Binance); FUNDING is SIMULATED (spot has none) and marked.
 */
export default function MarketsWorkspace({ onSymbol }) {
  const ref = useRef(null);
  useEnterStagger("markets", ref);
  const { dataMode } = useDataMode();
  const mock = dataMode === "mock";
  const [rows, setRows] = useState([]);
  const [sort, setSort] = useState({ key: "volume", dir: -1 });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let dead = false;
    const pull = () => {
      if (mock) {
        const mk = (s) => ({ symbol: s, venue: "BINANCE", last: sim.mockTicker(s).price, chg24h: sim.mockTicker(s).changePct, volume: sim.mockTicker(s).quoteVol, funding: sim.mockFunding(s).rate, spark: sim.genCandles(s, "1h", 30).map((c) => c.close) });
        setRows([mk("BTCUSDT"), mk("LTCUSDT")]);
        setLoaded(true);
        return;
      }
      getLiveMarkets()
        .then((r) => { if (!dead) { setRows(r.map((x) => ({ ...x, funding: sim.mockFunding(x.symbol).rate }))); setLoaded(true); } })
        .catch(() => { if (!dead) setLoaded(true); });
    };
    pull();
    const t = setInterval(pull, 12_000);
    return () => { dead = true; clearInterval(t); };
  }, [mock]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return ((av ?? -Infinity) - (bv ?? -Infinity)) * dir;
    });
    return arr;
  }, [rows, sort]);

  return (
    <div ref={ref} className="lt-ws grid" style={{ gridTemplateRows: "1fr" }}>
      <Panel
        title={`Markets · Binance Spot · ${rows.length} instruments`}
        simulated={mock}
        right={<span className="lt-mono lt-dim" style={{ fontSize: 8.5 }}>funding column is <SimulatedBadge /></span>}
      >
        {!loaded ? (
          <div className="lt-empty">Loading markets…</div>
        ) : (
          <table className="lt-table">
            <thead>
              <tr>
                {COLS.map(([key, label, num]) => (
                  <th key={key} className={num ? "num" : ""} style={{ cursor: key !== "spark" ? "pointer" : "default" }}
                      onClick={() => key !== "spark" && setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>
                    {label}{sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.symbol} style={{ cursor: "pointer" }} title="Open on the Trading chart"
                    onClick={() => onSymbol?.(r.symbol)}>
                  <td style={{ fontWeight: 700 }}>{r.symbol} <span className="lt-dim" style={{ fontSize: 8.5 }}>{r.venue}</span></td>
                  <td className="num">{r.last != null ? fmtNum(r.last) : "—"}</td>
                  <td className={`num ${r.chg24h >= 0 ? "lt-green" : "lt-red"}`}>{r.chg24h != null ? fmtPct(r.chg24h) : "—"}</td>
                  <td className={`num ${r.funding >= 0 ? "lt-red" : "lt-green"}`} title="SIMULATED — spot has no funding">
                    {r.funding != null ? `${r.funding >= 0 ? "+" : ""}${r.funding.toFixed(4)}%` : "—"}
                  </td>
                  <td className="num lt-muted">{r.volume != null ? fmtUsd(r.volume) : "—"}</td>
                  <td><Spark points={r.spark || []} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
