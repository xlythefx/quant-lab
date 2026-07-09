import PositionsPanel from "./PositionsPanel.jsx";
import LiquidationsPanel from "./LiquidationsPanel.jsx";
import FundingPanel from "./FundingPanel.jsx";
import NewsPanel from "./NewsPanel.jsx";
import KeyStatsPanel from "./KeyStatsPanel.jsx";
import BreadthPanel from "./BreadthPanel.jsx";
import CarryPanel from "./CarryPanel.jsx";

/**
 * Trading row-2 panel set for the selected instrument's asset class.
 *
 * Positions (REAL, from WAMP) and News (universal) are constant; the middle
 * panels adapt to what the asset actually has — perps get liquidations/funding,
 * a stock gets key stats, an index gets breadth, FX gets carry. Every
 * class-specific panel except Positions is SIMULATED until a real feed exists.
 *
 * Today every live instrument is crypto, so `crypto` is also the fallback for
 * an unknown class — nothing regresses; this just builds the seam so adding a
 * non-crypto instrument to a broker catalog swaps in the right panels.
 *
 * Returns `{ cols, panels }` — `cols` sizes the CSS grid so a 3-panel class
 * doesn't leave a dead 4th column.
 */
export function adaptPanels(cls, ctx) {
  const { symbol, price, account } = ctx;
  const positions = <PositionsPanel key="pos" account={account} compact />;
  const news = <NewsPanel key="news" />;

  const sets = {
    crypto: {
      cols: 4,
      panels: [
        positions,
        <LiquidationsPanel key="liq" symbol={symbol} lastPrice={price} />,
        <FundingPanel key="fund" symbol={symbol} />,
        news,
      ],
    },
    stock: { cols: 3, panels: [positions, <KeyStatsPanel key="ks" symbol={symbol} />, news] },
    index: { cols: 3, panels: [positions, <BreadthPanel key="br" symbol={symbol} />, news] },
    fx:    { cols: 3, panels: [positions, <CarryPanel key="carry" symbol={symbol} />, news] },
  };

  return sets[cls] || sets.crypto;
}
