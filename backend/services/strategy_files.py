"""
Safe file operations for the AI Strategy Builder.

Every disk write the builder makes funnels through here so the guardrails live
in one place:
  - writes only ever land inside services/strategies/,
  - ids must be strict slugs,
  - new code is AST-parsed before it touches disk,
  - after writing we re-scan the registry and run a tiny "smoke" backtest
    (one vectorized() call on a small recent slice) to prove the strategy
    actually imports and runs,
  - edits/deletes are reversible: the previous file is moved to _trash/ first
    and restored if verification fails.

These are called from services/strategy_builder.py only after the user has
approved the action in the chat.
"""
from __future__ import annotations

import ast
import inspect
import logging
import os
import re
import shutil
from datetime import datetime

from services import market_data, strategy_registry
from services.strategies.base import Strategy

log = logging.getLogger(__name__)

_STRATEGIES_DIR = os.path.dirname(os.path.abspath(
    strategy_registry._base.__file__))  # services/strategies/
_TRASH_DIR = os.path.join(_STRATEGIES_DIR, "_trash")

_ID_RE = re.compile(r"^[a-z][a-z0-9_]{2,40}$")
_CLASS_RE = re.compile(r"^[A-Z][A-Za-z0-9_]{2,60}$")

# Smoke test runs against whatever the user is looking at; default to a small,
# always-cached crypto slice.
_DEFAULT_SMOKE = ("BTCUSDT", "15m")


class StrategyFileError(RuntimeError):
    """Surfaced back into the chat so Claude can fix and retry."""


def _validate_id(strategy_id: str) -> str:
    sid = (strategy_id or "").strip().lower()
    if not _ID_RE.match(sid):
        raise StrategyFileError(
            f"invalid strategy id '{strategy_id}': use lowercase letters, digits "
            f"and underscores, 3-41 chars, starting with a letter."
        )
    return sid


def _path_for(strategy_id: str) -> str:
    return os.path.join(_STRATEGIES_DIR, f"{strategy_id}.py")


def _ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _trash(path: str, strategy_id: str) -> str:
    """Move a file into _trash/ with a timestamp; return the backup path."""
    os.makedirs(_TRASH_DIR, exist_ok=True)
    dest = os.path.join(_TRASH_DIR, f"{strategy_id}.{_ts()}.py")
    shutil.move(path, dest)
    return dest


def read_strategy_source(strategy_id: str) -> str:
    """Return the source text of a registered strategy (for tune/edit)."""
    cls = strategy_registry.get_strategy_class(strategy_id)  # raises KeyError if unknown
    src_path = inspect.getfile(cls)
    with open(src_path, "r", encoding="utf-8") as f:
        return f.read()


def _smoke_test(strategy_id: str, symbol: str, timeframe: str) -> None:
    """Prove the freshly-(re)loaded strategy imports + runs and emits the
    required columns. Raises StrategyFileError on any problem."""
    try:
        cls = strategy_registry.get_strategy_class(strategy_id)
    except KeyError:
        raise StrategyFileError(
            f"the file was written but no strategy registered with id '{strategy_id}'. "
            f"Make sure the class subclasses Strategy and its META.id == '{strategy_id}'."
        )
    # The registered class must come from OUR file (guards against a META.id that
    # collides with an existing strategy — the scan would keep the original).
    if os.path.abspath(inspect.getfile(cls)) != os.path.abspath(_path_for(strategy_id)):
        raise StrategyFileError(
            f"id '{strategy_id}' is already used by another strategy. "
            f"Pick a different id (the META.id must match the file name)."
        )
    if not (isinstance(cls, type) and issubclass(cls, Strategy)):
        raise StrategyFileError("the class must subclass Strategy.")
    if not callable(getattr(cls, "vectorized", None)):
        raise StrategyFileError("the strategy must implement vectorized(self, df).")

    try:
        df = market_data.load_parquet(symbol, timeframe,
                                      market_data.broker_for(symbol, timeframe))
    except Exception:
        # No data for the chosen symbol/tf — fall back to the always-present slice.
        symbol, timeframe = _DEFAULT_SMOKE
        df = market_data.load_parquet(symbol, timeframe,
                                      market_data.broker_for(symbol, timeframe))

    small = df.tail(800).reset_index(drop=True)
    try:
        out = cls({}).vectorized(small.copy())
    except Exception as e:
        raise StrategyFileError(f"vectorized() raised on a {symbol} {timeframe} "
                                f"sample: {type(e).__name__}: {e}")

    required = ["entry_long", "entry_short", "exit_long", "exit_short", "stop_price"]
    missing = [c for c in required if c not in getattr(out, "columns", [])]
    if missing:
        raise StrategyFileError(
            "vectorized() must return the dataframe with these columns: "
            + ", ".join(required) + f". Missing: {', '.join(missing)}."
        )
    if len(out) != len(small):
        raise StrategyFileError("vectorized() must return one row per input bar "
                                "(don't drop/reindex rows).")


def _check_syntax(code: str) -> None:
    try:
        ast.parse(code)
    except SyntaxError as e:
        raise StrategyFileError(f"the code has a syntax error on line {e.lineno}: {e.msg}")


def create_strategy(strategy_id: str, code: str,
                    symbol: str = "BTCUSDT", timeframe: str = "15m") -> dict:
    """Write a brand-new strategy file and verify it. Returns {ok, message}.
    Raises StrategyFileError (with a fixable message) on any failure; never
    leaves a broken file behind."""
    sid = _validate_id(strategy_id)
    path = _path_for(sid)
    if os.path.exists(path):
        raise StrategyFileError(f"a strategy file '{sid}.py' already exists — "
                                f"use edit instead, or choose a new id.")
    if sid in {d["id"] for d in strategy_registry.list_strategies()}:
        raise StrategyFileError(f"strategy id '{sid}' is already registered — choose a new id.")
    _check_syntax(code)

    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    try:
        strategy_registry.reload_registry()
        _smoke_test(sid, symbol, timeframe)
    except StrategyFileError:
        # roll back: bin the bad file and refresh the registry
        if os.path.exists(path):
            _trash(path, sid)
        strategy_registry.reload_registry()
        raise
    return {"ok": True, "strategy_id": sid,
            "message": f"Created and verified strategy '{sid}' (smoke-tested on {symbol} {timeframe})."}


def edit_strategy(strategy_id: str, code: str,
                  symbol: str = "BTCUSDT", timeframe: str = "15m") -> dict:
    """Overwrite an existing strategy file, backing up first and restoring on
    failure. Returns {ok, message}."""
    sid = _validate_id(strategy_id)
    path = _path_for(sid)
    if not os.path.exists(path):
        raise StrategyFileError(f"no strategy file '{sid}.py' to edit — create it first.")
    _check_syntax(code)

    backup = _trash(path, sid)   # moves the current file aside
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        strategy_registry.reload_registry()
        _smoke_test(sid, symbol, timeframe)
    except StrategyFileError:
        # restore the previous good version
        shutil.copyfile(backup, path)
        strategy_registry.reload_registry()
        raise
    return {"ok": True, "strategy_id": sid,
            "message": f"Updated and verified '{sid}'. Previous version backed up to _trash/."}


def delete_strategy(strategy_id: str) -> dict:
    """Move a strategy file to _trash/ (reversible) and refresh the registry."""
    sid = _validate_id(strategy_id)
    path = _path_for(sid)
    if not os.path.exists(path):
        raise StrategyFileError(f"no strategy file '{sid}.py' to delete.")
    backup = _trash(path, sid)
    strategy_registry.reload_registry()
    return {"ok": True, "strategy_id": sid,
            "message": f"Deleted '{sid}' (moved to _trash/{os.path.basename(backup)} — recoverable)."}


def archive_strategy(strategy_id: str, archived: bool = True) -> dict:
    """Toggle the archived flag via the registry sidecar (no source rewrite)."""
    sid = _validate_id(strategy_id)
    if sid not in {d["id"] for d in strategy_registry.list_strategies()}:
        raise StrategyFileError(f"unknown strategy '{sid}'.")
    strategy_registry.set_strategy_override(sid, archived=bool(archived))
    verb = "Archived" if archived else "Un-archived"
    return {"ok": True, "strategy_id": sid,
            "message": f"{verb} '{sid}'. (It now shows under the "
                       f"{'Archived' if archived else 'Available'} filter on the Strategies page.)"}
