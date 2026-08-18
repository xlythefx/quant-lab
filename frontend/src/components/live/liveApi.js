import { api } from "../../services/api.js";

/**
 * REST snapshots + commands for the Live Terminal. All calls ride the same
 * axios instance (same backend, same session) as the rest of the app —
 * shared connections, separate UI.
 */

// ---- phase 03: market snapshots -------------------------------------------
export async function getLiveInstruments() {
  const { data } = await api.get("/api/live/instruments");
  return data; // {instruments:[{symbol, venue, cls, label, priceDecimals}], timeframes:[..]}
}

export async function getLiveCandles({ symbol, timeframe, limit = 300 }) {
  const { data } = await api.get("/api/live/candles", { params: { symbol, timeframe, limit } });
  return data.candles; // [{time, open, high, low, close, volume}]
}

export async function getLiveTicker(symbol) {
  const { data } = await api.get("/api/live/ticker", { params: { symbol } });
  return data; // {price, changePct, high, low, vol, quoteVol, ts}
}

export async function getLiveMarkets() {
  const { data } = await api.get("/api/live/markets");
  return data.rows; // [{symbol, venue, last, chg24h, volume, funding, spark}]
}

// ---- phase 05: deployments --------------------------------------------------
export async function getDeployments() {
  const { data } = await api.get("/api/live/deployments");
  return data; // {deployments: [...], killswitch: bool}
}

export async function createDeployment(body) {
  const { data } = await api.post("/api/live/deployments", body);
  return data;
}

export async function patchDeployment(name, patch) {
  const { data } = await api.patch(`/api/live/deployments/${encodeURIComponent(name)}`, patch);
  return data;
}

export async function deleteDeployment(name) {
  const { data } = await api.delete(`/api/live/deployments/${encodeURIComponent(name)}`);
  return data;
}

export async function testDeploymentSignal(name, { action = "BUY", dry_run = true } = {}) {
  const { data } = await api.post(`/api/live/deployments/${encodeURIComponent(name)}/test-signal`, { action, dry_run });
  return data;
}

export async function previewPayload({ strategy_alias, leverage, symbol, payload_template } = {}) {
  // Exact JSON this deployment will POST (secret masked), built by the real
  // backend build_payload() — for cross-checking before arming.
  const { data } = await api.post("/api/live/payload-preview", {
    strategy_alias, leverage, symbol, payload_template,
  });
  return data; // {symbol, secret_masked, payloads:{BUY, SELL, EXIT_LONG, EXIT_SHORT}}
}

// ---- phase 06: kill switch, alerts history, activity ------------------------
export async function getKillSwitch() {
  const { data } = await api.get("/api/live/killswitch");
  return data; // {killed}
}

export async function setKillSwitch(killed) {
  const { data } = await api.post("/api/live/killswitch", { killed });
  return data; // {killed}
}

export async function getAlertsHistory({ limit = 200 } = {}) {
  const { data } = await api.get("/api/live/alerts-history", { params: { limit } });
  return data.rows;
}

export async function deleteAlertsHistory(ids = null) {
  // ids: array to delete specific rows, null → clear all
  const { data } = await api.delete("/api/live/alerts-history", { data: { ids } });
  return data;
}

export async function getActivityLog({ limit = 300 } = {}) {
  const { data } = await api.get("/api/live/activity", { params: { limit } });
  return data.rows;
}

// ---- phase 07: journal + analytics -----------------------------------------
export async function getLiveJournal(params = {}) {
  const { data } = await api.get("/api/live/journal", { params });
  return data.rows;
}

export async function getLiveAnalytics(params = {}) {
  const { data } = await api.get("/api/live/analytics", { params });
  return data; // {stats, curve, breakdown}
}

export async function getDeploymentExpectation(name) {
  // Runs the same strategy+params through the backtest engine (can take a bit).
  const { data } = await api.get(`/api/live/deployments/${encodeURIComponent(name)}/expectation`, { timeout: 300_000 });
  return data; // {ok, expected:{win_rate, profit_factor, ...}} | {ok:false, error}
}

// ---- phase 09: positions / risk / reconciliation ----------------------------
export async function getLivePositions(account) {
  const { data } = await api.get("/api/live/positions", { params: { account } });
  return data; // {ok, rows, source}
}

export async function getLiveClosedPositions(account, limit = 100) {
  const { data } = await api.get("/api/live/positions/closed", { params: { account, limit } });
  return data;
}

export async function getLiveRisk(account) {
  const { data } = await api.get("/api/live/risk", { params: { account } });
  return data;
}

export async function getLiveReconciliation(account) {
  const { data } = await api.get("/api/live/reconciliation", { params: { account } });
  return data;
}

// ---- master account (headline equity, read from the LOCAL deployed DB) -------
export async function getMasterAccount() {
  const { data } = await api.get("/api/live/master-account");
  return data; // {ok, equity, dayPnl, balance, unrealizedPnl, currency, ...}
}
