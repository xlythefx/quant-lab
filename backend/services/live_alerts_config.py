"""
Per-rule webhook alert config.

Persisted to data/live_alerts.json. Rules are keyed by `name` (the new
uniqueness field), so multiple rules can target the same (strategy_id, symbol)
— e.g. one per VPS endpoint — mirroring TradingView's per-alert model.

Each rule shape:
  {
    "name":           "VWMA BTC → VPS1",
    "strategy_id":    "vwma_reversion",
    "symbol":         "BTCUSDT",
    "enabled":        true,
    "webhook_url":    "https://api1.example.com/binance_webhook",
    "secret":         "<shared token>",
    "strategy_alias": "VWMA-Reversion",
    "leverage":       25
  }

Backwards compat: old rules without `name` get one auto-generated from
strategy_id + symbol on first load.
"""
from __future__ import annotations

import json
import logging
import os
from threading import Lock

from config import DATA_DIR
from services.atomic_io import atomic_write_json

log = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "live_alerts.json")
_LOCK = Lock()

_REQUIRED = ("name", "strategy_id", "symbol", "timeframe", "webhook_url", "secret", "strategy_alias")
_VALID_BROKERS = ("binance", "tradestation")
_cache: list[dict] | None = None

# Tokens available in a custom payload_template JSON string.
PAYLOAD_TOKENS = ("action", "symbol", "secret", "strategy", "leverage")


def _auto_broker(symbol: str) -> str:
    """Detect whether a symbol is Binance or TradeStation based on the asset list."""
    try:
        from services.market_data import is_binance_symbol
        return "binance" if is_binance_symbol(symbol) else "tradestation"
    except Exception:
        return "binance"


def _coerce_payload_template(v) -> str | None:
    """Return the template string if it's non-empty valid JSON, else None."""
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        parsed = json.loads(s)
        if not isinstance(parsed, dict):
            return None
        return s
    except (json.JSONDecodeError, ValueError):
        return None


def _coerce_rule(r: dict, *, fallback_index: int = 0) -> dict | None:
    if not isinstance(r, dict):
        return None
    strategy_id = str(r.get("strategy_id") or "").strip()
    symbol      = str(r.get("symbol") or "").strip().upper()
    name        = str(r.get("name") or "").strip()
    if not name:
        # backwards compat: generate from strategy+symbol
        name = f"{strategy_id}_{symbol}" if (strategy_id and symbol) else f"rule_{fallback_index}"
    out = {
        "name":             name,
        "strategy_id":      strategy_id,
        "symbol":           symbol,
        "timeframe":        str(r.get("timeframe") or "").strip(),
        "enabled":          bool(r.get("enabled", True)),
        "webhook_url":      str(r.get("webhook_url") or "").strip(),
        "secret":           str(r.get("secret") or "").strip(),
        "strategy_alias":   str(r.get("strategy_alias") or "").strip(),
        "leverage":         _to_int(r.get("leverage"), default=1, lo=1, hi=125),
        "payload_template": _coerce_payload_template(r.get("payload_template")),
        # broker is auto-detected from symbol if not explicitly set
        "broker":           str(r.get("broker") or _auto_broker(symbol)).lower(),
        # optional per-rule strategy param overrides; Strategy._merge_with_defaults handles coercion
        "params":           dict(r.get("params") or {}),
        # Live Terminal: which account the signal targets. Demo = run live
        # with fake money (the safe default); Live = real funds. Old rules
        # without the field are treated as demo. The old page ignores it.
        "account":          ("live" if str(r.get("account") or "").lower() == "live" else "demo"),
    }
    if out["broker"] not in _VALID_BROKERS:
        out["broker"] = _auto_broker(symbol)
    for k in _REQUIRED:
        if not out[k]:
            return None
    if not (out["webhook_url"].startswith("http://") or out["webhook_url"].startswith("https://")):
        return None
    return out


def _to_int(v, *, default: int, lo: int, hi: int) -> int:
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _coerce_rules(rules) -> list[dict]:
    if not isinstance(rules, list):
        return []
    seen_names: set[str] = set()
    out: list[dict] = []
    for i, r in enumerate(rules):
        c = _coerce_rule(r, fallback_index=i)
        if not c:
            continue
        if c["name"] in seen_names:
            continue
        seen_names.add(c["name"])
        out.append(c)
    return out


def load_rules() -> list[dict]:
    global _cache
    with _LOCK:
        if _cache is not None:
            return [dict(r) for r in _cache]
        if os.path.exists(_PATH):
            try:
                with open(_PATH, "r") as f:
                    data = json.load(f)
                _cache = _coerce_rules(data.get("rules") if isinstance(data, dict) else data)
                return [dict(r) for r in _cache]
            except Exception as e:
                log.warning("could not read %s: %s — falling back to empty rule list", _PATH, e)
        _cache = []
        return []


def save_rules(rules) -> list[dict]:
    global _cache
    with _LOCK:
        coerced = _coerce_rules(rules)
        atomic_write_json(_PATH, {"rules": coerced})
        _cache = coerced
        log.info("live_alerts saved: %d rule(s)", len(coerced))
        return [dict(r) for r in _cache]


def find_rules(strategy_id: str, symbol: str) -> list[dict]:
    """Return all enabled rules matching (strategy_id, symbol)."""
    sid = (strategy_id or "").strip()
    sym = (symbol or "").strip().upper()
    return [r for r in load_rules() if r["strategy_id"] == sid and r["symbol"] == sym]


def find_rule_by_name(name: str) -> dict | None:
    name = (name or "").strip()
    for r in load_rules():
        if r["name"] == name:
            return r
    return None
