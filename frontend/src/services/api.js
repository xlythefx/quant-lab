import axios from "axios";

const baseURL = import.meta.env.DEV ? "http://localhost:6173" : "";

export const api = axios.create({
  baseURL,
  timeout: 120_000, // backtest prepare can take ~60s on cold cache
});

export async function getSymbols() {
  const { data } = await api.get("/api/symbols");
  return data;
}

export async function getOHLCV({ symbol, timeframe, mode = "backtest", limit = 500, broker }) {
  const { data } = await api.get("/api/ohlcv", {
    params: { symbol, timeframe, mode, limit, broker },
  });
  return data.candles;
}

export async function getBacktestSeed({ symbol, timeframe, limit = 1500, broker }) {
  // Returns history slice ending at the same row BacktestStream will
  // replay from — guarantees timestamps line up so update() can append.
  const { data } = await api.get("/api/backtest/seed", {
    params: { symbol, timeframe, limit, broker },
  });
  return data; // {candles, start_index, start_time, total_rows}
}

export async function prepareBacktest({ symbol, timeframe, broker }) {
  const { data } = await api.post("/api/backtest/prepare", { symbol, timeframe, broker }, {
    timeout: 900_000, // 1m downloads can take several minutes on cold cache
  });
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

export async function importCsvDataset({ file, symbol, timeframes, sourceTz = "America/New_York" }) {
  const form = new FormData();
  form.append("file", file);
  form.append("symbol", symbol);
  timeframes.forEach((tf) => form.append("timeframes", tf));
  form.append("source_tz", sourceTz);
  const { data } = await api.post("/api/datasets/import", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 120_000,
  });
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
export async function runBacktest({ strategy_id, symbol, timeframe, params, start_time, end_time, broker }) {
  const { data } = await api.post("/api/strategies/run", {
    strategy_id, symbol, timeframe, params, start_time, end_time, broker,
  }, { timeout: 900_000 });
  return data;
}

/**
 * Portfolio backtest — accepts 1..N strategies sharing one cash pool.
 * `strategies` is `[{strategy_id, symbol, timeframe, params, priority}]`.
 * Returns `{strategies, risk_config, equity, trades, skipped_signals,
 *           stats, analytics, per_strategy: {sid: {trades, equity, stats,
 *           analytics, candles, overlays, spec}}}`.
 */
export async function runPortfolioBacktest({ strategies, start_time, end_time, sid }) {
  // `sid` (socket id) lets the backend stream live stage/HMM-refit progress back
  // to just this client while the (blocking) run computes. Optional.
  const { data } = await api.post("/api/backtest/portfolio", {
    strategies, start_time, end_time, sid,
  }, { timeout: 900_000 });
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

// Multi-seed robustness — run the same WFA config across N optimizer seeds.
export async function startWalkForwardRobustness(spec) {
  const { data } = await api.post("/api/walkforward/robustness/start", spec);
  return data; // {job_id, seeds, ok}
}

export async function cancelWalkForwardRobustness() {
  const { data } = await api.post("/api/walkforward/robustness/cancel");
  return data; // {ok}
}

export async function getWalkForwardRobustnessStatus() {
  const { data } = await api.get("/api/walkforward/robustness/status");
  return data;
}

export async function getWalkForwardRobustnessLastResult() {
  const { data } = await api.get("/api/walkforward/robustness/last_result");
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
// Market Lab — read-only structural analysis (synchronous)
// ---------------------------------------------------------------------------

/** Regime classification + forward-return / transition stats. */
export async function marketLabRegime({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/regime", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Causal Gaussian-HMM regime classification (same response shape as marketLabRegime).
 *  The HMM re-fits across history, so a cold run can take a while — allow up to 5 min. */
export async function marketLabRegimeHmm({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/regime-hmm", {
    symbol, timeframe, start_time, end_time, params,
  }, { timeout: 300_000 });
  return data;
}

/** Realized vol, clustering, EWMA/persistence forecast + skill. */
export async function marketLabVolatility({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/volatility", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Day/hour (UTC) returns, autocorrelation, distribution, conditional streaks. */
export async function marketLabStatistics({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/statistics", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Mean-reversion alpha scanner: VWMA z-score + RSI setup edge, by regime, with significance. */
export async function marketLabScan({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/scan", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Black-Scholes fade safety: do low-stretch VWMA-reversion setups carry the edge? */
export async function marketLabFadeSafety({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/fade-safety", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Feature importance: which causal indicators predict the next move (honest train/test). */
export async function marketLabFeatureImportance({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/feature-importance", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Mean-reversion scan across many symbols → ranked edge table. */
export async function marketLabScanBatch({ symbols, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/scan-batch", {
    symbols, timeframe, start_time, end_time, params,
  });
  return data;
}

/** KMeans candle-shape clustering with forward-return stats per cluster. */
export async function marketLabPatterns({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/patterns", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

/** Similarity search: nearest historical windows to the latest window + their outcomes. */
export async function marketLabSimilarity({ symbol, timeframe, start_time, end_time, params }) {
  const { data } = await api.post("/api/marketlab/similarity", {
    symbol, timeframe, start_time, end_time, params,
  });
  return data;
}

// Model Bench (async LSTM training job)
export async function startModelBench(spec) {
  const { data } = await api.post("/api/modelbench/start", spec);
  return data; // {job_id, ok}
}
export async function cancelModelBench() {
  const { data } = await api.post("/api/modelbench/cancel");
  return data;
}
export async function getModelBenchStatus() {
  const { data } = await api.get("/api/modelbench/status");
  return data;
}
export async function getModelBenchLastResult() {
  const { data } = await api.get("/api/modelbench/last_result");
  return data.result;
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

export async function aiChatWalkForward(messages, wf_result) {
  const { data } = await api.post("/api/ai/chat/walkforward",
    { messages, wf_result }, { timeout: 180_000 });
  return data; // {text, model, usage}
}

export async function aiSuggestWalkForward(meta) {
  const { data } = await api.post("/api/ai/suggest/walkforward",
    meta, { timeout: 180_000 });
  return data; // {suggestion: {is_bars, oos_bars, n_trials, metric, rationale, expected_windows}, ...}
}

// ---------------------------------------------------------------------------
// AI Strategy Builder (SSE streaming, tool-using chat behind the Sandbox)
// ---------------------------------------------------------------------------

/**
 * Stream one strategy-builder turn. POSTs the conversation + context and reads
 * the text/event-stream response, dispatching parsed events to `handlers`:
 *   onToken({text})            streaming assistant text
 *   onProposal({tool_use_id, name, input})  mutating tool awaiting approval
 *   onBacktest({result})       full backtest payload for the chart
 *   onToolRan({name, summary}) a safe tool finished
 *   onStrategiesChanged()      a file changed — refresh strategy lists
 *   onState({messages})        updated opaque message array to persist + resend
 *   onDone({awaiting_approval?})  turn finished
 *   onError({message})
 *   onClose()                  stream closed (always fires last)
 * Returns an AbortController so the caller can cancel.
 */
export function streamStrategyBuilder(payload, handlers = {}) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${baseURL}/api/strategy-builder/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
        handlers.onError?.({ message: msg });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {   // SSE frames split on blank line
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          _dispatchSse(frame, handlers);
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") handlers.onError?.({ message: e.message });
    } finally {
      handlers.onClose?.();
    }
  })();
  return controller;
}

function _dispatchSse(frame, handlers) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return;
  let data;
  try { data = JSON.parse(dataLines.join("\n")); } catch { return; }
  ({
    token: handlers.onToken,
    proposal: handlers.onProposal,
    backtest_result: handlers.onBacktest,
    tool_ran: handlers.onToolRan,
    strategies_changed: handlers.onStrategiesChanged,
    state: handlers.onState,
    done: handlers.onDone,
    error: handlers.onError,
  })[event]?.(data);
}

// ---------------------------------------------------------------------------
// Live Alerts (webhook dispatcher for live strategy signals)
// ---------------------------------------------------------------------------

export async function getLiveAlerts() {
  const { data } = await api.get("/api/live-alerts");
  return data.rules; // [{strategy_id, symbol, enabled, webhook_url, secret, strategy_alias, leverage}]
}

export async function saveLiveAlerts(rules) {
  const { data } = await api.put("/api/live-alerts", { rules });
  return data.rules;
}

export async function testLiveAlert({ rule_name, action = "BUY" }) {
  const { data } = await api.post("/api/live-alerts/test", { rule_name, action });
  return data; // {ok, url?, payload?: {secret redacted}, error?}
}

// Server-side strategy presets (persisted to data/presets.json, git-trackable).
export async function getPresets(strategyId) {
  const { data } = await api.get("/api/presets", { params: { strategy_id: strategyId } });
  return data.presets; // {name: params}
}

export async function savePresets(strategyId, presets) {
  const { data } = await api.put("/api/presets", { strategy_id: strategyId, presets });
  return data.presets; // {name: params}
}

// Skills catalog + Quant Researcher (AI-generated theories in docs/research).
export async function getSkills() {
  const { data } = await api.get("/api/skills");
  return data.skills; // [{id, name, icon, category, kind, summary}]
}

export async function runSkill(skill_id, params) {
  // Generator skills can take 10-30s — give the call generous headroom.
  const { data } = await api.post("/api/skills/run", { skill_id, params }, { timeout: 180_000 });
  return data; // {name, title, markdown, spec, model, usage}
}

export async function listResearch() {
  const { data } = await api.get("/api/skills/research");
  return data.items; // [{name, title, created, size}]
}

export async function getResearch(name) {
  const { data } = await api.get(`/api/skills/research/${encodeURIComponent(name)}`);
  return data; // {name, markdown}
}

// Report Import — parse an uploaded TradeStation Performance Report CSV.
// One-off, session-only: no persistence on the server. Returns the full
// dashboard payload {meta, reported, recomputed, equity_curve, ...}.
export async function parseTradestationReport(file) {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post("/api/report/tradestation", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 120_000,
  });
  return data;
}
