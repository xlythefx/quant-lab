/**
 * In-memory + sessionStorage cache of the most recent hindsight backtest
 * result, keyed by `${strategy_id}|${symbol}|${tf}`. The Analytics page
 * reads it; the Dashboard writes to it after each successful run.
 *
 * sessionStorage (not local) so it dies with the tab — heavy payloads
 * shouldn't bleed across sessions.
 *
 * SIZE DISCIPLINE
 * ---------------
 * sessionStorage caps at roughly 5 MB. A multi-strategy backtest result is far
 * bigger than that, so persisting it always threw QuotaExceededError into a
 * silent catch — while still paying for a full JSON.stringify of the entire
 * cache first. With a heavy result that stringify is hundreds of MB of
 * throwaway allocation, which is real pressure on an already-loaded tab.
 * So: measure once, and skip the write when it can't possibly fit. The
 * in-memory `state` is what actually serves the Analytics page; sessionStorage
 * is only a nicety for surviving a reload.
 */
import { useEffect, useState } from "react";

// v2: risk_pct moved from global → per-strategy. Cached v1 results were
// computed under the old global sizing; invalidate them.
const KEY = "quantlab.lastResult.v2";
const MAX_PERSIST_BYTES = 4_000_000;   // under the ~5 MB sessionStorage ceiling

function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function save(map) {
  try {
    const json = JSON.stringify(map);
    if (json.length > MAX_PERSIST_BYTES) {
      // Too big to persist — drop whatever was there so a reload doesn't
      // resurrect a stale result that no longer matches the in-memory one.
      sessionStorage.removeItem(KEY);
      return;
    }
    sessionStorage.setItem(KEY, json);
  } catch { /* quota / disabled storage — in-memory cache still works */ }
}

let state = load();
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(state));

/**
 * setLast(key, result) — write one entry.
 * setLast([[key, result], ...]) — write many in ONE pass.
 *
 * The batch form matters: the per-entry form re-serializes the whole cache on
 * every call, so writing N slices used to cost N full stringifies.
 */
export function setLast(keyOrEntries, result) {
  const entries = Array.isArray(keyOrEntries)
    ? keyOrEntries
    : [[keyOrEntries, result]];
  state = { ...state };
  for (const [k, v] of entries) state[k] = v;
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
