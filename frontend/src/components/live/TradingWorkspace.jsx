import { useEffect, useMemo, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import LiveChart from "./LiveChart.jsx";
import OrderBookPanel from "./OrderBookPanel.jsx";
import TapePanel from "./TapePanel.jsx";
import PositionsPanel from "./PositionsPanel.jsx";
import LiquidationsPanel from "./LiquidationsPanel.jsx";
import FundingPanel from "./FundingPanel.jsx";
import NewsPanel from "./NewsPanel.jsx";
import { useEnterStagger, useDrawProgress } from "./animations.js";
import { useInstruments, useLiveCandles, useTicker } from "./hooks.js";
import { onLiveSignal } from "./liveChannels.js";
import { fmtNum, fmtPct } from "../../services/format.js";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

/**
 * TRADING workspace — row 1: chart | order book | time & sales;
 * row 2: positions | liquidations | funding/OI | news.
 * Chart + price header are REAL (Binance feed); book/tape carry the
 * SIMULATED badge until their real feeds are wired.
 */
export default function TradingWorkspace({ symbol, timeframe, onSymbol, onTimeframe, deployments = [], account }) {
  const ref = useRef(null);
  useEnterStagger("trading", ref);
  const { instruments } = useInstruments();
  const { candles, lastPrice, status, stale, simulated } = useLiveCandles(symbol, timeframe);
  const { ticker } = useTicker(symbol);
  const progress = useDrawProgress(`${symbol}|${timeframe}`);
  const [markers, setMarkers] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const prevPrice = useRef(null);
  const [flash, setFlash] = useState("");

  // Live strategy signals on this symbol → chart markers (phase 05 emits these).
  useEffect(() => {
    setMarkers([]);
    const off = onLiveSignal((s) => {
      if (s.symbol !== symbol) return;
      setMarkers((prev) => [...prev.slice(-99), s]);
    });
    return () => off();
  }, [symbol]);

  // Price flash on tick
  useEffect(() => {
    if (lastPrice == null) return;
    if (prevPrice.current != null && lastPrice !== prevPrice.current) {
      setFlash(lastPrice > prevPrice.current ? "lt-flash-up" : "lt-flash-down");
      const t = setTimeout(() => setFlash(""), 520);
      prevPrice.current = lastPrice;
      return () => clearTimeout(t);
    }
    prevPrice.current = lastPrice;
  }, [lastPrice]);

  const price = lastPrice ?? ticker?.price ?? null;
  const chg = ticker?.changePct;
  const armedHere = useMemo(
    () => deployments.filter((d) => d.symbol === symbol),
    [deployments, symbol],
  );

  return (
    <div
      ref={ref}
      className="lt-ws grid"
      style={{ gridTemplateRows: "6fr 4fr", gridTemplateColumns: "1fr" }}
    >
      {/* Row 1 */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 1, background: "var(--lt-border)", minHeight: 0 }}>
        <Panel
          title={`VWMA(14) · Z-SCORE 1.5σ ${simulated ? "" : "· BINANCE FEED"}`}
          simulated={simulated}
          live={!simulated && status === "ok" && !stale}
          right={
            <div style={{ display: "flex", gap: 2 }}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => onTimeframe(tf)}
                  className="lt-mono"
                  style={{
                    background: tf === timeframe ? "var(--lt-border)" : "none",
                    border: "none",
                    color: tf === timeframe ? "#fff" : "var(--lt-muted)",
                    fontSize: 9.5, fontWeight: 600, padding: "2px 6px", cursor: "pointer",
                  }}
                >
                  {tf === "1h" ? "1H" : tf === "4h" ? "4H" : tf === "1d" ? "1D" : tf}
                </button>
              ))}
            </div>
          }
        >
          {stale && (
            <div className="lt-warn-banner">
              ⚠ PRICE FEED STALE — no frames from the stream. Chart may be outdated.
            </div>
          )}
          {status === "error" && (
            <div className="lt-warn-banner">⚠ LIVE FEED FAILED — could not load {symbol} {timeframe}.</div>
          )}
          <LiveChart candles={candles} markers={markers} progress={progress} />

          {/* Symbol switcher + price header overlay */}
          <div style={{ position: "absolute", top: 8, left: 10, zIndex: 6 }}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="lt-mono"
              style={{ background: "none", border: "none", color: "var(--lt-text)", fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, padding: 0 }}
            >
              {symbol}
              <span className="lt-cyan" style={{ fontSize: 8, border: "1px solid rgba(34,211,238,0.4)", padding: "1px 4px" }}>SPOT</span>
              <span className="lt-muted" style={{ fontSize: 9 }}>▾</span>
            </button>
            <div className={`lt-mono ${flash}`} style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15 }}>
              {price != null ? fmtNum(price) : "—"}
            </div>
            <div className="lt-mono" style={{ fontSize: 10 }}>
              <span className={chg == null ? "lt-muted" : chg >= 0 ? "lt-green" : "lt-red"}>
                {chg == null ? "—" : fmtPct(chg)}
              </span>
              <span className="lt-muted" style={{ marginLeft: 8 }}>
                H {ticker ? fmtNum(ticker.high) : "—"} · L {ticker ? fmtNum(ticker.low) : "—"} · V {ticker ? fmtNum(ticker.vol) : "—"}
              </span>
            </div>
            {menuOpen && (
              <div style={{ marginTop: 6, background: "var(--lt-chrome)", border: "1px solid var(--lt-border)", minWidth: 200 }}>
                <div className="lt-cmdk-kind">BINANCE</div>
                {instruments.map((inst) => (
                  <button
                    key={inst.symbol}
                    className={`lt-cmdk-item ${inst.symbol === symbol ? "sel" : ""}`}
                    onClick={() => { onSymbol(inst.symbol); setMenuOpen(false); }}
                  >
                    <span>{inst.symbol}</span>
                    <span className="lt-dim">{inst.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Strategy chips (deployments armed on this symbol) */}
          <div style={{ position: "absolute", top: 8, right: 62, zIndex: 6, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
            {armedHere.map((d) => (
              <div
                key={d.name}
                className="lt-mono"
                title={`${d.strategy_id} · ${d.timeframe} · ${d.status}`}
                style={{
                  border: `1px solid ${d.status === "RUNNING" ? "rgba(0,212,161,0.5)" : "var(--lt-border)"}`,
                  background: "var(--lt-chrome)",
                  padding: "3px 7px", fontSize: 9, display: "flex", gap: 7, alignItems: "center",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: d.status === "RUNNING" ? "var(--lt-green)" : "var(--lt-muted)" }} />
                <span>{d.name}</span>
                <span className={d.pnl >= 0 ? "lt-green" : "lt-red"}>
                  {d.pnl == null ? "" : `${d.pnl >= 0 ? "+" : ""}${fmtNum(d.pnl)}`}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <OrderBookPanel symbol={symbol} lastPrice={price} />
        <TapePanel symbol={symbol} lastPrice={price} />
      </div>

      {/* Row 2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, background: "var(--lt-border)", minHeight: 0 }}>
        <PositionsPanel account={account} compact />
        <LiquidationsPanel symbol={symbol} lastPrice={price} />
        <FundingPanel symbol={symbol} />
        <NewsPanel />
      </div>
    </div>
  );
}
