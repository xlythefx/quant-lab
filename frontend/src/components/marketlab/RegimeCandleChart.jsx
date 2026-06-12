import { useEffect, useRef } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

/**
 * OHLC candles (lightweight-charts) with the detected regime drawn as a colored
 * background band behind the bars. Mirrors the session-band idiom in TradingChart.jsx:
 * bands are absolutely-positioned divs positioned via the chart's timeScale, redrawn
 * on every visible-range change.
 *
 * Props:
 *   candles:  [{time, open, high, low, close, regime}]
 *   segments: [{regime, start_time, end_time}]  (run-length-encoded regimes)
 *   colors:   { regimeLabel -> cssColor }
 *   height:   px
 */
export default function RegimeCandleChart({ candles = [], segments = [], colors = {}, height = 360 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const bandsRef = useRef(null);
  const segmentsRef = useRef(segments);
  const colorsRef = useRef(colors);

  // Convert a #rrggbb to an rgba() string with the given alpha (for soft bands).
  const _alpha = (hex, a) => {
    if (!hex || hex[0] !== "#" || hex.length < 7) return `rgba(100,116,139,${a})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  };

  const renderBands = () => {
    const layer = bandsRef.current;
    const chart = chartRef.current;
    if (!layer || !chart) return;
    layer.innerHTML = "";
    const ts = chart.timeScale();
    const tr = ts.getVisibleRange();
    if (!tr) return;
    const from = Math.floor(tr.from);
    const to = Math.ceil(tr.to);
    for (const s of segmentsRef.current || []) {
      if (s.end_time < from || s.start_time > to) continue;
      const xs = ts.timeToCoordinate(Math.max(s.start_time, from));
      const xe = ts.timeToCoordinate(Math.min(s.end_time, to));
      if (xs == null || xe == null) continue;
      const left = Math.min(xs, xe);
      const width = Math.max(1, Math.abs(xe - xs));
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.top = "0";
      div.style.bottom = "0";
      div.style.left = `${left}px`;
      div.style.width = `${width}px`;
      div.style.background = _alpha((colorsRef.current || {})[s.regime], 0.16);
      div.style.pointerEvents = "none";
      layer.appendChild(div);
    }
  };

  // Build the chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#9ca3af",
                fontFamily: "JetBrains Mono, ui-monospace, monospace" },
      grid: { vertLines: { color: "rgba(31,32,48,0.6)" }, horzLines: { color: "rgba(31,32,48,0.6)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2030" },
      timeScale: { borderColor: "#1f2030", timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 4 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#3b82f6", downColor: "#ef4444",
      borderUpColor: "#3b82f6", borderDownColor: "#ef4444",
      wickUpColor: "#60a5fa", wickDownColor: "#f87171",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const ts = chart.timeScale();
    const onRange = () => renderBands();
    ts.subscribeVisibleTimeRangeChange(onRange);
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      ts.unsubscribeVisibleTimeRangeChange(onRange);
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push candle data + frame the most recent ~300 bars.
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(
      candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    if (candles.length) {
      const visible = Math.min(300, candles.length);
      chart.timeScale().setVisibleLogicalRange({ from: candles.length - visible, to: candles.length + 6 });
    }
    renderBands();
  }, [candles]);

  // Redraw bands when regimes/colors change.
  useEffect(() => {
    segmentsRef.current = segments;
    colorsRef.current = colors;
    renderBands();
  }, [segments, colors]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />
      <div ref={bandsRef} className="absolute inset-0 pointer-events-none z-[2]" />
    </div>
  );
}
