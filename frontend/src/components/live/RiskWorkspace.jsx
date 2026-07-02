import { useEffect, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import { useEnterStagger } from "./animations.js";
import { usePositionsRisk } from "./hooks.js";
import { getLiveCandles } from "./liveApi.js";
import { fmtUsd, fmtNum, fmtPct, fmtRatio } from "../../services/format.js";

function Card({ label, value, sub, tone, simulated }) {
  return (
    <div style={{ background: "var(--lt-panel)", padding: "11px 13px", position: "relative" }}>
      <div className="lt-mono lt-muted" style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {label}{simulated && <span className="lt-amber" style={{ marginLeft: 5, fontSize: 7.5 }}>SIM/DERIVED</span>}
      </div>
      <div className={`lt-mono ${tone || ""}`} style={{ fontSize: 17, fontWeight: 700, margin: "3px 0 2px" }}>{value}</div>
      {sub && <div className="lt-mono lt-dim" style={{ fontSize: 8.5 }}>{sub}</div>}
    </div>
  );
}

/**
 * RISK workspace — exposure cards, per-instrument exposure bars, margin
 * utilization, cross-asset correlation (REAL, from live 1h candles), and a
 * position risk table. Positions/risk data goes REAL via WAMP in phase 09;
 * until then the layout renders the labeled SIMULATED fallback.
 */
export default function RiskWorkspace({ account }) {
  const ref = useRef(null);
  useEnterStagger("risk", ref);
  const { risk, simulated, loading } = usePositionsRisk(account);
  const [corr, setCorr] = useState(null); // {symbols, matrix}

  // Real 30-bar correlation of 1h returns between our instruments.
  useEffect(() => {
    let dead = false;
    Promise.all([
      getLiveCandles({ symbol: "BTCUSDT", timeframe: "1h", limit: 31 }),
      getLiveCandles({ symbol: "LTCUSDT", timeframe: "1h", limit: 31 }),
    ]).then(([a, b]) => {
      if (dead) return;
      const rets = (cs) => cs.slice(1).map((c, i) => (c.close - cs[i].close) / cs[i].close);
      const ra = rets(a), rb = rets(b);
      const n = Math.min(ra.length, rb.length);
      if (n < 5) return;
      const ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
      const c = num / Math.max(1e-12, Math.sqrt(da * db));
      setCorr({ symbols: ["BTCUSDT", "LTCUSDT"], matrix: [[1, c], [c, 1]] });
    }).catch(() => {});
    return () => { dead = true; };
  }, []);

  const cards = risk?.cards;
  const util = cards ? Math.min(100, cards.utilPct ?? ((cards.marginUsed / Math.max(1, cards.equity)) * 100)) : 0;
  const utilColor = util > 60 ? "var(--lt-red)" : util > 35 ? "var(--lt-amber)" : "var(--lt-green)";
  const maxExp = Math.max(1, ...(risk?.exposures || []).map((e) => Math.abs(e.notional)));

  return (
    <div ref={ref} className="lt-ws" style={{ display: "flex", flexDirection: "column", gap: 1, background: "var(--lt-border)", overflow: "auto" }}>
      <div style={{ background: "var(--lt-chrome)", padding: "7px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <span className="lt-panel-title">Risk · Portfolio Exposure & Margin · {String(account || "demo").toUpperCase()}</span>
        {simulated && !loading && (
          <span className="lt-sim-badge" title="WAMP positions DB unreachable (or mock mode) — labeled placeholder data">SIMULATED — WAMP OFFLINE</span>
        )}
        {!simulated && <span className="lt-live-chip">REAL · sinegu-api</span>}
      </div>

      {/* 8 cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1 }}>
        {cards ? (
          <>
            <Card label="Account Equity" value={fmtUsd(cards.equity)} sub="balance + unrealized" />
            <Card label="Day P&L" value={`${cards.dayPnl >= 0 ? "+" : ""}${fmtUsd(cards.dayPnl)}`} tone={cards.dayPnl >= 0 ? "lt-green" : "lt-red"} sub="closed today + uPnL" />
            <Card label="Gross Exposure" value={fmtUsd(cards.gross)} sub={`${fmtRatio(cards.leverage ?? (cards.gross / Math.max(1, cards.equity)))}x leverage`} />
            <Card label="Net Delta" value={`${cards.netDelta >= 0 ? "+" : ""}${fmtUsd(cards.netDelta)}`} tone={cards.netDelta >= 0 ? "lt-green" : "lt-red"} sub="long − short notional" />
            <Card label="Margin Used" value={fmtUsd(cards.marginUsed)} sub={`${fmtNum(util)}% of equity`} tone={util > 60 ? "lt-red" : undefined} />
            <Card label="Free Margin" value={fmtUsd(cards.freeMargin)} />
            <Card label="Est. VaR 1-Day 95%" value={fmtUsd(cards.var1d)} simulated sub="derived estimate" />
            <Card label="Maint. Margin" value={fmtUsd(cards.maintMargin)} simulated={simulated} sub={simulated ? "derived" : "broker-reported"} />
          </>
        ) : (
          Array.from({ length: 8 }, (_, i) => <Card key={i} label="…" value="—" />)
        )}
      </div>

      {/* Exposure by instrument + margin utilization */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
        <Panel title="Net Exposure by Instrument" simulated={simulated} style={{ minHeight: 130 }}>
          {(risk?.exposures || []).length === 0 ? (
            <div className="lt-empty">No open positions</div>
          ) : (
            <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
              {risk.exposures.map((e) => {
                const long = e.side === "LONG" || e.side === "BUY";
                return (
                  <div key={`${e.symbol}-${e.side}`} className="lt-mono" style={{ fontSize: 9.5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span>{e.symbol} <span className={long ? "lt-green" : "lt-red"}>{e.side}</span></span>
                      <span className="lt-muted">{fmtUsd(Math.abs(e.notional))}</span>
                    </div>
                    <div style={{ height: 5, background: "var(--lt-grid)" }}>
                      <div style={{ width: `${(Math.abs(e.notional) / maxExp) * 100}%`, height: "100%", background: long ? "var(--lt-green)" : "var(--lt-red)", opacity: 0.7 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Margin Utilization" simulated={simulated} style={{ minHeight: 130 }}>
          <div style={{ padding: "14px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }} className="lt-mono">
              <span style={{ color: utilColor, fontWeight: 700, fontSize: 13 }}>{fmtNum(util)}% used</span>
              <span className="lt-dim" style={{ fontSize: 9 }}>limit 100%</span>
            </div>
            <div style={{ height: 8, background: "var(--lt-grid)" }}>
              <div style={{ width: `${util}%`, height: "100%", background: utilColor }} />
            </div>
            <div className="lt-dim lt-mono" style={{ fontSize: 8.5, marginTop: 6 }}>
              {util > 60 ? "⚠ high utilization — liquidation risk grows fast above 60%" : util > 35 ? "moderate utilization" : "healthy headroom"}
            </div>
          </div>
        </Panel>
      </div>

      {/* Correlation + position risk */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 1, flex: 1, minHeight: 170 }}>
        <Panel title="Cross-Asset Correlation · 30×1H" live={!!corr}>
          {!corr ? (
            <div className="lt-empty">Computing from live candles…</div>
          ) : (
            <table className="lt-table" style={{ maxWidth: 320 }}>
              <thead>
                <tr><th />{corr.symbols.map((s) => <th key={s} className="num">{s.replace("USDT", "")}</th>)}</tr>
              </thead>
              <tbody>
                {corr.symbols.map((s, i) => (
                  <tr key={s}>
                    <td className="lt-muted">{s.replace("USDT", "")}</td>
                    {corr.matrix[i].map((v, j) => {
                      const heat = v >= 0 ? `rgba(0,212,161,${Math.abs(v) * 0.28})` : `rgba(255,77,109,${Math.abs(v) * 0.28})`;
                      return <td key={j} className="num" style={{ background: heat }}>{fmtRatio(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Position Risk" simulated={simulated}>
          {(risk?.positionRisk || []).length === 0 ? (
            <div className="lt-empty">No open positions</div>
          ) : (
            <table className="lt-table">
              <thead>
                <tr><th>SYMBOL</th><th className="num">LEV</th><th className="num">NOTIONAL</th><th className="num">LIQ PRICE</th><th className="num">DIST</th><th className="num">uPNL</th></tr>
              </thead>
              <tbody>
                {risk.positionRisk.map((p, i) => (
                  <tr key={`${p.symbol}${i}`}>
                    <td style={{ fontWeight: 600 }}>{p.symbol}</td>
                    <td className="num">{p.lev != null ? `${fmtNum(p.lev)}x` : "—"}</td>
                    <td className="num">{fmtUsd(p.notional)}</td>
                    <td className="num lt-red">{p.liqPrice != null ? fmtNum(p.liqPrice) : "—"}</td>
                    <td className="num lt-muted">{p.distPct != null ? fmtPct(p.distPct, false) : "—"}</td>
                    <td className={`num ${p.uPnl >= 0 ? "lt-green" : "lt-red"}`}>{p.uPnl >= 0 ? "+" : ""}{fmtUsd(p.uPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
