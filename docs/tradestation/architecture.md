# Architecture — TradeStation Ingestion

## Big picture

```
┌───────────────────────┐
│  TradeStation WebAPI  │  REST + streaming, OAuth-secured
└──────────┬────────────┘
           │  HTTPS
┌──────────▼────────────┐
│  TradeStation client  │  auth.py, client.py, stream.py
│  (provider-specific)  │
└──────────┬────────────┘
           │  provider-native bar records
┌──────────▼────────────┐
│      Normalizer       │  TS schema → canonical schema
└──────────┬────────────┘
           │  canonical Bar records (UTC, OHLCV, source-tagged)
┌──────────▼────────────┐
│      Bar store        │  SQLAlchemy → SQLite (prototype)
│                       │             → WAMP MySQL (production)
└──────────┬────────────┘
           │  read API
┌──────────▼────────────┐
│  Strategies / engine  │  existing quant-laptop code
│  Dashboards / UI      │
└───────────────────────┘
```

The same `Normalizer → Bar store` rail is what future providers
(IBKR, Polygon, DXFeed, Binance, Capital.com, Dukascopy) will feed into.
TradeStation is just the first.

## How this fits the existing repo

quant-laptop already has a broker pattern:

```
backend/services/brokers/
├── __init__.py
├── yahoo.py          ← download(symbol, start, end, timeframe, ...) -> DataFrame
└── dukascopy.py      ← same signature
```

Plus a binance feed via CCXT inside `backend/services/market_data.py`,
and the streaming base in `backend/services/stream_base.py`.

**TradeStation slots into the same place** but is large enough to be a
**package**, not a single file:

```
backend/services/brokers/
└── tradestation/
    ├── __init__.py        # re-exports download(...) so existing pipelines keep working
    ├── auth.py            # OAuth bootstrap + token refresh + token storage
    ├── client.py          # historical REST: fetch_bars(), fetch_quotes()
    ├── stream.py          # streaming subclass of CandleStream
    ├── provider.py        # implements feed.FeedProvider, glues everything together
    └── symbol_map.py      # TS-specific symbol normalization (uses data/assets/tradestation.json)
```

The new generic abstraction lives one level up:

```
backend/services/feed/
├── __init__.py
├── base.py                # FeedProvider ABC (interface for any data provider)
├── bar.py                 # canonical Bar dataclass
├── normalizer.py          # TS-native → canonical
├── health.py              # FeedHealth dataclass + per-provider tracker
└── storage.py             # BarStore interface; SQLAlchemy impl for SQLite/MySQL
```

And asset metadata lives where the existing pattern puts it:

```
backend/data/assets/
├── yahoo.json
└── tradestation.json      # symbol catalog: TS symbol → canonical + contract metadata
```

## Canonical bar schema

One row per bar. **Always UTC.** Match the existing parquet column
convention so the rest of quant-laptop doesn't need to change.

```python
@dataclass(frozen=True)
class Bar:
    symbol: str            # canonical, e.g. "NQ_CONT", not "@NQ"
    timeframe: str         # "1m", "5m", "60m", "1d" — same vocab as TIMEFRAME_SECONDS
    ts_utc: int            # unix seconds, UTC, bar OPEN time (not close)
    open: float
    high: float
    low: float
    close: float
    volume: float
    source: str            # "tradestation", "yahoo", "binance", ...
    session: str | None    # "RTH" / "ETH" / "Custom:USEQPreAndPost" — provider session template
    contract: str | None   # underlying contract if known, e.g. "NQM26"; null for continuous
```

Primary key: `(source, symbol, timeframe, ts_utc)`. The `source` is in
the key so the same (symbol, timeframe) from different providers can
coexist — critical for the parity check (Sinegual Lab) and for future
multi-provider redundancy.

## Provider abstraction (`feed/base.py`)

```python
class FeedProvider(ABC):
    name: ClassVar[str]                       # "tradestation", "polygon", ...

    @abstractmethod
    def fetch_bars(self, symbol: str, timeframe: str,
                   start: datetime, end: datetime) -> list[Bar]: ...

    @abstractmethod
    def stream_bars(self, symbol: str, timeframe: str,
                    on_bar: Callable[[Bar], None]) -> CandleStream: ...

    @abstractmethod
    def fetch_quote(self, symbol: str) -> Quote: ...

    def health(self) -> FeedHealth: ...
```

A consumer (strategy runner, dashboard, validation export) talks only
to the `BarStore` and to whatever provider it explicitly chose.
Cross-provider switching is config-driven, not code-driven.

## Why this layout

- **Matches what's already there.** Existing yahoo/dukascopy stay
  untouched. New code follows their conventions (signature of
  `download()`, parquet schema, `data/assets/<broker>.json`).
- **TradeStation is complex enough to be a package.** OAuth + REST +
  streaming + reconnect logic + symbol map don't fit in a single
  file the way Yahoo's wrapper does.
- **`feed/` namespace is new but cheap.** It's the future-proofing layer
  Christian's section 7 asked for. Empty until a second provider needs it,
  but TradeStation implementing the interface from day 1 means the
  refactor cost is zero later.
- **Storage is pluggable from day 1.** SQLAlchemy means SQLite-now,
  WAMP-MySQL-later is a config flip, not a rewrite. See `storage.md`.

## What stays out of this architecture

- **Execution / order routing.** Christian: "MultiCharts can remain
  independent for execution." We are building the data layer only.
  No `/v3/orderexecution/*` endpoints.
- **Account management.** No `/v3/brokerage/accounts/*` endpoints.
  Strict data-feed scope until that's explicitly added.
- **Tick data.** Bars only. Tick streaming is `stream/tickbars` or
  similar and is a separate feature if/when needed.
