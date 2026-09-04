# QuantLab

A multi-asset quantitative trading research platform: Flask + SocketIO backend
(Python), React frontend. It covers the full research loop — backtesting,
walk-forward optimization, Monte Carlo and cost-sensitivity testing, a "Market
Lab" of read-only market-structure analyses, and a Live Terminal that runs
validated strategies against real brokers.

```
quantlab/
├── backend/       Flask + SocketIO + CCXT + pandas/torch/optuna  (port 6173)
│   ├── services/strategies/   the strategy library
│   ├── services/              backtest engine, walk-forward, market lab, brokers
│   ├── routes/                Flask blueprints (/api/*)
│   └── data/                  parquet OHLCV cache  (gitignored — see Setup)
├── frontend/      Vite + React + Tailwind + Lightweight Charts  (port 5173)
├── scripts/       data downloaders and one-off tools
├── experiments/   isolated research spikes (HMM regime detection)
└── docs/plans/    design notes and the validation checklist
```

---

## Setup

**Prerequisites:** Python 3.11+ (developed on 3.14) and Node 18+.

### 1. Backend dependencies

```
cd backend
pip install -r requirements.txt
```

This pulls pandas, pyarrow, ccxt, optuna, scikit-learn and torch (CPU build is
fine — torch is only used by the Market Lab's LSTM model bench).

### 2. Frontend dependencies

```
cd frontend
npm install
```

### 3. Seed the market data

**The parquet data files are not in git** — they're ~140 MB of binary that
would bloat the repo permanently, so `.gitignore` excludes them. A fresh clone
has code but no candles. Download them with:

```
python scripts/seed_data.py
```

That pulls the full history for 26 crypto symbols at 15m straight from
Binance's public API — no API key, no account. Expect roughly 30–60 minutes
and ~140 MB; the download is deliberately rate-limited so Binance doesn't
throttle you. Cached symbols are skipped on re-runs, so it's safe to
interrupt and restart.

Want less than the full set to start:

```
python scripts/seed_data.py --symbols BTCUSDT ETHUSDT      # just two
python scripts/seed_data.py --timeframe 1h                 # a different timeframe
python scripts/seed_data.py --start 2022-01-01             # shorter history
```

Each symbol is clamped to its Binance listing date, so the default
`--start 2017-01-01` just means "as far back as Binance will go."

**Reproducing published results.** A plain seed run downloads bars up to
today, which means your dataset is longer than the one any committed backtest
number was produced on — so your Sharpe, drawdown and trade count will differ,
and you can't tell a real bug from a data difference. To compare against
results recorded in this repo, pin the end date to the snapshot they were run
on:

```
python scripts/seed_data.py --end 2026-05-18
```

Run without `--end` for live research; run with it when a number is supposed
to match.

### 4. Environment file (optional)

```
cp backend/.env.example backend/.env
```

Nothing in `.env` is required for crypto backtesting. The keys are only for
optional features — see the comments in `.env.example`.

### 5. Run

```
python backend/app.py          # backend on http://localhost:6173
cd frontend && npm run dev     # frontend on http://localhost:5173
```

Or use the launchers: `python ui.py` (GUI) or `launch.bat` (Windows).

Open `http://localhost:5173`.

---

## Data

`market_data.load_parquet(symbol, timeframe, broker=None)` returns a DataFrame
with columns `[time (int seconds), open, high, low, close, volume]`. Files live
at `backend/data/{broker}/{SYMBOL}_{TF}.parquet`.

- **Crypto (Binance)** — free and public. `scripts/seed_data.py` seeds it; the
  app also auto-downloads ~2 years on demand the first time you pick an
  uncached (symbol, timeframe) in the UI.
- **CME futures (Databento)** — the code supports ES/NQ/CL/GC via
  `scripts/pull_databento.py`, but it needs your own paid `DATABENTO_API_KEY`
  in `backend/.env`. Vendor data is licensed per subscriber and is not
  redistributed with this repo. Everything except the futures symbols works
  without it.

---

## Strategies

Strategies live in `backend/services/strategies/` and auto-register — drop in a
`Strategy` subclass with a `META` and `PARAM_SCHEMA` and it appears in the UI.
Each implements two methods:

- `vectorized(df)` — batch backtest, returns entry/exit/stop columns.
- `on_candle(candle, state)` — the same logic bar-by-bar, for live execution.

`vwma_reversion.py` is the reference implementation — read that one first. The
library also includes momentum (`vwma_momentum*`), breakout
(`donchian_breakout*`, `opening_range_breakout`, `pivot_breakout`,
`asia_range_breakout`), mean reversion (`rsi2_reversion`, `vwap_deviation`) and
several session-specific variants.

Tuned parameter sets ship with the repo in `backend/data/presets.json`, so you
can load a strategy with the maintainer's settings rather than starting from
defaults.

Regime detection is in `services/strategies/regime.py` — a deterministic,
causal ADX + slope + volatility classifier. It's a per-strategy entry filter,
default OFF; it isn't applied globally.

---

## Validating a strategy

Backtest results are easy to fool yourself with. Before believing any strategy,
run it through the gauntlet documented in
[docs/plans/validation-checklist.md](docs/plans/validation-checklist.md):

1. **Parameter plateau, not a spike** — good parameters sit in a flat region of
   neighbors. A lone peak means it's curve-fit to noise.
2. **Pessimistic costs** — survives elevated fees and slippage (Cost Sweep).
3. **Walk-forward holds out-of-sample** — profitable on data the optimizer
   never saw, not just in-sample.
4. **Monte Carlo still profitable** — shuffling trade order shouldn't destroy it.
5. **Locked holdout, once** — reserve the last 6–12 months, run the finished
   strategy on it exactly one time.
6. **Enough trades, and it beats buy-and-hold** — a great Sharpe on 15 trades
   is noise. Check the t-statistic and the per-window baseline.
7. **Consistent across sub-periods** — green in several years, not one lucky one.

The Market Lab analyses are deliberately "honest" in the same spirit —
read-only, causal, in-sample edges flagged, t-tests against baselines. Mirror
that tone when extending it.

---

## Sizing and fees

The branch point is in `backend/services/backtest_engine.py` (~L200), driven by
the asset class in `backend/data/assets/{broker}.json`:

- **Futures** — fixed `units = contracts × contract_size` (ES 50, NQ 20, GC 100,
  CL 1000). Fees are `fee_flat + futures_commission × contracts`. The `risk_pct`
  parameter is inert here.
- **Crypto/spot** — `units = equity × risk_pct / price`, which compounds with
  equity each bar. Fees are `fee_flat + |notional| × fee_pct`. The `contracts`
  parameter is inert here.

Slippage (`slippage_bps`, default 1bp) applies symmetrically to both.
`starting_capital`, fees and slippage are global (Risk Settings page);
`risk_pct`, `contracts` and `pyramiding` are per-strategy.

---

## Live Terminal

**Go Live** in the navbar flips the app into a separate live UI
(`frontend/src/pages/live/`); **EXIT LIVE** returns. The engine is the alert
daemon — rules in `backend/data/live_alerts.json`, headless runners in
`alerts_daemon`, webhooks via `live_alerter`. A "deployment" is an alert rule
plus a demo/live account field.

Safety rails: a global DISARM ALL blocks every webhook POST, the deploy modal
confirms before arming (Demo is the default), test signals are dry-run by
default, and a given (rule, bar, action) fires at most once. Keep live
strategies at `pyramiding = 1` — that's the setting where live execution
matches the backtest exactly.

---

## Notes

- Backend port is **6173**, frontend **5173**.
- `experiments/hmm_regime/` is isolated by rule: it reads market data but is
  never imported by `backend/`, and its dependencies stay in its own
  `requirements-hmm.txt`.
- `hmmlearn` does not install on Python 3.14 (no prebuilt wheel), which is why
  the HMM experiment implements Baum-Welch from scratch in numpy/scipy.
