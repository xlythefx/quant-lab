import axios from "axios";

const baseURL = "http://localhost:5050";

export const api = axios.create({
  baseURL,
  timeout: 120_000, // backtest prepare can take ~60s on cold cache
});

export async function getSymbols() {
  const { data } = await api.get("/api/symbols");
  return data;
}

export async function getOHLCV({ symbol, timeframe, mode = "backtest", limit = 500 }) {
  const { data } = await api.get("/api/ohlcv", {
    params: { symbol, timeframe, mode, limit },
  });
  return data.candles;
}

export async function getBacktestSeed({ symbol, timeframe, limit = 1500 }) {
  // Returns history slice ending at the same row BacktestStream will
  // replay from — guarantees timestamps line up so update() can append.
  const { data } = await api.get("/api/backtest/seed", {
    params: { symbol, timeframe, limit },
  });
  return data; // {candles, start_index, start_time, total_rows}
}

export async function prepareBacktest({ symbol, timeframe }) {
  const { data } = await api.post("/api/backtest/prepare", { symbol, timeframe });
  return data;
}

export async function listDatasets() {
  const { data } = await api.get("/api/datasets");
  return data.datasets;
}

export async function downloadDataset({ symbol, timeframe, start, end, sid, jobId, broker = "binance" }) {
  // start/end are 'YYYY-MM-DD' strings.
  // Returns immediately with {ok, job_id, ...}; actual progress + terminal
  // state arrive via socket events (download_progress / download_complete /
  // download_cancelled / download_error). broker selects which adapter
  // handles the fetch (binance | dukascopy).
  const { data } = await api.post("/api/datasets/download", {
    symbol, timeframe, start, end, sid, job_id: jobId, broker,
  });
  return data;
}

export async function cancelDownload() {
  const { data } = await api.post("/api/datasets/download/cancel");
  return data;
}

export async function getDownloadStatus() {
  const { data } = await api.get("/api/datasets/download/status");
  return data;
}

export async function deleteDataset({ symbol, timeframe, broker = "binance" }) {
  const { data } = await api.delete("/api/datasets", {
    params: { symbol, timeframe, broker },
  });
  return data;
}

export async function getStrategies() {
  const { data } = await api.get("/api/strategies");
  return data.strategies;
}

/** Hindsight backtest — returns full result {candles, overlays, trades, equity, stats, analytics}. */
export async function runBacktest({ strategy_id, symbol, timeframe, params, start_time, end_time }) {
  const { data } = await api.post("/api/strategies/run", {
    strategy_id, symbol, timeframe, params, start_time, end_time,
  });
  return data;
}

/**
 * Portfolio backtest — accepts 1..N strategies sharing one cash pool.
 * `strategies` is `[{strategy_id, symbol, timeframe, params, priority}]`.
 * Returns `{strategies, risk_config, equity, trades, skipped_signals,
 *           stats, analytics, per_strategy: {sid: {trades, equity, stats,
 *           analytics, candles, overlays, spec}}}`.
 */
export async function runPortfolioBacktest({ strategies, start_time, end_time }) {
  const { data } = await api.post("/api/backtest/portfolio", {
    strategies, start_time, end_time,
  });
  return data;
}

export async function getRiskConfig() {
  const { data } = await api.get("/api/risk-config");
  return data;
}

export async function updateRiskConfig(patch) {
  const { data } = await api.put("/api/risk-config", patch);
  return data;
}

// ---------------------------------------------------------------------------
// Walk-Forward Optimization
// ---------------------------------------------------------------------------

export async function startWalkForward(spec) {
  const { data } = await api.post("/api/walkforward/start", spec);
  return data; // {job_id, ok}
}

export async function cancelWalkForward() {
  const { data } = await api.post("/api/walkforward/cancel");
  return data; // {ok}
}

export async function getWalkForwardStatus() {
  const { data } = await api.get("/api/walkforward/status");
  return data;
}

export async function getWalkForwardLastResult() {
  const { data } = await api.get("/api/walkforward/last_result");
  return data.result;
}

// ---------------------------------------------------------------------------
// Grid Search
// ---------------------------------------------------------------------------

export async function startGridSearch(spec) {
  const { data } = await api.post("/api/grid_search/start", spec);
  return data; // {job_id, ok}
}

export async function cancelGridSearch() {
  const { data } = await api.post("/api/grid_search/cancel");
  return data; // {ok}
}

export async function getGridSearchStatus() {
  const { data } = await api.get("/api/grid_search/status");
  return data;
}

export async function getGridSearchLastResult() {
  const { data } = await api.get("/api/grid_search/last_result");
  return data.result;
}

export async function estimateGridSearch(spec) {
  const { data } = await api.post("/api/grid_search/estimate", spec);
  return data; // {combos, projected_seconds, warn, refuse, error?}
}

// ---------------------------------------------------------------------------
// Cost Sweep
// ---------------------------------------------------------------------------

export async function startCostSweep(spec) {
  const { data } = await api.post("/api/cost_sweep/start", spec);
  return data; // {job_id, ok}
}

export async function cancelCostSweep() {
  const { data } = await api.post("/api/cost_sweep/cancel");
  return data; // {ok}
}

export async function getCostSweepStatus() {
  const { data } = await api.get("/api/cost_sweep/status");
  return data;
}

export async function getCostSweepLastResult() {
  const { data } = await api.get("/api/cost_sweep/last_result");
  return data.result;
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

/** Run a Monte Carlo simulation against 1..N strategies.
 *  `strategies` is `[{strategy_id, symbol, timeframe, params, priority}]`.
 *  method = "trade_bootstrap" | "block_bootstrap" | "synthetic".
 *  N≥2 runs MC over the portfolio aggregate equity/trades. Synthetic
 *  requires all strategies share the same (symbol, timeframe). */
export async function runMonteCarlo({ strategies, start_time, end_time,
                                      method, n_sims, block_size, seed }) {
  const { data } = await api.post("/api/montecarlo/run", {
    strategies, start_time, end_time,
    method, n_sims, block_size, seed,
  });
  return data;
}

// ---------------------------------------------------------------------------
// AI Insights (Claude-powered, backend-proxied)
// ---------------------------------------------------------------------------

export async function aiAnalyzeMonteCarlo(mc_result) {
  // AI calls can take ~30s with adaptive thinking, override default timeout.
  const { data } = await api.post("/api/ai/insights/monte-carlo",
    { mc_result }, { timeout: 180_000 });
  return data; // {text, model, usage}
}

export async function aiAnalyzeWalkForward(wf_result) {
  const { data } = await api.post("/api/ai/insights/walkforward",
    { wf_result }, { timeout: 180_000 });
  return data;
}

export async function aiAnalyzeBacktestSection(result, section) {
  const { data } = await api.post("/api/ai/insights/backtest-section",
    { result, section }, { timeout: 180_000 });
  return data; // {text, model, usage}
}

export async function aiAnalyzeWalkForwardSection(result, section) {
  const { data } = await api.post("/api/ai/insights/walkforward-section",
    { result, section }, { timeout: 180_000 });
  return data; // {text, model, usage}
}

export async function aiSuggestWalkForward(meta) {
  const { data } = await api.post("/api/ai/suggest/walkforward",
    meta, { timeout: 180_000 });
  return data; // {suggestion: {is_bars, oos_bars, n_trials, metric, rationale, expected_windows}, ...}
}
