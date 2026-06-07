"""
Asset metadata catalog — the data model that supports multi-broker, multi-
asset-class trading. Stage 1 of the architecture roadmap.

For now this is read-only metadata: backtest_engine and friends are not yet
wired to consume it. The point of Stage 1 is to make the data model exist
without changing any user-visible behavior. Later stages (3+) plug the
execution engine into ExecutionModel selected from `execution_model` here.

Catalog format: backend/data/assets/{broker}.json
  {
    "BTCUSDT": {
      "asset_class":     "crypto",
      "execution_model": "spot_crypto",
      "base":            "BTC",
      "quote":           "USDT",
      "contract_size":   1.0,
      "tick_size":       0.01,
      "market_hours_tz": "UTC",
      "swap_long_pct":   0.0,
      "swap_short_pct":  0.0,
      "leverage_max":    1.0
    },
    ...
  }

If a symbol is requested but not in any catalog, we synthesize a sensible
default (treat as crypto USDT pair) rather than raising. This keeps the
download flow tolerant of new pairs that haven't been catalogued yet.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, asdict
from typing import Optional

log = logging.getLogger(__name__)

_ASSETS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "assets"
)
_CACHE: dict[str, dict[str, "AssetMetadata"]] = {}  # broker -> {symbol -> meta}
_CACHE_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# Allowed enum values. Kept as plain string sets (not Enum) so JSON catalogs
# and API payloads stay strings end-to-end.
# ---------------------------------------------------------------------------

ASSET_CLASSES = ("crypto", "forex", "stock", "index", "commodity", "futures")
EXECUTION_MODELS = ("spot_crypto", "forex_cfd", "stock_cfd", "stock_cash", "commodity_cfd", "futures")


@dataclass(frozen=True)
class AssetMetadata:
    symbol: str
    broker: str
    asset_class: str
    execution_model: str
    base: str
    quote: str
    contract_size: float
    tick_size: float
    market_hours_tz: str
    swap_long_pct: float
    swap_short_pct: float
    leverage_max: float

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Catalog loading
# ---------------------------------------------------------------------------

def _load_broker_catalog(broker: str) -> dict[str, AssetMetadata]:
    """Read backend/data/assets/{broker}.json into a {symbol: AssetMetadata}
    map. Missing file → empty dict (broker exists but has no catalogued
    symbols yet)."""
    path = os.path.join(_ASSETS_DIR, f"{broker}.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as e:
        log.warning("failed to read asset catalog %s: %s", path, e)
        return {}

    out: dict[str, AssetMetadata] = {}
    for symbol, fields in raw.items():
        try:
            meta = AssetMetadata(
                symbol=symbol,
                broker=broker,
                asset_class=str(fields.get("asset_class") or "crypto"),
                execution_model=str(fields.get("execution_model") or "spot_crypto"),
                base=str(fields.get("base") or ""),
                quote=str(fields.get("quote") or ""),
                contract_size=float(fields.get("contract_size") or 1.0),
                tick_size=float(fields.get("tick_size") or 0.0),
                market_hours_tz=str(fields.get("market_hours_tz") or "UTC"),
                swap_long_pct=float(fields.get("swap_long_pct") or 0.0),
                swap_short_pct=float(fields.get("swap_short_pct") or 0.0),
                leverage_max=float(fields.get("leverage_max") or 1.0),
            )
        except (TypeError, ValueError) as e:
            log.warning("bad metadata for %s in %s: %s", symbol, path, e)
            continue
        out[symbol] = meta
    return out


def _broker_catalog(broker: str) -> dict[str, AssetMetadata]:
    """Cached per-broker catalog. Reload-safe (call refresh() to bust)."""
    with _CACHE_LOCK:
        if broker not in _CACHE:
            _CACHE[broker] = _load_broker_catalog(broker)
        return _CACHE[broker]


def refresh() -> None:
    """Bust the catalog cache. Useful in tests or after a catalog edit."""
    with _CACHE_LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------------------
# Defaults for un-catalogued symbols (so new downloads don't blow up)
# ---------------------------------------------------------------------------

_CRYPTO_QUOTES = ("USDT", "USDC", "BUSD", "FDUSD", "TUSD", "BTC", "ETH", "BNB", "EUR", "TRY")


def _split_crypto_pair(symbol: str) -> tuple[str, str]:
    """BTCUSDT → ('BTC', 'USDT'). Splits on the longest matching quote suffix.
    Falls back to (symbol[:-4], symbol[-4:]) if no known quote matches."""
    s = symbol.upper()
    for q in sorted(_CRYPTO_QUOTES, key=len, reverse=True):
        if s.endswith(q) and len(s) > len(q):
            return s[: -len(q)], q
    return s[:-4], s[-4:]


def _default_meta(symbol: str, broker: str) -> AssetMetadata:
    """Best-effort fallback when a symbol isn't catalogued. Today we treat
    every unknown as a crypto spot pair on whatever broker was asked for —
    safe for Binance, and will be revisited when forex/stocks land."""
    base, quote = _split_crypto_pair(symbol)
    return AssetMetadata(
        symbol=symbol,
        broker=broker,
        asset_class="crypto",
        execution_model="spot_crypto",
        base=base,
        quote=quote,
        contract_size=1.0,
        tick_size=0.0,
        market_hours_tz="UTC",
        swap_long_pct=0.0,
        swap_short_pct=0.0,
        leverage_max=1.0,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get(symbol: str, broker: str = "binance") -> AssetMetadata:
    """Return the AssetMetadata for (symbol, broker). Falls back to a
    synthesized default if not catalogued — never raises on lookup."""
    cat = _broker_catalog(broker)
    if symbol in cat:
        return cat[symbol]
    return _default_meta(symbol, broker)


def lookup(symbol: str, broker: str = "binance") -> Optional[AssetMetadata]:
    """Like get() but returns None for un-catalogued symbols (no fallback).
    Use when you want to know "is this in our catalog?"."""
    return _broker_catalog(broker).get(symbol)


def for_broker(broker: str) -> dict[str, AssetMetadata]:
    """Return all catalogued symbols for a broker as {symbol: AssetMetadata}."""
    return dict(_broker_catalog(broker))


def list_brokers() -> list[str]:
    """All brokers that have a catalog file under data/assets/."""
    if not os.path.isdir(_ASSETS_DIR):
        return []
    return sorted([
        f[:-len(".json")] for f in os.listdir(_ASSETS_DIR)
        if f.endswith(".json")
    ])
