import Panel from "./Panel.jsx";
import { useOrderBook } from "./hooks.js";
import { fmtNum } from "../../services/format.js";

/**
 * Order Book — asks stacked above a spread row, bids below, cumulative depth
 * bars behind mono numbers. SIMULATED until the Binance partial-depth stream
 * is wired (phase 08); the layout is already the real one.
 */
export default function OrderBookPanel({ symbol, lastPrice }) {
  const { book, simulated } = useOrderBook(symbol, lastPrice);

  const asks = (book?.asks || []).slice(0, 11);
  const bids = (book?.bids || []).slice(0, 11);
  const maxCum = Math.max(
    asks.length ? asks[asks.length - 1].cum : 1,
    bids.length ? bids[bids.length - 1].cum : 1,
    1e-9,
  );
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const spread = bestAsk != null && bestBid != null ? bestAsk - bestBid : null;
  const spreadBps = spread != null && bestBid ? (spread / bestBid) * 10_000 : null;

  const Row = ({ lvl, side }) => {
    const color = side === "ask" ? "var(--lt-red)" : "var(--lt-green)";
    const tint = side === "ask" ? "rgba(255,77,109,0.13)" : "rgba(0,212,161,0.13)";
    const w = Math.min(100, (lvl.cum / maxCum) * 100);
    return (
      <div
        className="lt-mono"
        style={{
          position: "relative", display: "grid",
          gridTemplateColumns: "1.2fr 1fr 1fr", gap: 4,
          padding: "1.5px 10px", fontSize: 10,
        }}
      >
        <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${w}%`, background: tint }} />
        <span style={{ color, position: "relative" }}>{fmtNum(lvl.price)}</span>
        <span style={{ position: "relative", textAlign: "right" }}>{lvl.size.toFixed(3)}</span>
        <span className="lt-muted" style={{ position: "relative", textAlign: "right" }}>{lvl.cum.toFixed(2)}</span>
      </div>
    );
  };

  return (
    <Panel title="Order Book" simulated={simulated}>
      <div
        className="lt-mono lt-muted"
        style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 4, padding: "4px 10px", fontSize: 8.5, letterSpacing: "0.08em", borderBottom: "1px solid var(--lt-row)" }}
      >
        <span>PRICE</span><span style={{ textAlign: "right" }}>SIZE</span><span style={{ textAlign: "right" }}>TOTAL</span>
      </div>
      {!book && <div className="lt-empty">Waiting for depth…</div>}
      {book && (
        <>
          <div style={{ display: "flex", flexDirection: "column-reverse" }}>
            {asks.map((l, i) => <Row key={`a${i}`} lvl={l} side="ask" />)}
          </div>
          <div
            className="lt-mono"
            style={{ background: "var(--lt-chrome)", borderTop: "1px solid var(--lt-border)", borderBottom: "1px solid var(--lt-border)", padding: "3px 10px", fontSize: 9.5, display: "flex", justifyContent: "space-between" }}
          >
            <span className="lt-muted">SPREAD</span>
            <span>{spread != null ? fmtNum(spread) : "—"}</span>
            <span className="lt-muted">{spreadBps != null ? `${spreadBps.toFixed(2)} bps` : ""}</span>
          </div>
          <div>
            {bids.map((l, i) => <Row key={`b${i}`} lvl={l} side="bid" />)}
          </div>
        </>
      )}
    </Panel>
  );
}
