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
 *
 * Candles/overlays/regime bands come from `chartData` — fetched lazily by the
 * page when this tab opens (/api/backtest/chart-data), NOT from the portfolio
 * response, which no longer carries per-bar series. Markers still come from
 * the trades in `result`, which the portfolio response does carry.
 */
export default function PriceChartV2({
  result, chartData, loading, selectedId, active, symbol, timeframe, broker, portfolioId,
}) {
  const { staticData, regimeSegments } = useMemo(() => {
    if (!result || !chartData) return { staticData: null, regimeSegments: null };
    const isPortfolio = selectedId === portfolioId;
    const ids = isPortfolio ? active.map((s) => s.id) : [selectedId];

    const overlaysByStrategy = {};
    const markersByStrategy = {};
    let candles = null;
    // Regime bands {five, adx, default} from the selected strategy (or the first
    // regime-aware strategy when the Portfolio aggregate is selected) — mirrors v1.
    let regimeSegments = null;
    for (const id of ids) {
      const psd = result.per_strategy?.[id];
      if (!psd) continue;
      if (!candles) {
        // Candles are stored once per dataset; resolve via this strategy's key.
        const key = chartData.dataset_key_by_strategy?.[id];
        const c = key ? chartData.candles_by_dataset?.[key] : null;
        if (c?.length) candles = c;
      }
      const rs = chartData.regime_segments_by_strategy?.[id];
      if (!regimeSegments && rs && Object.keys(rs).length) regimeSegments = rs;
      overlaysByStrategy[id] = chartData.overlays_by_strategy?.[id] || [];
      markersByStrategy[id] = tradesToMarkers(psd.trades || []);
    }
    if (!candles) return { staticData: null, regimeSegments: null };
    return { staticData: { candles, overlaysByStrategy, markersByStrategy }, regimeSegments };
  }, [result, chartData, selectedId, active, portfolioId]);

  // Session highlight bands only make sense for a single, non-24/7 strategy.
  const sessions = useMemo(() => {
    if (selectedId === portfolioId) return undefined;
    const p = active.find((a) => a.id === selectedId)?.params;
    if (!p || p.trade_24_7) return undefined;
    return p.sessions;
  }, [active, selectedId, portfolioId]);

  if (!staticData) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm gap-2">
        {loading ? (
          <>
            <span className="w-3.5 h-3.5 rounded-full border-2 border-accent-blue border-t-transparent animate-spin" />
            Loading chart data…
          </>
        ) : (
          "No chart data — run a backtest first."
        )}
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
      regimeSegments={regimeSegments}
    />
  );
}
