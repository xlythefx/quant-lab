# Historical integration map (quantlab ↔ Databento)

How a Databento historical feed plugs into quantlab's existing **broker-adapter +
download-job** pattern. **This is now implemented** (the pieces below describe the
shipped wiring). Read [reference.md](reference.md) first.

> **Status: built.** Adapter, job registration, asset catalog, the `futures`
> asset class, and the Downloads UI tab are all in place. The only runtime
> prerequisite is `pip install databento` (added to requirements) and the
> `DATABENTO_API_KEY` already in `backend/.env`.

The design goal: a Databento download must produce the **exact same parquet bar
schema** every other feed produces, so it's drop-in compatible with all strategies,
the backtest engine, and the chart — no schema changes anywhere downstream.

## The parquet contract (non-negotiable)

Every feed writes one file per `(symbol, timeframe)` under `data/{broker}/` with
these columns:

| column | type | notes |
|---|---|---|
| `time` | int64 | epoch **seconds** (NOT ms, NOT ns) |
| `open` | float64 | |
| `high` | float64 | |
| `low` | float64 | |
| `close` | float64 | |
| `volume` | float64 | |

Sorted by `time`, de-duplicated on `time`. This is what
[dukascopy.py](../../backend/services/brokers/dukascopy.py) returns and what the
strategies' `vectorized(df)` methods read.

## Pieces to add / change

### 1. New broker adapter — `backend/services/brokers/databento.py`

Mirror the shape of
[dukascopy.py](../../backend/services/brokers/dukascopy.py). Expose:

```python
def download(
    symbol: str,
    start: datetime,           # UTC
    end: datetime,             # UTC, exclusive
    timeframe: str,            # "1m" | "5m" | "15m" | "1h" | "1d"
    *,
    progress_cb: Optional[Callable[[int, int], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> pd.DataFrame:             # the parquet-contract columns above
    ...
```

Internals:

1. `client = db.Historical()`  (reads `DATABENTO_API_KEY` from env — see §5).
2. Map quantlab `symbol` → Databento `symbols` + `stype_in` (see §3).
3. Map quantlab `timeframe` → Databento `schema` (see §4).
4. `data = client.timeseries.get_range(dataset="GLBX.MDP3", symbols=..., schema=...,
   stype_in="continuous", start=start, end=end)`.
5. `df = data.to_df()` — already float OHLCV, tz-aware datetime index (see
   [reference.md §4](reference.md#4-data-encoding--important-gotchas); **do not
   re-scale prices**).
6. Normalize to the contract: reset the index → `time` as **epoch seconds**
   (`(idx.view("int64") // 1_000_000_000)` or `.astype("datetime64[s]").astype(int)`),
   keep `open/high/low/close/volume`, `sort_values("time")`, `drop_duplicates("time")`.
7. For sub-hour timeframes, resample 1m → target TF (see §4) — reuse the
   resample idiom from `dukascopy.download` (`resample(rule, label="left",
   closed="left").ohlc()` + `volume.sum()`).

Progress: Databento returns the whole range per request, so progress is coarse
(like Yahoo). Emit one mid-fetch ping and a final 100% via `progress_cb`, and
honor `cancel_check` before/after the request.

### 2. Register the broker — `backend/services/download_jobs.py`

- Add `"databento"` to `_BROKERS` at
  [download_jobs.py:39](../../backend/services/download_jobs.py#L39):
  ```python
  _BROKERS = ("binance", "dukascopy", "yahoo", "tradestation", "databento")
  ```
- Import it alongside the others
  ([download_jobs.py:34](../../backend/services/download_jobs.py#L34)).
- Add a dispatch branch in `_run`
  ([download_jobs.py:195-202](../../backend/services/download_jobs.py#L195-L202)):
  ```python
  elif self.spec["broker"] == "databento":
      meta = self._run_databento()
  ```
- Add `_run_databento()` modeled on `_run_dukascopy`
  ([download_jobs.py:245-295](../../backend/services/download_jobs.py#L245-L295)):
  convert `start_ms`/`end_ms` → UTC datetimes, call `databento.download(...)`, then
  do the **same idempotent parquet merge** — read existing via
  `market_data.parquet_path(symbol, tf, broker="databento")`, `concat`,
  `drop_duplicates(subset=["time"]).sort_values("time")`, write back, and return
  `{rows_added, rows_total, path, first_time, last_time}`.

`market_data.parquet_path` already namespaces by broker
([market_data.py:137](../../backend/services/market_data.py#L137)), so files land
in `backend/data/databento/{SYMBOL}_{tf}.parquet` automatically.

### 3. Symbol mapping convention

quantlab uses bare roots (`ES`, `NQ`, `CL`, `GC`) like the TradeStation catalog.
Adopt: **default to continuous front-month.**

| quantlab symbol | Databento `symbols` | `stype_in` |
|---|---|---|
| `ES` | `ES.c.0` | `continuous` |
| `NQ` | `NQ.c.0` | `continuous` |
| `CL` | `CL.c.0` | `continuous` |
| `GC` | `GC.c.0` | `continuous` |
| `ESH4` (explicit contract) | `ESH4` | `raw_symbol` |

Rule of thumb in the adapter: if the symbol already contains a month/year code,
use `raw_symbol`; otherwise append `.c.0` and use `continuous`.

### 4. Timeframe mapping

quantlab timeframes today are `["1m", "5m", "15m", "1h"]`
([config.py:9](../../backend/config.py#L9)); `1d` is supported by the parquet/resample
machinery. Databento has native `ohlcv-1s/1m/1h/1d` but **no native 5m/15m/30m**.

| quantlab tf | strategy |
|---|---|
| `1m` | request `schema="ohlcv-1m"` directly |
| `5m`, `15m`, `30m` | request `ohlcv-1m`, **resample** to target TF in-adapter |
| `1h` | request `schema="ohlcv-1h"` |
| `1d` | request `schema="ohlcv-1d"` |

Fetching 1m and resampling keeps the output schema-complete and consistent with
how dukascopy builds every non-native TF.

### 5. Secrets

Nothing new. `DATABENTO_API_KEY` is already in `backend/.env` and loaded by
`python-dotenv` at boot. In the adapter:

```python
import os
client = db.Historical()                       # picks up env automatically
# or, explicit/defensive:
client = db.Historical(os.environ.get("DATABENTO_API_KEY"))
```

### 6. Asset catalog — `backend/data/assets/databento.json`

Create a per-broker catalog like the others
([tradestation.json](../../backend/data/assets/tradestation.json)). The loader
([assets.py](../../backend/services/assets.py)) expects the `AssetMetadata` field
set: `asset_class, execution_model, base, quote, contract_size, tick_size,
market_hours_tz, swap_long_pct, swap_short_pct, leverage_max`.

```json
{
  "ES": {
    "asset_class": "futures",
    "execution_model": "futures",
    "base": "S&P500", "quote": "USD",
    "contract_size": 50.0, "tick_size": 0.25,
    "market_hours_tz": "America/Chicago",
    "swap_long_pct": 0.0, "swap_short_pct": 0.0, "leverage_max": 20.0
  },
  "NQ": { "contract_size": 20.0, "tick_size": 0.25, "...": "..." },
  "CL": { "contract_size": 1000.0, "tick_size": 0.01, "...": "..." },
  "GC": { "contract_size": 100.0, "tick_size": 0.10, "...": "..." }
}
```

Notes:
- `tick_size`/`contract_size` per CME contract specs (ES 0.25/$50, NQ 0.25/$20,
  CL 0.01/1000 bbl, GC 0.10/100 oz). The `definition` schema (reference.md §3) can
  source these programmatically later.
- A dedicated **`futures`** value was added to both `assets.ASSET_CLASSES` and
  `assets.EXECUTION_MODELS` ([assets.py](../../backend/services/assets.py)) for
  this integration, so the catalog uses `asset_class="futures"` /
  `execution_model="futures"`. The execution engine doesn't consume
  `execution_model` yet (Stage 3 of [ARCHITECTURE.md](../../ARCHITECTURE.md));
  futures commission already lives in `risk_config.json`. `asset_class="futures"`
  also matches the frontend Futures tab id so downloaded datasets show there.

### 7. Dependency

Add to [backend/requirements.txt](../../backend/requirements.txt):

```
databento>=0.34
```

(Pin to whatever the current stable release is at build time; requires Python ≥3.10.)

## First-pull walkthrough (once the adapter is registered)

The download UI/route already dispatches by broker through the job runner, so no
route changes are needed — only the adapter + registration above.

1. Set the API key (already in `backend/.env`) and `pip install -r requirements.txt`.
2. Trigger a job with `broker="databento"`, `symbol="ES"`, `timeframe="1h"`, and a
   `start_ms`/`end_ms` range (via the Downloads page or `/api/datasets/download`).
3. The job runs `_run_databento` → `databento.download` → parquet merge, streaming
   `download_progress` and finally `download_complete` over Socket.IO
   ([download_jobs.py](../../backend/services/download_jobs.py)).
4. Result: `backend/data/databento/ES_1h.parquet` with the standard
   `[time, open, high, low, close, volume]` schema — immediately usable by the
   chart, backtests, walk-forward, and every strategy.

## Quick verification when built

- `databento.download("ES", start, end, "1h")` returns a DataFrame whose columns
  are exactly `[time, open, high, low, close, volume]`, `time` is epoch **seconds**,
  monotonic and unique.
- Spot-check a known ES bar's OHLC against another source (prices in the hundreds/
  thousands, **not** ~4.5e12 — that would mean the 1e-9 scaling was applied twice).
- A backtest on the produced parquet runs unchanged (no strategy edits).
