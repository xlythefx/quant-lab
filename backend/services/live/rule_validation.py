"""
Server-side checks for a live deployment (alert rule) before it may run.

validate_rule(rule) -> list of plain-language problems ([] = OK). Used by
POST/PATCH /api/live/deployments, PUT /api/live-alerts, and by the daemon
itself before it starts a runner — so a bad rule is refused with a clear
reason instead of failing silently later.
"""
from __future__ import annotations

import dis
import math
import re

from services.live.live_symbols import is_live_eligible
from services.strategies.base import ParamType, Strategy
from services.strategy_registry import get_strategy_class, is_archived

# Timeframes the live terminal offers (all are native Binance kline intervals).
LIVE_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]

_HHMM = re.compile(r"^\d{1,2}:\d{2}$")


def implements_on_candle(cls) -> bool:
    """False for the abstract base or a placeholder body (`return None` /
    `pass` / `...` / `raise NotImplementedError`) — those can never signal."""
    fn = getattr(cls, "on_candle", None)
    code = getattr(fn, "__code__", None)
    if fn is None or fn is Strategy.on_candle or code is None:
        return False
    ops = [(i.opname, i.argval) for i in dis.get_instructions(code)
           if i.opname not in ("RESUME", "NOP", "CACHE")]
    if ops in ([("LOAD_CONST", None), ("RETURN_VALUE", None)], [("RETURN_CONST", None)]):
        return False   # body only returns None
    if set(code.co_names) <= {"NotImplementedError"} and any(op == "RAISE_VARARGS" for op, _ in ops):
        return False   # body only raises NotImplementedError
    return True


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _check_range(name: str, v, spec, problems: list[str]) -> None:
    if spec.min is not None and v < spec.min:
        problems.append(f"param {name}={v} is below the minimum {spec.min:g}")
    if spec.max is not None and v > spec.max:
        problems.append(f"param {name}={v} is above the maximum {spec.max:g}")


def validate_params(cls, params) -> list[str]:
    """Check rule params against the strategy's PARAM_SCHEMA (types, min/max,
    select options, nested keys). Unknown keys are rejected — a typo would
    otherwise be silently ignored and the strategy would run on its default."""
    if params is None:
        return []
    if not isinstance(params, dict):
        return ["params must be an object of {name: value}"]
    specs = {s.name: s for s in cls.PARAM_SCHEMA}
    problems: list[str] = []
    for name, v in params.items():
        spec = specs.get(name)
        if spec is None:
            problems.append(f"unknown param '{name}' (not in this strategy's settings)")
            continue
        if v is None:
            continue   # None = use the default
        t = spec.type
        if t == ParamType.INT:
            if not _is_number(v) or float(v) != int(v):
                problems.append(f"param {name} must be a whole number (got {v!r})")
            else:
                _check_range(name, v, spec, problems)
        elif t == ParamType.FLOAT:
            if not _is_number(v):
                problems.append(f"param {name} must be a number (got {v!r})")
            else:
                _check_range(name, v, spec, problems)
        elif t == ParamType.BOOL:
            if not isinstance(v, bool):
                problems.append(f"param {name} must be true/false (got {v!r})")
        elif t == ParamType.SELECT:
            allowed = [o.get("value") for o in (spec.options or [])]
            # The form sends select values as strings, so compare as text.
            if str(v) not in {str(a) for a in allowed}:
                problems.append(f"param {name}={v!r} is not one of {allowed}")
        elif t in (ParamType.SIDES, ParamType.REGIMES):
            if not isinstance(v, dict):
                problems.append(f"param {name} must be an object of on/off flags")
                continue
            for k, on in v.items():
                if k not in (spec.default or {}):
                    problems.append(f"param {name}: unknown key '{k}'")
                elif not isinstance(on, bool):
                    problems.append(f"param {name}.{k} must be true/false")
        elif t == ParamType.SESSIONS:
            if not isinstance(v, dict):
                problems.append(f"param {name} must be an object of sessions")
                continue
            for sess, cfg in v.items():
                if sess not in (spec.default or {}):
                    problems.append(f"param {name}: unknown session '{sess}'")
                    continue
                if not isinstance(cfg, dict):
                    problems.append(f"param {name}.{sess} must be an object")
                    continue
                if "enabled" in cfg and not isinstance(cfg["enabled"], bool):
                    problems.append(f"param {name}.{sess}.enabled must be true/false")
                for edge in ("start", "end"):
                    if cfg.get(edge) and not _HHMM.match(str(cfg[edge])):
                        problems.append(f"param {name}.{sess}.{edge} must be HH:MM (got {cfg[edge]!r})")
    return problems


def validate_rule(rule: dict) -> list[str]:
    """All problems that should stop this rule from running live."""
    problems: list[str] = []
    sid = str(rule.get("strategy_id") or "").strip()
    cls = None
    try:
        cls = get_strategy_class(sid)
    except KeyError:
        problems.append(f"strategy '{sid}' does not exist")
    if cls is not None:
        if is_archived(sid):
            problems.append(f"strategy '{sid}' is archived — un-archive it before deploying")
        if not implements_on_candle(cls):
            problems.append(f"strategy '{sid}' has no live on_candle() implementation")

    tf = str(rule.get("timeframe") or "").strip()
    if tf not in LIVE_TIMEFRAMES:
        problems.append(f"timeframe '{tf}' is not supported live (use one of {', '.join(LIVE_TIMEFRAMES)})")

    ok, reason = is_live_eligible(str(rule.get("symbol") or ""), tf or None)
    if not ok:
        problems.append(reason)

    if cls is not None:
        problems += validate_params(cls, rule.get("params"))
    return problems
