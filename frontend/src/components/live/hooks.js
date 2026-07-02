import { useCallback, useEffect, useRef, useState } from "react";
import { useDataMode } from "./dataMode.jsx";
import {
  getLiveInstruments, getLiveCandles, getLiveTicker, getDeployments,
  getLiveRisk, getLivePositions,
} from "./liveApi.js";
import {
  subscribeLiveCandles, subscribeOrderBook, onGateway, onSocketReconnect,
  onDeploymentsChanged, onAlertDispatched, onLiveSignal,
} from "./liveChannels.js";
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
 * Order book behind a clean seam. Live mode rides the REAL Binance partial
 * depth stream (top-20 snapshots via the backend hub — phase 08 wiring per
 * ref-binance-orderbook.md); mock mode (or until the first real frame lands)
 * uses the seeded generator. `simulated` always tells the truth: the badge
 * drops only once real depth is on screen.
 */
export function useOrderBook(symbol, lastPrice) {
  const { dataMode } = useDataMode();
  const mock = dataMode === "mock";
  const [book, setBook] = useState(null);
  const [real, setReal] = useState(false);
  const priceRef = useRef(lastPrice);
  priceRef.current = lastPrice;

  useEffect(() => {
    setBook(null);
    setReal(false);

    if (mock) {
      const tick = () => setBook(sim.mockBook(symbol, priceRef.current));
      tick();
      const t = setInterval(tick, 1500);
      return () => clearInterval(t);
    }

    let gotReal = false;
    const unsub = subscribeOrderBook(symbol, (b) => {
      gotReal = true;
      setReal(true);
      setBook({ bids: b.bids, asks: b.asks, ts: Date.now() });
    });
    // Until the first real frame, keep a labeled sim book so the panel isn't blank.
    const t = setInterval(() => {
      if (!gotReal) setBook(sim.mockBook(symbol, priceRef.current));
    }, 1500);
    return () => { unsub(); clearInterval(t); };
  }, [symbol, mock]);

  return { book, simulated: !real };
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

/**
 * Deployments (armed live-alert rules + runtime state) + kill switch.
 * Refetches on backend change events, dispatches, and signals.
 */
export function useDeployments() {
  const [state, setState] = useState({ deployments: [], killswitch: false, loading: true, error: null });

  const refresh = useCallback(() => {
    getDeployments()
      .then((d) => setState({ deployments: d.deployments || [], killswitch: !!d.killswitch, loading: false, error: null }))
      .catch((e) => setState((s) => ({ ...s, loading: false, error: e?.message || "failed to load deployments" })));
  }, []);

  useEffect(() => {
    refresh();
    const offs = [
      onDeploymentsChanged(refresh),
      onAlertDispatched(refresh),
      onLiveSignal(refresh),
    ];
    const t = setInterval(refresh, 30_000);
    return () => { offs.forEach((f) => f()); clearInterval(t); };
  }, [refresh]);

  return { ...state, refresh };
}

/**
 * Real broker risk/positions (WAMP read-only, phase 09) with an honest
 * SIMULATED fallback: when the backend can't reach the WAMP MySQL (or in
 * mock mode) panels render the labeled placeholder instead of hard-breaking.
 */
export function usePositionsRisk(account = "demo") {
  const { dataMode } = useDataMode();
  const mock = dataMode === "mock";
  const [state, setState] = useState({ risk: null, positions: [], simulated: true, loading: true });

  useEffect(() => {
    let dead = false;
    setState((s) => ({ ...s, loading: true }));

    if (mock) {
      setState({ risk: sim.mockRisk(account), positions: sim.mockPositions(account), simulated: true, loading: false });
      return () => { dead = true; };
    }

    const pull = async () => {
      try {
        const [riskRes, posRes] = await Promise.all([getLiveRisk(account), getLivePositions(account)]);
        if (dead) return;
        if (riskRes?.ok) {
          setState({ risk: riskRes, positions: posRes?.rows || [], simulated: false, loading: false });
          return;
        }
        throw new Error(riskRes?.error || "wamp unavailable");
      } catch {
        if (!dead) setState({ risk: sim.mockRisk(account), positions: sim.mockPositions(account), simulated: true, loading: false });
      }
    };
    pull();
    const t = setInterval(pull, 10_000);
    return () => { dead = true; clearInterval(t); };
  }, [account, mock]);

  return state;
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
