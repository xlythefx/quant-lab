import { useMemo } from "react";
import TradingChart from "../TradingChart.jsx";
import { tradesToMarkers } from "../../services/chartMarkers.js";

/**
 * Static (hindsight) price chart for Dashboard v2.
 *
 * Reuses the exact same TradingChart component as Dashboard v1, in static mode:
 * candles + the selected strategy's overlays (VWMA, ±z·σ bands, and the dashed
 * ATR stop line that appears only while a trade is open) + entry/exit markers.
 *
 * When the Portfolio aggregate is selected we merge every strategy's overlays
 * and markers onto one set of candles (all per-strategy slices share the same
 * OHLCV for a given symbol/timeframe).
 */
export default function PriceChartV2({
  result, selectedId, active, symbol, timeframe, broker, portfolioId,
}) {
  const staticData = useMemo(() => {
    if (!result) return null;
    const isPortfolio = selectedId === portfolioId;
    const ids = isPortfolio ? active.map((s) => s.id) : [selectedId];

    const overlaysByStrategy = {};
    const markersByStrategy = {};
    let candles = null;
    for (const id of ids) {
      const psd = result.per_strategy?.[id];
      if (!psd) continue;
      if (!candles && psd.candles?.length) candles = psd.candles;
      overlaysByStrategy[id] = psd.overlays || [];
      markersByStrategy[id] = tradesToMarkers(psd.trades || []);
    }
    if (!candles) return null;
    return { candles, overlaysByStrategy, markersByStrategy };
  }, [result, selectedId, active, portfolioId]);

  // Session highlight bands only make sense for a single, non-24/7 strategy.
  const sessions = useMemo(() => {
    if (selectedId === portfolioId) return undefined;
    const p = active.find((a) => a.id === selectedId)?.params;
    if (!p || p.trade_24_7) return undefined;
    return p.sessions;
  }, [active, selectedId, portfolioId]);

  if (!staticData) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No chart data — run a backtest first.
      </div>
    );
  }

  return (
    <TradingChart
      mode="backtest"
      symbol={symbol}
      timeframe={timeframe}
      broker={broker || undefined}
      staticData={staticData}
      sessions={sessions}
    />
  );
}
