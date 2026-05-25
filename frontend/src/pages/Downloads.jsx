import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Navbar from "../components/Navbar.jsx";
import ConfirmModal, { TrashIcon } from "../components/ConfirmModal.jsx";
import { listDatasets, deleteDataset, importCsvDataset } from "../services/api.js";
import { waitForSocketId } from "../services/socket.js";
import { getState as getDlState, subscribe as subscribeDl,
         startDownload, cancelCurrent as cancelCurrentDl,
         hydrate as hydrateDl } from "../services/downloadStore.js";

const TFS = ["1m", "5m", "15m", "1h"];

/**
 * Asset-class tab definitions. Each declares its broker, default symbol,
 * suggestion list (for the datalist), source label, and whether it's
 * implemented yet. Adding a new asset class later = one entry in this list.
 */
const TABS = [
  {
    id: "crypto",
    label: "Crypto",
    broker: "binance",
    source: "Binance via CCXT",
    defaultSymbol: "BTCUSDT",
    suggested: ["BTCUSDT", "FETUSDT", "LTCUSDT", "ETHUSDT", "SOLUSDT"],
    enabled: true,
    note: "Pair-shaped tickers (BASE+QUOTE concatenated, e.g. BTCUSDT). Re-running merges into the existing file.",
  },
  {
    id: "commodity",
    label: "Commodities",
    broker: "dukascopy",
    source: "Dukascopy (free tick history)",
    defaultSymbol: "XAUUSD",
    suggested: ["XAUUSD", "XAGUSD"],
    enabled: true,
    note: "Gold/silver via Dukascopy's public CDN. Real 23/5 trading hours (Friday close → Sunday open gap preserved).",
  },
  {
    id: "forex",
    label: "Forex",
    broker: "dukascopy",
    source: "Dukascopy (free tick history)",
    defaultSymbol: "EURUSD",
    suggested: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"],
    enabled: true,
    note: "Major + minor pairs via Dukascopy. 24/5 trading hours.",
  },
  {
    id: "futures",
    label: "Futures",
    broker: "yahoo",
    source: "Yahoo Finance (free)",
    defaultSymbol: "ES",
    suggested: ["ES"],
    enabled: true,
    note: "E-mini index futures via Yahoo Finance. Yahoo caps intraday history at ~730 days for 60min bars (less for shorter TFs). Symbol → Yahoo ticker mapping lives in data/assets/yahoo.json (ES → ES=F). Add more symbols there as needed.",
  },
  {
    id: "tradestation",
    label: "TradeStation",
    broker: "tradestation",
    source: "Manual CSV Export only",
    defaultSymbol: "@NQ",
    suggested: ["@NQ", "@ES", "@RTY", "@YM", "@GC", "@CL"],
    enabled: true,
    note: "WebAPI integration is temporarily disabled. Use the manual CSV export from TradeStation's platform and import below.",
  },
  {
    id: "stock",
    label: "Stocks",
    broker: null,
    source: "Coming soon · capital.com or IG.com adapter",
    defaultSymbol: "",
    suggested: [],
    enabled: false,
    note: "Stocks require a broker adapter (capital.com or IG.com). Stage 5+ of the multi-asset roadmap.",
  },
  {
    id: "index",
    label: "Indices",
    broker: null,
    source: "Coming soon · capital.com or IG.com adapter",
    defaultSymbol: "",
    suggested: [],
    enabled: false,
    note: "Indices (US30, NAS100, SPX500, etc.) also wait on the same adapter as stocks.",
  },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }
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

function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function Downloads() {
  const [activeTabId, setActiveTabId] = useState("crypto");
  const tab = useMemo(() => TABS.find((t) => t.id === activeTabId) || TABS[0], [activeTabId]);

  // Form state — re-initialized when the active tab changes.
  const [symbol, setSymbol] = useState(tab.defaultSymbol);
  const [timeframe, setTimeframe] = useState("15m");
  const [start, setStart] = useState(isoDaysAgo(180));
  const [end, setEnd] = useState(todayIso());

  // Re-seed the symbol field when switching tabs.
  useEffect(() => {
    setSymbol(tab.defaultSymbol);
  }, [tab.id, tab.defaultSymbol]);

  // Download state lives in a module-level store so the in-flight POST + socket
  // events survive navigation. useSyncExternalStore re-renders us on change.
  const dl = useSyncExternalStore(subscribeDl, getDlState);
  const { busy, progress, result, error, cancelled } = dl;

  const [datasets, setDatasets] = useState([]);
  const [confirmDel, setConfirmDel] = useState(null); // {symbol, timeframe, broker} | null

  // Manual CSV import state (TradeStation tab)
  const [csvFile, setCsvFile] = useState(null);
  const [csvSymbol, setCsvSymbol] = useState("ES");
  const [csvTimeframes, setCsvTimeframes] = useState(["15m", "1h"]);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvResult, setCsvResult] = useState(null);
  const [csvError, setCsvError] = useState(null);

  const refresh = () => listDatasets().then(setDatasets).catch(() => {});
  useEffect(() => { refresh(); }, []);

  // On mount: ask the backend whether a job is already running (e.g., user
  // refreshed the page mid-download) and adopt its progress into the store.
  useEffect(() => { hydrateDl(); }, []);

  // Live-updating elapsed clock for the progress panel. Just bump a counter
  // once a second while busy — the actual elapsed value is derived from
  // dl.startedAt below.
  const [, _tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => _tick((n) => (n + 1) % 1e9), 1000);
    return () => clearInterval(id);
  }, [busy]);

  // Refresh the cached list when a background download finishes.
  useEffect(() => {
    if (!busy && result) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, result]);

  const onCsvImport = async () => {
    if (!csvFile || !csvSymbol || csvTimeframes.length === 0) return;
    setCsvBusy(true);
    setCsvResult(null);
    setCsvError(null);
    try {
      const res = await importCsvDataset({ file: csvFile, symbol: csvSymbol, timeframes: csvTimeframes });
      setCsvResult(res);
      refresh();
    } catch (err) {
      setCsvError(err?.response?.data?.error || err.message || "Import failed");
    } finally {
      setCsvBusy(false);
    }
  };

  const toggleCsvTf = (tf) =>
    setCsvTimeframes((prev) =>
      prev.includes(tf) ? prev.filter((t) => t !== tf) : [...prev, tf]
    );

  const onDownload = async (e) => {
    e?.preventDefault?.();
    if (!tab.enabled) return;
    const sym = symbol.trim().toUpperCase();
    const jobId = `${tab.broker}_${sym}_${timeframe}_${Date.now()}`;
    let sid = null;
    try { sid = await waitForSocketId(2000); } catch { /* progress just won't stream */ }
    try {
      await startDownload({ symbol: sym, timeframe, start, end, sid, jobId, broker: tab.broker });
    } catch { /* error already on the store */ }
  };

  const performDelete = async () => {
    if (!confirmDel) return;
    const { symbol: s, timeframe: tf, broker: b } = confirmDel;
    setConfirmDel(null);
    try {
      await deleteDataset({ symbol: s, timeframe: tf, broker: b });
      refresh();
    } catch (err) {
      // No place to surface this yet; refresh to at least keep the table accurate.
      refresh();
    }
  };

  // Datasets filtered to the active tab. TradeStation filters by broker name;
  // all other tabs filter by asset_class matching the tab id.
  const tabDatasets = useMemo(() => {
    // Broker-specific tabs: tradestation and yahoo each own their files
    if (tab.broker === "tradestation" || tab.broker === "yahoo") {
      return datasets.filter((d) => d.broker === tab.broker);
    }
    return datasets.filter((d) => (d.asset_class || "crypto") === tab.id);
  }, [datasets, tab.id, tab.broker]);

  // Per-asset-class counts for the tab badges.
  const countsByClass = useMemo(() => {
    const c = {};
    for (const d of datasets) {
      const k = d.asset_class || "crypto";
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }, [datasets]);

  // Progress derived values
  const pct = progress && progress.expected
    ? Math.min(100, Math.round((progress.fetched / progress.expected) * 100))
    : null;
  const cursorPct = progress && progress.start_ms && progress.end_ms
    ? Math.min(100, Math.max(0,
        ((progress.cursor_ms - progress.start_ms) /
          (progress.end_ms - progress.start_ms)) * 100))
    : null;
  // Elapsed + ETA based on the date-range cursor (preferred — more accurate
  // than candle count for Dukas, where the candle estimate is approximate).
  const elapsedSec = dl.startedAt ? (Date.now() - dl.startedAt) / 1000 : null;
  const etaSec = (elapsedSec != null && cursorPct != null && cursorPct > 0.5 && cursorPct < 100)
    ? Math.max(0, elapsedSec * (100 - cursorPct) / cursorPct)
    : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="downloads" />

      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Historical Data Downloads</h1>
          <p className="text-sm text-muted mt-1">
            Pull OHLCV by asset class and cache as Parquet under{" "}
            <span className="font-mono">backend/data/{"{broker}"}/</span>.
            Once cached, the symbol becomes selectable on the Dashboard in Backtest mode.
          </p>
        </header>

        {/* Tab strip */}
        <div className="flex flex-wrap gap-1 border-b border-line">
          {TABS.map((t) => {
            const isActive = t.id === activeTabId;
            const cnt = countsByClass[t.id] || 0;
            return (
              <button
                key={t.id}
                onClick={() => t.enabled && setActiveTabId(t.id)}
                disabled={!t.enabled}
                className={[
                  "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition",
                  isActive
                    ? "border-accent-blue text-text"
                    : "border-transparent text-muted hover:text-text",
                  !t.enabled && "opacity-40 cursor-not-allowed hover:text-muted",
                ].filter(Boolean).join(" ")}
              >
                {t.label}
                {cnt > 0 && (
                  <span className={`ml-2 inline-block min-w-[1.5em] px-1.5 py-0.5 rounded text-[10px] font-mono ${
                    isActive ? "bg-accent-blue/20 text-accent-blue" : "bg-bg-elev/60 text-muted"
                  }`}>
                    {cnt}
                  </span>
                )}
                {!t.enabled && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-muted/60">soon</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Source + note */}
        <div className="flex items-start justify-between gap-4 -mt-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-accent-blue">Source</div>
            <div className="text-sm font-mono text-text mt-0.5">{tab.source}</div>
          </div>
          <div className="text-[11px] text-muted/80 max-w-md text-right">{tab.note}</div>
        </div>

        {/* Form (only when tab is enabled and not tradestation WebAPI) */}
        {tab.id === "tradestation" ? (
          <div className="rounded-xl border border-line/40 bg-bg-elev/20 p-6 flex items-start gap-4">
            <div className="mt-0.5 text-amber-400 text-lg">⚠</div>
            <div>
              <div className="text-sm font-semibold text-text mb-1">TradeStation WebAPI — Temporarily Disabled</div>
              <div className="text-xs text-muted leading-relaxed">
                Programmatic API access is paused pending account funding requirements.
                Use the <span className="text-amber-400 font-medium">Manual CSV Import</span> panel below
                to load data exported directly from TradeStation's platform.
              </div>
            </div>
          </div>
        ) : tab.enabled ? (
          <form
            onSubmit={onDownload}
            className="rounded-xl border border-line bg-bg-panel/60 p-5 grid grid-cols-1 md:grid-cols-5 gap-4 items-end"
          >
            <div className="md:col-span-2">
              <label className="block text-xs uppercase tracking-wider text-muted mb-1">Symbol</label>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                list={`symbol-suggestions-${tab.id}`}
                placeholder={tab.defaultSymbol}
                className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono focus:outline-none focus:border-accent-blue"
              />
              <datalist id={`symbol-suggestions-${tab.id}`}>
                {tab.suggested.map((s) => <option key={s} value={s} />)}
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
              {busy ? (
                <button
                  type="button"
                  onClick={() => cancelCurrentDl()}
                  className="px-5 py-2 rounded-md bg-loss/15 text-loss border border-loss/40 text-sm font-medium"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!symbol || !start || !end}
                  className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50"
                >
                  Download from {tab.source.split(" ")[0]}
                </button>
              )}
              <span className="text-xs text-muted">
                Runs in the background — you can navigate away and come back. Re-runs merge into the existing file (idempotent).
              </span>
            </div>

            {/* Progress */}
            {busy && (
              <div className="md:col-span-5 mt-2 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-muted">
                  <span>
                    {progress?.status === "starting" && "queued…"}
                    {progress?.status === "downloading" && (
                      <>cursor at <span className="text-text">{fmtDateMs(progress.cursor_ms)}</span></>
                    )}
                    {!progress && "preparing…"}
                  </span>
                  <span>
                    {dl.broker ? `${dl.broker} · ${dl.symbol} ${dl.timeframe} · ` : ""}
                    {fmtDateMs(progress?.start_ms) ?? "?"} → {fmtDateMs(progress?.end_ms) ?? "?"}
                  </span>
                </div>

                <div className="h-2 rounded-full bg-bg-elev border border-line overflow-hidden">
                  <div
                    className="h-full bg-accent-grad transition-all duration-300"
                    style={{ width: `${cursorPct ?? 0}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-xs font-mono text-muted">
                  <span>
                    {progress?.fetched?.toLocaleString?.() ?? 0}
                    {" / "}
                    ~{progress?.expected?.toLocaleString?.() ?? "?"} candles
                  </span>
                  <span>{pct != null ? `${pct}%` : ""}</span>
                </div>

                <div className="flex items-center justify-between text-xs font-mono text-muted/80 pt-1 border-t border-line/30">
                  <span>elapsed <span className="text-text">{fmtDuration(elapsedSec)}</span></span>
                  <span>
                    ETA <span className="text-text">{etaSec != null ? fmtDuration(etaSec) : "—"}</span>
                  </span>
                </div>
              </div>
            )}
          </form>
        ) : (
          <div className="rounded-xl border border-line/40 bg-bg-elev/20 p-8 text-center">
            <div className="text-sm text-muted">{tab.note}</div>
            <div className="mt-3 text-[11px] uppercase tracking-wider text-muted/60">Not available yet</div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
            {error}
          </div>
        )}

        {result && !busy && (
          <div className="rounded-md border border-accent-cyan/40 bg-accent-cyan/5 px-4 py-3 text-sm font-mono">
            ✓ {result.broker || "binance"} · {result.symbol} {result.timeframe} — added{" "}
            {result.rows_added?.toLocaleString?.() ?? "?"} rows (total{" "}
            {result.rows_total?.toLocaleString?.() ?? "?"}) · {fmtTime(result.first_time)} → {fmtTime(result.last_time)}
          </div>
        )}

        {cancelled && !busy && (
          <div className="rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-3 text-sm font-mono text-amber-400">
            ⨯ download cancelled · partial bars (if any) were merged into the cache
          </div>
        )}

        {/* Manual CSV import — TradeStation tab only */}
        {tab.id === "tradestation" && (
          <div className="rounded-xl border border-dashed border-line bg-bg-panel/40 p-5 space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-text">Manual CSV Import</h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-amber-400/15 text-amber-400 border border-amber-400/30">
                Manually Exported
              </span>
            </div>
            <p className="text-[11px] text-muted/80 leading-relaxed">
              Upload a TradeStation 1-minute history export (CSV with columns: Date, Time, Open,
              High, Low, Close, Up, Down — or Volume). Timestamps are treated as{" "}
              <span className="font-mono">America/New_York</span> (CME default) and converted to
              UTC. Select which output timeframes to generate and the file is resampled + stored
              alongside regular downloads.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              {/* File picker */}
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted mb-1">
                  CSV File
                </label>
                <input
                  type="file"
                  accept=".csv"
                  onChange={(e) => { setCsvFile(e.target.files[0] || null); setCsvResult(null); setCsvError(null); }}
                  className="w-full text-sm text-muted file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-line file:bg-bg-elev file:text-text file:text-xs file:cursor-pointer cursor-pointer"
                />
              </div>

              {/* Symbol */}
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted mb-1">
                  Symbol
                </label>
                <input
                  value={csvSymbol}
                  onChange={(e) => setCsvSymbol(e.target.value.toUpperCase())}
                  placeholder="ES"
                  className="w-full px-3 py-2 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
                />
              </div>

              {/* Output timeframes */}
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted mb-1">
                  Output Timeframes
                </label>
                <div className="flex flex-wrap gap-2 pt-1">
                  {["1m", "5m", "15m", "30m", "1h", "4h", "1d"].map((tf) => (
                    <label key={tf} className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={csvTimeframes.includes(tf)}
                        onChange={() => toggleCsvTf(tf)}
                        className="accent-accent-blue"
                      />
                      <span className="text-xs font-mono text-text">{tf}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={onCsvImport}
                disabled={!csvFile || !csvSymbol || csvTimeframes.length === 0 || csvBusy}
                className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50"
              >
                {csvBusy ? "Importing…" : "Import CSV"}
              </button>
              {csvFile && !csvBusy && (
                <span className="text-xs text-muted font-mono">{csvFile.name}</span>
              )}
            </div>

            {csvError && (
              <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
                {csvError}
              </div>
            )}

            {csvResult && !csvBusy && (
              <div className="rounded-md border border-accent-cyan/40 bg-accent-cyan/5 px-4 py-3 space-y-1">
                {csvResult.results?.map((r) => (
                  <div key={r.timeframe} className="text-sm font-mono">
                    ✓ {csvResult.symbol} {r.timeframe} — added{" "}
                    {r.rows_added?.toLocaleString() ?? "?"} rows (total{" "}
                    {r.rows_total?.toLocaleString() ?? "?"}) · {fmtTime(r.first_time)} → {fmtTime(r.last_time)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Filtered datasets table */}
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-3">
            Cached {tab.label.toLowerCase()} datasets ({tabDatasets.length})
          </h2>
          <div className="rounded-xl border border-line bg-bg-panel/60 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted bg-bg-elev/40">
                <tr>
                  <th className="text-left px-4 py-2">Symbol</th>
                  <th className="text-left px-4 py-2">TF</th>
                  <th className="text-left px-4 py-2">Broker</th>
                  <th className="text-right px-4 py-2">Rows</th>
                  <th className="text-left px-4 py-2">First</th>
                  <th className="text-left px-4 py-2">Last</th>
                  <th className="text-right px-4 py-2">Size</th>
                  <th className="text-right px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {tabDatasets.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-muted text-xs">
                      no {tab.label.toLowerCase()} datasets yet — use the form above
                    </td>
                  </tr>
                )}
                {tabDatasets.map((d) => (
                  <tr key={`${d.broker}_${d.symbol}_${d.timeframe}`} className="border-t border-line/60 hover:bg-bg-elev/30">
                    <td className="px-4 py-2 font-mono">{d.symbol}</td>
                    <td className="px-4 py-2 font-mono">{d.timeframe}</td>
                    <td className="px-4 py-2 font-mono text-muted text-xs">{d.broker || "binance"}</td>
                    <td className="px-4 py-2 font-mono text-right">{d.rows.toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-muted">{fmtTime(d.first_time)}</td>
                    <td className="px-4 py-2 font-mono text-muted">{fmtTime(d.last_time)}</td>
                    <td className="px-4 py-2 font-mono text-right text-muted">{fmtBytes(d.size_bytes)}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => setConfirmDel({ symbol: d.symbol, timeframe: d.timeframe, broker: d.broker || "binance" })}
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
              <span className="font-mono text-text">
                {confirmDel.broker} · {confirmDel.symbol} {confirmDel.timeframe}
              </span>. You can re-download it later from this page.
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
