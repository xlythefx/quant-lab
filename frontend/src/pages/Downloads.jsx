import { useEffect, useState, useSyncExternalStore } from "react";
import Navbar from "../components/Navbar.jsx";
import ConfirmModal, { TrashIcon } from "../components/ConfirmModal.jsx";
import { listDatasets, deleteDataset } from "../services/api.js";
import { waitForSocketId } from "../services/socket.js";
import { getState as getDlState, subscribe as subscribeDl,
         startDownload, clearResult as clearDlResult } from "../services/downloadStore.js";

const TFS = ["1m", "5m", "15m", "1h"];
const SUGGESTED = ["BTCUSDT", "FETUSDT", "ETHUSDT", "SOLUSDT"];

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function fmtTime(epochSec) {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}
function fmtDateMs(ms) {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}
function fmtBytes(n) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

export default function Downloads() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState("15m");
  const [start, setStart] = useState(isoDaysAgo(180));
  const [end, setEnd] = useState(todayIso());

  // Download lifecycle lives in a module-level store so it survives navigation.
  // useSyncExternalStore re-renders us whenever the store changes.
  const dl = useSyncExternalStore(subscribeDl, getDlState);
  const { busy, progress, result, error } = dl;

  const [datasets, setDatasets] = useState([]);
  const [confirmDel, setConfirmDel] = useState(null); // {symbol, timeframe} | null

  const refresh = () => listDatasets().then(setDatasets).catch(() => {});

  useEffect(() => { refresh(); }, []);

  // When a background download finishes while we were on another page, the
  // dataset list shown here is stale — refresh once on (re-)mount-and-idle.
  useEffect(() => {
    if (!busy && result) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, result]);

  const onDownload = async (e) => {
    e?.preventDefault?.();
    const sym = symbol.trim().toUpperCase();
    const jobId = `${sym}_${timeframe}_${Date.now()}`;

    let sid = null;
    try { sid = await waitForSocketId(2000); } catch { /* progress just won't stream */ }

    try {
      await startDownload({ symbol: sym, timeframe, start, end, sid, jobId });
    } catch { /* error already on the store */ }
  };

  const performDelete = async () => {
    if (!confirmDel) return;
    const { symbol: s, timeframe: tf } = confirmDel;
    setConfirmDel(null);
    try {
      await deleteDataset({ symbol: s, timeframe: tf });
      refresh();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || "delete failed");
    }
  };

  // Progress derived values
  const pct = progress && progress.expected
    ? Math.min(100, Math.round((progress.fetched / progress.expected) * 100))
    : null;
  const cursorPct = progress && progress.start_ms && progress.end_ms
    ? Math.min(100, Math.max(0,
        ((progress.cursor_ms - progress.start_ms) /
          (progress.end_ms - progress.start_ms)) * 100))
    : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="downloads" />

      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Historical Data Downloads</h1>
          <p className="text-sm text-muted mt-1">
            Pull OHLCV from Binance via CCXT and cache as Parquet under <span className="font-mono">backend/data/</span>.
            Once cached, the symbol becomes selectable on the Dashboard in Backtest mode.
            Files persist across restarts.
          </p>
        </header>

        {/* Form */}
        <form
          onSubmit={onDownload}
          className="rounded-xl border border-line bg-bg-panel/60 p-5 grid grid-cols-1 md:grid-cols-5 gap-4 items-end"
        >
          <div className="md:col-span-2">
            <label className="block text-xs uppercase tracking-wider text-muted mb-1">Symbol (pair)</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              list="symbol-suggestions"
              placeholder="e.g. BTCUSDT"
              className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono focus:outline-none focus:border-accent-blue"
            />
            <datalist id="symbol-suggestions">
              {SUGGESTED.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-muted mb-1">Timeframe</label>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono focus:outline-none focus:border-accent-blue"
            >
              {TFS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-muted mb-1">Start</label>
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono focus:outline-none focus:border-accent-blue"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-muted mb-1">End</label>
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono focus:outline-none focus:border-accent-blue"
            />
          </div>

          <div className="md:col-span-5 flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !symbol || !start || !end}
              className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Downloading…" : "Download"}
            </button>
            <span className="text-xs text-muted">
              Larger ranges + smaller TF = more time. Re-running merges into the existing file (idempotent).
            </span>
          </div>

          {/* Progress */}
          {busy && (
            <div className="md:col-span-5 mt-2">
              <div className="flex items-center justify-between text-xs font-mono text-muted mb-1">
                <span>
                  {progress?.status === "starting" && "queued…"}
                  {progress?.status === "downloading" && (
                    <>cursor at <span className="text-text">{fmtDateMs(progress.cursor_ms)}</span></>
                  )}
                  {!progress && "preparing…"}
                </span>
                <span>
                  {busy && dl.symbol ? `${dl.symbol} ${dl.timeframe} · ` : ""}
                  {(busy ? dl.start : start)} → {(busy ? dl.end : end)}
                </span>
              </div>

              {/* Date-range cursor bar (visual %) */}
              <div className="h-2 rounded-full bg-bg-elev border border-line overflow-hidden">
                <div
                  className="h-full bg-accent-grad transition-all duration-300"
                  style={{ width: `${cursorPct ?? 0}%` }}
                />
              </div>

              <div className="mt-2 flex items-center justify-between text-xs font-mono text-muted">
                <span>
                  {progress?.fetched?.toLocaleString?.() ?? 0}
                  {" / "}
                  ~{progress?.expected?.toLocaleString?.() ?? "?"} candles
                </span>
                <span>{pct != null ? `${pct}%` : ""}</span>
              </div>
            </div>
          )}
        </form>

        {error && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
            {error}
          </div>
        )}

        {result && !busy && (
          <div className="rounded-md border border-accent-cyan/40 bg-accent-cyan/5 px-4 py-3 text-sm font-mono">
            ✓ {result.symbol} {result.timeframe} — added {result.rows_added.toLocaleString()} rows
            (total {result.rows_total.toLocaleString()}) · {fmtTime(result.first_time)} → {fmtTime(result.last_time)}
          </div>
        )}

        {/* Datasets table */}
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Cached datasets ({datasets.length})</h2>
          <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted bg-bg-elev/40">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-4 py-2">TF</th>
                  <th className="text-right px-4 py-2">Rows</th>
                  <th className="text-left px-4 py-2">First</th>
                  <th className="text-left px-4 py-2">Last</th>
                  <th className="text-right px-4 py-2">Size</th>
                  <th className="text-right px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {datasets.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-muted text-xs">no datasets yet — fill the form above</td></tr>
                )}
                {datasets.map((d) => (
                  <tr key={`${d.symbol}_${d.timeframe}`} className="border-t border-line/60 hover:bg-bg-elev/30">
                    <td className="px-4 py-2 font-mono">{d.symbol}</td>
                    <td className="px-4 py-2 font-mono">{d.timeframe}</td>
                    <td className="px-4 py-2 font-mono text-right">{d.rows.toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-muted">{fmtTime(d.first_time)}</td>
                    <td className="px-4 py-2 font-mono text-muted">{fmtTime(d.last_time)}</td>
                    <td className="px-4 py-2 font-mono text-right text-muted">{fmtBytes(d.size_bytes)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => setConfirmDel({ symbol: d.symbol, timeframe: d.timeframe })}
                        title="Delete dataset"
                        aria-label={`Delete ${d.symbol} ${d.timeframe}`}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted hover:text-loss hover:bg-loss/10 transition"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <ConfirmModal
        open={!!confirmDel}
        title="Delete dataset?"
        message={
          confirmDel ? (
            <>
              This will permanently delete the cached Parquet for{" "}
              <span className="font-mono text-text">{confirmDel.symbol} {confirmDel.timeframe}</span>.
              You can re-download it later from this page.
            </>
          ) : null
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={performDelete}
        onCancel={() => setConfirmDel(null)}
      />
    </div>
  );
}
