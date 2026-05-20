/**
 * Module-level singleton for the historical-data download job.
 *
 * Lives outside any React component so the in-flight POST and socket-driven
 * progress survive navigation. The Downloads page subscribes via
 * useSyncExternalStore and renders whatever the store holds at any moment.
 *
 * Why this exists: previously the Downloads component owned `busy`, `progress`,
 * `result`, and the socket listener. Leaving the page unmounted those, so when
 * you came back the UI looked idle even though the backend was still working.
 */
import { socket } from "./socket.js";
import { downloadDataset } from "./api.js";

let state = {
  busy: false,
  jobId: null,
  broker: null,
  symbol: null,
  timeframe: null,
  start: null,
  end: null,
  progress: null,   // { fetched, expected, cursor_ms, start_ms, end_ms, status, broker }
  result: null,     // server response on success
  error: null,      // string on failure
};

const listeners = new Set();

function emit() {
  // Replace the reference so React's useSyncExternalStore notices a change.
  state = { ...state };
  for (const fn of listeners) fn();
}

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

// Attach the socket listener once at module load. Filters by the active jobId,
// so stale events from a previous job are dropped.
socket.on("download_progress", (p) => {
  if (!state.jobId || p.job_id !== state.jobId) return;
  setState({ progress: p });
});

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Start a download. Returns the result promise.
 *
 * The promise is awaited HERE, not by the calling component, so even if the
 * page unmounts mid-download the final result still lands in the store.
 *
 * Throws synchronously if a download is already in flight.
 */
export async function startDownload({ symbol, timeframe, start, end, sid, jobId, broker = "binance" }) {
  if (state.busy) throw new Error("a download is already in progress");
  setState({
    busy: true,
    jobId, broker, symbol, timeframe, start, end,
    progress: null, result: null, error: null,
  });
  try {
    const r = await downloadDataset({ symbol, timeframe, start, end, sid, jobId, broker });
    setState({ busy: false, jobId: null, result: r });
    return r;
  } catch (e) {
    setState({
      busy: false,
      jobId: null,
      error: e?.response?.data?.error || e.message || "download failed",
    });
    throw e;
  }
}

/** Clear `result` / `error` so the next download starts visually fresh. */
export function clearResult() {
  setState({ result: null, error: null });
}
