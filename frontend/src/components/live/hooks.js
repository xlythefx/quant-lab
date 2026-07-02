import { useEffect, useRef, useState } from "react";
import { useDataMode } from "./dataMode.jsx";
import { getLiveInstruments, getLiveCandles, getLiveTicker } from "./liveApi.js";
import { subscribeLiveCandles, onGateway, onSocketReconnect } from "./liveChannels.js";
import * as sim from "./simFeed.js";

/**
 * Terminal data hooks. Each one honors the terminal-wide mock ⇄ live toggle
 * (dataMode context): "mock" runs on simFeed, "live" on the real backend.
 * The returned `simulated` flag drives the SIMULATED badge — always truthful.
 */

export function useInstruments() {
  const [data, setData] = useState({ instruments: [], timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"] });
  useEffect(() => {
    let dead = false;
    getLiveInstruments()
      .then((d) => { if (!dead) setData(d); })
      .catch(() => {
        if (!dead) setData({
          instruments: [
            { symbol: "BTCUSDT", venue: "BINANCE", cls: "crypto", label: "Bitcoin / USDT", priceDecimals: 2 },
            { symbol: "LTCUSDT", venue: "BINANCE", cls: "crypto", label: "Litecoin / USDT", priceDecimals: 2 },
          ],
          timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"],
        });
      });
    return () => { dead = true; };
  }, []);
  return data;
}

/**
 * Live candles for (symbol, timeframe): REST snapshot for first paint, then
 * the shared Binance kline stream over Socket.IO. On socket reconnect the
 * snapshot is re-fetched so the chart is never left stale/gapped.
 * Watchdog: no frame for 45s ⇒ stale=true (drives the loud feed warning).
 */
export function useLiveCandles(symbol, timeframe) {
  const { dataMode } = useDataMode();
  const mock = dataMode === "mock";
  const [candles, setCandles] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ok | error
  const [stale, setStale] = useState(false);
  const lastFrameAt = useRef(0);

  useEffect(() => {
    let dead = false;
    setCandles([]);
    setStatus("loading");
    setStale(false);

    if (mock) {
      const seed = sim.genCandles(symbol, timeframe, 300);
      setCandles(seed);
      setStatus("ok");
      const t = setInterval(() => {
        setCandles((prev) => sim.tickCandles(symbol, timeframe, prev));
      }, 900);
      return () => { dead = true; clearInterval(t); };
    }

    const fetchSnapshot = () =>
      getLiveCandles({ symbol, timeframe, limit: 300 })
        .then((rows) => {
          if (dead) return;
          setCandles(rows || []);
          setStatus("ok");
        })
        .catch(() => { if (!dead) setStatus("error"); });

    fetchSnapshot();

    const unsub = subscribeLiveCandles(symbol, timeframe, (c) => {
      lastFrameAt.current = Date.now();
      setStale(false);
      setCandles((prev) => {
        if (!prev.length) return [{ ...c }];
        const last = prev[prev.length - 1];
        if (c.time === last.time) return [...prev.slice(0, -1), { ...c }];
        if (c.time > last.time) return [...prev.slice(-499), { ...c }];
        return prev;
      });
    }, () => { if (!dead) setStatus("error"); });

    // Resilience: backfill via REST after a reconnect before resuming live.
    const offReconnect = onSocketReconnect(() => fetchSnapshot());

    const watchdog = setInterval(() => {
      if (lastFrameAt.current && Date.now() - lastFrameAt.current > 45_000) setStale(true);
    }, 5_000);

    return () => {
      dead = true;
      unsub();
      offReconnect();
      clearInterval(watchdog);
    };
  }, [symbol, timeframe, mock]);

  const lastPrice = candles.length ? candles[candles.length - 1].close : null;
  return { candles, lastPrice, status, stale, simulated: mock };
}

/** 24h ticker stats (REST, refreshed ~30s). Live tick comes from the candle feed. */
export function useTicker(symbol) {
  const { dataMode } = useDataMode();
  const mock = dataMode === "mock";
  const [ticker, setTicker] = useState(null);

  useEffect(() => {
    let dead = false;
    setTicker(null);
    if (mock) {
      setTicker(sim.mockTicker(symbol));
      const t = setInterval(() => { if (!dead) setTicker(sim.mockTicker(symbol)); }, 5000);
      return () => { dead = true; clearInterval(t); };
    }
    const pull = () => getLiveTicker(symbol).then((t) => { if (!dead) setTicker(t); }).catch(() => {});
    pull();
    const t = setInterval(pull, 30_000);
    return () => { dead = true; clearInterval(t); };
  }, [symbol, mock]);

  return { ticker, simulated: mock };
}

/**
 * Order book behind a clean seam: SIMULATED generator today, real Binance
 * partial-depth stream drop-in in phase 08 (see ref-binance-orderbook.md).
 * `simulated` in the result always tells the truth for the badge.
 */
export function useOrderBook(symbol, lastPrice) {
  const [book, setBook] = useState(null);
  const priceRef = useRef(lastPrice);
  priceRef.current = lastPrice;

  useEffect(() => {
    setBook(null);
    const tick = () => setBook(sim.mockBook(symbol, priceRef.current));
    tick();
    const t = setInterval(tick, 1500);
    return () => clearInterval(t);
  }, [symbol]);

  return { book, simulated: true };
}

/** Time & Sales — SIMULATED streaming prints (~0.8s), newest first. */
export function useTape(symbol, lastPrice) {
  const [prints, setPrints] = useState([]);
  const priceRef = useRef(lastPrice);
  priceRef.current = lastPrice;

  useEffect(() => {
    setPrints([]);
    const t = setInterval(() => {
      setPrints((prev) => [sim.mockPrint(symbol, priceRef.current), ...prev].slice(0, 42));
    }, 800);
    return () => clearInterval(t);
  }, [symbol]);

  return { prints, simulated: true };
}

/** Footer gateway heartbeat; degrades loudly when beats stop arriving. */
export function useGateway() {
  const [gw, setGw] = useState(null);
  const lastAt = useRef(0);
  useEffect(() => {
    const off = onGateway((g) => { lastAt.current = Date.now(); setGw(g); });
    const watchdog = setInterval(() => {
      if (lastAt.current && Date.now() - lastAt.current > 8000) {
        setGw((g) => (g && g.feed !== "DEGRADED" ? { ...g, feed: "DEGRADED", latencyMs: null } : g));
      }
    }, 2000);
    return () => { off(); clearInterval(watchdog); };
  }, []);
  return gw;
}
