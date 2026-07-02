/**
 * App-level mode: "research" (the classic backtest app) vs "live" (the Live
 * Terminal). Persisted so a reload lands you back in the same world.
 * A custom window event lets App.jsx react to changes from anywhere.
 */
const KEY = "ql.app_mode";
const EVT = "ql-app-mode";

export function getAppMode() {
  try {
    return localStorage.getItem(KEY) === "live" ? "live" : "research";
  } catch {
    return "research";
  }
}

export function setAppMode(mode) {
  try {
    localStorage.setItem(KEY, mode === "live" ? "live" : "research");
  } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVT));
}

export function goLive() { setAppMode("live"); }
export function exitLive() { setAppMode("research"); }

export function onAppModeChange(fn) {
  window.addEventListener(EVT, fn);
  return () => window.removeEventListener(EVT, fn);
}
