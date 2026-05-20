/**
 * Module-level singleton for the historical-data download job.
 *
 * Refactored to the background-job pattern (same shape as walkforward /
 * cost_sweep / grid_search):
 *
 *   1. startDownload() POSTs to /datasets/download and returns the job_id
 *      almost immediately — no waiting on the actual fetch.
 *   2. Progress arrives over socket `download_progress` events.
 *   3. Terminal state arrives over socket `download_complete` /
 *      `download_cancelled` / `download_error` events.
 *   4. On mount, the page calls hydrate() to pull the live job snapshot
 *      from /datasets/download/status, so refreshing mid-download still
 *      shows the bar advancing.
 *
 * Lives outside any React component so the in-flight job survives navigation.
 */
import { socket } from "./socket.js";
import { downloadDataset, cancelDownload, getDownloadStatus } from "./api.js";

let state = {
  busy: false,
  jobId: null,
  broker: null,
  symbol: null,
  timeframe: null,
  start: null,
  end: null,
  progress: null,   // { fetched, expected, cursor_ms, start_ms, end_ms, status, broker }
  result: null,     // server payload on download_complete
  error: null,      // string on download_error
  cancelled: false, // true after download_cancelled
  startedAt: null,  // ms epoch — used for elapsed/ETA in the UI
};

const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

// Subscribe once at module load. Filter by active jobId so events from a
// previous (cancelled or completed) job don't bleed into the new job's view.
socket.on("download_progress", (p) => {
  if (!state.jobId || p.job_id !== state.jobId) return;
  setState({ progress: p });
});

socket.on("download_complete", (p) => {
  if (!state.jobId || p.job_id !== state.jobId) return;
  setState({ busy: false, jobId: null, result: p, error: null, cancelled: false });
});

socket.on("download_cancelled", (p) => {
  if (!state.jobId || p.job_id !== state.jobId) return;
  setState({ busy: false, jobId: null, cancelled: true });
});

socket.on("download_error", (p) => {
  if (!state.jobId || p.job_id !== state.jobId) return;
  setState({ busy: false, jobId: null, error: p.message || "download failed" });
});

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Kick off a download. Fire-and-forget: returns once the backend has
 * accepted the spec (sub-second), then progress streams through sockets.
 *
 * If a job is already running, throws synchronously — the UI's Cancel
 * button should be used first.
 */
export async function startDownload({ symbol, timeframe, start, end, sid, jobId, broker = "binance" }) {
  if (state.busy) throw new Error("a download is already in progress");
  setState({
    busy: true,
    jobId, broker, symbol, timeframe, start, end,
    progress: null, result: null, error: null, cancelled: false,
    startedAt: Date.now(),
  });
  try {
    const r = await downloadDataset({ symbol, timeframe, start, end, sid, jobId, broker });
    // Backend may rewrite the job_id (e.g., if it dedupes). Adopt it so socket
    // event filtering matches.
    if (r?.job_id && r.job_id !== state.jobId) setState({ jobId: r.job_id });
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

/** Cancel the running job (if any). */
export async function cancelCurrent() {
  try {
    await cancelDownload();
  } catch {
    // The terminal `download_cancelled` event will arrive anyway if the job
    // was running; swallow the HTTP error.
  }
}

/** Pull the live job snapshot from the backend and restore the store state.
 * Call on Downloads page mount so a refresh mid-download still shows progress.
 */
export async function hydrate() {
  try {
    const snap = await getDownloadStatus();
    if (!snap || snap.state === "idle") return;
    if (snap.state === "running" || snap.state === "starting") {
      const spec = snap.spec || {};
      setState({
        busy: true,
        jobId: snap.job_id,
        broker: spec.broker || null,
        symbol: spec.symbol || null,
        timeframe: spec.timeframe || null,
        start: null,
        end: null,
        progress: snap.progress || null,
        result: null, error: null, cancelled: false,
        startedAt: Date.now() - Math.round((snap.elapsed_seconds || 0) * 1000),
      });
    }
  } catch {
    // Best-effort; just ignore failures.
  }
}

/** Clear `result` / `error` / `cancelled` so the next download starts fresh. */
export function clearResult() {
  setState({ result: null, error: null, cancelled: false });
}
