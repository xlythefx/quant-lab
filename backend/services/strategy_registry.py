"""
Auto-discover Strategy subclasses from the services.strategies package.

Drop a new .py into services/strategies/ that defines a Strategy subclass
with a META and PARAM_SCHEMA, restart, and it shows up in /api/strategies
without further wiring.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from typing import Type

from services.strategies import base as _base
from services.strategies.base import Strategy, StrategyMeta

log = logging.getLogger(__name__)

_REGISTRY: dict[str, Type[Strategy]] = {}


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


def list_strategies() -> list[dict]:
    _scan()
    out = []
    for cls in _REGISTRY.values():
        d = cls.META.to_dict()
        d["symbol_defaults"] = dict(getattr(cls, "SYMBOL_DEFAULTS", {}) or {})
        d["timeframe_defaults"] = dict(getattr(cls, "TIMEFRAME_DEFAULTS", {}) or {})
        d["presets"] = dict(getattr(cls, "PRESETS", {}) or {})
        out.append(d)
    return out


def get_strategy_class(strategy_id: str) -> Type[Strategy]:
    _scan()
    cls = _REGISTRY.get(strategy_id)
    if cls is None:
        raise KeyError(f"unknown strategy: {strategy_id}")
    return cls
