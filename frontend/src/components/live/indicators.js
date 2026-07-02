/**
 * Chart indicator math for the terminal (pure functions, causal).
 * VWMA(win) + Z-bands: vwma ± z · rolling stdev(close, win).
 * Mirrors the prototype's computeIndicators — display only, not a strategy.
 */
export function computeIndicators(candles, win = 14, z = 1.5) {
  const n = candles.length;
  const vwma = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  if (!n) return { vwma, upper, lower };

  for (let i = win - 1; i < n; i++) {
    let pv = 0, v = 0, sum = 0;
    for (let j = i - win + 1; j <= i; j++) {
      pv += candles[j].close * (candles[j].volume || 1);
      v += candles[j].volume || 1;
      sum += candles[j].close;
    }
    const m = v > 0 ? pv / v : sum / win;
    const mean = sum / win;
    let sq = 0;
    for (let j = i - win + 1; j <= i; j++) sq += (candles[j].close - mean) ** 2;
    const sd = Math.sqrt(sq / win);
    vwma[i] = m;
    upper[i] = m + z * sd;
    lower[i] = m - z * sd;
  }
  return { vwma, upper, lower };
}

/** Session for a UTC epoch-second bar: LONDON 8–13, NEW YORK 13–22, else ASIA. */
export function sessionFor(epochSec) {
  const h = new Date(epochSec * 1000).getUTCHours();
  if (h >= 8 && h < 13) return "LONDON";
  if (h >= 13 && h < 22) return "NEW YORK";
  return "ASIA";
}
