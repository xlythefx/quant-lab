import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle } from "lightweight-charts";
import { getOHLCV, getBacktestSeed, marketLabRegimeHmm } from "../services/api.js";
import { subscribeCandles, socket } from "../services/socket.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { REGIME_COLORS, ADX_REGIME_COLORS, buildRegimeColors } from "./marketlab/charts.jsx";
import { collapseMarkers } from "../services/chartMarkers.js";

// Regime lenses shown on the chart. 5-Mood and ADX ship with the backtest;
// HMM is fetched lazily (Market Lab endpoint) the first time it's selected.
const REGIME_LENSES = [
  { key: "five", label: "5-Mood" },
  { key: "adx",  label: "ADX" },
  { key: "hmm",  label: "HMM" },
];

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
  tokyo:  "rgba(239,68,68,0.07)",    // red
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

// #rrggbb -> rgba() at the given alpha, for soft regime bands.
// Mirrors RegimeCandleChart._alpha so the Dashboard and Market Lab look the same.
function _alpha(hex, a) {
  if (!hex || hex[0] !== "#" || hex.length < 7) return `rgba(100,116,139,${a})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export default function TradingChart({
  mode, symbol, timeframe, speed, broker,
  onMissingDataset,
  // streaming-only:
  markersByStrategy = {},
  activeStrategies = [],
  replayOpts,        // { start_time, end_time, loop } — backtest replay only
  // static-only:
  staticData,        // { candles, overlaysByStrategy, markersByStrategy }
  // shared:
  sessions,          // {tokyo:{enabled,start,end}, london:..., ny_am:..., ny_pm:...}
  regimeSegments = null, // { five:[...], adx:[...], default } — regime bands per lens (static mode)
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
  const regimeBandsLayerRef = useRef(null); // overlay div for regime (mood) bands
  // Live mirrors of session config + visibility. The scroll handlers are
  // subscribed once (in the [isStatic] effect) and would otherwise close over
  // stale prop/state values, blanking the bands on the first scroll.
  const sessionsRef = useRef(null);
  const showSessionsRef = useRef(true);
  // Same idea for the regime bands. We mirror the ACTIVE lens's segments + color
  // map so the scroll handlers redraw the currently-selected lens.
  const activeRegimeSegsRef = useRef([]);
  const activeRegimeColorsRef = useRef(REGIME_COLORS);
  const showRegimesRef = useRef(false);
  const hmmCacheRef = useRef(new Map());   // `${symbol}|${timeframe}` -> {segments, colors, labels}
  // Volume profile (VRVP): horizontal volume-by-price histogram over the visible bars.
  const volProfileLayerRef = useRef(null);
  const vpCandlesRef = useRef(null);       // mirror of staticData.candles for scroll handlers
  const showVolProfileRef = useRef(false);
  // Folded exit-stack counts: bar-time -> { count, wins, losses }. Populated when
  // markers are set; read by the crosshair handler to show "N exits" on hover.
  const exitCountsRef = useRef(new Map());
  const tooltipRef = useRef(null);         // floating "N exits (xW / yL)" tooltip div

  const [last, setLast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  // User-controlled visibility of the session-highlight bands. Persisted so the
  // choice sticks across reloads. Defaults to on to preserve prior behaviour.
  const [showSessions, setShowSessions] = usePersistentState("ql.chart.showSessions", true);
  // Regime (mood) bands. Default OFF — a scouting overlay you flip on to see which
  // moods the trades land in, then decide which to allow in the strategy.
  const [showRegimes, setShowRegimes] = usePersistentState("ql.chart.showRegimes", false);
  // Which regime lens colors the bands: "five" | "adx" | "hmm". Reset to the
  // strategy's default each run (see effect below); the user can override.
  const [regimeLens, setRegimeLens] = useState("five");
  // HMM is fetched on demand: { loading, error, segments, colors, labels }.
  const [hmmState, setHmmState] = useState(null);
  // Volume profile overlay. Default OFF — flip on to see where volume piled up by price.
  const [showVolProfile, setShowVolProfile] = usePersistentState("ql.chart.showVolProfile", false);

  const isStatic = !!staticData;

  const _styleFromName = (s) => (s === "dashed" ? LineStyle.Dashed : LineStyle.Solid);

  // Build session bands as absolutely-positioned divs overlaid on the chart.
  // Recomputes on every visible-range change.
  const _renderSessionBands = () => {
    const layer = bandsLayerRef.current;
    const chart = chartRef.current;
    if (!layer || !chart) return;
    layer.innerHTML = "";
    const sessions = sessionsRef.current;
    if (!sessions || !showSessionsRef.current) return;

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

  // Build regime bands: one translucent div per run-length-encoded segment, colored
  // by the active lens's color map. Same div-over-timeScale idiom as the sessions.
  const _renderRegimeBands = () => {
    const layer = regimeBandsLayerRef.current;
    const chart = chartRef.current;
    if (!layer || !chart) return;
    layer.innerHTML = "";
    const segments = activeRegimeSegsRef.current;
    const colors = activeRegimeColorsRef.current || {};
    if (!segments || !segments.length || !showRegimesRef.current) return;

    const ts = chart.timeScale();
    const tr = ts.getVisibleRange();
    if (!tr) return;
    const fromSec = Math.floor(tr.from);
    const toSec   = Math.ceil(tr.to);

    for (const s of segments) {
      if (s.end_time < fromSec || s.start_time > toSec) continue;
      const xs = ts.timeToCoordinate(Math.max(s.start_time, fromSec));
      const xe = ts.timeToCoordinate(Math.min(s.end_time, toSec));
      if (xs == null || xe == null) continue;
      const left = Math.min(xs, xe);
      const width = Math.max(1, Math.abs(xe - xs));
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.top = "0";
      div.style.bottom = "0";
      div.style.left = `${left}px`;
      div.style.width = `${width}px`;
      div.style.background = _alpha(colors[s.regime], 0.14);
      div.style.pointerEvents = "none";
      layer.appendChild(div);
    }
  };

  // Volume profile (VRVP): a horizontal volume-by-price histogram over the bars
  // currently in view. Binance gives candles, not ticks, so each bar's volume is
  // spread evenly across the price buckets its high–low range covers (the standard
  // candle approximation). Marks the POC (most-traded price) and the ~70% Value Area.
  const _renderVolProfile = () => {
    const layer = volProfileLayerRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    const el = containerRef.current;
    if (!layer || !chart || !series || !el) return;
    layer.innerHTML = "";
    const candles = vpCandlesRef.current;
    if (!candles || !candles.length || !showVolProfileRef.current) return;

    const tr = chart.timeScale().getVisibleRange();
    if (!tr) return;
    const fromSec = Math.floor(tr.from);
    const toSec   = Math.ceil(tr.to);
    const vis = candles.filter((c) => c.time >= fromSec && c.time <= toSec);
    if (vis.length < 2) return;

    let pMin = Infinity, pMax = -Infinity;
    for (const c of vis) { if (c.low < pMin) pMin = c.low; if (c.high > pMax) pMax = c.high; }
    if (!(pMax > pMin)) return;

    const N = 50;
    const bucket = (pMax - pMin) / N;
    const prof = new Array(N).fill(0);
    const clampIdx = (i) => (i < 0 ? 0 : i > N - 1 ? N - 1 : i);
    for (const c of vis) {
      const lo = clampIdx(Math.floor((c.low  - pMin) / bucket));
      const hi = clampIdx(Math.floor((c.high - pMin) / bucket));
      const span = hi - lo + 1;
      const per = (c.volume || 0) / span;
      for (let j = lo; j <= hi; j++) prof[j] += per;
    }

    let maxVol = 0, total = 0, pocIdx = 0;
    for (let i = 0; i < N; i++) { total += prof[i]; if (prof[i] > maxVol) { maxVol = prof[i]; pocIdx = i; } }
    if (maxVol <= 0) return;

    // Value Area: expand out from the POC, always taking the heavier neighbor,
    // until ~70% of total volume is enclosed (contiguous band, TradingView-style).
    let cum = prof[pocIdx], vaLo = pocIdx, vaHi = pocIdx;
    const target = 0.70 * total;
    while (cum < target && (vaLo > 0 || vaHi < N - 1)) {
      const above = vaHi < N - 1 ? prof[vaHi + 1] : -1;
      const below = vaLo > 0 ? prof[vaLo - 1] : -1;
      if (above >= below) { vaHi += 1; cum += prof[vaHi]; }
      else { vaLo -= 1; cum += prof[vaLo]; }
    }

    const maxW = Math.max(40, el.clientWidth * 0.28);   // longest bar ≈ 28% of width
    for (let i = 0; i < N; i++) {
      if (prof[i] <= 0) continue;
      const yTop = series.priceToCoordinate(pMin + (i + 1) * bucket);
      const yBot = series.priceToCoordinate(pMin + i * bucket);
      if (yTop == null || yBot == null) continue;
      const h = Math.max(1, Math.abs(yBot - yTop) - 1);
      const w = (prof[i] / maxVol) * maxW;
      const inVA = i >= vaLo && i <= vaHi;
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.left = "0";
      div.style.top = `${Math.min(yTop, yBot)}px`;
      div.style.width = `${w}px`;
      div.style.height = `${h}px`;
      div.style.pointerEvents = "none";
      div.style.background = i === pocIdx
        ? "rgba(251,191,36,0.55)"                 // POC — amber
        : inVA ? "rgba(96,165,250,0.34)"          // value area — blue
               : "rgba(148,163,184,0.20)";        // rest — slate
      layer.appendChild(div);
    }

    // POC line across the full width at the most-traded price.
    const yPoc = series.priceToCoordinate(pMin + (pocIdx + 0.5) * bucket);
    if (yPoc != null) {
      const line = document.createElement("div");
      line.style.position = "absolute";
      line.style.left = "0";
      line.style.right = "0";
      line.style.top = `${yPoc}px`;
      line.style.height = "1px";
      line.style.background = "rgba(251,191,36,0.7)";
      line.style.pointerEvents = "none";
      layer.appendChild(line);
    }
  };

  useEffect(() => {
    seriesRef.current?.applyOptions({ priceFormat: _priceFormat(symbol) });
  }, [symbol]);

  // Re-render bands when sessions prop or visibility toggle changes. Mirror the
  // values into refs first so the long-lived scroll handlers see fresh state.
  useEffect(() => {
    sessionsRef.current = sessions;
    showSessionsRef.current = showSessions;
    _renderSessionBands();
  }, [sessions, showSessions]);

  // Each new run, reset the lens to the strategy's default ("five" if it gates on
  // the 5-mood engine, else "adx"). Within a run the user can override via buttons.
  // NEVER auto-select the HMM lens, though: it kicks off a slow (~45s) Market Lab
  // fit the moment it's active (with Regimes left on). If the strategy gates on
  // HMM, we fall back to the cheap "five" lens here — the HMM ribbon only fetches
  // when the user explicitly clicks the HMM lens button.
  useEffect(() => {
    const def = regimeSegments?.default;
    if (def) setRegimeLens(def === "hmm" ? "five" : def);
  }, [regimeSegments]);

  // Lazy HMM: fetch (and cache) the Market Lab HMM only when its lens is selected.
  // The fit is slow on a cold cache (~45s) — we show a spinner meanwhile.
  useEffect(() => {
    if (!showRegimes || regimeLens !== "hmm") return;
    const candles = staticData?.candles;
    if (!candles || !candles.length) return;
    const startT = candles[0].time;
    const endT = candles[candles.length - 1].time;
    const key = `${symbol}|${timeframe}|${startT}|${endT}`;
    if (hmmCacheRef.current.has(key)) { setHmmState(hmmCacheRef.current.get(key)); return; }
    let cancelled = false;
    setHmmState({ loading: true });
    marketLabRegimeHmm({
      symbol, timeframe,
      start_time: startT,
      end_time: endT,
      params: {},
    }).then((data) => {
      if (cancelled) return;
      const labels = data?.meta?.labels || [];
      const method = data?.meta?.method || {};
      const result = {
        loading: false, segments: data?.segments || [], colors: buildRegimeColors(labels), labels,
        capped: !!method.capped, analyzedBars: method.analyzed_bars,
      };
      hmmCacheRef.current.set(key, result);
      setHmmState(result);
    }).catch((e) => {
      if (!cancelled) setHmmState({ loading: false, error: e?.message || "HMM failed" });
    });
    return () => { cancelled = true; };
  }, [regimeLens, showRegimes, symbol, timeframe, staticData]);

  // Mirror the ACTIVE lens's segments + colors into refs, then redraw. Runs on any
  // change to the lens, the band data, the HMM result, or the on/off toggle.
  useEffect(() => {
    let segs = [];
    let colors = REGIME_COLORS;
    if (regimeLens === "adx")      { segs = regimeSegments?.adx || [];  colors = ADX_REGIME_COLORS; }
    else if (regimeLens === "hmm") { segs = hmmState?.segments || [];   colors = hmmState?.colors || {}; }
    else                           { segs = regimeSegments?.five || []; colors = REGIME_COLORS; }
    activeRegimeSegsRef.current = segs;
    activeRegimeColorsRef.current = colors;
    showRegimesRef.current = showRegimes;
    _renderRegimeBands();
  }, [regimeLens, regimeSegments, hmmState, showRegimes]);

  // Mirror candles + toggle into refs (for the scroll handlers), then redraw the
  // volume profile. Recomputes whenever the data or the toggle changes.
  useEffect(() => {
    vpCandlesRef.current = staticData?.candles || null;
    showVolProfileRef.current = showVolProfile;
    _renderVolProfile();
  }, [staticData, showVolProfile]);

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
      _renderRegimeBands();
      _renderVolProfile();
    };
    const handleVisibleTimeRange = () => { _renderSessionBands(); _renderRegimeBands(); _renderVolProfile(); };
    ts.subscribeVisibleLogicalRangeChange(handleVisibleRange);
    ts.subscribeVisibleTimeRangeChange(handleVisibleTimeRange);

    // Hover tooltip for folded exit stacks: when the crosshair is over a bar whose
    // exits were collapsed into one square, show how many closed there.
    const handleCrosshair = (param) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const info = param?.time != null ? exitCountsRef.current.get(param.time) : null;
      if (!info || !param.point) { tip.style.display = "none"; return; }
      const wl = (info.wins || info.losses) ? `  ·  ${info.wins}W / ${info.losses}L` : "";
      tip.textContent = `${info.count} exits${wl}`;
      tip.style.display = "block";
      tip.style.left = `${param.point.x + 14}px`;
      tip.style.top = `${Math.max(4, param.point.y - 10)}px`;
    };
    chart.subscribeCrosshairMove(handleCrosshair);

    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      ts.unsubscribeVisibleTimeRangeChange(handleVisibleTimeRange);
      chart.unsubscribeCrosshairMove(handleCrosshair);
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

    // Markers — merge across strategies, then fold same-bar exit stacks into one
    // square each (hover shows how many closed together).
    const markersByStrat = staticData.markersByStrategy || {};
    const merged = [];
    for (const list of Object.values(markersByStrat)) {
      for (const m of list || []) merged.push(m);
    }
    const { markers: collapsed, counts } = collapseMarkers(merged);
    exitCountsRef.current = counts;
    try { series.setMarkers(collapsed); } catch {}

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
    _renderRegimeBands();
    _renderVolProfile();
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
          const seed = await getBacktestSeed({ symbol, timeframe, limit: SEED_LIMIT, broker });
          candles = seed.candles;
        } else {
          candles = await getOHLCV({ symbol, timeframe, mode, limit: 1000, broker });
        }
        if (cancelled) return;

        paint(candles);
        setLast(candles[candles.length - 1] || null);
        setLoading(false);

        unsub = subscribeCandles({
          mode, symbol, timeframe, speed, broker,
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
  }, [isStatic, mode, symbol, timeframe, broker]);

  // Streaming-mode marker reconciliation (signals trickle in over time).
  useEffect(() => {
    if (isStatic) return;
    const series = seriesRef.current;
    if (!series) return;
    const merged = [];
    for (const list of Object.values(markersByStrategy)) {
      for (const m of list || []) merged.push(m);
    }
    const { markers: collapsed, counts } = collapseMarkers(merged);
    exitCountsRef.current = counts;
    try { series.setMarkers(collapsed); } catch {}
  }, [isStatic, markersByStrategy]);

  // Regime overlay availability + legend entries for the active lens.
  const hasRegimeData = !!(regimeSegments && (regimeSegments.five?.length || regimeSegments.adx?.length));
  const legendEntries = (() => {
    if (regimeLens === "adx") return Object.entries(ADX_REGIME_COLORS);
    if (regimeLens === "hmm") {
      const cols = hmmState?.colors || {};
      const labs = hmmState?.labels?.length ? hmmState.labels : Object.keys(cols);
      return labs.map((l) => [l, cols[l]]);
    }
    return Object.entries(REGIME_COLORS);
  })();

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {/* Volume profile — horizontal volume-by-price histogram, drawn behind the bands. */}
      <div ref={volProfileLayerRef} className="absolute inset-0 pointer-events-none z-[3]" />
      {/* Regime (mood) bands — one z-index below sessions so a tinted session still reads. */}
      <div ref={regimeBandsLayerRef} className="absolute inset-0 pointer-events-none z-[4]" />
      {/* Session bands overlay — rendered imperatively, positioned by chart timeScale. */}
      <div ref={bandsLayerRef} className="absolute inset-0 pointer-events-none z-[5]" />
      {/* Folded exit-stack hover tooltip — positioned at the crosshair point. */}
      <div
        ref={tooltipRef}
        style={{ display: "none" }}
        className="absolute z-20 pointer-events-none px-2 py-1 rounded-md border border-line bg-bg-elev/95 text-[11px] font-mono text-text whitespace-nowrap shadow-lg"
      />

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

      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        {isStatic && staticData?.candles?.length > 0 && (
          <button
            type="button"
            onClick={() => setShowVolProfile((v) => !v)}
            title={showVolProfile ? "Hide volume profile" : "Show volume profile (volume by price)"}
            className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-widest rounded-md border transition-colors ${
              showVolProfile
                ? "bg-amber-400/20 text-amber-300 border-amber-400/40"
                : "bg-bg-elev/60 text-muted border-line hover:text-text"
            }`}
          >
            Volume {showVolProfile ? "on" : "off"}
          </button>
        )}
        {hasRegimeData && (
          <button
            type="button"
            onClick={() => setShowRegimes((v) => !v)}
            title={showRegimes ? "Hide regime (mood) bands" : "Show regime (mood) bands"}
            className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-widest rounded-md border transition-colors ${
              showRegimes
                ? "bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40"
                : "bg-bg-elev/60 text-muted border-line hover:text-text"
            }`}
          >
            Regimes {showRegimes ? "on" : "off"}
          </button>
        )}
        {sessions && (
          <button
            type="button"
            onClick={() => setShowSessions((v) => !v)}
            title={showSessions ? "Hide session highlight bands" : "Show session highlight bands"}
            className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-widest rounded-md border transition-colors ${
              showSessions
                ? "bg-accent-violet/20 text-accent-violet border-accent-violet/40"
                : "bg-bg-elev/60 text-muted border-line hover:text-text"
            }`}
          >
            Sessions {showSessions ? "on" : "off"}
          </button>
        )}
      </div>

      {/* Regime lens selector + color legend (only while the bands are showing). */}
      {showRegimes && hasRegimeData && (
        <div className="absolute top-12 right-3 z-10 w-44 rounded-md border border-line bg-bg-elev/85 backdrop-blur px-2.5 py-2 text-[10px]">
          <div className="flex items-center gap-1 mb-2">
            {REGIME_LENSES.map((L) => (
              <button
                key={L.key}
                type="button"
                onClick={() => setRegimeLens(L.key)}
                className={`flex-1 px-1.5 py-1 font-semibold uppercase tracking-wider rounded transition-colors ${
                  regimeLens === L.key
                    ? "bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/40"
                    : "bg-bg/40 text-muted border border-line hover:text-text"
                }`}
              >
                {L.label}
              </button>
            ))}
          </div>
          {regimeLens === "hmm" && hmmState?.loading ? (
            <div className="text-muted py-1">fitting HMM… (~45s first run)</div>
          ) : regimeLens === "hmm" && hmmState?.error ? (
            <div className="text-red-400 py-1">HMM failed: {hmmState.error}</div>
          ) : (
            <div className="flex flex-col gap-1">
              {legendEntries.map(([label, color]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color || "#64748b" }} />
                  <span className="text-text/80 truncate" title={label}>{label}</span>
                </div>
              ))}
              {regimeLens === "hmm" && hmmState?.capped && (
                <div className="text-muted/70 mt-1 leading-snug">
                  Recent {hmmState.analyzedBars?.toLocaleString?.() || hmmState.analyzedBars} bars only (HMM speed cap).
                </div>
              )}
            </div>
          )}
        </div>
      )}

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
