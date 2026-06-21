import { useEffect, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";
import { getRiskConfig, updateRiskConfig } from "../services/api.js";
import { fmtUsd, fmtNum } from "../services/format.js";
import {
  clearAll as clearAllStrategies,
  getCount as strategiesCount,
} from "../services/strategiesStore.js";
import {
  clear as clearAllResults,
  getCount as resultsCount,
} from "../services/lastResultStore.js";
import { TZ_PRESETS, getTz, setTz, convertUtcHHmm } from "../services/timezone.js";

const RISK_DEFAULTS = {
  starting_capital:   100000,
  fee_flat:           0.0,
  fee_pct:            0.04,
  futures_commission: 0.0,
  slippage_bps:       1.0,
};

// Quick fee/cost-model presets. They stage values into the form (like "Reset
// to defaults") — not saved until Save. Starting capital is left untouched.
const COST_PRESETS = [
  { id: "none", label: "No Fees",
    hint: "Zero out all fees, commission & slippage.",
    values: { fee_flat: 0, fee_pct: 0, futures_commission: 0, slippage_bps: 0 } },
  { id: "binance", label: "Binance",
    hint: "Crypto/spot: 0.06% per side, no flat fee.",
    values: { fee_flat: 0, fee_pct: 0.06, futures_commission: 0, slippage_bps: 1 } },
  { id: "tradestation", label: "TradeStation",
    hint: "Futures: $1.50 per contract per side (no % fee).",
    values: { fee_flat: 0, fee_pct: 0, futures_commission: 1.50, slippage_bps: 1 } },
];

const FIELDS = [
  { key: "starting_capital", label: "Starting Capital",     unit: "$",   step: 1000, min: 1,
    hint: "Same baseline applied to every backtest." },
  { key: "fee_flat",         label: "Flat Fee per Side",    unit: "$",   step: 0.1,  min: 0,
    hint: "Charged on both entry and exit." },
  { key: "fee_pct",          label: "Fee % per Side",       unit: "%",   step: 0.01, min: 0, max: 10,
    hint: "Of notional (crypto/spot). Charged on both entry and exit." },
  { key: "futures_commission", label: "Futures Commission / Contract", unit: "$", step: 0.25, min: 0,
    hint: "Flat $ per contract per side for index futures (ES, NQ…). Replaces the % fee for contract-sized instruments." },
  { key: "slippage_bps",     label: "Slippage",             unit: "bps", step: 0.5,  min: 0, max: 500,
    hint: "Adverse fill price applied to each entry & exit." },
  // risk_pct and pyramiding are now configured per-strategy in the strategy Settings panel.
];

export default function RiskSettings() {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [err, setErr] = useState(null);

  // Storage / cache state
  const [confirm, setConfirm] = useState(null);  // 'strategies' | 'results' | 'all' | null
  const [stratN, setStratN] = useState(strategiesCount());
  const [resultN, setResultN] = useState(resultsCount());
  const refreshCounts = () => { setStratN(strategiesCount()); setResultN(resultsCount()); };

  // Display timezone (browser-local). Conversions show UTC session times in this zone.
  const [tz, setTzState] = useState(getTz());
  const onTzChange = (next) => { setTz(next); setTzState(next); };

  useEffect(() => {
    getRiskConfig().then(setCfg).catch((e) => setErr(e.message));
  }, []);

  if (!cfg) {
    return (
      <div className="min-h-screen flex flex-col">
        <Navbar view="settings" />
        <main className="flex-1 p-6 max-w-3xl w-full mx-auto">
          <div className="text-sm text-muted">{err ? `error: ${err}` : "loading…"}</div>
        </main>
      </div>
    );
  }

  const setField = (key, v) => setCfg({ ...cfg, [key]: v });
  const applyPreset = (values) => setCfg((c) => ({ ...c, ...values }));

  const onSave = async () => {
    setBusy(true); setErr(null);
    try {
      const next = await updateRiskConfig(cfg);
      setCfg(next);
      setSavedAt(new Date());
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar view="settings" />
      <main className="flex-1 p-6 max-w-3xl w-full mx-auto space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Risk Management</h1>
          <p className="text-sm text-muted mt-1">
            Global infrastructure settings shared by <span className="text-text">all strategies</span>.
            Position sizing (<span className="font-mono">risk_pct</span>) and pyramiding live on each strategy.
          </p>
        </header>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-muted mr-1">Cost presets</span>
          {COST_PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.values)}
              title={p.hint}
              className="px-3 py-1.5 rounded-md border border-line text-sm text-muted hover:text-text hover:border-accent-blue transition"
            >
              {p.label}
            </button>
          ))}
          <span className="text-xs text-muted/70 basis-full">
            Fills the fee fields below — review, then Save. Starting capital is untouched.
          </span>
        </div>

        <div className="rounded-xl border border-line bg-bg-panel/60 divide-y divide-line/40">
          {FIELDS.map((f) => (
            <Row key={f.key} field={f} value={cfg[f.key]} onChange={(v) => setField(f.key, v)} />
          ))}
        </div>

        {err && (
          <div className="rounded-md border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{err}</div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={onSave} disabled={busy}
            className="px-5 py-2 rounded-md bg-accent-grad text-white text-sm font-semibold disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => setCfg((c) => ({ ...c, ...RISK_DEFAULTS }))}
            disabled={busy}
            className="px-4 py-2 rounded-md border border-line text-muted text-sm hover:text-text hover:border-accent-blue disabled:opacity-50 transition"
            title="Reset to factory defaults (does not save until you click Save)"
          >
            Reset to defaults
          </button>
          {savedAt && (
            <span className="text-xs text-muted">
              saved {savedAt.toLocaleTimeString()}
            </span>
          )}
        </div>

        <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
          <div className="text-xs uppercase tracking-wider text-muted mb-2">Current effective</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
            <div className="text-muted">Starting capital</div><div className="text-text">{fmtUsd(cfg.starting_capital)}</div>
            <div className="text-muted">Flat fee</div>        <div className="text-text">{fmtUsd(cfg.fee_flat)}</div>
            <div className="text-muted">Fee %</div>           <div className="text-text">{fmtNum(cfg.fee_pct)}%</div>
            <div className="text-muted">Futures comm.</div>   <div className="text-text">{fmtUsd(cfg.futures_commission ?? 0)}/contract</div>
            <div className="text-muted">Slippage</div>        <div className="text-text">{fmtNum(cfg.slippage_bps)} bps</div>
          </div>
        </div>

        {/* Display timezone (browser-local) */}
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Display timezone</h2>
          <div className="rounded-xl border border-line bg-bg-panel/60 px-5 py-4 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm">Strategy session times</div>
                <div className="text-xs text-muted/80 mt-0.5">
                  Session windows are always stored as <span className="font-mono">UTC</span>.
                  Pick a zone here and the strategy editor will show live conversions
                  (plus NY and PH for reference). Browser-local — not synced.
                </div>
              </div>
              <select
                value={tz}
                onChange={(e) => onTzChange(e.target.value)}
                className="px-3 py-1.5 rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue"
              >
                {TZ_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="rounded-lg border border-line/40 bg-bg-elev/30 px-3 py-2 font-mono text-xs flex flex-wrap gap-x-6 gap-y-1">
              <span className="text-muted">e.g. <span className="text-text">12:30 UTC</span></span>
              <span className="text-muted">= <span className="text-text">{convertUtcHHmm("12:30", "America/New_York")}</span> NY</span>
              <span className="text-muted">= <span className="text-text">{convertUtcHHmm("12:30", "Asia/Manila")}</span> PH</span>
              {tz !== "Etc/UTC" && tz !== "America/New_York" && tz !== "Asia/Manila" && (
                <span className="text-muted">= <span className="text-text">{convertUtcHHmm("12:30", tz)}</span> {TZ_PRESETS.find(p => p.value === tz)?.short || tz}</span>
              )}
            </div>
          </div>
        </section>

        {/* Storage / cache */}
        <section>
          <h2 className="text-sm uppercase tracking-wider text-muted mb-2">Browser storage</h2>
          <div className="rounded-xl border border-line bg-bg-panel/60 divide-y divide-line/40">
            <CacheRow
              label="Active strategies"
              hint="Strategies you've added to the dashboard, plus their edited params (sessions, RSI, etc)."
              count={stratN}
              suffix={stratN === 1 ? "strategy" : "strategies"}
              onClear={() => setConfirm("strategies")}
            />
            <CacheRow
              label="Cached backtest results"
              hint="The full result blobs the Analytics page reads (per strategy/symbol/timeframe)."
              count={resultN}
              suffix={resultN === 1 ? "result" : "results"}
              onClear={() => setConfirm("results")}
            />
            <CacheRow
              label="Everything"
              hint="Wipe both. Use after default-param updates to start fresh."
              count={stratN + resultN}
              suffix="entries"
              onClear={() => setConfirm("all")}
              danger
            />
          </div>
        </section>
      </main>

      <ConfirmModal
        open={!!confirm}
        title={
          confirm === "strategies" ? "Clear active strategies?" :
          confirm === "results"    ? "Clear cached backtest results?" :
                                     "Clear all browser data?"
        }
        message={
          confirm === "strategies" ? "Your dashboard strategy list and any param customizations will be removed. You can re-add strategies from the Strategies page." :
          confirm === "results"    ? "Cached backtest result blobs will be removed. The Analytics page will be empty until you run a fresh backtest." :
                                     "Wipes both active strategies and cached results. Risk config is unaffected."
        }
        confirmLabel="Clear"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm === "strategies" || confirm === "all") clearAllStrategies();
          if (confirm === "results"    || confirm === "all") clearAllResults();
          refreshCounts();
          setConfirm(null);
        }}
      />
    </div>
  );
}

function CacheRow({ label, hint, count, suffix, onClear, danger }) {
  const empty = count === 0;
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-xs text-muted/80 mt-0.5">{hint}</div>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-muted">{count} {suffix}</span>
        <button
          onClick={onClear}
          disabled={empty}
          className={`px-3 py-1.5 text-xs rounded-md font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed ${
            danger
              ? "border-loss/40 text-loss hover:bg-loss/10"
              : "border-line text-muted hover:text-text hover:border-accent-blue"
          }`}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function Row({ field, value, onChange }) {
  const apply = (raw) => {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) onChange(Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, n)));
  };
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div>
        <div className="text-sm">{field.label}</div>
        <div className="text-xs text-muted/80 mt-0.5">{field.hint}</div>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => apply((Number(value) || 0) - field.step)}
          className="w-7 h-7 rounded-md bg-bg-elev border border-line text-muted hover:text-text hover:border-accent-blue text-sm leading-none">−</button>
        <div className="relative">
          <input
            type="number" step={field.step} min={field.min} max={field.max}
            value={value}
            onChange={(e) => apply(e.target.value)}
            className="w-32 px-3 py-1.5 text-right rounded-md bg-bg-elev border border-line font-mono text-sm focus:outline-none focus:border-accent-blue pr-9"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none">{field.unit}</span>
        </div>
        <button onClick={() => apply((Number(value) || 0) + field.step)}
          className="w-7 h-7 rounded-md bg-bg-elev border border-line text-muted hover:text-text hover:border-accent-blue text-sm leading-none">+</button>
      </div>
    </div>
  );
}
