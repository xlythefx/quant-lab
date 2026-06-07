# Databento SDK / API reference

A focused reference for the parts of Databento quantlab uses: the Python client,
historical retrieval, schemas, data encoding, symbology, and the CME dataset.
Facts here were verified against the official
[`databento-python` README](https://github.com/databento/databento-python) and
the [Databento docs](https://databento.com/docs) during planning.

> The Databento docs site is JS-rendered; the canonical text references are the
> GitHub README and the per-topic doc/blog URLs in [Sources](#sources).

---

## 1. Clients

The `databento` package exposes two clients. Both pick up `DATABENTO_API_KEY` from
the environment if no `key=` is passed (preferred for production — don't hardcode).

```python
import databento as db

hist = db.Historical()        # reads DATABENTO_API_KEY from env
live = db.Live()              # same
# or explicit: db.Historical("db-XXXX...")
```

- `db.Historical` — point-in-time / range queries over recorded data.
- `db.Live` — real-time subscriptions (see [live-integration.md](live-integration.md)).

---

## 2. Historical retrieval — `timeseries.get_range`

```python
data = hist.timeseries.get_range(
    dataset="GLBX.MDP3",      # CME Globex MDP 3.0
    symbols="ES.c.0",         # continuous front-month ES
    schema="ohlcv-1h",        # hourly bars
    stype_in="continuous",    # how `symbols` is interpreted
    start="2023-01-01",       # INCLUSIVE
    end="2024-01-01",         # EXCLUSIVE
)
```

- Returns a **`DBNStore`** (the binary DBN payload, lazily decoded).
- **Start is inclusive, end is exclusive.**
- Convert:
  - `df = data.to_df()` → pandas DataFrame (tz-aware datetime index, float prices).
  - `arr = data.to_ndarray()` → numpy structured array (raw encoding — see §4).
- Accepts a single symbol string or a list (`symbols=["ES.c.0", "NQ.c.0"]`).

`stype_out` controls the output symbology (defaults are fine for OHLCV; leave
unset unless you need instrument-id mapping).

---

## 3. Schemas

A *schema* is the record type / shape of the data. The ones relevant to quantlab:

| Schema | What it is | quantlab use |
|---|---|---|
| `ohlcv-1s` | 1-second bars | live candle source (later) |
| `ohlcv-1m` | 1-minute bars | **historical bars + resample base for 5m/15m/30m** |
| `ohlcv-1h` | 1-hour bars | **historical bars** |
| `ohlcv-1d` | daily bars | **historical bars** |
| `trades` | every trade print | only if we aggregate ticks ourselves |
| `mbp-1` | top-of-book (BBO) + trades | only for spread/live microstructure |
| `mbp-10` | 10-level book | not needed |
| `tbbo` | trade + BBO at trade time | not needed for bars |
| `bbo-1s` | 1-second sampled BBO | not needed for bars |
| `definition` | instrument definitions (tick size, expiry, …) | useful to seed the asset catalog |
| `statistics` | settlement, open interest, etc. | optional enrichment |

For the historical milestone quantlab uses **only the `ohlcv-*` schemas**. `trades`
/ `mbp-1` matter only if live bars are built from ticks (see live doc).

---

## 4. Data encoding — important gotchas

The **raw DBN encoding** (what `to_ndarray()` and the underlying records expose):

- **Timestamps** are `uint64` **nanoseconds since the UNIX epoch, UTC**
  (`ts_event`, `ts_recv`, plus `ts_event` per bar). Divide by `1e9` for seconds.
- **Prices** are `int64` **fixed-point, scaled by `1e-9`** (1 unit = 0.000000001).
  A price field of `4500000000000` means `4500.00`. Divide by `1e9` to get the
  real price.
- **Volume** is an integer contract/share count.

The **`to_df()` decoding** already does this work for you:

- Index is a **tz-aware `datetime64[ns, UTC]`** (the bar's `ts_event`).
- `open` / `high` / `low` / `close` are **floats in real price units** (already
  divided by 1e9).
- `volume` is an integer.
- An OHLCV DataFrame's columns are `open, high, low, close, volume` (+ symbol /
  instrument id), indexed by timestamp.

> ⚠️ **Do not double-scale.** If you use `to_df()`, prices are already real floats
> and the index is already datetime — never divide by 1e9 again. Only apply the
> 1e-9 / nanosecond conversions when working with the **raw** records or
> `to_ndarray()`. The quantlab adapter will use `to_df()`, so it just reads the
> float OHLCV columns and converts the index to epoch **seconds**.

---

## 5. Symbology (`stype_in`)

How the strings in `symbols=` are interpreted:

| `stype_in` | Example | Meaning |
|---|---|---|
| `raw_symbol` | `ESH4` | exact exchange symbol (ES, March 2024). Rolls/expires. |
| `continuous` | `ES.c.0` | continuous series; `.c.0` = lead (front) month, `.c.1` = next, … |
| `parent` | `ES.FUT` | all contracts in the ES futures family (returns many symbols). |

**Recommendation for backtests:** use `stype_in="continuous"` with `<ROOT>.c.0`
(`ES.c.0`, `NQ.c.0`, `CL.c.0`, `GC.c.0`). This gives one clean, gap-free front-month
series with calendar-based roll, which is what quantlab strategies expect (a single
continuous OHLCV stream, like the existing `@ES`/`ES_CONT` continuous symbols in
[tradestation.json](../../backend/data/assets/tradestation.json)).

Roll note: `.c.0` follows the front contract by expiry; the bar series is stitched
across rolls. For research this is the right default; for precise P&L around roll
dates, be aware of the roll convention.

---

## 6. Dataset: `GLBX.MDP3` (CME Globex MDP 3.0)

One dataset id covers all CME Group venues — CME, CBOT, NYMEX, COMEX — so every
target instrument lives here:

| Root | Product | Exchange | Continuous symbol |
|---|---|---|---|
| ES | E-mini S&P 500 | CME | `ES.c.0` |
| NQ | E-mini Nasdaq-100 | CME | `NQ.c.0` |
| CL | Crude Oil | NYMEX | `CL.c.0` |
| GC | Gold | COMEX | `GC.c.0` |

Minimal verbatim example — fetch ES hourly bars:

```python
import databento as db

hist = db.Historical()  # DATABENTO_API_KEY from env

data = hist.timeseries.get_range(
    dataset="GLBX.MDP3",
    symbols="ES.c.0",
    schema="ohlcv-1h",
    stype_in="continuous",
    start="2023-01-01",
    end="2024-01-01",
)

df = data.to_df()   # datetime-indexed OHLCV, float prices
print(df.head())
```

---

## 7. Cost control

Historical billing is **by data volume**, so always size a request before pulling
a large range:

```python
cost = hist.metadata.get_cost(
    dataset="GLBX.MDP3", symbols="ES.c.0", schema="ohlcv-1h",
    stype_in="continuous", start="2023-01-01", end="2024-01-01",
)            # estimated USD
size = hist.metadata.get_billable_size(...)   # bytes that would be billed
```

OHLCV schemas are tiny compared to `trades`/`mbp-*`; an hourly ES year is cents.
Tick schemas over long ranges can be large — estimate first. New teams have $125
of free credits.

---

## Sources

- Python client README: <https://github.com/databento/databento-python>
- PyPI: <https://pypi.org/project/databento/>
- Historical API: <https://databento.com/docs/api-reference-historical>
- Live API: <https://databento.com/docs/api-reference-live>
- Schemas & data formats: <https://databento.com/docs/schemas-and-data-formats>
  (OHLCV: <https://databento.com/docs/schemas-and-data-formats/ohlcv>)
- Symbology: <https://databento.com/docs/standards-and-conventions/symbology>
  (continuous: <https://databento.com/docs/examples/symbology/continuous>)
- GLBX.MDP3 dataset: <https://databento.com/datasets/GLBX.MDP3>
- Historical demo (Python): <https://databento.com/blog/api-demo-python>
