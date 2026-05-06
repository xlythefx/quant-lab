import axios from "axios";

const baseURL = import.meta.env.VITE_API_URL || "http://localhost:5000";

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

export async function downloadDataset({ symbol, timeframe, start, end, sid, jobId }) {
  // start/end are 'YYYY-MM-DD' strings.
  // sid lets the backend stream `download_progress` Socket.IO events to us.
  const { data } = await api.post("/api/datasets/download", {
    symbol, timeframe, start, end, sid, job_id: jobId,
  });
  return data;
}

export async function deleteDataset({ symbol, timeframe }) {
  const { data } = await api.delete("/api/datasets", {
    params: { symbol, timeframe },
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

export async function getRiskConfig() {
  const { data } = await api.get("/api/risk-config");
  return data;
}

export async function updateRiskConfig(patch) {
  const { data } = await api.put("/api/risk-config", patch);
  return data;
}
