/**
 * Module-level singleton for the Multi-Asset basket run.
 *
 * Lives outside any React component (same pattern as downloadStore) so a run
 * — finished or still going — survives navigating to another page and back,
 * including the page's own "Analytics →" round trip. Page switches only: a
 * browser refresh starts empty (a full basket's results are ~13 MB, far over
 * sessionStorage's ~5 MB).
 *
 * `setupKey` names the setup the results belong to (strategy, timeframe,
 * params, range). The page calls syncSetup(key) whenever its setup changes;
 * a different key drops the results, so numbers from another setup are never
 * shown.
 */
import { runMultiAssetBacktest } from "./api.js";

// Assets in flight at once. Each runs on its own backend worker process; 4
// stays under the browser's ~6-requests-per-server limit, so opening an
// asset's chart mid-run isn't stuck behind the basket.
const CONCURRENCY = 4;

let state = {
  setupKey: null,
  runs: {},          // {assetId: {status: "queued"|"running"|"done"|"error", result?, error?}}
  // Direction variants of one asset, fetched on demand: {assetId: {both|long|short: run}}
  variants: {},
  loading: false,
  startedAt: null,   // ms epoch of the current run — drives the elapsed timer
  runId: null,       // the backend run id; variant requests reuse it (see runVariants)
};
// Bumped by every new run and every reset; lanes of an older generation stop
// writing, so a superseded run can never overwrite newer results.
let gen = 0;

const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

const setRun = (id, run) => setState({ runs: { ...state.runs, [id]: run } });

export function getState() { return state; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Point the store at `key`. A different setup drops the results (and stops
 *  any in-flight run from writing). Returns true when something was dropped. */
export function syncSetup(key) {
  if (key === state.setupKey) return false;
  gen++;
  setState({ setupKey: key, runs: {}, variants: {}, loading: false, startedAt: null, runId: null });
  return true;
}

/**
 * Run every row of the basket, CONCURRENCY at a time.
 * `requestFor(row)` → {strategy, start_time, end_time} for that asset.
 */
export async function runBasket(setupKey, rows, requestFor) {
  const myGen = ++gen;
  const runId = Date.now();   // newer run → backend drops this one's queued assets
  setState({
    setupKey, loading: true, startedAt: Date.now(), runId, variants: {},
    runs: Object.fromEntries(rows.map((r) => [r.id, { status: "queued" }])),
  });

  // CONCURRENCY lanes pull the next asset off a shared index until the basket is done.
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      if (myGen !== gen) return;
      setRun(row.id, { status: "running" });
      try {
        const res = await runMultiAssetBacktest({ ...requestFor(row), run_id: runId });
        if (myGen !== gen) return;
        setRun(row.id, { status: "done", result: res });
      } catch (e) {
        if (myGen !== gen) return;
        setRun(row.id, { status: "error", error: e?.response?.data?.error || e.message || "Backtest failed." });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, lane));
  if (myGen === gen) setState({ loading: false });
}

const setVariant = (assetId, patch) => setState({
  variants: { ...state.variants, [assetId]: { ...(state.variants[assetId] || {}), ...patch } },
});

/**
 * Fetch direction variants (e.g. ["long", "short"]) of ONE asset, skipping any
 * already done or in flight. Each is a separate backtest: with one trade a day,
 * the longs inside a Both run are not a Long-only strategy.
 * `requestFor(dir)` → {strategy, start_time, end_time}.
 *
 * Reuses the basket's run id on purpose: a NEW id would make the backend retire
 * the basket's worker pool and cancel assets still queued in it.
 */
export async function runVariants(setupKey, assetId, dirs, requestFor) {
  if (setupKey !== state.setupKey || state.runId == null) return;
  const myGen = gen;
  const have = state.variants[assetId] || {};
  const todo = dirs.filter((d) => !have[d] || have[d].status === "error");
  if (!todo.length) return;
  setVariant(assetId, Object.fromEntries(todo.map((d) => [d, { status: "running" }])));
  await Promise.all(todo.map(async (d) => {
    try {
      const res = await runMultiAssetBacktest({ ...requestFor(d), run_id: state.runId });
      if (myGen === gen) setVariant(assetId, { [d]: { status: "done", result: res } });
    } catch (e) {
      if (myGen === gen) setVariant(assetId, { [d]: { status: "error", error: e?.response?.data?.error || e.message || "Backtest failed." } });
    }
  }));
}
