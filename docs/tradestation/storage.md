# Storage — Canonical Bars

## The tension

Two voices on storage:
- **User (you):** "Database soon will be WAMP MySQL."
- **Christian:** "Save into SQLite/Postgres."

Both can be true if we pick the right abstraction. The right move:
**SQLAlchemy from day 1**, point at SQLite for the prototype, swap the
connection string to MySQL when WAMP is up. Same code path, zero rewrite.

## Why SQLAlchemy

- Connection string is config. SQLite → MySQL → Postgres is one env-var change.
- Dialect-aware upserts: `dialect.insert(...).on_conflict_do_update`
  works for SQLite (`INSERT OR REPLACE`) and MySQL
  (`INSERT ... ON DUPLICATE KEY UPDATE`) using the same Python call.
  Critical for idempotent bar writes after stream reconnects.
- The Core layer (not the ORM) is the right level — bars are bulk tuples,
  not domain objects with behavior.
- It's the path of least pain when WAMP arrives.

## Why not pick MySQL directly even now

- WAMP isn't installed yet on the dev box. Adding a server dependency to
  start the prototype slows everything down.
- SQLite is single-file, zero-install, runs anywhere. Ideal for the
  tracer-bullet prototype.
- The schema is the same either way (with one minor dialect note below).

## Why not stay on Parquet

The existing parquet pipeline (`backend/services/market_data.py`) is
great for **bulk historical** read-then-replay (backtest engine, walk-forward).
It's bad for **live ingestion** because:
- Append-on-each-bar means rewriting the whole file every minute.
- No primary key, no upsert semantics — dedup is manual.
- No concurrent writer story.

**Plan:** the live ingestion writes to the SQL DB. A periodic exporter
(or on-demand call) materializes parquet snapshots for the backtest
engine to consume. Best of both: SQL for live, parquet for batch.
Parquet pipeline stays untouched.

## Schema — minimum viable for the prototype

One table is enough to make the prototype work:

```sql
CREATE TABLE bars (
    source      VARCHAR(32)   NOT NULL,   -- "tradestation", "yahoo", "binance", ...
    symbol      VARCHAR(32)   NOT NULL,   -- canonical, e.g. "NQ_CONT", "ES_M26"
    timeframe   VARCHAR(8)    NOT NULL,   -- "1m", "5m", "60m", "1d"
    ts_utc      BIGINT        NOT NULL,   -- unix seconds, UTC, bar OPEN time
    open        DOUBLE        NOT NULL,
    high        DOUBLE        NOT NULL,
    low         DOUBLE        NOT NULL,
    close       DOUBLE        NOT NULL,
    volume      DOUBLE        NOT NULL,
    session     VARCHAR(32)   NULL,       -- "RTH" / "ETH" / null
    contract    VARCHAR(16)   NULL,       -- "NQM26" if contract-specific, null for continuous
    inserted_at BIGINT        NOT NULL,   -- when we received it, for late-data debugging
    PRIMARY KEY (source, symbol, timeframe, ts_utc)
);

CREATE INDEX bars_symbol_tf_ts ON bars (symbol, timeframe, ts_utc);
```

### Schema notes

- **`source` is in the primary key.** This lets the same `(symbol,
  timeframe)` exist from multiple providers without collisions. The
  Sinegual parity check needs `NQ_CONT` from TradeStation + `NQ_CONT`
  from elsewhere to coexist for comparison. Don't drop `source` from
  the PK to "simplify" — you'll regret it the day a second provider arrives.

- **`ts_utc` as `BIGINT` unix-seconds.** Matches the existing parquet
  convention (`time` column is unix-seconds). Lets the backtest engine
  consume DB-sourced bars without translation. **Always UTC.** Convert
  TS's ISO 8601 timestamps to UTC at the normalizer, never deeper.

- **`ts_utc` = bar OPEN time.** Pick a convention, stick to it. TS docs
  should confirm which TS uses — **[verify]**. If TS returns bar-close
  time, normalize to open in the normalizer (subtract `TIMEFRAME_SECONDS`).

- **`contract` is nullable.** Continuous symbols (`@NQ` → `NQ_CONT`)
  store NULL; contract-specific (`NQM26` → `NQ_CONT` with `contract='NQM26'`)
  store the underlying contract. This way you can query "all NQ continuous"
  vs "only NQ June 2026" without two different symbols.

- **`inserted_at` for forensic debugging.** When a reconnect re-ingests
  bars, you can see exactly when the second write happened.

### Dialect note: `DOUBLE`

- MySQL: `DOUBLE` is standard.
- SQLite: ignores type strength but accepts `DOUBLE` as a column affinity
  hint. Works fine in practice.
- Postgres: uses `DOUBLE PRECISION`. SQLAlchemy's `Float` type emits the
  right keyword for each dialect — so use `Column(Float, nullable=False)`
  in the SQLAlchemy table definition rather than hand-rolling SQL.

## Schema — additional tables for the full system

Build these when you go past the prototype. Not needed for steps 1–5.

```sql
-- Symbol catalog. Source of truth for canonical → provider mapping
-- and per-symbol metadata. The current per-broker JSON
-- (data/assets/<broker>.json) can be migrated here later.
CREATE TABLE symbols (
    canonical    VARCHAR(32)   PRIMARY KEY,
    asset_class  VARCHAR(16)   NOT NULL,   -- "future" / "equity" / "fx" / "crypto"
    exchange     VARCHAR(16)   NULL,
    tick_size    DOUBLE        NULL,
    contract_size DOUBLE       NULL,
    is_continuous BOOLEAN      NOT NULL DEFAULT TRUE,
    metadata_json TEXT         NULL        -- escape hatch for provider-specific extras
);

CREATE TABLE symbol_aliases (
    canonical    VARCHAR(32)   NOT NULL REFERENCES symbols(canonical),
    source       VARCHAR(32)   NOT NULL,
    provider_symbol VARCHAR(32) NOT NULL,
    PRIMARY KEY (source, provider_symbol)
);

-- Session templates — codifies the "Fixed session hours" idea from the
-- Sinegual sample folder. Each strategy / asset can reference one.
CREATE TABLE sessions (
    name         VARCHAR(32)   PRIMARY KEY,    -- "RTH_USEQ", "ETH_USEQ", "CME_GLOBEX"
    timezone     VARCHAR(64)   NOT NULL,       -- "America/New_York"
    open_local   TIME          NOT NULL,
    close_local  TIME          NOT NULL,
    weekdays     VARCHAR(7)    NOT NULL        -- "MTWTF--" mask
);

-- Per-(source, symbol, timeframe) ingestion health. Watchdog reads/writes this.
CREATE TABLE feed_health (
    source       VARCHAR(32)   NOT NULL,
    symbol       VARCHAR(32)   NOT NULL,
    timeframe    VARCHAR(8)    NOT NULL,
    last_bar_ts_utc BIGINT     NULL,
    last_seen_at BIGINT        NULL,           -- when we last received any event (bar or heartbeat)
    stream_alive BOOLEAN       NOT NULL DEFAULT FALSE,
    reconnect_count INT        NOT NULL DEFAULT 0,
    last_error   TEXT          NULL,
    last_error_at BIGINT       NULL,
    PRIMARY KEY (source, symbol, timeframe)
);
```

## Write semantics — idempotent upsert

The streaming + reconnect logic relies on being able to **re-send the same
bar** without creating duplicates or failing. SQLAlchemy idiom (works
for SQLite and MySQL):

```python
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
# or:
from sqlalchemy.dialects.mysql import insert as mysql_insert

stmt = sqlite_insert(bars).values(rows)
stmt = stmt.on_conflict_do_update(
    index_elements=["source", "symbol", "timeframe", "ts_utc"],
    set_={
        "open": stmt.excluded.open,
        "high": stmt.excluded.high,
        "low":  stmt.excluded.low,
        "close": stmt.excluded.close,
        "volume": stmt.excluded.volume,
        "inserted_at": int(time.time()),
    },
)
conn.execute(stmt)
```

For MySQL, the same pattern with `mysql_insert` and
`stmt.on_duplicate_key_update(...)`. A thin `BarStore.write(rows)`
abstraction can dispatch based on the configured dialect, so callers
never see the dialect difference.

## Migration story

When WAMP MySQL goes live:

1. Run the DDL above against the `quantlab` database.
2. Flip `QUANTLAB_DB_URL` env var from
   `sqlite:///backend/data/quantlab.sqlite` to
   `mysql+pymysql://user:pass@localhost/quantlab`.
3. Optionally, one-shot export from SQLite → MySQL using a tiny script
   (SQLAlchemy makes this trivial — `read all from bars table on one
   engine, write to the other`).
4. Update `.env`, restart backend.

That's it. No application code changes if SQLAlchemy was used from
the start.

## What's deliberately out of scope here

- No row-level audit / change history. Re-ingested bars overwrite
  in-place (with updated `inserted_at`). If you ever need
  "what did we have at time T" you'd need a separate `bars_history`
  table — defer until there's a real reason.
- No partitioning. At hour-bar cadence, single-table is fine for years.
  At tick cadence you'd want per-month partitions; cross that bridge
  if/when tick ingestion is added.
- No materialized rollups (1m → 5m → 15m). Compute on read via the
  backtest engine; storage is single-truth at the smallest stored
  resolution.
