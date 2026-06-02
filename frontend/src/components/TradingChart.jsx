import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import { getOHLCV, getBacktestSeed } from "../services/api.js";
import { subscribeCandles, socket } from "../services/socket.js";

const MAX_BARS = 100000;
const SEED_LIMIT = 5000;

/**
 * Two render modes:
 *  - STATIC (Hindsight): caller passes `staticData`. We just setData. No sockets.
 *  - STREAMING (Replay + Live): we fetch a seed, subscribe to candle_update,
 *    and listen to indicator_init / indicator_tick events.
 */
// Session band colors (matches StrategyEditor labels).
const SESSION_BAND_COLORS = {
  tokyo:  "rgba(59,130,246,0.07)",   // blue
  london: "rgba(34,197,94,0.07)",    // green
  ny_am:  "rgba(245,158,11,0.07)",   // amber
  ny_pm:  "rgba(139,92,246,0.07)",   // violet
};

function _priceFormat(sym) {
  const btc = sym && sym.startsWith("BTC");
  return btc
    ? { type: "price", precision: 4, minMove: 0.0001 }
    : { type: "price", precision: 6, minMove: 0.000001 };
}

function _hhmmToSec(s) {
  const m = (s || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Math.min(23, parseInt(m[1], 10)) * 3600 + Math.min(59, parseInt(m[2], 10)) * 60;
}

export default function TradingChart({
  mode, symbol, timeframe, speed,
  onMissingDataset,
  // streaming-only:
  markersByStrategy = {},
  activeStrategies = [],
  replayOpts,        // { start_time, end_time, loop } — backtest replay only
  // static-only:
  staticData,        // { candles, overlaysByStrategy, markersByStrategy }
  // shared:
  sessions,          // {tokyo:{enabled,start,end}, london:..., ny_am:..., ny_pm:...}
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeRef = useRef(null);
  const lastSeriesIndexRef = useRef(null);
  const userScrolledBackRef = useRef(false);
  // strategyId -> overlayKey -> lineSeries
  const indicatorSeriesRef = useRef({});
  const bandsLayerRef = useRef(null);     // overlay div for session bands

  const [last, setLast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const isStatic = !!staticData;

  const _styleFromName = (s) => (s === "dashed" ? LineStyle.Dashed : LineStyle.Solid);

  // Build session bands as absolutely-positioned divs overlaid on the chart.
  // Recomputes on every visible-range change.
  const _renderSessionBands = () => {
    const layer = bandsLayerRef.current;
    const chart = chartRef.current;
    if (!layer || !chart) return;
    layer.innerHTML = "";
    if (!sessions) return;

    const ts = chart.timeScale();
    const tr = ts.getVisibleRange();
    if (!tr) return;
    const fromSec = Math.floor(tr.from);
    const toSec   = Math.ceil(tr.to);

    // Iterate visible UTC days; for each enabled session render one band per day.
    const dayStart = Math.floor(fromSec / 86400) * 86400;
    const dayEnd   = Math.ceil(toSec / 86400) * 86400;
    const enabled = Object.entries(sessions).filter(([_, cfg]) => cfg && cfg.enabled);

    for (let day = dayStart; day < dayEnd + 86400; day += 86400) {
      for (const [name, cfg] of enabled) {
        const startOff = _hhmmToSec(cfg.start);
        const endOff   = _hhmmToSec(cfg.end);
        // Wraps midnight: split into two segments.
        const segments = endOff > startOff
          ? [[day + startOff, day + endOff]]
          : [[day + startOff, day + 86400], [day, day + endOff]];
        for (const [s, e] of segments) {
          if (e < fromSec || s > toSec) continue;
          const xs = ts.timeToCoordinate(s);
          const xe = ts.timeToCoordinate(e);
          if (xs == null || xe == null) continue;
          const left = Math.min(xs, xe);
          const width = Math.max(1, Math.abs(xe - xs));
          const div = document.createElement("div");
          div.style.position = "absolute";
          div.style.top = "0";
          div.style.bottom = "0";
          div.style.left = `${left}px`;
          div.style.width = `${width}px`;
          div.style.background = SESSION_BAND_COLORS[name] || "rgba(255,255,255,0.04)";
          div.style.pointerEvents = "none";
          layer.appendChild(div);
        }
      }
    }
  };

  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: _priceFormat(symbol) });
  }, [symbol]);

  // Re-render bands when sessions prop changes.
  useEffect(() => { _renderSessionBands(); }, [sessions]);

  const _removeStrategyOverlays = (strategyId) => {
    const chart = chartRef.current;
    const map = indicatorSeriesRef.current[strategyId];
    if (!chart || !map) return;
    for (const k of Object.keys(map)) {
      try { chart.removeSeries(map[k]); } catch {}
    }
    delete indicatorSeriesRef.current[strategyId];
  };

  // ---- Chart construction (same for both modes) -------------------
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
        vertLines: { color: "rgba(31,32,48,0.6)" },
        horzLines: { color: "rgba(31,32,48,0.6)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2030" },
      timeScale: {
        borderColor: "#1f2030",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 6,
      },
      autoSize: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#3b82f6",
      downColor: "#ef4444",
      borderUpColor: "#3b82f6",
      borderDownColor: "#ef4444",
      wickUpColor: "#60a5fa",
      wickDownColor: "#f87171",
      priceFormat: _priceFormat(symbol),
    });

    const volume = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "rgba(139,92,246,0.4)",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    const ts = chart.timeScale();
    const handleVisibleRange = () => {
      const lr = ts.getVisibleLogicalRange();
      if (!lr || lastSeriesIndexRef.current == null) return;
      userScrolledBackRef.current = lr.to < lastSeriesIndexRef.current - 3;
      _renderSessionBands();
    };
    const handleVisibleTimeRange = () => _renderSessionBands();
    ts.subscribeVisibleLogicalRangeChange(handleVisibleRange);
    ts.subscribeVisibleTimeRangeChange(handleVisibleTimeRange);

    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      ts.unsubscribeVisibleTimeRangeChange(handleVisibleTimeRange);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      indicatorSeriesRef.current = {};
    };
    // Only rebuild on static<->streaming switch. Symbol/timeframe changes
    // are absorbed via setData so the chart instance survives.
  }, [isStatic]);

  // ============================================================
  // STATIC mode (Hindsight)
  // ============================================================
  useEffect(() => {
    if (!isStatic) return;
    const chart = chartRef.current;
    const series = seriesRef.current;
    const volume = volumeRef.current;
    if (!chart || !series || !volume || !staticData) return;

    setErr(null);
    setLoading(false);
    userScrolledBackRef.current = false;

    const candles = staticData.candles || [];
    series.setData(
      candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    volume.setData(
      candles.map((c) => ({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.45)",
      }))
    );
    lastSeriesIndexRef.current = candles.length - 1;
    setLast(candles[candles.length - 1] || null);

    // Reconcile per-strategy overlays from staticData.overlaysByStrategy.
    const overlaysByStrategy = staticData.overlaysByStrategy || {};
    const wantSet = new Set(Object.keys(overlaysByStrategy));
    for (const sid of Object.keys(indicatorSeriesRef.current)) {
      if (!wantSet.has(sid)) _removeStrategyOverlays(sid);
    }
    for (const [sid, overlays] of Object.entries(overlaysByStrategy)) {
      _removeStrategyOverlays(sid);
      const bucket = (indicatorSeriesRef.current[sid] = {});
      for (const ov of overlays || []) {
        const s = chart.addLineSeries({
          color: ov.color,
          lineWidth: ov.line_width ?? 1,
          lineStyle: _styleFromName(ov.line_style),
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceScaleId: "right",
        });
        s.setData(ov.data || []);
        bucket[ov.key] = s;
      }
    }

    // Markers — merge across strategies.
    const markersByStrat = staticData.markersByStrategy || {};
    const merged = [];
    for (const list of Object.values(markersByStrat)) {
      for (const m of list || []) merged.push(m);
    }
    merged.sort((a, b) => a.time - b.time);
    try { series.setMarkers(merged); } catch {}

    // Show the last ~300 bars by default.
    const ts = chart.timeScale();
    if (candles.length > 0) {
      const visibleBars = Math.min(300, candles.length);
      ts.setVisibleLogicalRange({
        from: candles.length - visibleBars,
        to: candles.length + 8,
      });
    }
    _renderSessionBands();
  }, [isStatic, staticData, sessions]);

  // ============================================================
  // STREAMING mode (Replay + Live)
  // ============================================================
  useEffect(() => {
    if (isStatic) return;

    const onInit = (p) => {
      const chart = chartRef.current;
      if (!chart) return;
      if (p.symbol !== symbol || p.timeframe !== timeframe) return;
      if (!activeStrategies.find((s) => s.id === p.strategy_id)) return;

      _removeStrategyOverlays(p.strategy_id);
      const bucket = (indicatorSeriesRef.current[p.strategy_id] = {});
      for (const ov of p.specs || []) {
        bucket[ov.key] = chart.addLineSeries({
          color: ov.color,
          lineWidth: ov.line_width ?? 1,
          lineStyle: _styleFromName(ov.line_style),
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceScaleId: "right",
        });
      }
    };
    const onTick = (p) => {
      const bucket = indicatorSeriesRef.current[p.strategy_id];
      if (!bucket) return;
      for (const [key, value] of Object.entries(p.values || {})) {
        const s = bucket[key];
        if (s) { try { s.update({ time: p.time, value: Number(value) }); } catch {} }
      }
    };

    socket.on("indicator_init", onInit);
    socket.on("indicator_tick", onTick);
    return () => {
      socket.off("indicator_init", onInit);
      socket.off("indicator_tick", onTick);
    };
  }, [isStatic, symbol, timeframe, activeStrategies]);

  useEffect(() => {
    if (isStatic) return;
    const wantIds = new Set(activeStrategies.map((s) => s.id));
    for (const sid of Object.keys(indicatorSeriesRef.current)) {
      if (!wantIds.has(sid)) _removeStrategyOverlays(sid);
    }
  }, [isStatic, activeStrategies]);

  useEffect(() => {
    if (isStatic) return;

    let cancelled = false;
    let unsub = () => {};
    setLoading(true);
    setErr(null);
    setLast(null);
    userScrolledBackRef.current = false;
    lastSeriesIndexRef.current = null;

    let bars = [];
    let lastTime = -Infinity;

    const paint = (initial) => {
      const tail = initial.slice(-MAX_BARS);
      bars = tail;
      lastTime = tail.length ? tail[tail.length - 1].time : -Infinity;
      seriesRef.current?.setData(
        tail.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
      );
      volumeRef.current?.setData(
        tail.map((c) => ({
          time: c.time, value: c.volume,
          color: c.close >= c.open ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.45)",
        }))
      );
      lastSeriesIndexRef.current = tail.length - 1;
      const visibleBars = Math.min(200, tail.length);
      const ts = chartRef.current?.timeScale();
      if (ts && tail.length > 0) {
        ts.setVisibleLogicalRange({
          from: tail.length - visibleBars,
          to: tail.length + 8,
        });
      }
    };

    const apply = (c) => {
      if (c.time < lastTime) return;
      seriesRef.current?.update({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
      });
      volumeRef.current?.update({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.45)",
      });
      if (c.time > lastTime) {
        bars.push(c);
        lastTime = c.time;
        lastSeriesIndexRef.current = (lastSeriesIndexRef.current ?? -1) + 1;
        if (!userScrolledBackRef.current) {
          chartRef.current?.timeScale().scrollToRealTime();
        }
        if (bars.length > MAX_BARS + 200) {
          bars = bars.slice(-MAX_BARS);
          seriesRef.current?.setData(
            bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
          );
          volumeRef.current?.setData(
            bars.map((b) => ({
              time: b.time, value: b.volume,
              color: b.close >= b.open ? "rgba(59,130,246,0.45)" : "rgba(239,68,68,0.45)",
            }))
          );
          lastSeriesIndexRef.current = bars.length - 1;
        }
      } else {
        bars[bars.length - 1] = c;
      }
      setLast(c);
    };

    (async () => {
      try {
        let candles;
        if (mode === "backtest") {
          const seed = await getBacktestSeed({ symbol, timeframe, limit: SEED_LIMIT });
          candles = seed.candles;
        } else {
          candles = await getOHLCV({ symbol, timeframe, mode, limit: 1000 });
        }
        if (cancelled) return;

        paint(candles);
        setLast(candles[candles.length - 1] || null);
        setLoading(false);

        unsub = subscribeCandles({
          mode, symbol, timeframe, speed,
          ...(replayOpts || {}),
        }, apply, (msg) => { if (!cancelled) setErr(msg); });
      } catch (e) {
        if (!cancelled) {
          console.error(e);
          const status = e?.response?.status;
          if (status === 404 && mode === "backtest") {
            setErr("__MISSING__");
            onMissingDataset?.();
          } else {
            setErr(e?.response?.data?.error || e.message || "failed to load");
          }
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStatic, mode, symbol, timeframe]);

  // Streaming-mode marker reconciliation (signals trickle in over time).
  useEffect(() => {
    if (isStatic) return;
    const series = seriesRef.current;
    if (!series) return;
    const merged = [];
    for (const list of Object.values(markersByStrategy)) {
      for (const m of list || []) merged.push(m);
    }
    merged.sort((a, b) => a.time - b.time);
    try { series.setMarkers(merged); } catch {}
  }, [isStatic, markersByStrategy]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {/* Session bands overlay — rendered imperatively, positioned by chart timeScale. */}
      <div ref={bandsLayerRef} className="absolute inset-0 pointer-events-none z-[5]" />

      <div className="absolute top-3 left-3 flex items-center gap-3 z-10 pointer-events-none">
        <span
          className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-widest rounded-md ${
            mode === "backtest"
              ? "bg-accent-violet/20 text-accent-violet border border-accent-violet/40"
              : "bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40"
          }`}
        >
          {mode}{isStatic && mode === "backtest" ? " · hindsight" : ""}
        </span>
        <span className="text-xs text-muted font-mono">{symbol} · {timeframe}</span>
        {last && (
          <span className="text-sm font-mono text-text">
            {Number(last.close).toFixed(symbol.startsWith("BTC") ? 4 : 6)}
          </span>
        )}
      </div>

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm bg-bg/40 backdrop-blur-sm z-20">
          loading {mode} candles…
        </div>
      )}
      {err === "__MISSING__" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-bg/85 backdrop-blur">
          <div className="text-text text-base">
            No cached dataset for <span className="font-mono text-accent-violet">{symbol} {timeframe}</span>
          </div>
          <div className="text-xs text-muted">Download it (or re-download) from the Downloads page.</div>
          <a href="#downloads" className="mt-2 px-4 py-2 rounded-md bg-accent-grad text-white text-sm font-medium">
            Open Downloads page →
          </a>
        </div>
      )}
      {err && err !== "__MISSING__" && (
        <div className="absolute inset-0 flex items-center justify-center text-loss text-sm bg-bg/60 z-20">
          error: {err}
        </div>
      )}
    </div>
  );
}
