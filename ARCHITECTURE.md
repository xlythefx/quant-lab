# Roadmap: Multi-Asset Architecture (Crypto → Forex → Stocks / Indices / Commodities)

## Context

Quantlab today is **Binance-only and crypto-only**. The user wants to extend to forex / stocks / indices / commodities via **capital.com** and **ig.com**, while keeping strategies asset-agnostic where they naturally are (e.g., VWMA Reversion works on EURUSD as well as it works on BTCUSDT). The dashboard is also already filling up with feature buttons; before adding any new asset class, the UI needs a scalable container.

This is a **roadmap plan**, not a single shippable change. It captures the target architecture, lists the coupling points that block multi-asset support today, and stages the work so each step is independently usable.

**Locked decisions (from user):**
- **Combined dashboard with an asset-class filter** — one Dashboard / Walk-Forward / Grid Search / etc. for everything. A top-level Crypto / Forex / Stocks / Commodities selector filters available symbols and applies asset-class defaults. Cross-asset portfolios work naturally.
- **Navbar reorganized into dropdown groups** — Research ▾, Robustness ▾, Live ▾, Settings ▾ so the bar scales past 12 features.
- **Forex via capital.com is the first non-crypto asset class.** Most similar to crypto (24/5 OHLCV, no earnings/dividends), validates the broker abstraction with the lowest new-concept surface.

---

## Current coupling points (what blocks multi-asset today)

Concrete list from a codebase audit — these are the things that hardcode "Binance" or "crypto" today and will need refactoring before any new broker can plug in:

| Layer | File | Hardcoded assumption |
|---|---|---|
| Data fetch | [backend/services/market_data.py:31](backend/services/market_data.py#L31) | `_exchange = ccxt.binance({...})` — single global Binance instance |
| Data fetch | [backend/services/market_data.py:34](backend/services/market_data.py#L34) | `_QUOTES = ("USDT", "USDC", ...)` — crypto quote currencies |
| Data fetch | [backend/services/market_data.py:37](backend/services/market_data.py#L37) | `_to_ccxt_symbol()` — assumes BTC/USDT format; won't handle EURUSD or US30 |
| Data fetch | [backend/services/market_data.py:74](backend/services/market_data.py#L74) | Parquet filename `{symbol}_{timeframe}.parquet` — no broker namespace, future collisions when same symbol exists on two brokers |
| Data fetch | [backend/services/market_data.py:126](backend/services/market_data.py#L126) | Parquet schema is only OHLCV — no `asset_class` / `broker` / `tick_size` / `contract_size` metadata |
| Streaming | [backend/config.py:16](backend/config.py#L16) | `BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws"` |
| Symbols | [backend/utils/validators.py:14](backend/utils/validators.py#L14) | Validator accepts any alphanumeric — no asset-class enforcement |
| Symbols | [backend/config.py:8](backend/config.py#L8) | `SUPPORTED_SYMBOLS = ["BTCUSDT", "FETUSDT"]` — crypto only |
| Symbols | [frontend/src/pages/Downloads.jsx:10](frontend/src/pages/Downloads.jsx#L10) | `SUGGESTED = ["BTCUSDT", "FETUSDT", "ETHUSDT", "SOLUSDT"]` — crypto suggestions baked in frontend |
| Execution | [backend/services/backtest_engine.py:222](backend/services/backtest_engine.py#L222) | `units = equity * risk_pct / fill` — fractional sizing, no lot rounding (forex needs 100k or 10k lots; stocks need integer shares) |
| Execution | [backend/data/risk_config.json](backend/data/risk_config.json) | No `leverage`, `margin_req`, `swap_long`, `swap_short`, `spread_bps`, `contract_size`, or `min_tick` fields |
| Execution | [backend/services/backtest_engine.py:191](backend/services/backtest_engine.py#L191) | Only slippage modelled. No bid-ask spread, no overnight swap, no leverage cost |
| Sessions | [backend/services/strategies/vwma_reversion.py:107](backend/services/strategies/vwma_reversion.py#L107) | Session windows defined in UTC only, no timezone awareness or DST handling |
| Strategy | [backend/services/strategies/base.py](backend/services/strategies/base.py) | `Strategy` base class has no `supported_asset_classes` / `supported_brokers` field |
| Broker | (everywhere) | **No broker-adapter pattern.** All data access routes through the global `ccxt.binance()` |

---

## Target architecture (4 layers)

```
┌──────────────────────────────────────────────────────────────────┐
│ STRATEGIES (asset-class agnostic)                                │
│   - Operate on OHLCV + params → signals                          │
│   - Declare supported_asset_classes for UI hints (soft)          │
│   - Sessions become per-asset-class defaults, not UTC-hardcoded  │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│ EXECUTION MODELS (selected per asset)                            │
│   - spot_crypto    : current behavior — no leverage/swap         │
│   - forex_cfd      : leverage, swap, lot rounding, spread        │
│   - stock_cfd      : leverage, commission, overnight cost        │
│   - stock_cash     : no leverage, commission, no overnight       │
│   - commodity_cfd  : leverage, swap, contract size               │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│ ASSET METADATA (one record per traded instrument)                │
│   AssetMetadata(symbol, broker, asset_class, base, quote,        │
│                 contract_size, tick_size, market_hours_tz,       │
│                 swap_long_pct, swap_short_pct, leverage_max,     │
│                 execution_model, default_sessions)               │
│   Stored in: backend/data/assets/{broker}.json (per-broker file) │
└──────────────────────────────────────────────────────────────────┘
                              │
┌──────────────────────────────────────────────────────────────────┐
│ BROKER ADAPTERS (one per broker)                                 │
│   class BrokerAdapter (abstract):                                │
│     - download_history(symbol, timeframe, start, end) → DataFrame│
│     - stream_candles(symbol, timeframe, on_update)               │
│     - asset_catalog() → list[AssetMetadata]                      │
│     - place_order(...)   # later, for live/paper trading         │
│                                                                  │
│   Implementations:                                               │
│     - BinanceAdapter (refactor of current code)                  │
│     - CapitalComAdapter (new, REST + WS)                         │
│     - IgComAdapter (new, REST + WS)                              │
└──────────────────────────────────────────────────────────────────┘
```

Parquet files become **broker-namespaced**: `data/{broker}/{symbol}_{timeframe}.parquet`. The dataset metadata table the frontend already consumes (via [api.js:10](frontend/src/services/api.js#L10) `getSymbols()`) gains `asset_class` and `broker` fields.

---

## Staged migration

Each stage is independently shippable and reversible. Behavior **does not change** until Stage 3+; Stages 1–2 are pure refactors that prepare the codebase for non-crypto.

### Stage 1: Asset metadata + broker namespace (no behavior change)
**Goal:** introduce the data model that future stages need, without changing any user-visible behavior.

- Add `AssetMetadata` dataclass in new file `backend/services/assets.py`.
- Create `backend/data/assets/binance.json` populated with metadata for current symbols (all `asset_class="crypto"`, `execution_model="spot_crypto"`, `contract_size=1.0`, `leverage_max=1`, `market_hours_tz="UTC"`, `swap=0`, etc.).
- Add `asset_class` + `broker` columns to the dataset list returned by [backend/routes/market_routes.py](backend/routes/market_routes.py) `/api/symbols`. Default all current rows to `crypto` / `binance`.
- Add `broker` namespace to parquet path. Migrate current `data/{symbol}_{tf}.parquet` → `data/binance/{symbol}_{tf}.parquet` once at startup (idempotent).
- No frontend changes yet.

### Stage 2: BrokerAdapter abstraction + Binance refactor (no behavior change)
**Goal:** prove the abstraction works against the only broker that currently exists.

- New folder: `backend/services/brokers/` with `base.py` (abstract `BrokerAdapter`) and `binance.py` (the refactored current code).
- Routes that currently call `market_data` directly delegate to the adapter via a small registry (`brokers.get("binance")`).
- Live WS stream code in [backend/services/binance_stream.py](backend/services/binance_stream.py) moves into the BinanceAdapter as `stream_candles()`.
- `market_data.py` becomes a thin facade: routes by `broker` field, dispatches to adapter.
- No new asset classes yet.

### Stage 3: Execution model abstraction in backtest_engine
**Goal:** allow per-asset-class execution math without breaking the current crypto path.

- Extract the current execution math out of [backtest_engine.py](backend/services/backtest_engine.py) into a strategy pattern. Define `ExecutionModel` abstract with methods: `compute_fill_price(side, bar)`, `compute_size(equity, price, risk_pct, asset_meta)`, `compute_overnight_cost(position, bars_held, asset_meta)`.
- Implementations:
  - `SpotCryptoModel` — exactly the current behavior (slippage, fee_pct, fractional sizing, no overnight).
  - Stub `ForexCfdModel`, `StockCfdModel`, `CommodityCfdModel` — not exercised until later stages, but present for the abstraction.
- `backtest_engine.run` looks up the execution model from `AssetMetadata.execution_model` and delegates. Existing crypto symbols continue producing identical results (regression-tested).

### Stage 4: UI navbar reorg + asset-class context selector
**Goal:** prepare the UI to handle multi-asset before non-crypto data arrives.

- **Navbar dropdown groups** (replaces current flat 8-item bar):
  ```
  [Logo Quantlab]  Dashboard  Strategies  Research ▾  Robustness ▾  Live ▾  Settings ▾
                                            │           │              │
                                  Analytics │ Monte Carlo│ Paper Trade  │
                                  Walk-Forward│Cost Sweep │ Live (TBD)  │
                                  Grid Search │Cross-Asset │             │
                                              │Portfolio   │             │
  ```
- **Top-right context selector** (always visible, next to the existing Mode toggle and clock):
  ```
  [ Asset class ▾ ]  [ Broker ▾ ]   [ Backtest | Live ]   [ clock ]
  ```
  - Asset class options: All, Crypto, Forex, Stocks, Indices, Commodities. Currently only `Crypto` is enabled; others greyed until their stage lands.
  - Broker options: filtered by asset class. Currently only `Binance` available.
  - Selection is persisted in localStorage and passed as a filter to every page's `getSymbols()` call.
- SymbolSelector, Downloads, and dataset list all respect the asset-class + broker filter.
- New `frontend/src/components/AssetContextSelector.jsx` ([Navbar.jsx](frontend/src/components/Navbar.jsx) hosts it).
- New `frontend/src/components/NavDropdown.jsx` — the dropdown primitive used by Research/Robustness/Live groups.

### Stage 5: Capital.com adapter for forex
**Goal:** the first real non-crypto broker. Forex pairs only (EURUSD, GBPUSD, USDJPY, etc.).

- New file `backend/services/brokers/capital_com.py`. Implements `BrokerAdapter`.
  - Auth: API key + identifier (capital.com uses session tokens; ref [docs](https://open-api.capital.com)). Stored in `backend/.env` as `CAPITAL_API_KEY` and `CAPITAL_IDENTIFIER`.
  - History download via REST: `/api/v1/prices/{epic}?resolution={tf}&max={n}&from={iso}&to={iso}`.
  - Streaming via WebSocket: subscribe to `OHLCMarketData.SUBSCRIBE` for the timeframe.
  - Symbol translation: capital.com uses `epic` codes (e.g. `EURUSD` is just `EURUSD`, but `US30` is `US30`).
- New asset catalog: `backend/data/assets/capital_com.json` with forex pairs and their `forex_cfd` execution model: `leverage_max=30`, `contract_size=100000`, `tick_size=0.0001`, `swap_long/short` per pair.
- Forex sessions become **timezone-aware** at the strategy level. Add `tz: "Europe/London"` field to session entries. Render in the strategy params editor as the asset-class default.
- Downloads page gains a broker selector (uses Stage 4 context).
- Backtests of existing crypto strategies now run on forex pairs once they're toggled to support `forex` in their `META.supported_asset_classes`.

### Stage 6: IG.com adapter (mirror of capital.com)
**Goal:** prove the abstraction wasn't accidentally shaped to one broker.

- New file `backend/services/brokers/ig_com.py`. IG's API is similar in concept to capital.com — REST + Lightstreamer WS. Same `BrokerAdapter` interface, different transport details.
- Forex symbols available from both brokers — UI handles `(symbol, broker)` as the unique key.

### Stage 7: Stocks + Indices + Commodities asset classes
**Goal:** complete the asset-class matrix.

- **Stocks** (`stock_cfd` execution model): market hours per exchange (NYSE 9:30-16:00 ET, NASDAQ same, LSE 8:00-16:30 GMT). Pre/post hours optional. Commission-style fees. Most strategies' UTC session filters become inappropriate — strategy hint system rejects mismatched configs with a soft warning.
- **Indices** (`stock_cfd`-like): track underlying contract; same hours model as stocks but no dividends.
- **Commodities** (`commodity_cfd`): mostly forex-style (24/5), bigger swap costs, larger spreads. Gold (XAUUSD) is the obvious first.
- No new code structure; just more asset catalogs and execution model variants.

### Stage 8 (future): Cross-asset portfolio + paper trading on multiple brokers
- Once Stages 1–7 are in, the **Portfolio** feature already planned naturally extends to cross-broker, cross-asset portfolios.
- **Paper trading** layer sits on top of `BrokerAdapter` — each adapter either uses the broker's native demo account (capital.com and ig.com both offer this; Binance has Testnet) or the in-process simulator.

---

## Decisions deferred (don't lock in yet)

- **Symbol representation across brokers** — currently `BTCUSDT` is one string. After Stage 5, EURUSD on capital.com vs EURUSD on ig.com are conceptually the same instrument but priced differently. **Open question**: should the frontend treat them as one symbol with broker switcher, or as two distinct rows? My recommendation: separate rows in datasets, but the **strategy view treats them as one** for purposes of cross-broker robustness testing. Defer until Stage 6.
- **DST handling** — forex London/NY sessions shift by an hour twice a year. **Open question**: store sessions in IANA timezone (correct) or fixed UTC offset (simpler). My recommendation: IANA — leave the heavy lifting to `pytz`. Trivial to do right.
- **Margin call modeling** — leveraged forex/stock positions can be force-closed when equity drops below margin. **Open question**: should the backtest engine simulate margin calls? My recommendation: yes, but as a Stage 5+ refinement, not initially. For now, just track margin used.
- **Currency conversion for non-USD-quoted assets** — if account is USD but you trade EURJPY, P&L in JPY needs converting. **Open question**: assume USD-quoted only at first, or add FX conversion? My recommendation: USD-quoted only at first; document the limitation.

---

## What this plan does NOT cover

- **Detailed code-level implementation of any single stage** — those become standalone plans (one per stage). This document is the master roadmap.
- **Live trading** (real money). Paper trading first, live last. Each adapter's `place_order` is wired in Stage 8 specifically.
- **Tax/reporting model** — out of scope for backtesting; only relevant once live.
- **Mobile / responsive UI** — out of scope.
- **Multi-user / auth** — out of scope; assumes single-user local install.

---

## Recommended next steps (after this plan is approved)

1. **Commit the pending Cost Sweep + presets work** (still in the working tree).
2. **Write a focused implementation plan for Stage 1** (asset metadata + broker namespace). It's a low-risk refactor that unblocks everything else.
3. After Stage 1 ships, build **Cross-Asset Robustness** (still on the previous roadmap — works fine on crypto today and benefits Stage 5+ once forex exists).
4. Proceed through Stages 2–5 in order. Don't skip 2 (broker abstraction) — that's what makes capital.com adapter a clean add.
