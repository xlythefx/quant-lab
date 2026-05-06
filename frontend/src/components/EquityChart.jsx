import { useEffect, useRef } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

/**
 * Multi-line equity chart. One line per active strategy.
 *
 * props:
 *   strategies: [{id, color}]
 *   pointsByStrategy: {id: [{time, value}, ...]}  (caller manages)
 */
export default function EquityChart({ strategies, pointsByStrategy }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({}); // id -> series

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor: "#9ca3af",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "rgba(31,32,48,0.4)" },
        horzLines: { color: "rgba(31,32,48,0.4)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2030" },
      timeScale: { borderColor: "#1f2030", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, []);

  // Reconcile series with the active strategies set.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const wantIds = new Set(strategies.map((s) => s.id));

    // Remove series no longer active.
    for (const id of Object.keys(seriesRef.current)) {
      if (!wantIds.has(id)) {
        try { chart.removeSeries(seriesRef.current[id]); } catch {}
        delete seriesRef.current[id];
      }
    }
    // Add new ones.
    for (const s of strategies) {
      if (!seriesRef.current[s.id]) {
        seriesRef.current[s.id] = chart.addLineSeries({
          color: s.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
        });
      } else {
        seriesRef.current[s.id].applyOptions({ color: s.color });
      }
    }
  }, [strategies]);

  // Push data into each series whenever the points change.
  useEffect(() => {
    for (const s of strategies) {
      const series = seriesRef.current[s.id];
      if (!series) continue;
      const pts = pointsByStrategy[s.id] || [];
      series.setData(pts);
    }
  }, [pointsByStrategy, strategies]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      <div className="absolute top-2 left-3 text-[10px] uppercase tracking-widest text-muted z-10 pointer-events-none">
        Equity (%)
      </div>
    </div>
  );
}
