"""
Persistence for the Overnight Run — a plain JSON file at data/overnight_runs.json.

Mirrors the presets_config.py store pattern (module _PATH/_LOCK/_cache + atomic
writes). Unlike presets.json this holds machine-specific run output (per-asset best
params, plateau summaries), so it is GITIGNORED like data/live_terminal.db.

Shape:
  {
    "current": <full run result | null>,   # updated per-asset (crash-resilient checkpoint)
    "history": [ <trimmed run summary>, ... ]   # newest first, capped
  }

`current` is the live/last full result the UI + verdict PDF read. `history` is a
lightweight list for a "past runs" view. A backend restart cannot resume an
in-flight batch, but `current` holds the last checkpoint (finished assets), so a
partial verdict is still available.
"""
from __future__ import annotations

import json
import logging
import os
from threading import Lock

from config import DATA_DIR
from services.atomic_io import atomic_write_json

log = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "overnight_runs.json")
_LOCK = Lock()
_cache: dict | None = None

HISTORY_CAP = 20


def _coerce(raw) -> dict:
    if not isinstance(raw, dict):
        return {"current": None, "history": []}
    current = raw.get("current")
    if not isinstance(current, dict):
        current = None
    history = raw.get("history")
    if not isinstance(history, list):
        history = []
    return {"current": current, "history": [h for h in history if isinstance(h, dict)]}


def _read_disk() -> dict:
    if os.path.exists(_PATH):
        try:
            with open(_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            log.warning("could not read %s: %s — using empty store", _PATH, e)
    return {}


def load() -> dict:
    """Return {current, history} (from the in-memory cache after first read)."""
    global _cache
    with _LOCK:
        if _cache is None:
            _cache = _coerce(_read_disk())
        return {"current": _cache["current"], "history": list(_cache["history"])}


def get_last() -> dict | None:
    """The last full run result (the checkpointed `current`), for /last_result."""
    return load()["current"]


def get_history() -> list:
    return load()["history"]


def save_current(result: dict) -> None:
    """Checkpoint the (possibly partial) run result. Called after each asset and
    on completion. Atomic write so a crash mid-write can't corrupt the file."""
    global _cache
    with _LOCK:
        if _cache is None:
            _cache = _coerce(_read_disk())
        _cache["current"] = result
        atomic_write_json(_PATH, _cache)


def _summarize(result: dict) -> dict:
    """A lightweight history row (no per-combo rows, no plateau cells)."""
    per_asset = result.get("per_asset") or []
    return {
        "job_id": result.get("job_id"),
        "kind": result.get("kind"),
        "strategy_id": result.get("strategy_id"),
        "timeframe": result.get("timeframe"),
        "mode": result.get("mode"),
        "metric": result.get("metric"),
        "started_at": result.get("started_at"),
        "finished_at": result.get("finished_at"),
        "elapsed_seconds": result.get("elapsed_seconds"),
        "n_assets": len(per_asset),
        "n_skipped": len(result.get("skipped") or []),
        "assets": [
            {"symbol": a.get("symbol"),
             "best_metric_value": (a.get("best") or {}).get("metric_value")}
            for a in per_asset
        ],
    }


def commit_to_history(result: dict, cap: int = HISTORY_CAP) -> None:
    """Prepend a summary of a finished run to history (and keep it as `current`)."""
    global _cache
    with _LOCK:
        if _cache is None:
            _cache = _coerce(_read_disk())
        _cache["current"] = result
        _cache["history"] = [_summarize(result)] + _cache["history"][: max(0, cap - 1)]
        atomic_write_json(_PATH, _cache)
