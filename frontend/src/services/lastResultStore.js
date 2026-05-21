/**
 * In-memory + sessionStorage cache of the most recent hindsight backtest
 * result, keyed by `${strategy_id}|${symbol}|${tf}`. The Analytics page
 * reads it; the Dashboard writes to it after each successful run.
 *
 * sessionStorage (not local) so it dies with the tab — heavy payloads
 * shouldn't bleed across sessions.
 */
import { useEffect, useState } from "react";

// v2: risk_pct moved from global → per-strategy. Cached v1 results were
// computed under the old global sizing; invalidate them.
const KEY = "quantlab.lastResult.v2";

function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function save(map) {
  try { sessionStorage.setItem(KEY, JSON.stringify(map)); } catch {}
}

let state = load();
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(state));

export function setLast(key, result) {
  state = { ...state, [key]: result };
  save(state);
  emit();
}

export function getLast(key) {
  return state[key] || null;
}

export function getAll() { return state; }
export function getCount() { return Object.keys(state).length; }

export function clear() {
  state = {};
  save(state);
  emit();
}

export function useLastResult(key) {
  const [v, setV] = useState(state[key] || null);
  useEffect(() => {
    const fn = (s) => setV(s[key] || null);
    listeners.add(fn);
    setV(state[key] || null);
    return () => listeners.delete(fn);
  }, [key]);
  return v;
}
