import { useEffect, useRef, useState } from "react";

/**
 * useState that mirrors itself to localStorage under `key`. Initial value
 * is whatever was stored last; falls back to `fallback` if no entry exists
 * or the JSON is bad.
 *
 * Multiple components with the same key stay in sync via a 'storage' event
 * AND a tiny pub/sub for same-tab updates.
 */
const subs = new Map();   // key -> Set<(value) => void>
const _emit = (key, value) => {
  const set = subs.get(key);
  if (set) for (const fn of set) fn(value);
};

function _read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function usePersistentState(key, fallback) {
  const [v, setV] = useState(() => _read(key, fallback));
  const fbRef = useRef(fallback);

  useEffect(() => {
    const fn = (value) => setV(value);
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);

    // cross-tab sync via storage event
    const onStorage = (e) => {
      if (e.key === key) setV(_read(key, fbRef.current));
    };
    window.addEventListener("storage", onStorage);

    return () => {
      subs.get(key)?.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  const set = (next) => {
    const value = typeof next === "function" ? next(v) : next;
    setV(value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    _emit(key, value);
  };

  return [v, set];
}
