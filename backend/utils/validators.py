"""
Lightweight request validators.

Centralized so REST routes and Socket.IO handlers share one source of truth.
"""
import re
from config import TIMEFRAMES, MODES, DEFAULT_MODE


class ValidationError(ValueError):
    pass


_SYMBOL_RE = re.compile(r"^[A-Z0-9]{4,16}$")


def validate_symbol(symbol: str) -> str:
    """Symbols are user-driven now (downloads page). Accept any pair-shaped
    upper-case ticker like BTCUSDT, FETUSDT, SOLUSDC, 1000PEPEUSDT."""
    if not symbol:
        raise ValidationError("symbol is required")
    s = symbol.upper().strip()
    if not _SYMBOL_RE.match(s):
        raise ValidationError(f"symbol '{symbol}' is malformed (expected e.g. BTCUSDT)")
    return s


def validate_timeframe(tf: str) -> str:
    if not tf:
        raise ValidationError("timeframe is required")
    if tf not in TIMEFRAMES:
        raise ValidationError(
            f"timeframe '{tf}' not supported. Allowed: {TIMEFRAMES}"
        )
    return tf


def validate_mode(mode: str | None) -> str:
    if mode is None or mode == "":
        return DEFAULT_MODE
    if mode not in MODES:
        raise ValidationError(f"mode '{mode}' not supported. Allowed: {MODES}")
    return mode


def validate_limit(limit, default=500, maximum=200000) -> int:
    try:
        n = int(limit) if limit is not None else default
    except (TypeError, ValueError):
        raise ValidationError("limit must be an integer")
    if n <= 0 or n > maximum:
        raise ValidationError(f"limit must be between 1 and {maximum}")
    return n
