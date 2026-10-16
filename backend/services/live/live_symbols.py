"""
Which symbols may run LIVE (real webhooks) — one helper, used everywhere.

Live = Binance spot klines over a websocket. A symbol is live-eligible when it
is a TRADING spot pair on Binance, per the public exchangeInfo endpoint (cached
in memory ~6h; if Binance can't be reached we fall back to the small curated
catalog in data/assets/binance.json and try again in a few minutes).

NOT live-eligible on the server:
  - research names with an exchange prefix / perp suffix (MEXC.*, BYBIT.*, *.P)
    — there's no live feed for them here;
  - CME futures (ES/NQ/CL/GC) — UNLESS a TradeStation CSV feed file actually
    exists for them (only true on the Windows dev box).

Why it matters: when a live stream can't be built, the old code silently fell
back to REPLAYING HISTORY — and replayed bars fire real webhooks. Every live
path now asks is_live_eligible() first and refuses instead.
"""
from __future__ import annotations

import logging
import re
import time
from threading import Lock

import requests

log = logging.getLogger(__name__)

EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/exchangeInfo"
_TTL_SECONDS = 6 * 3600          # a good exchangeInfo answer is trusted this long
_RETRY_AFTER_FAIL = 300          # after a failed fetch, try again in 5 min
_PLAIN = re.compile(r"^[A-Z0-9]{2,20}$")   # SOLUSDT yes; MEXC.SOLUSDT / SOLUSDT.P no

_lock = Lock()
_cache: dict = {"pairs": None, "expires": 0.0, "source": ""}


def _fetch_exchange_info() -> dict[str, str]:
    """{symbol: quoteAsset} for every TRADING Binance spot pair."""
    r = requests.get(EXCHANGE_INFO_URL, timeout=10)
    r.raise_for_status()
    out = {}
    for s in r.json().get("symbols", []):
        if s.get("status") == "TRADING" and s.get("isSpotTradingAllowed", True):
            out[str(s["symbol"]).upper()] = str(s.get("quoteAsset") or "").upper()
    if not out:
        raise ValueError("exchangeInfo listed no TRADING spot pairs")
    return out


def _catalog_fallback() -> dict[str, str]:
    """The curated data/assets/binance.json pairs (used when Binance is unreachable)."""
    try:
        from services import assets
        return {sym.upper(): (meta.quote or "").upper()
                for sym, meta in assets.for_broker("binance").items()}
    except Exception:
        log.exception("[live_symbols] could not read the binance.json catalog")
        return {}


def binance_spot_pairs() -> dict[str, str]:
    """{symbol: quoteAsset} of tradable Binance spot pairs (cached)."""
    now = time.time()
    with _lock:
        if _cache["pairs"] is not None and now < _cache["expires"]:
            return _cache["pairs"]
        previous, prev_source = _cache["pairs"], _cache["source"]
    try:
        pairs, ttl, source = _fetch_exchange_info(), _TTL_SECONDS, "exchangeInfo"
    except Exception as e:
        log.warning("[live_symbols] Binance exchangeInfo fetch failed (%s) — using fallback", e)
        ttl = _RETRY_AFTER_FAIL
        if previous and prev_source.startswith("exchangeInfo"):
            pairs, source = previous, "exchangeInfo (stale)"   # an old full list beats the tiny catalog
        else:
            pairs, source = _catalog_fallback(), "binance.json"
    with _lock:
        _cache.update(pairs=pairs, expires=now + ttl, source=source)
    return pairs


def is_binance_spot(symbol: str) -> bool:
    s = (symbol or "").strip().upper()
    return bool(_PLAIN.match(s)) and s in binance_spot_pairs()


def _ts_csv_exists(symbol: str, timeframe: str | None) -> bool:
    """A TradeStation live CSV for this symbol (and timeframe, when given) is on disk."""
    try:
        from services.ts_csv_stream import ROOT, _csv_path
    except Exception:
        return False
    if timeframe:
        return _csv_path(symbol, timeframe).exists()
    sym = symbol.lstrip("@")
    folder = ROOT / sym
    return folder.is_dir() and any(folder.glob(f"{sym}_*_live.csv"))


def is_live_eligible(symbol: str, timeframe: str | None = None) -> tuple[bool, str]:
    """(ok, reason). The single gate every live path (stream, daemon, deploy
    validation) goes through."""
    s = (symbol or "").strip().upper()
    if not s:
        return False, "symbol is required"
    if is_binance_spot(s):
        return True, f"{s} is a trading Binance spot pair"
    if _ts_csv_exists(s, timeframe):
        return True, f"{s} has a TradeStation CSV live feed on this machine"
    if not _PLAIN.match(s):
        return False, (f"{s} is a research symbol (exchange prefix / .P perp suffix) — live runs "
                       f"only on plain Binance spot pairs such as SOLUSDT")
    return False, f"{s} is not a trading Binance spot pair — there is no live feed for it on this server"


def deployable_usdt_symbols() -> list[str]:
    """Sorted USDT-quoted Binance spot pairs — what the Deploy modal offers."""
    pairs = binance_spot_pairs()
    return sorted(s for s, q in pairs.items() if q == "USDT" or (not q and s.endswith("USDT")))
