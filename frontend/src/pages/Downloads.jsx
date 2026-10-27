import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Navbar from "../components/Navbar.jsx";
import ConfirmModal, { TrashIcon } from "../components/ConfirmModal.jsx";
import { listDatasets, deleteDataset, importCsvDataset, probeDataset } from "../services/api.js";
import { fmtDateLong, fmtDateStr, fmtInt } from "../services/format.js";
import { waitForSocketId } from "../services/socket.js";
import { getState as getDlState, subscribe as subscribeDl,
         startDownload, cancelCurrent as cancelCurrentDl,
         hydrate as hydrateDl } from "../services/downloadStore.js";

const TFS = ["1m", "3m", "5m", "6m", "10m", "12m", "15m", "23m", "30m", "46m", "1h", "2h", "4h", "1d"];

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
    broker: "databento",
    source: "Databento (CME Globex MDP 3.0)",
    defaultSymbol: "ES",
    suggested: ["ES", "NQ", "CL", "GC"],
    enabled: true,
    note: "CME futures (ES, NQ, CL, GC) via Databento's GLBX.MDP3 dataset. Bare roots map to the continuous front-month contract (ES → ES.c.0); an explicit code like ESH4 pulls that single contract. 5m/15m are resampled from 1m. Requires DATABENTO_API_KEY in backend/.env. Contract specs live in data/assets/databento.json.",
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

/**
 * Crypto tab only: which exchange, and spot vs USDT-M perpetuals. Every
 * combination is its own broker folder ("{exchange}" or "{exchange}_perp"),
 * and the saved symbol carries both choices: a ".P" suffix for perps
 * (BTCUSDT.P — TradingView's convention) and, off Binance, an exchange prefix
 * (BYBIT.LTCUSDT.P — TradingView's BYBIT:LTCUSDT.P, with "." because Windows
 * forbids ":" in file names). Research pages load by symbol alone, so without
 * them a perp or Bybit/MEXC file would be shadowed by the Binance spot twin.
 */
const MEXC_WINDOW =
  "MEXC only keeps ~30 days of 1m and ~1 year of 5m/15m (1h and up go back years) — an older Start skips ahead to the first bar MEXC still has. Re-download regularly: the saved file keeps every bar even after MEXC drops it.";
const CRYPTO_EXCHANGES = {
  binance: {
    label: "Binance",
    prefix: "",
    spot: {
      source: "Binance Spot via CCXT",
      note: "Pair-shaped tickers (BASE+QUOTE concatenated, e.g. BTCUSDT). Re-running merges into the existing file.",
    },
    perp: {
      source: "Binance USDT-M Perps via CCXT",
      note: "Perpetual futures — the market the live acceptor trades. Saved as SYMBOL.P (e.g. BTCUSDT.P) in its own folder, so it sits next to the spot file, never on top of it. History starts Sep 2019 for BTC, ~Sep 2020 for most alts.",
    },
  },
  bybit: {
    label: "Bybit",
    prefix: "BYBIT.",
    spot: {
      source: "Bybit Spot via CCXT",
      note: "Saved as BYBIT.SYMBOL (e.g. BYBIT.LTCUSDT) in its own folder, so it never lands on the Binance file. LTCUSDT history starts Aug 2021.",
    },
    perp: {
      source: "Bybit USDT Perps via CCXT",
      note: "Saved as BYBIT.SYMBOL.P (e.g. BYBIT.LTCUSDT.P). LTCUSDT history starts Oct 2020, at every timeframe.",
    },
  },
  mexc: {
    label: "MEXC",
    prefix: "MEXC.",
    spot: {
      source: "MEXC Spot via CCXT",
      note: `Saved as MEXC.SYMBOL (e.g. MEXC.LTCUSDT). ${MEXC_WINDOW}`,
    },
    perp: {
      source: "MEXC USDT Perps via CCXT",
      note: `Saved as MEXC.SYMBOL.P (e.g. MEXC.LTCUSDT.P). Volume is converted from MEXC's contracts to coins. ${MEXC_WINDOW}`,
    },
  },
};
const CRYPTO_MARKETS = [["spot", "Spot"], ["perp", "Perps"]];
const PERP_SUFFIX = ".P";

// Quote assets a typed symbol may already end with (longest first). Anything
// else is read as a bare coin name and gets USDT: OCEAN -> OCEANUSDT.
const QUOTES = ["FDUSD", "USDT", "USDC", "BUSD", "TUSD", "BTC", "ETH", "BNB", "EUR", "TRY"];

/** Crypto tab: the Symbol box takes one symbol or a whole list (commas,
 * spaces, new lines). Each gets the exchange prefix / ".P" the pickers imply. */
function parseCryptoSymbols(text, prefix, isPerp) {
  const out = [];
  for (let s of text.toUpperCase().split(/[\s,;|]+/)) {
    s = s.replace(/^(BYBIT|MEXC)\./, "");
    if (s.endsWith(PERP_SUFFIX)) s = s.slice(0, -PERP_SUFFIX.length);
    s = s.replace(/[^A-Z0-9]/g, "");
    if (!s) continue;
    if (!QUOTES.some((q) => s.endsWith(q) && s.length > q.length)) s += "USDT";
    const full = prefix + s + (isPerp ? PERP_SUFFIX : "");
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

/** Small radio-style pill group (exchange / market pickers on the Crypto tab). */
function Segmented({ label, options, value, onChange }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-line overflow-hidden text-[11px] font-mono"
    >
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`px-2.5 py-0.5 transition ${
            value === id
              ? "bg-accent-blue/20 text-accent-blue"
              : "text-muted hover:text-text"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

// Crypto tab: which timeframes to download (remembered between visits).
const TFS_KEY = "ql.downloads.timeframes";
const DEFAULT_TFS = ["1m", "5m", "15m"];
function loadTfs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TFS_KEY));
    const ok = Array.isArray(saved) ? TFS.filter((t) => saved.includes(t)) : [];
    if (ok.length) return ok;
  } catch { /* storage unavailable */ }
  return DEFAULT_TFS;
}

/** Multi-select timeframe pills. Each ticked timeframe downloads on its own
 * (straight from the exchange), one after another in this list's order. */
function TfChips({ value, onChange }) {
  const toggle = (tf) =>
    onChange(value.includes(tf) ? value.filter((t) => t !== tf) : TFS.filter((t) => t === tf || value.includes(t)));
  return (
    <div role="group" aria-label="Timeframes" className="flex flex-wrap gap-1">
      {TFS.map((tf) => {
        const on = value.includes(tf);
        return (
          <button
            key={tf}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(tf)}
            className={`px-2.5 py-1 rounded-md border text-xs font-mono transition ${
              on
                ? "border-accent-blue/60 bg-accent-blue/20 text-accent-blue"
                : "border-line text-muted hover:text-text"
            }`}
          >
            {tf}
          </button>
        );
      })}
    </div>
  );
}

const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;
const msDate = (ms) => fmtDateLong(ms / 1000);

const SEGMENT_LABEL = {
  all: "whole range",
  head: "older than your file",
  hole: "gap inside your file",
  tail: "newer than your file",
};
const MAX_SEGMENTS_SHOWN = 6;

/** "no new bars since …" tag for a pair the exchange stopped trading. */
function DelistedTag({ t }) {
  if (t.active) return null;
  return <span className="text-amber-400 text-[11px] font-mono">delisted · last bar {msDate(t.last_ms)}</span>;
}

/** One symbol, every detail: per timeframe what the exchange has, what's on
 * disk, and exactly which date ranges a download would fetch. */
function ProbeDetail({ item }) {
  return (
    <div className="divide-y divide-line/40">
      {item.timeframes.map((t) => (
        <div key={t.timeframe} className="py-2 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
            <div className="font-mono text-sm">
              <span className="text-accent-blue">{t.timeframe}</span>
              <span className="text-muted"> available </span>
              {msDate(t.first_ms)} – {msDate(t.last_ms)} <DelistedTag t={t} />
            </div>
            <div className="text-xs font-mono text-muted">
              {t.pages
                ? <>{plural(t.bars, "bar")} · {plural(t.pages, "page")} · ≈ <span className="text-text">{fmtDuration(t.est_seconds)}</span></>
                : "nothing to fetch"}
            </div>
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            On disk:{" "}
            {t.saved
              ? <>{msDate(t.saved.first_ms)} – {msDate(t.saved.last_ms)} · {plural(t.saved.rows, "bar")}</>
              : "nothing yet"}
          </div>
          {t.segments.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11px] font-mono">
              {t.segments.slice(0, MAX_SEGMENTS_SHOWN).map((s, i) => (
                <li key={i} className={s.kind === "hole" ? "text-amber-400" : "text-text/80"}>
                  fetch {SEGMENT_LABEL[s.kind]}: {msDate(s.start_ms)} – {msDate(s.end_ms)}
                  {s.kind === "hole" && (
                    <span className="text-muted"> — often a real exchange outage that stays empty; re-checking costs about a page</span>
                  )}
                </li>
              ))}
              {t.segments.length > MAX_SEGMENTS_SHOWN && (
                <li className="text-muted">+ {t.segments.length - MAX_SEGMENTS_SHOWN} more</li>
              )}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** A batch: one short line per symbol and timeframe. */
function ProbeBatch({ items }) {
  return (
    <div className="divide-y divide-line/40 max-h-[420px] overflow-y-auto pr-1">
      {items.map((item) => (
        <div key={item.symbol} className="py-1.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm font-mono">
            <span className="text-text">{item.symbol}</span>
            {item.error
              ? <span className="text-loss text-[11px]">will be skipped — {item.error}</span>
              : <DelistedTag t={item.timeframes[0]} />}
          </div>
          {!item.error && item.timeframes.map((t) => {
            const holes = t.segments.filter((x) => x.kind === "hole").length;
            return (
              <div key={t.timeframe} className="flex flex-wrap justify-between gap-x-4 text-[11px] font-mono text-muted">
                <span>
                  <span className="inline-block w-9 text-accent-blue">{t.timeframe}</span>
                  {msDate(t.first_ms)} – {msDate(t.last_ms)} ·{" "}
                  {t.saved ? <span className="text-text/80">saved to {msDate(t.saved.last_ms)}</span> : "new"}
                  {holes > 0 && <span className="text-amber-400"> · {plural(holes, "gap")} re-checked</span>}
                </span>
                <span>
                  {t.pages
                    ? <>{plural(t.bars, "bar")} · ≈ <span className="text-text">{fmtDuration(t.est_seconds)}</span></>
                    : "nothing to fetch"}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Auto-detect result shown before downloading: only the missing parts get
 * fetched, and every number here is what the exchange actually has. */
function ProbePreview({ probe, datesChanged, onRecheck }) {
  if (probe.loading) {
    return (
      <div className="rounded-lg border border-line bg-bg-elev/40 px-4 py-3 text-xs font-mono text-muted">
        Asking the exchange for its first and newest bars…
      </div>
    );
  }
  if (probe.error) {
    return (
      <div className="rounded-lg border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{probe.error}</div>
    );
  }
  const data = probe.data;
  const ok = data.symbols.filter((x) => !x.error);
  const batch = data.symbols.length > 1;
  const first = ok[0]?.timeframes[0];
  if (!batch && !ok.length) {
    return (
      <div className="rounded-lg border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{data.symbols[0].error}</div>
    );
  }
  return (
    <div className="rounded-lg border border-accent-blue/30 bg-accent-blue/5 px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wider text-accent-blue">
          Before you download · {batch ? plural(data.symbols.length, "symbol") : data.symbols[0].symbol}
          {first && ` on ${first.exchange}`}
        </div>
        <div className="text-xs font-mono text-muted">
          {data.pages
            ? <>total ≈ <span className="text-text">{fmtDuration(data.est_seconds)}</span> · {plural(data.pages, "page")}</>
            : <span className="text-accent-cyan">everything is already on disk</span>}
        </div>
      </div>

      {datesChanged && (
        <div className="text-[11px] text-amber-400">
          Start/End changed since this check — the numbers below are for the old dates.{" "}
          <button type="button" onClick={onRecheck} className="underline hover:text-text">Re-check</button>
        </div>
      )}

      {batch ? <ProbeBatch items={data.symbols} /> : <ProbeDetail item={ok[0]} />}

      <div className="text-[11px] text-muted/80 leading-relaxed pt-1 border-t border-line/40">
        {first?.parallel
          ? `Binance: 8 pages at a time, capped at ${Math.round(data.budget_share * 100)}% of Binance's per-minute request limit so live runners on this machine keep room.`
          : first ? `${first.exchange}: one page at a time.` : ""}{" "}
        {batch && "One after another in a single background download; a symbol that fails is skipped, not fatal. "}
        The first bar is when the pair was listed — the first weeks after a listing are thin and erratic, so start backtests about a month later.
      </div>
    </div>
  );
}

/** One radio card in ExistingDataModal. */
function ModeChoice({ id, choice, setChoice, title, estimate, disabled, children }) {
  const on = choice === id && !disabled;
  return (
    <label
      className={`block rounded-lg border px-3 py-2.5 transition ${
        on ? "border-accent-blue/60 bg-accent-blue/10" : "border-line"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:border-accent-blue/40"}`}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="radio"
          name="dl-mode"
          checked={on}
          disabled={disabled}
          onChange={() => setChoice(id)}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-text">{title}</span>
            <span className="text-xs font-mono text-muted shrink-0">{estimate}</span>
          </div>
          <div className="text-xs text-muted mt-0.5 leading-relaxed">{children}</div>
        </div>
      </div>
    </label>
  );
}

/** Opens when Download is pressed and some ticked timeframes already have a
 * saved file. Fill gaps (default) keeps the file and adds what's missing;
 * overwrite downloads a fresh copy of Start–End and swaps it in only once it's
 * complete. Estimates come from the auto-detect probe run when this opens. */
function ExistingDataModal({ open, title, rows, start, end, probe, choice, setChoice, overwriteBlocked, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);
  if (!open) return null;

  const plans = probe.data ? probe.data.symbols.flatMap((x) => x.timeframes || []) : null;
  const batch = new Set(rows.map((r) => r.symbol)).size > 1;
  const name = (r) => (batch ? `${r.symbol} ${r.timeframe}` : r.timeframe);
  const savedRows = rows.filter((r) => r.saved);
  const newCount = rows.length - savedRows.length;
  const estimate = (pick) => {
    if (probe.loading) return "estimating…";
    if (!plans) return "";
    const pages = plans.reduce((n, t) => n + pick(t).pages, 0);
    const secs = plans.reduce((n, t) => n + pick(t).est_seconds, 0);
    return pages ? `≈ ${plural(pages, "page")} · ${fmtDuration(secs)}` : "nothing to fetch";
  };

  // Overwrite keeps only Start–End: anything saved outside it is deleted.
  const startSec = Date.parse(`${start}T00:00:00Z`) / 1000;
  const endSec = Date.parse(`${end}T23:59:59Z`) / 1000;
  const losses = savedRows.flatMap((r) => {
    const out = [];
    if (r.saved.first_time < startSec) out.push(`${name(r)}: ${fmtDateLong(r.saved.first_time)} – ${fmtDateStr(start)}`);
    if (r.saved.last_time > endSec) out.push(`${name(r)}: ${fmtDateStr(end)} – ${fmtDateLong(r.saved.last_time)}`);
    return out;
  });
  const overwrite = choice === "overwrite" && !overwriteBlocked;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-[540px] max-w-[92vw] rounded-xl border border-line bg-bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-line">
          <h3 className="text-base font-semibold">{title}</h3>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1">On disk</div>
            <div className="space-y-0.5 text-xs font-mono max-h-48 overflow-y-auto">
              {savedRows.map((r) => (
                <div key={`${r.symbol}-${r.timeframe}`} className="flex gap-3">
                  <span className={`${batch ? "w-32" : "w-10"} shrink-0 text-accent-blue`}>{name(r)}</span>
                  <span className="text-text">
                    {fmtDateLong(r.saved.first_time)} – {fmtDateLong(r.saved.last_time)}{" "}
                    <span className="text-muted">· {plural(r.saved.rows, "bar")}</span>
                  </span>
                </div>
              ))}
              {newCount > 0 && (
                <div className="text-muted">
                  + {batch ? plural(newCount, "new symbol/timeframe") : plural(newCount, "new timeframe")} — nothing saved yet
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <ModeChoice id="fill" choice={choice} setChoice={setChoice} title="Fill gaps only" estimate={estimate((t) => t)}>
              Keeps your files and adds only what's missing — older dates, newer bars, and gaps longer than a day.
            </ModeChoice>
            <ModeChoice
              id="overwrite"
              choice={choice}
              setChoice={setChoice}
              title="Overwrite"
              estimate={estimate((t) => t.overwrite)}
              disabled={!!overwriteBlocked}
            >
              {overwriteBlocked ? overwriteBlocked : (
                <>
                  Downloads a fresh copy of {fmtDateStr(start)} – {fmtDateStr(end)} and replaces the files. Your old
                  files stay untouched until the new copy is complete, so cancelling is safe.
                  {losses.length > 0 && (
                    <span className="block mt-1.5 text-loss">
                      These saved dates are outside Start/End and would be deleted:
                      {losses.map((l) => <span key={l} className="block font-mono">{l}</span>)}
                    </span>
                  )}
                </>
              )}
            </ModeChoice>
          </div>

          {probe.error && <div className="text-xs text-loss">Couldn't estimate: {probe.error}</div>}
        </div>

        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded-md text-muted hover:text-text">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm rounded-md font-medium text-white ${
              overwrite ? "bg-loss hover:bg-loss/90" : "bg-accent-grad"
            }`}
          >
            {overwrite ? "Overwrite" : "Fill gaps"}
          </button>
        </div>
      </div>
    </div>
  );
}

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

  // Crypto tab: exchange + Spot/Perps pickers. They own the exchange prefix and
  // the ".P" suffix — the user types the bare pair and we derive the symbol
  // that actually gets saved.
  const [cryptoExchange, setCryptoExchange] = useState("binance");
  const [cryptoMarket, setCryptoMarket] = useState("spot");
  const exchange = tab.id === "crypto" ? CRYPTO_EXCHANGES[cryptoExchange] : null;
  const isPerp = !!exchange && cryptoMarket === "perp";
  const market = exchange ? exchange[cryptoMarket] : null;
  const effectiveBroker = exchange ? `${cryptoExchange}${isPerp ? "_perp" : ""}` : tab.broker;
  const effectiveSource = market ? market.source : tab.source;
  const effectiveNote = market ? market.note : tab.note;
  const effectiveSymbols = useMemo(() => {
    if (!exchange) {
      const s = symbol.trim().toUpperCase();
      return s ? [s] : [];
    }
    return parseCryptoSymbols(symbol, exchange.prefix, isPerp);
  }, [symbol, exchange, isPerp]);
  const effectiveSymbol = effectiveSymbols[0] || "";
  const isBatch = effectiveSymbols.length > 1;

  // Crypto tab: several timeframes per download; other tabs keep the single picker.
  const isCrypto = tab.id === "crypto";
  const [timeframes, setTimeframes] = useState(loadTfs);
  useEffect(() => {
    try { localStorage.setItem(TFS_KEY, JSON.stringify(timeframes)); } catch { /* storage unavailable */ }
  }, [timeframes]);
  const dlTimeframes = isCrypto ? timeframes : [timeframe];

  // Auto-detect preview. It describes one symbol + exchange + timeframe set,
  // so it's dropped as soon as any of those change (keyRef also discards a
  // reply that lands after the inputs moved on).
  const NO_PROBE = { loading: false, data: null, error: null, key: null, range: null };
  const [probe, setProbe] = useState(NO_PROBE);
  const probeKey = `${effectiveBroker}|${effectiveSymbols.join(",")}|${timeframes.join(",")}`;
  const keyRef = useRef(probeKey);
  useEffect(() => {
    keyRef.current = probeKey;
    setProbe((p) => (p.key && p.key !== probeKey ? NO_PROBE : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey]);

  // fillDates: true = whole history, and copy the detected dates into Start/End.
  // false = re-check the dates already in Start/End.
  const runProbe = async ({ fillDates }) => {
    if (!effectiveSymbols.length || !timeframes.length) return;
    const key = probeKey;
    setProbe({ ...NO_PROBE, loading: true, key });
    try {
      const data = await probeDataset({
        symbols: effectiveSymbols, broker: effectiveBroker, timeframes,
        start: fillDates ? undefined : start,
        end: fillDates ? undefined : end,
      });
      if (keyRef.current !== key) return;
      let range = { start, end };
      const firsts = data.symbols.flatMap((x) => x.timeframes || []).map((t) => t.first_ms);
      if (fillDates && firsts.length) {
        // The earliest of them; each symbol is still clamped to its own first bar.
        const firstMs = Math.min(...firsts);
        range = { start: new Date(firstMs).toISOString().slice(0, 10), end: todayIso() };
        setStart(range.start);
        setEnd(range.end);
      }
      setProbe({ ...NO_PROBE, data, key, range });
    } catch (err) {
      if (keyRef.current !== key) return;
      setProbe({ ...NO_PROBE, key, error: err?.response?.data?.error || err.message || "Auto-detect failed" });
    }
  };
  const datesChanged = !!probe.range && (probe.range.start !== start || probe.range.end !== end);

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
  // The preview's "on disk" numbers are stale after that, so drop it too.
  useEffect(() => {
    if (!busy && result) {
      refresh();
      setProbe(NO_PROBE);
    }
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

  // Crypto: every symbol x ticked timeframe and its saved file (if any).
  const existingRows = useMemo(
    () => effectiveSymbols.flatMap((sym) => dlTimeframes.map((tf) => ({
      symbol: sym,
      timeframe: tf,
      saved: datasets.find((d) => d.symbol === sym && d.timeframe === tf
        && (d.broker || "binance") === effectiveBroker) || null,
    }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datasets, effectiveSymbols.join(","), effectiveBroker, dlTimeframes.join(",")],
  );
  const [askExisting, setAskExisting] = useState(false);
  const [mode, setMode] = useState("fill"); // fill | overwrite
  // MEXC drops old short-timeframe bars, so a fresh copy would lose history
  // that only your saved file still has.
  const overwriteBlocked = cryptoExchange === "mexc"
    ? "Not available on MEXC — it only keeps ~30 days of 1m and ~1 year of 5m/15m, so a fresh copy would delete history MEXC no longer has."
    : null;

  const launchDownload = async (overwrite) => {
    const syms = effectiveSymbols;
    const label = isBatch ? `${syms.length}symbols` : syms[0];
    const jobId = `${effectiveBroker}_${label}_${dlTimeframes.join("-")}_${Date.now()}`;
    let sid = null;
    try { sid = await waitForSocketId(2000); } catch { /* progress just won't stream */ }
    try {
      await startDownload({ symbols: syms, timeframes: dlTimeframes, start, end, sid, jobId, broker: effectiveBroker, overwrite });
    } catch { /* error already on the store */ }
  };

  const onDownload = (e) => {
    e?.preventDefault?.();
    if (!tab.enabled) return;
    // Something's already saved: ask fill-gaps vs overwrite first, and fetch
    // estimates for both while the popup is open.
    if (isCrypto && existingRows.some((r) => r.saved)) {
      setMode("fill");
      setAskExisting(true);
      runProbe({ fillDates: false });
      return;
    }
    launchDownload(false);
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

  // ---- search + pagination over the cached-datasets table -------------------
  const PAGE_SIZE = 10;
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  // Crypto tab: exchange filter (spot + perp folders together, e.g. mexc + mexc_perp).
  const [exchangeFilter, setExchangeFilter] = useState("all");
  const exchangeOf = (d) => (d.broker || "binance").replace(/_perp$/, "");
  const filterByExchange = tab.id === "crypto" && exchangeFilter !== "all";

  // Match on symbol, timeframe or broker so "check this asset exists" works
  // whether you type OPUSDT, 15m, or binance.
  const matchesQuery = (d, q) =>
    `${d.symbol} ${d.timeframe} ${d.broker || "binance"}`.toLowerCase().includes(q);

  const queryMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? tabDatasets.filter((d) => matchesQuery(d, q)) : tabDatasets;
  }, [tabDatasets, query]);

  const filteredDatasets = useMemo(
    () => (filterByExchange ? queryMatches.filter((d) => exchangeOf(d) === exchangeFilter) : queryMatches),
    [queryMatches, filterByExchange, exchangeFilter],
  );

  const exchangeOptions = useMemo(() => {
    const n = (id) => tabDatasets.filter((d) => exchangeOf(d) === id).length;
    return [
      ["all", `All ${tabDatasets.length}`],
      ...Object.entries(CRYPTO_EXCHANGES).map(([id, x]) => [id, `${x.label} ${n(id)}`]),
    ];
  }, [tabDatasets]);

  // Same search run against the OTHER tabs, using each tab's own membership
  // rule — so a symbol cached under a different asset class still gets found
  // instead of reading as "doesn't exist".
  const otherTabHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return TABS
      .filter((t) => t.id !== tab.id && t.enabled)
      .map((t) => {
        const inTab = (t.broker === "tradestation" || t.broker === "yahoo")
          ? datasets.filter((d) => d.broker === t.broker)
          : datasets.filter((d) => (d.asset_class || "crypto") === t.id);
        return { id: t.id, label: t.label, n: inTab.filter((d) => matchesQuery(d, q)).length };
      })
      .filter((h) => h.n > 0);
  }, [datasets, query, tab.id]);

  const totalPages = Math.max(1, Math.ceil(filteredDatasets.length / PAGE_SIZE));
  // Clamp rather than store — after a delete or a new filter the stored page can
  // point past the end, which would render an empty table.
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageRows = useMemo(
    () => filteredDatasets.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredDatasets, safePage],
  );
  useEffect(() => { setPage(1); }, [tab.id, query, exchangeFilter]);

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
  // Crypto reports pages (they finish out of order, so a date cursor would
  // jump around) plus its own ETA for the timeframe in progress.
  const pagesPct = progress?.pages_total
    ? Math.min(100, (progress.pages_done / progress.pages_total) * 100)
    : null;
  const barPct = pagesPct ?? cursorPct;
  const itemCount = progress?.item_count || 1;
  const multiSymbol = (dl.symbols?.length || 1) > 1;
  const tfLabel = progress?.timeframe
    ? `${multiSymbol ? `${progress.symbol} ` : ""}${progress.timeframe}`
      + (itemCount > 1 ? ` (${(progress.item_index ?? 0) + 1}/${itemCount})` : "")
    : "";
  const etaSec = progress?.eta_seconds != null
    ? progress.eta_seconds
    : (elapsedSec != null && cursorPct != null && cursorPct > 0.5 && cursorPct < 100)
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
            <div className="text-sm font-mono text-text mt-0.5">{effectiveSource}</div>
          </div>
          <div className="text-[11px] text-muted/80 max-w-md text-right">{effectiveNote}</div>
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
            <div className={isCrypto ? "md:col-span-3" : "md:col-span-2"}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-1">
                <label className="block text-xs uppercase tracking-wider text-muted">Symbol</label>
                {exchange && (
                  <div className="flex items-center gap-1.5">
                    <Segmented
                      label="Exchange"
                      options={Object.entries(CRYPTO_EXCHANGES).map(([id, x]) => [id, x.label])}
                      value={cryptoExchange}
                      onChange={setCryptoExchange}
                    />
                    <Segmented
                      label="Market"
                      options={CRYPTO_MARKETS}
                      value={cryptoMarket}
                      onChange={setCryptoMarket}
                    />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  onPaste={(e) => {
                    // A pasted list, one per line: keep every line (a plain
                    // input would drop the line breaks and glue names together).
                    const text = e.clipboardData.getData("text");
                    if (!isCrypto || !/[\r\n]/.test(text)) return;
                    e.preventDefault();
                    setSymbol((prev) => `${prev} ${text}`.replace(/\s+/g, " ").trim().toUpperCase());
                  }}
                  list={`symbol-suggestions-${tab.id}`}
                  placeholder={isCrypto ? `${tab.defaultSymbol} — or a list: ONEUSDT, OGN, CVC…` : tab.defaultSymbol}
                  className="w-full min-w-0 px-3 py-2 rounded-md bg-bg-elev border border-line font-mono focus:outline-none focus:border-accent-blue"
                />
                {isCrypto && (
                  <button
                    type="button"
                    onClick={() => runProbe({ fillDates: true })}
                    disabled={!effectiveSymbols.length || !timeframes.length || probe.loading}
                    title="Find the exchange's first and newest bar, fill Start/End, and preview what will download"
                    className="shrink-0 px-3 py-2 rounded-md border border-accent-blue/50 text-accent-blue text-sm font-medium hover:bg-accent-blue/10 disabled:opacity-50"
                  >
                    {probe.loading ? "Detecting…" : "Auto-detect"}
                  </button>
                )}
              </div>
              <datalist id={`symbol-suggestions-${tab.id}`}>
                {tab.suggested.map((s) => <option key={s} value={s} />)}
              </datalist>
              {exchange && effectiveSymbols.length > 0
                && (isBatch || effectiveBroker !== "binance" || effectiveSymbol !== symbol.trim()) && (
                <div className="mt-1 text-[11px] font-mono text-muted">
                  {isBatch ? `${effectiveSymbols.length} symbols: ` : "saves as "}
                  <span className="text-accent-blue">{effectiveSymbols.join(" · ")}</span> · folder{" "}
                  <span className="text-text">{effectiveBroker}</span>
                </div>
              )}
            </div>

            {!isCrypto && (
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
            )}

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

            {isCrypto && (
              <div className="md:col-span-5">
                <label className="block text-xs uppercase tracking-wider text-muted mb-1">
                  Timeframes{" "}
                  <span className="normal-case tracking-normal text-muted/70">
                    — each one downloads straight from the exchange, one after another
                  </span>
                </label>
                <TfChips value={timeframes} onChange={setTimeframes} />
              </div>
            )}

            {isCrypto && (probe.loading || probe.data || probe.error) && (
              <div className="md:col-span-5">
                <ProbePreview probe={probe} datesChanged={datesChanged} onRecheck={() => runProbe({ fillDates: false })} />
              </div>
            )}

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
                  disabled={!effectiveSymbols.length || !start || !end || !dlTimeframes.length}
                  className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-medium disabled:opacity-50"
                >
                  Download {isBatch ? `${effectiveSymbols.length} symbols · ` : ""}
                  {isCrypto && timeframes.length ? `${timeframes.join(" · ")} ` : ""}from{" "}
                  {exchange ? exchange.label : effectiveSource.split(" ")[0]}{isPerp ? " Perps" : ""}
                </button>
              )}
              <span className="text-xs text-muted">
                {isCrypto
                  ? "Runs in the background. Only the parts missing from your files are fetched — run it again to top up or to resume a stopped download."
                  : "Runs in the background — you can navigate away and come back. Re-runs merge into the existing file (idempotent)."}
              </span>
            </div>

            {/* Progress */}
            {busy && (
              <div className="md:col-span-5 mt-2 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-muted">
                  <span>
                    {progress?.status === "starting" && "queued…"}
                    {progress?.status === "downloading" && (
                      progress.pages_total != null
                        ? <>{tfLabel} · <span className="text-text">{fmtInt(progress.pages_done)} / {plural(progress.pages_total, "page")}</span></>
                        : <>{tfLabel && `${tfLabel} · `}cursor at <span className="text-text">{msDate(progress.cursor_ms)}</span></>
                    )}
                    {!progress && "preparing…"}
                  </span>
                  <span>
                    {dl.broker ? `${dl.broker} · ${multiSymbol ? plural(dl.symbols.length, "symbol") : dl.symbol} · ` : ""}
                    {msDate(progress?.start_ms)} – {msDate(progress?.end_ms)}
                  </span>
                </div>

                <div className="h-2 rounded-full bg-bg-elev border border-line overflow-hidden">
                  <div
                    className="h-full bg-accent-grad transition-all duration-300"
                    style={{ width: `${barPct ?? 0}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-xs font-mono text-muted">
                  {pagesPct != null ? (
                    <>
                      <span>{plural(progress.fetched ?? 0, "bar")} fetched</span>
                      <span>{Math.round(pagesPct)}%</span>
                    </>
                  ) : (
                    <>
                      <span>
                        {fmtInt(progress?.fetched ?? 0)} / ~{fmtInt(progress?.expected, "?")} candles
                      </span>
                      <span>{pct != null ? `${pct}%` : ""}</span>
                    </>
                  )}
                </div>

                <div className="flex items-center justify-between text-xs font-mono text-muted/80 pt-1 border-t border-line/30">
                  <span>elapsed <span className="text-text">{fmtDuration(elapsedSec)}</span></span>
                  <span>
                    ETA{itemCount > 1 && progress?.eta_seconds != null ? " (this one)" : ""}{" "}
                    <span className="text-text">{etaSec != null ? fmtDuration(etaSec) : "—"}</span>
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
          <div className="rounded-md border border-accent-cyan/40 bg-accent-cyan/5 px-4 py-3 text-sm font-mono space-y-0.5">
            {(result.results || [result]).map((r) => (r.error ? (
              <div key={`${r.symbol}-${r.timeframe}`} className="text-loss">
                ✗ {result.broker || "binance"} · {r.symbol} {r.timeframe} — skipped: {r.error}
              </div>
            ) : (
              <div key={`${r.symbol || result.symbol}-${r.timeframe}`}>
                ✓ {result.broker || "binance"} · {r.symbol || result.symbol} {r.timeframe} —{" "}
                {r.replaced
                  ? <>replaced: now {fmtInt(r.rows_total, "?")} bars (was {fmtInt(r.rows_before, "?")})</>
                  : <>added {fmtInt(r.rows_added, "?")} bars (total {fmtInt(r.rows_total, "?")})</>}{" "}
                · {fmtDateLong(r.first_time)} – {fmtDateLong(r.last_time)}
              </div>
            )))}
          </div>
        )}

        {cancelled && !busy && (
          <div className="rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-3 text-sm font-mono text-amber-400">
            {dl.overwrite
              ? "⨯ overwrite cancelled · the timeframe in progress kept its old file (any already finished were replaced)"
              : "⨯ download cancelled · what was already fetched was kept — download again to resume"}
          </div>
        )}

        <ExistingDataModal
          open={askExisting}
          title={isBatch ? "Some of these already have saved data" : `${effectiveSymbol} already has saved data`}
          rows={existingRows}
          start={start}
          end={end}
          probe={probe}
          choice={mode}
          setChoice={setMode}
          overwriteBlocked={overwriteBlocked}
          onCancel={() => setAskExisting(false)}
          onConfirm={() => {
            setAskExisting(false);
            launchDownload(mode === "overwrite" && !overwriteBlocked);
          }}
        />

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
          <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
            <h2 className="text-sm uppercase tracking-wider text-muted">
              Cached {tab.label.toLowerCase()} datasets ({filteredDatasets.length}
              {filteredDatasets.length !== tabDatasets.length && ` of ${tabDatasets.length}`})
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {tab.id === "crypto" && (
                <Segmented
                  label="Filter by exchange"
                  options={exchangeOptions}
                  value={exchangeFilter}
                  onChange={setExchangeFilter}
                />
              )}
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search asset — symbol, TF or broker"
                  aria-label="Search cached datasets"
                  className="w-72 max-w-full pl-3 pr-8 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-xs focus:outline-none focus:border-accent-blue"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded text-muted hover:text-text hover:bg-bg-panel transition leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          </div>

          {query.trim() && queryMatches.length === 0 && (
            <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-2.5 text-xs">
              <span className="font-mono text-amber-400">{query.trim().toUpperCase()}</span>
              <span className="text-muted"> is not cached under {tab.label}.</span>
              {otherTabHits.length > 0 && (
                <span className="text-muted">
                  {" "}Found in{" "}
                  {otherTabHits.map((h, i) => (
                    <span key={h.id}>
                      {i > 0 && ", "}
                      <button
                        onClick={() => setActiveTabId(h.id)}
                        className="text-accent-blue hover:underline"
                      >
                        {h.label} ({h.n})
                      </button>
                    </span>
                  ))}
                  .
                </span>
              )}
              {otherTabHits.length === 0 && (
                <span className="text-muted"> Not cached under any other asset class either — download it with the form above.</span>
              )}
            </div>
          )}

          {query.trim() && queryMatches.length > 0 && otherTabHits.length > 0 && (
            <div className="mb-3 text-[11px] text-muted">
              Also matches in{" "}
              {otherTabHits.map((h, i) => (
                <span key={h.id}>
                  {i > 0 && ", "}
                  <button onClick={() => setActiveTabId(h.id)} className="text-accent-blue hover:underline">
                    {h.label} ({h.n})
                  </button>
                </span>
              ))}
              .
            </div>
          )}

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
                {pageRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-muted text-xs">
                      {filterByExchange
                        ? `no ${CRYPTO_EXCHANGES[exchangeFilter].label} datasets${query.trim() ? ` match "${query.trim()}"` : " yet — use the form above"}`
                        : query.trim()
                          ? `no ${tab.label.toLowerCase()} datasets match "${query.trim()}"`
                          : `no ${tab.label.toLowerCase()} datasets yet — use the form above`}
                    </td>
                  </tr>
                )}
                {pageRows.map((d) => (
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

            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-line/60 bg-bg-elev/20">
                <span className="text-[11px] font-mono text-muted">
                  {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredDatasets.length)} of {filteredDatasets.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(safePage - 1)}
                    disabled={safePage <= 1}
                    className="px-2.5 py-1 rounded-md border border-line text-xs font-mono text-muted hover:text-text hover:border-muted transition disabled:opacity-40 disabled:hover:text-muted disabled:hover:border-line"
                  >
                    ‹ Prev
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      aria-current={p === safePage ? "page" : undefined}
                      className={`min-w-[1.9rem] px-2 py-1 rounded-md border text-xs font-mono transition ${
                        p === safePage
                          ? "border-accent-blue/60 bg-accent-blue/15 text-accent-blue"
                          : "border-line text-muted hover:text-text hover:border-muted"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage(safePage + 1)}
                    disabled={safePage >= totalPages}
                    className="px-2.5 py-1 rounded-md border border-line text-xs font-mono text-muted hover:text-text hover:border-muted transition disabled:opacity-40 disabled:hover:text-muted disabled:hover:border-line"
                  >
                    Next ›
                  </button>
                </div>
              </div>
            )}
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
