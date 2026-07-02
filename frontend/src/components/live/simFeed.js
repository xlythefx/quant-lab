/**
 * simFeed — the ONE seeded client-side generator behind every SIMULATED
 * panel and the terminal-wide mock data mode. Deterministic per symbol so
 * demos are stable. Nothing here ever mixes into real-feed paths: panels on
 * this backend always show the SIMULATED badge.
 */

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seedStr) {
  let a = hashSeed(seedStr);
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BASE_PRICE = { BTCUSDT: 68120, LTCUSDT: 94.6, ETHUSDT: 3480, DEFAULT: 100 };
export const basePrice = (symbol) => BASE_PRICE[symbol] ?? BASE_PRICE.DEFAULT;

const TF_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const tfSeconds = (tf) => TF_SECONDS[tf] || 3600;

/** Random-walk OHLCV series ending at `endTime` (epoch s, defaults to now). */
export function genCandles(symbol, tf, n = 300, endTime = null) {
  const r = rng(`${symbol}|${tf}|candles`);
  const step = tfSeconds(tf);
  const end = endTime ?? Math.floor(Date.now() / 1000 / step) * step;
  const base = basePrice(symbol);
  const vol = base * 0.0028;
  let price = base * (0.97 + r() * 0.06);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * step;
    const drift = (r() - 0.5) * vol * 2;
    const open = price;
    const close = Math.max(base * 0.5, open + drift);
    const high = Math.max(open, close) + r() * vol * 0.8;
    const low = Math.min(open, close) - r() * vol * 0.8;
    const volume = 20 + r() * 180;
    out.push({ time: t, open, high, low, close, volume });
    price = close;
  }
  return out;
}

/** Nudge the last candle like a live tick; occasionally rolls a new bar. */
export function tickCandles(symbol, tf, candles) {
  if (!candles?.length) return candles;
  const r = Math.random;
  const step = tfSeconds(tf);
  const nowBar = Math.floor(Date.now() / 1000 / step) * step;
  const last = candles[candles.length - 1];
  const move = last.close * 0.0004 * (r() - 0.5) * 2;
  if (nowBar > last.time) {
    const open = last.close;
    const close = open + move;
    return [...candles.slice(-499), {
      time: nowBar, open, close,
      high: Math.max(open, close), low: Math.min(open, close),
      volume: 5 + r() * 30,
    }];
  }
  const close = last.close + move;
  const upd = {
    ...last, close,
    high: Math.max(last.high, close), low: Math.min(last.low, close),
    volume: last.volume + r() * 2,
  };
  return [...candles.slice(0, -1), upd];
}

/** 24h ticker stats derived from a mock candle set. */
export function mockTicker(symbol, lastPrice = null) {
  const base = basePrice(symbol);
  const price = lastPrice ?? base;
  const r = rng(`${symbol}|ticker`);
  return {
    symbol,
    price,
    changePct: (r() - 0.45) * 4,
    high: price * (1 + 0.012 * r()),
    low: price * (1 - 0.014 * r()),
    vol: 40000 + r() * 60000,
    quoteVol: price * (40000 + r() * 60000),
    ts: Math.floor(Date.now() / 1000),
  };
}

/** Top-N order book around `price` with cumulative depth. */
export function mockBook(symbol, price, levels = 15) {
  const r = Math.random;
  const p = price || basePrice(symbol);
  const tick = p * 0.0001;
  const mk = (side) => {
    let cum = 0;
    return Array.from({ length: levels }, (_, i) => {
      const size = 0.05 + r() * 2.4;
      cum += size;
      return {
        price: side === "ask" ? p + tick * (i + 1) : p - tick * (i + 1),
        size, cum,
      };
    });
  };
  return { bids: mk("bid"), asks: mk("ask"), ts: Date.now() };
}

/** One time & sales print near `price`. */
export function mockPrint(symbol, price) {
  const r = Math.random;
  const p = (price || basePrice(symbol)) * (1 + (r() - 0.5) * 0.0004);
  return {
    side: r() > 0.5 ? "BUY" : "SELL",
    price: p,
    size: r() < 0.85 ? 0.02 + r() * 1.2 : 2.2 + r() * 4,
    t: Date.now(),
  };
}

/** Funding + OI + long/short (perp-style panel). */
export function mockFunding(symbol) {
  const r = rng(`${symbol}|funding|${new Date().getUTCHours()}`);
  const next = new Date();
  next.setUTCHours(Math.ceil((next.getUTCHours() + 1) / 8) * 8 % 24, 0, 0, 0);
  if (next <= new Date()) next.setUTCHours(next.getUTCHours() + 8);
  return {
    rate: (r() - 0.35) * 0.02,
    predicted: (r() - 0.35) * 0.02,
    nextFundingTs: next.getTime(),
    longShortRatio: 0.9 + r() * 0.5,
  };
}

export function mockOiSeries(symbol, n = 48) {
  const r = rng(`${symbol}|oi`);
  let v = 8 + r() * 4;
  return Array.from({ length: n }, () => {
    v = Math.max(4, v + (r() - 0.5) * 0.35);
    return +v.toFixed(3);
  });
}

export function mockLiquidation(symbol, price) {
  const r = Math.random;
  return {
    side: r() > 0.55 ? "LONG" : "SHORT",
    usd: (8 + r() * 320) * 1000,
    price: (price || basePrice(symbol)) * (1 + (r() - 0.5) * 0.002),
    t: Date.now(),
  };
}

const HEADLINES = [
  ["Fed officials split on next rate move as inflation cools", "NEUTRAL"],
  ["Spot ETF inflows hit monthly high; desks report basis bid", "BULLISH"],
  ["Exchange outage briefly halts alt pairs; funds unaffected", "BEARISH"],
  ["Miners' reserve outflows slow to 3-month low", "BULLISH"],
  ["CFTC data shows leveraged funds trimming net shorts", "BULLISH"],
  ["Asia session volumes thin ahead of macro prints", "NEUTRAL"],
  ["Large options expiry pins price into the weekly close", "NEUTRAL"],
  ["Stablecoin supply expands for a fourth straight week", "BULLISH"],
  ["Regulator floats stricter custody rules for exchanges", "BEARISH"],
  ["L2 activity hits all-time high as fees compress", "BULLISH"],
];

export function mockNews() {
  const now = Date.now();
  return HEADLINES.map(([headline, sentiment], i) => ({
    t: now - i * 7 * 60 * 1000,
    headline,
    sentiment,
  }));
}

/** SIMULATED positions (used only when WAMP is unreachable — labeled). */
export function mockPositions(account = "demo") {
  const r = rng(`positions|${account}`);
  const rows = [
    { symbol: "BTCUSDT", side: "LONG", size: 0.42, entry: 66980, broker: "binance" },
    { symbol: "LTCUSDT", side: "SHORT", size: 18.0, entry: 97.1, broker: "binance" },
  ];
  return rows.map((p) => {
    const mark = p.entry * (1 + (r() - 0.45) * 0.02) * (p.side === "LONG" ? 1.004 : 0.996);
    const upnl = (mark - p.entry) * p.size * (p.side === "LONG" ? 1 : -1);
    return {
      ...p, mark, upnl,
      notional: mark * p.size,
      margin: (mark * p.size) / 10,
      leverage: 10,
      account,
    };
  });
}

export function mockRisk(account = "demo") {
  const pos = mockPositions(account);
  const gross = pos.reduce((s, p) => s + Math.abs(p.notional), 0);
  const net = pos.reduce((s, p) => s + p.notional * (p.side === "LONG" ? 1 : -1), 0);
  const upnl = pos.reduce((s, p) => s + p.upnl, 0);
  const equity = 130300 + upnl;
  const marginUsed = pos.reduce((s, p) => s + p.margin, 0);
  return {
    cards: {
      equity, dayPnl: upnl * 0.6, gross, netDelta: net,
      marginUsed, freeMargin: equity - marginUsed,
      var1d: equity * 0.031, maintMargin: marginUsed * 0.4,
      leverage: gross / Math.max(1, equity), utilPct: (marginUsed / Math.max(1, equity)) * 100,
    },
    exposures: pos.map((p) => ({ symbol: p.symbol, side: p.side, notional: p.notional })),
    positionRisk: pos.map((p) => ({
      symbol: p.symbol, lev: p.leverage, notional: p.notional,
      liqPrice: p.side === "LONG" ? p.entry * (1 - 1 / p.leverage) : p.entry * (1 + 1 / p.leverage),
      distPct: (1 / p.leverage) * 100,
      uPnl: p.upnl,
    })),
  };
}
