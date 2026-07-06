# QuantLab — project guide for Claude

A multi-asset quantitative trading research platform: Flask + SocketIO backend (Python),
React frontend, with backtesting, walk-forward optimization, a "Market Lab" of read-only
market-structure analyses, and live/paper strategy running across brokers (Binance via CCXT,
Databento for CME futures, TradeStation).

## How to work with me (read this first)

- **We're partners — you're the senior one, I'm the junior researcher learning the craft.**
  Treat me as a new quant researcher who was handed this project and genuinely wants to do it
  the *correct* way while learning. So: teach me the *why* behind each step, not just the *what*.
  Don't silently do everything for me — pause at the real decisions, show your reasoning, and let
  me make the call. When there's a proper quant practice vs. a convenient shortcut, name the
  proper one and explain why it matters. I'd rather learn it right once than cargo-cult it. You
  lead and advise; I stay in the loop and grow.
- **I'm not an experienced quant.** I'm navigating this project as I go. Explain things in
  plain, non-technical language. When a quant or finance term is genuinely needed (e.g. Sharpe,
  walk-forward, slippage, drawdown), add a short one-line definition in plain words the first
  time it comes up. Don't assume I already know the jargon.
- **Tell me the plan in plain words before you edit.** Before making non-trivial changes,
  describe what you're going to do in non-technical terms and let me approve it first. Don't
  auto-edit straight into the code on bigger changes — walk me through it, then do it once I say go.
  (Small obvious fixes are fine to just do.)
- **Challenge me, and ask.** Always ask questions when something's unclear or a choice would
  change the outcome — don't guess. And if my approach is weak or there's a better one, say so and
  counter it with the better path plus *why*; don't just execute what I asked. I'd rather be
  corrected early than unwind a wrong assumption. Pushing back is your job as the senior one.
- **Use the simplest words that still carry the meaning.** Only reach for a technical or finance
  term when a plain word would genuinely lose something — and when you do, define it in one line.
- **Don't over-engineer.** Always look for the easiest path that still scales reasonably. Prefer
  simple, readable solutions over clever or heavily-abstracted ones.
- **This is for self-use validation only.** The project won't be used by many people — it's me
  validating ideas for myself. Optimize for "works and I understand it," not for production
  hardening, multi-user scale, or enterprise polish.

## Display formatting (always follow these)

- **Dates** — always display as `Mon DD, YYYY` (e.g. `Feb 03, 2021`). Never bare ISO (`2021-02-03`).
  - From epoch seconds → `fmtDateLong(epochSec)` in `frontend/src/services/format.js`
  - From `"YYYY-MM-DD"` string → `fmtDateStr(dateStr)` in the same file
  - Date ranges: `Feb 03, 2021 – May 19, 2026` (en-dash, no hyphens)
- **Numbers** — always comma-separated with 2 decimal places: `132,312.00`, `1,231.00`
  - Plain numbers → `fmtNum(v)` · integers (bar counts, trades) → `fmtInt(v)` · USD → `fmtUsd(v)`
  - Never use raw `.toLocaleString()`, `.toFixed()`, or bare template literals for displayed numbers
- **Percentages** — `+3.46%` / `-1.20%` via `fmtPct(v)` (sign forced) or `fmtPct(v, false)` (unsigned)

## Environment (important)

- **Python 3.14** is the only interpreter installed (no venv). The full backend stack is
  already installed and working on it: `torch 2.12.0+cpu`, `pandas 3.0.3`, `optuna`,
  `ccxt`, `pyarrow`, `scikit-learn`, `flask`, etc.
- **`hmmlearn` will NOT install on 3.14** — no prebuilt cp314 wheel, and a source build needs
  the MSVC C++ Build Tools. Don't add it to `backend/requirements.txt`. The HMM experiment
  (below) implements the model in pure numpy/scipy to avoid this. Do not downgrade the project
  to get a single package — 3.14 already runs everything else.
- Platform: Windows 11, PowerShell. Use PowerShell syntax (`$null`, `$env:VAR`).

## Layout

```
backend/
  app.py                      # Flask + SocketIO entrypoint (port 6173)
  config.py                   # SUPPORTED_SYMBOLS, TIMEFRAMES, DATA_DIR, lookback, capital
  services/
    market_data.py            # parquet OHLCV cache; load_parquet / ensure_parquet / download_range
    backtest_engine.py        # run(strategy_id, symbol, timeframe, ...) -> candles/trades/equity/stats
    walkforward.py            # rolling IS/OOS + Optuna; stitched OOS equity curve
    strategy_registry.py      # auto-discovers Strategy subclasses
    market_lab.py             # read-only analyses (regimes, vol, stats, MR scan, feature importance...)
    quant_metrics.py          # Sharpe/Sortino/Calmar, infer_bars_per_year, _safe
    brokers/                  # binance, databento (CME), tradestation, dukascopy
    strategies/
      base.py                 # Strategy ABC: vectorized() + on_candle(); ParamSpec/Signal/OverlaySpec
      regime.py               # DETERMINISTIC regime detection (see below)
      vwma_reversion.py       # only strategy that uses regimes (entry gating)
      vwma_momentum.py, pivot_breakout.py, rsi2_reversion.py, lunar.py
  routes/                     # Flask blueprints (strategy, market, walkforward, market_lab, ...)
  data/{binance,databento,tradestation}/{SYMBOL}_{TF}.parquet
frontend/                     # React (Vite dev server, port 5173)
experiments/hmm_regime/       # ISOLATED HMM regime experiment (see below)
scripts/pull_databento.py     # bulk CME futures downloader
ui.py / launch.py             # GUI / process launchers (also ui.bat, launch.bat)
```

## Live Terminal (new live dashboard — plans/01–10, built Jul 02, 2026)

- **Go Live** (button in both research navbars) hard-flips the app into the Live
  Terminal; **EXIT LIVE** flips back. Mode persists (`ql.app_mode`). The terminal is a
  pristine separate UI: `frontend/src/pages/live/LiveTerminal.jsx` +
  `frontend/src/components/live/` under a scoped `.live-terminal` theme — it never
  imports backtest components and vice versa (see plans/EXECUTION-NOTES.md).
- **The daemon is the engine.** The terminal is a view/control over the SAME live-alert
  pipeline: rules in `data/live_alerts.json`, headless runners in `alerts_daemon`,
  webhooks via `live_alerter`. A "deployment" == an alert rule (+ `account` demo|live
  field). Live-only backend: `backend/services/live/` (live_engine = kill switch /
  idempotency / journal, live_store = SQLite `data/live_terminal.db` (gitignored),
  live_analytics, wamp_positions, orderbook_hub, live_feed) + `routes/live_terminal_routes.py`
  (`/api/live/*`).
- **Safety:** global DISARM ALL blocks every webhook POST; deploy modal confirms before
  arming (Demo default; Live shows a red warning); test signals default to dry-run;
  a (rule, bar, action) fires at most once; `pyramiding` locked to 1 live (parity).
- **Positions / Risk / Reconciliation** read the WAMP `sinegu_db` READ-ONLY
  (`WAMP_DB_*` in backend/.env, defaults localhost/root/''/sinegu_db) and fall back to
  labeled SIMULATED when WAMP is down. Alerts are stored in QuantLab only.
- **Old `#livealerts` page stays fully working** until the cutover soak completes
  (plans/10) — don't remove it before then.

## Data

- `market_data.load_parquet(symbol, timeframe, broker=None)` returns a DataFrame with columns
  `[time (int seconds), open, high, low, close, volume]`. Raises `FileNotFoundError` if not
  cached — `ensure_parquet(symbol, timeframe)` downloads ~2yr (Binance/CCXT) first.
- Cached crypto symbols: `BTCUSDT`, `FETUSDT` at `1m/5m/15m/1h`. CME futures (ES/NQ/CL/GC) via
  Databento need `DATABENTO_API_KEY` in `backend/.env`.

## Regime detection

Two systems exist; keep them straight:

1. **Deterministic (production)** — [backend/services/strategies/regime.py](backend/services/strategies/regime.py).
   - `RegimeDetector(period, threshold)` — binary ADX filter: `detect(df)` → bool Series
     (True = ranging/safe for mean reversion); `last_adx(df)` for live.
   - `_regime_labels(df, _regime_params(p))` → 5 labels: `Trending Up/Down`, `High-Volatility`,
     `Quiet`, `Choppy-Range`, from ADX + rolling-linreg slope + trailing volatility percentile.
     **Causal** (every feature at bar i uses only bars ≤ i). Shared by `vwma_reversion.py`
     (entry gating) and `market_lab.classify_regimes()` (UI regime ribbon).

2. **Gaussian HMM (experimental, isolated)** — [experiments/hmm_regime/](experiments/hmm_regime/).
   - Evaluating an HMM as a data-driven alternative to the rule-based detector for BTCUSDT.
     Phase 1 is purely diagnostic: "does it read well?" — NOT yet wired into any strategy.
   - Model is implemented **from scratch** in `hmm_model.py` (Baum-Welch EM, log-space
     forward-backward, Viterbi, full-covariance Gaussian emissions, KMeans init) — no hmmlearn.
   - Observations (`features.py`): log return, 20-bar realized vol, rolling Hurst (R/S), standardized.
   - Run: `pip install -r experiments\hmm_regime\requirements-hmm.txt` then
     `python experiments\hmm_regime\run_hmm_btc.py` → PNGs + `hmm_bars.csv` + console report in
     `experiments/hmm_regime/out/`. Fits k=2/3/4 and cross-tabs against the deterministic labels.
   - **Isolation rule:** this folder must not be imported by `backend/`, must not edit
     `regime.py`/strategies/routes, and its deps stay in `requirements-hmm.txt`. It only READS
     market data and the deterministic labels.
   - **Caveat:** the fit is full-sample (look-ahead) — fine for visual evaluation, NOT tradeable
     as-is. A rolling/expanding refit is the prerequisite before any strategy integration.

## Strategies & backtests

- A `Strategy` subclass (in `backend/services/strategies/`) with a `META` and `PARAM_SCHEMA`
  auto-registers. Implement `vectorized(df)` (batch backtest → entry/exit/stop columns) and
  `on_candle(candle, state)` (live). See `vwma_reversion.py` as the reference.
- Backtest: `backtest_engine.run(...)`. Optimize across rolling windows with `walkforward.py`.
- Market Lab analyses are read-only, causal, and deliberately "honest" (in-sample edges flagged,
  t-tests vs baselines, no look-ahead) — mirror that tone when extending it.

## Validating a strategy (the gauntlet)

Before believing any strategy, it must clear these gates. Full plain-language guide with the
"why" and where each number already lives in the app:
[docs/plans/validation-checklist.md](docs/plans/validation-checklist.md). In brief:

1. **Parameter plateau, not a spike** — good params sit in a flat region of neighbors, not a lone
   peak (a spike = curve-fit). `parameter_stability_score` in the WF robustness block.
2. **Pessimistic costs** — survives elevated fees/slippage (Cost Sweep). If it only works at 1bp, it doesn't.
3. **Walk-forward OOS holds** — profitable on out-of-sample windows, not just in-sample. `pct_windows_positive_oos`, WFE.
4. **Monte Carlo still profitable** — shuffle trades / bootstrap paths; the edge shouldn't be luck of ordering.
5. **Locked holdout (do this last, once)** — reserve the most recent ~6–12 months, never touch it during
   research, run the finished strategy on it exactly once. The only data your tuning never saw.
6. **Cross-strategy honesty** — deflated Sharpe only penalizes trials *within one run*. Also count how many
   *distinct* ideas/symbols/timeframes you've tried; the more you tested, the more skeptical you must be.
7. **Enough trades + beats a baseline** — a great Sharpe on ~15 trades is noise. Check the `t_pvalue`/
   `significance` and that it beats buy-and-hold (`bh_return_pct` per window).
8. **Consistency across sub-periods** — green in 2022 *and* 2024, not one lucky year carrying it. Per-window
   OOS + monthly returns.

Regime gating is a **strategy feature** (an entry filter), validated per-strategy through this same gauntlet —
never bolted on afterward, never applied globally by default. Default OFF; it earns its place only with stable
OOS improvement for *that* strategy.

## Sizing & fees — futures vs crypto

The single branch point is in [backtest_engine.py](backend/services/backtest_engine.py) (~L200):
`contract_sizing = _meta.asset_class in ("equity_index_future", "futures") and _meta.contract_size > 1.0`,
where `_meta = assets.get(symbol, broker)`. Note `"equity_index_future"` is **dead** — the
catalogs and the `ASSET_CLASSES` enum only ever emit `"futures"`; the live trigger is
`asset_class == "futures"`. `contract_size` comes from `data/assets/{broker}.json`
(ES 50, NQ 20, GC 100, CL 1000; crypto = 1.0).

- **Sizing** (one line, both entry paths): `units = contract_units if contract_sizing else (cur_eq * risk_frac) / fill`.
  - Futures → **fixed** `units = contracts × contract_size`. P&L = `move × units` yields TS-style
    dollars ($50/pt for 1 ES). Driven by the per-strategy `contracts` param; **`risk_pct` is inert**.
  - Crypto/spot → `units = equity × risk_pct / price` — **compounds** with MTM equity each bar.
    Driven by `risk_pct`; **`contracts` is inert**.
- **Fees** (`_fee()`, per side, charged on entry AND exit):
  - Futures → `fee_flat + futures_commission × contracts` ($/contract; notional ignored).
  - Crypto → `fee_flat + |notional| × fee_pct` (fee_pct default 0.04%).
- **Slippage** (`slippage_bps`, default 1bp) applies symmetrically to both.
- **Global vs per-strategy:** `starting_capital`, `fee_flat`, `fee_pct`, `futures_commission`,
  `slippage_bps` live in the global `risk_config` (Risk Settings page — symbol-agnostic, so it
  correctly shows both fee types). `risk_pct`, `contracts`, `pyramiding` are per-strategy
  (PARAM_SCHEMA), edited in the Dashboard Settings panel.
- **UI:** the Settings panel ([StrategyEditor.jsx](frontend/src/components/StrategyEditor.jsx))
  takes a `hiddenParams` prop; [Dashboard.jsx](frontend/src/pages/Dashboard.jsx) computes it from
  the selected symbol's asset class (`_isContractSized`) to hide the inert sizing slider —
  `risk_pct` on futures, `contracts` on crypto. WalkForward/GridSearch param editors do NOT yet
  do this (still show both as optimizable ranges).

## Running

- App: `python ui.py` (GUI launcher) or `python backend/app.py` (backend on :6173) +
  the Vite frontend on :5173.
- Commit messages end with the Co-Authored-By trailer; branch off `main` before committing.
- **Commit subject naming:** prefix with today's date as `MMDDYYYY-{short-change-desc}`, e.g.
  `07062026-verdict-subpage`. (Matches the existing dated docs like `docs/06112026-changes-…md`.)
