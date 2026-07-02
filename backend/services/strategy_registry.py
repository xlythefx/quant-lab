"""
Auto-discover Strategy subclasses from the services.strategies package.

Drop a new .py into services/strategies/ that defines a Strategy subclass
with a META and PARAM_SCHEMA, restart, and it shows up in /api/strategies
without further wiring.
"""
from __future__ import annotations

import importlib
import json
import logging
import os
import sys
import pkgutil
from typing import Type

from config import DATA_DIR
from services.strategies import base as _base
from services.strategies.base import Strategy, StrategyMeta

log = logging.getLogger(__name__)

_REGISTRY: dict[str, Type[Strategy]] = {}

# Sidecar for UI-side flags the AI Strategy Builder can toggle without rewriting
# source files — currently just {id: {"archived": bool}}. Merged into each
# strategy dict in list_strategies(); archive/unarchive is fully reversible.
_OVERRIDES_PATH = os.path.join(DATA_DIR, "strategy_overrides.json")


def _load_overrides() -> dict:
    try:
        with open(_OVERRIDES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def set_strategy_override(strategy_id: str, **flags) -> dict:
    """Merge-and-persist per-strategy UI flags (e.g. archived=True). Returns the
    full override entry for the strategy."""
    data = _load_overrides()
    entry = dict(data.get(strategy_id) or {})
    entry.update(flags)
    data[strategy_id] = entry
    os.makedirs(os.path.dirname(_OVERRIDES_PATH), exist_ok=True)
    with open(_OVERRIDES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return entry


def _scan() -> None:
    if _REGISTRY:
        return
    pkg = importlib.import_module("services.strategies")
    for mod_info in pkgutil.iter_modules(pkg.__path__):
        if mod_info.name.startswith("_") or mod_info.name == "base":
            continue
        full = f"services.strategies.{mod_info.name}"
        try:
            mod = importlib.import_module(full)
        except Exception as e:
            log.exception("Failed to import strategy module %s: %s", full, e)
            continue
        for attr_name in dir(mod):
            obj = getattr(mod, attr_name)
            if (isinstance(obj, type)
                    and issubclass(obj, Strategy)
                    and obj is not Strategy
                    and getattr(obj, "META", None) is not None):
                meta: StrategyMeta = obj.META
                if meta.id in _REGISTRY:
                    log.warning("Duplicate strategy id %s (%s vs %s)", meta.id,
                                _REGISTRY[meta.id].__name__, obj.__name__)
                    continue
                _REGISTRY[meta.id] = obj
                log.info("Registered strategy: %s (%s)", meta.id, obj.__name__)


def reload_registry() -> None:
    """Pick up strategy files created/edited/deleted at runtime (the AI Builder).

    Reloads already-imported strategy modules whose source still exists, forgets
    ones whose file is gone (deleted), then clears + re-scans. A brand-new file
    isn't in sys.modules yet, so the re-scan imports it fresh.
    """
    prefix = "services.strategies."
    for name in list(sys.modules):
        if not name.startswith(prefix) or name == "services.strategies.base":
            continue
        mod = sys.modules.get(name)
        src = getattr(mod, "__file__", None)
        if src and not os.path.exists(src):
            sys.modules.pop(name, None)   # file moved/deleted → forget it
            continue
        try:
            importlib.reload(mod)
        except Exception as e:
            log.exception("reload failed for %s: %s", name, e)
            sys.modules.pop(name, None)
    _REGISTRY.clear()
    _scan()


def list_strategies() -> list[dict]:
    _scan()
    overrides = _load_overrides()
    out = []
    for cls in _REGISTRY.values():
        d = cls.META.to_dict()
        # Sidecar archive flag (set by the AI Builder) is authoritative when
        # present, so archive/un-archive is a reversible toggle; otherwise fall
        # back to the strategy's source-declared default.
        ov = overrides.get(d["id"]) or {}
        if "archived" in ov:
            d["archived"] = bool(ov["archived"])
        d["symbol_defaults"] = dict(getattr(cls, "SYMBOL_DEFAULTS", {}) or {})
        d["timeframe_defaults"] = dict(getattr(cls, "TIMEFRAME_DEFAULTS", {}) or {})
        d["presets"] = dict(getattr(cls, "PRESETS", {}) or {})
        # Per-symbol tradeable window (e.g. Lunar on ES → 2018-01-01..2026-04-30).
        # The engine floors to this when no explicit dates are passed; the UI uses
        # it to pre-fill and bound the date picker so a default run matches.
        d["symbol_backtest_start"] = dict(getattr(cls, "SYMBOL_BACKTEST_START", {}) or {})
        d["symbol_backtest_end"] = dict(getattr(cls, "SYMBOL_BACKTEST_END", {}) or {})
        out.append(d)
    return out


def get_strategy_class(strategy_id: str) -> Type[Strategy]:
    _scan()
    cls = _REGISTRY.get(strategy_id)
    if cls is None:
        raise KeyError(f"unknown strategy: {strategy_id}")
    return cls
