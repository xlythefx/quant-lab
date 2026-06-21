"""
Server-side strategy presets — user-created named param sets.

Persisted to data/presets.json (a plain JSON file, NOT a database). Unlike
live_alerts.json this holds only param numbers (no secrets), so it is committed
to git and travels via `git push` to other machines, exactly like risk_config.json.

Shape:
  {
    "<strategy_id>": { "<preset_name>": { <sparse param overrides> }, ... },
    ...
  }

These are separate from a strategy's hardcoded built-in PRESETS (shown with a ★);
those live in code. This store is the editable, user-created layer.
"""
from __future__ import annotations

import json
import logging
import os
from threading import Lock

from config import DATA_DIR
from services.atomic_io import atomic_write_json

log = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "presets.json")
_LOCK = Lock()
_cache: dict | None = None


def _coerce(raw) -> dict:
    """Normalize to {strategy_id: {preset_name: params_dict}}. Drops junk."""
    out: dict[str, dict] = {}
    if not isinstance(raw, dict):
        return out
    for sid, presets in raw.items():
        if not isinstance(sid, str) or not isinstance(presets, dict):
            continue
        clean: dict[str, dict] = {}
        for name, params in presets.items():
            name = str(name).strip()
            if not name or not isinstance(params, dict):
                continue
            clean[name] = dict(params)
        if clean:
            out[sid] = clean
    return out


def load() -> dict:
    global _cache
    with _LOCK:
        if _cache is not None:
            return {s: dict(p) for s, p in _cache.items()}
        if os.path.exists(_PATH):
            try:
                with open(_PATH, "r") as f:
                    _cache = _coerce(json.load(f))
                    return {s: dict(p) for s, p in _cache.items()}
            except Exception as e:
                log.warning("could not read %s: %s — using empty presets", _PATH, e)
        _cache = {}
        return {}


def get_for(strategy_id: str) -> dict:
    """Return {preset_name: params} for one strategy (empty if none)."""
    return dict(load().get((strategy_id or "").strip(), {}))


def save_for(strategy_id: str, presets: dict) -> dict:
    """Replace the full preset map for one strategy. Returns the saved map."""
    global _cache
    sid = (strategy_id or "").strip()
    if not sid:
        return {}
    with _LOCK:
        if _cache is None:
            # populate from disk so other strategies' presets aren't lost
            _cache = _coerce(_read_disk())
        # coerce just this strategy's submap
        merged = dict(_cache)
        clean = _coerce({sid: presets or {}}).get(sid, {})
        if clean:
            merged[sid] = clean
        else:
            merged.pop(sid, None)
        _cache = merged
        _write_disk(_cache)
        log.info("presets saved for %s: %d preset(s)", sid, len(clean))
        return dict(clean)


def _read_disk() -> dict:
    if os.path.exists(_PATH):
        try:
            with open(_PATH, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _write_disk(data: dict) -> None:
    atomic_write_json(_PATH, data)
