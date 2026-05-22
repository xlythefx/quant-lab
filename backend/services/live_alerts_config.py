"""
Per-(strategy_id, symbol) webhook alert rules.

Persisted to data/live_alerts.json. Mirrors risk_config.py: atomic read/write,
in-memory cache, defaults if the file is missing.

Each rule shape:
  {
    "strategy_id":    "vwma_reversion",
    "symbol":         "BTCUSDT",
    "enabled":        true,
    "webhook_url":    "http://localhost:5051/binance_webhook",
    "secret":         "<shared token>",
    "strategy_alias": "VWMA-Reversion",   # what the acceptor expects in `strategy`
    "leverage":       25
  }
"""
from __future__ import annotations

import json
import logging
import os
from threading import Lock

from config import DATA_DIR

log = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "live_alerts.json")
_LOCK = Lock()

_REQUIRED = ("strategy_id", "symbol", "webhook_url", "secret", "strategy_alias")
_cache: list[dict] | None = None


def _coerce_rule(r: dict) -> dict | None:
    if not isinstance(r, dict):
        return None
    out = {
        "strategy_id":    str(r.get("strategy_id") or "").strip(),
        "symbol":         str(r.get("symbol") or "").strip().upper(),
        "enabled":        bool(r.get("enabled", True)),
        "webhook_url":    str(r.get("webhook_url") or "").strip(),
        "secret":         str(r.get("secret") or "").strip(),
        "strategy_alias": str(r.get("strategy_alias") or "").strip(),
        "leverage":       _to_int(r.get("leverage"), default=1, lo=1, hi=125),
    }
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
    seen = set()
    out: list[dict] = []
    for r in rules:
        c = _coerce_rule(r)
        if not c:
            continue
        key = (c["strategy_id"], c["symbol"])
        if key in seen:
            continue
        seen.add(key)
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
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = _PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"rules": coerced}, f, indent=2)
        os.replace(tmp, _PATH)
        _cache = coerced
        log.info("live_alerts saved: %d rule(s)", len(coerced))
        return [dict(r) for r in _cache]


def find_rule(strategy_id: str, symbol: str) -> dict | None:
    sid = (strategy_id or "").strip()
    sym = (symbol or "").strip().upper()
    for r in load_rules():
        if r["strategy_id"] == sid and r["symbol"] == sym:
            return r
    return None
