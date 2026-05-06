/**
 * Tiny global store for "which strategies the user has activated on the
 * dashboard, and what params they last set". Persisted to localStorage so
 * it survives reload.
 *
 * Shape:
 *   active: [{id, color, params}]
 *
 * No external deps — uses the subscribe/snapshot pattern (compatible with
 * useSyncExternalStore, but we just expose a hook below).
 */
import { useEffect, useState } from "react";

// Stable key — manual "Clear" buttons on the Risk page handle resets so
// users don't lose customizations every time we tweak schema defaults.
const KEY = "quantlab.activeStrategies.v2";

const PALETTE = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#22d3ee", // cyan
  "#f59e0b", // amber
  "#ec4899", // pink
  "#10b981", // green
];

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Migration: drop any stored entries whose params are in the old
    // shape (sessions: {tokyo: true} or risk_pct < 0.5). New shape is
    // sessions: {tokyo: {enabled, start, end}, ...} and risk_pct is %.
    return arr.filter((s) => {
      const p = s?.params || {};
      const ses = p.sessions;
      const oldSessions = ses && Object.values(ses).some((v) => typeof v === "boolean");
      const oldRisk = typeof p.risk_pct === "number" && p.risk_pct > 0 && p.risk_pct < 0.5;
      return !oldSessions && !oldRisk;
    });
  } catch {
    return [];
  }
}

function save(arr) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {}
}

let state = load();
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(state));

function setState(next) {
  state = next;
  save(state);
  emit();
}

function nextColor(existing) {
  const used = new Set(existing.map((s) => s.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[existing.length % PALETTE.length];
}

export function getActive() { return state; }

export function isActive(id) { return state.some((s) => s.id === id); }

export function addStrategy(id, defaultParams = {}) {
  if (state.some((s) => s.id === id)) return;
  const color = nextColor(state);
  setState([...state, { id, color, params: defaultParams }]);
}

export function removeStrategy(id) {
  setState(state.filter((s) => s.id !== id));
}

export function updateParams(id, params) {
  setState(state.map((s) => (s.id === id ? { ...s, params } : s)));
}

export function clearAll() {
  setState([]);
}

export function getCount() { return state.length; }

export function useActiveStrategies() {
  const [v, setV] = useState(state);
  useEffect(() => {
    const fn = (s) => setV(s);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return v;
}
