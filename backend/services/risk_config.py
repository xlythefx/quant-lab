"""
Global risk-management configuration shared by ALL strategies.

Single source of truth for: starting capital, risk per trade, fees, slippage.
Persisted to data/risk_config.json so it survives restarts.
"""
from __future__ import annotations

import json
import logging
import os
from threading import Lock
from typing import Any

from config import DATA_DIR, STARTING_CAPITAL

log = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "risk_config.json")
_LOCK = Lock()

DEFAULTS: dict = {
    "starting_capital": float(STARTING_CAPITAL),
    "risk_pct": 3.0,             # % of equity per trade
    "fee_flat":   0.0,           # flat $ per trade (each side)
    "fee_pct":    0.04,          # % of notional per trade (each side)
    "slippage_bps": 1.0,         # basis points applied to fill price
    "pyramiding": 10.0,          # max concurrent positions per strategy
}

_cache: dict | None = None


def _coerce(d: dict) -> dict:
    out = dict(DEFAULTS)
    for k, default in DEFAULTS.items():
        if k in d and d[k] is not None:
            try: out[k] = float(d[k])
            except (TypeError, ValueError): pass
    # Sanity bounds.
    out["starting_capital"] = max(1.0, out["starting_capital"])
    out["risk_pct"] = max(0.0, min(100.0, out["risk_pct"]))
    out["fee_flat"] = max(0.0, out["fee_flat"])
    out["fee_pct"] = max(0.0, min(10.0, out["fee_pct"]))
    out["slippage_bps"] = max(0.0, min(500.0, out["slippage_bps"]))
    out["pyramiding"] = max(1.0, min(100.0, out["pyramiding"]))
    return out


def get() -> dict:
    global _cache
    with _LOCK:
        if _cache is not None:
            return dict(_cache)
        if os.path.exists(_PATH):
            try:
                with open(_PATH, "r") as f:
                    _cache = _coerce(json.load(f))
                    return dict(_cache)
            except Exception as e:
                log.warning("could not read %s: %s — falling back to defaults", _PATH, e)
        _cache = dict(DEFAULTS)
        return dict(_cache)


def update(patch: dict) -> dict:
    global _cache
    with _LOCK:
        current = dict(_cache) if _cache is not None else dict(DEFAULTS)
        current.update(patch or {})
        _cache = _coerce(current)
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_PATH, "w") as f:
            json.dump(_cache, f, indent=2)
        log.info("risk_config updated: %s", _cache)
        return dict(_cache)
