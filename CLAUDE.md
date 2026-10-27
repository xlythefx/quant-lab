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
  arming (Live default — the receiving accounts are demo; Live shows a red warning); test
  signals default to dry-run (both test endpoints); a (rule, bar, action) fires at most once.
- **Live mode hardening (Oct 16, 2026):** `alerts_daemon` is the ONLY webhook sender (the
  old browser LiveRunner only draws signals). Live never replays history — no real feed ⇒
  refused (`live_symbols.is_live_eligible`: TRADING Binance spot pairs from exchangeInfo).
  Runners warm up from Binance REST, force flat on a fresh start, persist state per rule in
  `data/live_state/` (restart keeps the open position), and on catch-up send stale EXITS
  but drop stale ENTRIES ("missed (stale)" in the activity log). Deployments are validated
  server-side (`services/live/rule_validation.py`); status is honest (RUNNING / STARTING /
  STALE / ERROR / PAUSED). Webhook retries happen only when the request never connected
  (or 502/503) — never on timeouts. Tests: `cd backend; python -m pytest tests`.
- **Positions / Risk / Reconciliation** read the WAMP `sinegu_db` READ-ONLY
  (`WAMP_DB_*` in backend/.env, defaults localhost/root/''/sinegu_db) and fall back to
  labeled SIMULATED when WAMP is down. Alerts are stored in QuantLab only.
- **Old `#livealerts` page stays fully working** until the cutover soak completes
  (plans/10) — don't remove it before then.

## Where QuantLab runs live, and the live rules (checked Oct 27, 2026)

- **Prod only: ubuntu-prod 191.218.162.171 → `lab.nexafamily.com`** (nginx basic auth,
  unit `quantlab.service`, port 6173). It is **NOT on staging 182** — no unit, no folder, no
  vhost there. `vps-deployment/deploy_ubuntu.py` (gitignored, local only) hardcodes
  `CRED_KEY = "ubuntu-prod"`. "QuantLab on staging" doesn't exist; what looks like staging
  is the **Pixel Alpha test feed** the rules post to.
- **Adding a coin = adding a rule (deployment) in the Live Terminal on lab.nexafamily.com.**
  No code change and no deploy needed when the strategy already has the knobs. A deploy
  never overwrites the box's rules: `stage_data` skips `live_alerts.json`,
  `live_terminal.db`, `live_state/`.
- **Every deploy backs up first (since Oct 27, 2026) — keep it that way.** Each writing
  stage of `deploy_ubuntu.py` (`full`, `code`, `dash`, `data`, `service`, `nginx`,
  `restore`) first snapshots the box into `/root/quantlab-backups/<UTC yyyymmdd-hhmmss>/`:
  backend code (not the `data/` parquet cache), `backend/.env`, `frontend/dist`, `docs`,
  `scripts`, the unit + nginx files, and the live state (`live_alerts.json`,
  `live_terminal.db` copied through SQLite's backup API, `live_state/`). ~7 MB each, newest
  10 kept; `BACKUP_INFO` names the local commit that replaced it. There is no skip flag.
  - `deploy_ubuntu.py backups` lists them; `deploy_ubuntu.py restore [ts]` (default newest)
    puts back code, `.env`, `dist`, docs, scripts and the unit, then restarts. It snapshots
    first, so a restore can be undone too. It never rolls back the live state; copy that
    from the snapshot by hand if really wanted.
  - The deployer is gitignored, so this exists only in the local copy. The version before
    backups is `vps-deployment/deploy_ubuntu.py.bak-10272026`.
  - Hand edits to the rules file still get their own named copy next to the snapshots
    (`live_alerts.json.<date>-before-<what>`), which pruning never touches.
- **The service needs ~11 s to listen after a restart** (strategy registry + imports), so
  `stage_service`'s check 8 s in can print `port 6173: NOT LISTENING` on a healthy deploy.
  Re-check with `deploy_ubuntu.py status` before treating it as a failure.
- **Deploy away from a 15m close.** A restart stops all runners for ~15 s; time it a
  minute or more after :00/:15/:30/:45 so no bar closes while they warm up.
- **Live rule 1 — `VWMA Reversion LTCUSDT 15m`** (enabled): `vwma_reversion`, vwma 23,
  z 1.5, rsi 15, **longs only**, **`trade_24_7: true`** (so its session toggles are
  ignored), ATR stop off, 25x, account `live` →
  `https://pixel-alpha.com/binance_test_webhook`. Sends BUY / EXIT_LONG pairs.
- **Live rule 2 — `VWMA Reversion RENDERUSDT 15m`**: added Oct 26, 2026 and **RUNNING
  since Oct 26, 2026 03:53 UTC** (the user switched it on). Same webhook and secret as LTC
  (via `secret_source`) and the same alias, 25x, account `live`; params below. Pixel Alpha
  needs a RENDERUSDT asset with max sizing ≥ 3× base size (the user set it up). To
  switch it on or off from a terminal: PATCH `/api/live/deployments/<url-encoded name>`
  with `{"status": "RUNNING"|"PAUSED"}`. Pre-change backup on the box:
  `/root/quantlab-backups/live_alerts.json.20261026-before-render`.
- **Live rules 3 + 4 — `VWMA Reversion QNTUSDT 15m` and `VWMA Reversion SANTOSUSDT 15m`**:
  RUNNING since Oct 26, 2026 04:25 UTC. Same webhook, secret, alias, 25x, `live` as LTC;
  pyramiding 3, no stop, **`trade_24_7: true`**. Their Pine has Asia `"0000-0000"` (which
  in Pine means a full 24h) with London and Main off. In QuantLab a 00:00–00:00 window is
  **empty** (`in_window_live` needs start < end), so 24h sessions must be `trade_24_7`.
  - QNT (Pine "XlytheAI - QNT VWMA"): vwma 34, z 1.2, rsi 26, RSI < 35 / > 65, **longs only**.
  - SANTOS (Pine "XlytheAI - SANTOS VWMA"): vwma 46, z 1.0, rsi 14, **RSI < 32** / > 65,
    longs + shorts.
  - Their Pine checks entries *before* exits and has no `process_orders_on_close`, so
    TradingView fills on the next bar's open. Live, both still send at bar close.
  - Parity (local parquet, ~5 yrs): QNT 2,554 / 2,557 match; SANTOS 9,631 / 9,689 (99.4%).
    The SANTOS gap is 41 same-bar long↔short flips (~1 per 6 weeks) where the Pine
    reverses on one bar and QuantLab exits, then enters next bar if still valid. SANTOS is
    busy: ~27 entries/week, 3,732 of 6,710 are stacked adds.
  - Pre-change backup: `/root/quantlab-backups/live_alerts.json.20261026-before-qnt-santos`.
  - The parity script is `vwma_parity.py` (Oct 26 session scratchpad). It's a bar-by-bar Pine
    port vs `on_candle`; rebuild it from this description if needed.
- **Live rule 5 — `ANN Strategy (Original) BTCUSDT 15m`**: added Oct 27, 2026 ~08:03 UTC,
  enabled. `ann_v2_original` (the faithful port of TradingView "ANN Strategy v2"), Pine
  defaults: anchor `1D`, longs + shorts. Same webhook and secret as SANTOS (via
  `secret_source`), 25x, account `live`. Alias **`ANN Strategy (Original) - QuantLab`**.
  That is the webhook's `"strategy"` value, so Pixel Alpha files its trades under it. The
  user named it; the final name was set at 08:09 UTC, before the first signal.
  - **ANN Strategy (Insights) - QuantLab** = `ann_v2_plus`. **Do NOT deploy it** (the
    user's call, Oct 27, 2026). That alias is reserved for it if that ever changes.
  - It is **always in the market**: every side change is an exit + opposite entry on the
    same bar (~3 flips a day on 15m), no pyramiding, no stop. A fresh runner is forced flat
    after warm-up but keeps the net's side, so its first live bar close sends an entry
    straight away.
  - Pre-change backups: `/root/quantlab-backups/live_alerts.json.20261027-before-ann-btc`,
    `…-before-ann-alias` and `…-before-ann-rename`.
- **Every webhook carries `sent_at` (deployed Oct 27, 2026):** UTC ISO with ms
  (`"2026-10-26T14:15:02.812Z"`), stamped once in `build_payload` when the signal is
  dispatched. Retries resend the same value. It's also a `{{sent_at}}` token for
  `payload_template`. Pixel Alpha's engine reads it to measure signal → fill delay, so the
  box clock must stay NTP-synced (191: `NTPSynchronized=yes`). The frontend token hint
  text in `AlertsView.jsx` / `LiveAlerts.jsx` doesn't list it yet. It was written Oct 26, but
  191 kept running Oct 16 code until the Oct 27 deploy, so no webhook carried it before then.
- To add a rule from a terminal, POST `/api/live/deployments` on the box's loopback
  (`http://127.0.0.1:6173`, which skips nginx basic auth). Send `"secret": "***"` +
  `"secret_source": "<existing rule name>"` so the real secret never leaves the server.
  Note `live_alerts.json` is `{"rules": [...]}`, not a bare list.

### RENDERUSDT 15m — follow the Pine exactly (LIVE since Oct 26, 2026)

Source: the TradingView `//@version=6` strategy **"XlytheAI - RENDER VWMA"** (the full Pine
was reviewed Oct 26, 2026; it is not in this repo). Maps onto `vwma_reversion` with no code
change:

| Pine | Value | QuantLab rule param |
|---|---|---|
| timeframe | 15m | rule `timeframe: "15m"` |
| VWMA Length | 35 | `vwma_length: 35` |
| Z-Score Threshold | 1.5 | `z_threshold: 1.5` |
| RSI Length | 21 | `rsi_length: 21` |
| `rsiVal < 35` / `rsiVal > 65` (hardcoded) | 35 / 65 | `rsi_long_max: 35`, `rsi_short_min: 65` (= defaults) |
| Enable Longs / Shorts | both ON | `sides: {long: true, short: true}` |
| Asia Session | ON, `0100-0830` | `sessions.tokyo {enabled, start "01:00", end "08:30"}` |
| London Session | ON, `0830-1230` | `sessions.london {enabled, start "08:30", end "12:30"}` |
| Main Trading Session | OFF, `1230-1645` | `sessions.ny_am {enabled: false, "12:30"–"16:45"}`; `ny_pm` off |
| (no 24/7 in Pine) | — | `trade_24_7: false` (unlike LTC) |
| `pyramiding = 3` | 3 | `pyramiding: 3` |
| no stop; exits `close >= / <= mean`, not session-gated | — | `atr_stop: false`, `use_regime: false` |
| leverage | not in Pine | 25, same as LTC |

Type the session start/end times explicitly. QuantLab's defaults (tokyo 00:00–04:00, london
05:00–12:30, ny_am 12:30–16:00) are NOT the Pine's.

**Timezone: settled. The times are UTC; enter them as-is.** The Pine calls
`time(timeframe.period, sess)` with **no** timezone argument, so sessions run in the
exchange timezone (Binance = UTC). The chart's **UTC+8** setting only changes the clock
labels. (TradingView's List of Trades shows UTC+8, so add 8h when comparing.)

**Parity check (Oct 26, 2026)**: a bar-by-bar port of the Pine vs `on_candle` replayed
over local `RENDERUSDT_15m.parquet` (Nov 2021 – Oct 21, 2026, 171k bars). Result: **3,977
of 3,978 actions match on the same bar**. The only miss is a same-bar flip (Dec 05, 2024):
the Pine closes and reverses on one bar, while QuantLab only exits that bar. ~10.9 entries
a week; **1,570 of 2,774 entries are 2nd/3rd stacked tranches**. `process_orders_on_close =
true` only moves the backtest fill to the signal bar's close. Live, both send at bar close.

Before arming:
- Pixel Alpha needs a RENDERUSDT asset (the user is adding it). The acceptor
  (`trading-flask` `webhook.py`) adds to the position on a repeated BUY/SELL
  (`handle_add`) but SKIPS it as `maxed_sizing` past the asset's **max sizing**. So max
  sizing must allow **3× base_size** or tranches 2–3 never fill. EXIT closes the whole stack.
- One sender only. The user confirmed TradingView won't also send RENDER to that webhook.
- First live rule with **shorts on**, so the first real SELL / EXIT_SHORT on that feed.
- RENDERUSDT is a TRADING Binance spot pair, so it passes `is_live_eligible`.

## Deployment reality — how a strategy actually reaches the market

**QuantLab is the research lab, not the execution venue.** The full path is:

1. **Research here** — backtest, walk-forward, cost sweep, Monte Carlo, the gauntlet below.
   This is where a strategy earns the right to be traded, and where its params are chosen.
2. **Convert to Pine Script** and paste into TradingView, carrying the researched params
   across by hand (see the Pine section below for the faithfulness rules).
3. **TradingView fires the alerts** on "Order fills only" with
   `{{strategy.order.alert_message}}`, POSTing the `build_payload` JSON to a **Flask
   webhook acceptor** (the Binance/TradeStation endpoint), which places the real order.
4. QuantLab's own Live Terminal / `alerts_daemon` fires the **same payload shape** to the
   **same acceptor** — it is a second, independent signal source, not a different system.

So there are always **two implementations of every strategy** (Python `on_candle` and the
Pine port) pointed at **one acceptor**. Any claim that "live matches the backtest" has to
survive both hops: signal parity (Python vs Pine) *and* execution parity (modeled fill and
size vs what the acceptor actually does).

### ⚠ Sizing is owned by the acceptor, and the backtest models a DIFFERENT scheme

This is by design and is not to be "fixed" in the payload: `build_payload` deliberately
sends only `{secret, strategy, leverage, action, symbol, sent_at}` — no quantity, no risk_pct. One
place owns risk, and the same shape works for both TradingView and QuantLab alerts.

**What live actually trades** (`_scale_qty` in the acceptor,
`C:/Users/Xlythe/trading-flask/src/routes/webhook.py`):

```
quantity = base_size × (balance / 500)      # stepped; BTCUSDT uses coarse whole steps
                                            # below a 500 balance it's a flat base_size
```

`base_size` is a per-asset constant from the acceptor's `assets` DB row. This is
**fixed-lot** sizing. `leverage` (default 25 in `live_alerts_config`) does NOT enter this
formula — it only sets margin and the liquidation distance on the exchange.

**What the backtest models**: `units = equity × risk_pct / price`, `risk_pct` default 3.0.
This is **fixed-fraction** sizing, and it compounds. Grep `leverage` in
[backtest_engine.py](backend/services/backtest_engine.py) / `portfolio_runner.py` — no hits,
the simulator has no leverage or liquidation concept at all.

**Consequence — the two schemes are not interchangeable, in two separate ways:**

1. **Scale.** Whether live risks more or less than the modeled 3% depends entirely on
   `base_size` vs balance. A `base_size` worth more than 3% of the account means every live
   trade is proportionally bigger than anything the backtest ever simulated.
2. **Shape.** Fixed-fraction shrinks size after losses (self-protective); fixed-lot does
   not. So even at the same starting scale the two equity paths diverge — fixed-lot
   drawdowns run deeper and recover slower. Max drawdown %, Sharpe and Calmar are all
   **sizing-dependent**, so the gauntlet's risk numbers describe a scheme you don't trade.

The *signals* transfer between the two; the *risk numbers* do not. So a strategy can show
an identical equity-curve **shape** live, in QuantLab, and in TradingView while its live
P&L looks nothing like the backtest — that is a sizing-model mismatch, not a signal bug.

**Sizing does NOT affect entry/exit timing.** The only equity term in the entry condition
is a `cur_eq > 0` bankruptcy guard (backtest_engine ~L514); signals come from `vectorized()`
/ `on_candle()`, which see only OHLCV and params, and exits are price-based (ATR stops,
mean-revert crosses). So the parity that matters — **same bars in, same bars out** — is
unaffected by any of the above. Two exceptions only: total ruin stops entries in the
backtest, and a live **liquidation** at 25× is an exit the simulator cannot produce at all.

**Rule:** compare live to backtest on **direction and % return per trade**, never on
dollars or drawdown. If direction and % match, live is faithful — a bigger loss is then
the position size you chose in `base_size`, not a bug.

Teaching the backtest a fixed-lot mode (mirroring `contract_sizing`, which futures already
use) is OPTIONAL — do it only if you want drawdown/Sharpe to describe the real account.
Do NOT add sizing to the webhook; the acceptor owns that deliberately.

## Pine Script conversions (Python → TradingView)

When converting a QuantLab strategy to Pine Script, ALWAYS map to the four canonical
live actions QuantLab uses (from `_ACTION_MAP` in
[backend/services/live_alerter.py](backend/services/live_alerter.py)) — there is no
bare `LONG`/`SHORT` action:

- `("long","entry")` → **BUY**  → `strategy.entry("Long", strategy.long)`
- `("short","entry")` → **SELL** → `strategy.entry("Short", strategy.short)`
- `("long","exit")` → **EXIT_LONG**  → `strategy.close("Long")`
- `("short","exit")` → **EXIT_SHORT** → `strategy.close("Short")`

To make the Pine webhook-ready (fire the same payload as `build_payload`:
`{secret, strategy, leverage, action, symbol}`), attach `alert_message` to each call
and alert on **"Order fills only"** with `{{strategy.order.alert_message}}`. Faithfulness
rules that keep a Pine port comparable to the QuantLab engine: use `ta.vwma`/`ta.rsi`
(match `_vwma`/`_rsi`), keep `process_orders_on_close = false` (fill next bar open =
QuantLab honest mode / look_ahead OFF), test at `pyramiding = 1` (parity-safe — stacking
diverges), and match costs on both sides. A flip (long→short same bar) emits SELL and
closes the long in one order, where QuantLab would emit EXIT_LONG then SELL.

## Data

- `market_data.load_parquet(symbol, timeframe, broker=None)` returns a DataFrame with columns
  `[time (int seconds), open, high, low, close, volume]`. Raises `FileNotFoundError` if not
  cached — `ensure_parquet(symbol, timeframe)` downloads ~2yr (Binance/CCXT) first.
- Cached crypto symbols: `BTCUSDT`, `FETUSDT` at `1m/5m/15m/1h`.
- Crypto exchanges (all CCXT, Downloads → Crypto): Binance `LTCUSDT` / `LTCUSDT.P`, Bybit
  `BYBIT.LTCUSDT[.P]`, MEXC `MEXC.LTCUSDT[.P]`, each in `data/{exchange}[_perp]/`. The
  prefix/suffix is load-bearing — `find_parquet` loads by symbol and tries `data/binance/`
  first, so a bare name would be shadowed. MEXC's API keeps only ~30 days of 1m and ~1 year
  of 5m/15m: re-download regularly so the saved file keeps growing past that window. CME futures (ES/NQ/CL/GC) via
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
  takes a `hiddenParams` prop; [DashboardV2.jsx](frontend/src/pages/DashboardV2.jsx) computes it from
  the selected symbol's asset class (`hiddenSizingParams`) to hide the inert sizing slider —
  `risk_pct` on futures, `contracts` on crypto. WalkForward/GridSearch param editors do NOT yet
  do this (still show both as optimizable ranges).

## Running

- App: `python ui.py` (GUI launcher) or `python backend/app.py` (backend on :6173) +
  the Vite frontend on :5173.
- Commit messages end with the Co-Authored-By trailer; branch off `main` before committing.
- **Commit subject naming:** prefix with today's date as `MMDDYYYY-{short-change-desc}`, e.g.
  `07062026-verdict-subpage`. (Matches the existing dated docs like `docs/06112026-changes-…md`.)
