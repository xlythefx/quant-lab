"""
Server-side strategy presets — user-created named param sets.

Persisted to data/presets.json (a plain JSON file, NOT a database). Unlike
live_alerts.json this holds only param numbers (no secrets), so it is committed
to git and travels via `git push` to other machines, exactly like risk_config.json.

Shape on disk:
  {
    "<strategy_id>": {
      "<preset_name>": {
        "params": { <full param dict> },
        "meta":   { "symbol": "BTCUSDT", "timeframe": "15m", "source": "walkforward",
                    "created": 1757203200, "oos_return_pct": 12.34, "note": "..." }
      },
      ...
    },
    ...
  }

`meta` is PROVENANCE, not settings: it records where a preset came from so the
UI can say "tuned on BTCUSDT 15m" and warn when you load it onto a different
instrument. A param set tuned on BTC 15m is not evidence about ES 5m, and
nothing else in the app remembers that link. Every field is optional.

LEGACY SHAPE: presets written before provenance existed are a bare param dict
({"<preset_name>": {"vwma_length": 30, ...}}). `_coerce` detects and lifts those
into {"params": …, "meta": {}} on read, so old files keep working untouched.

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

# Provenance keys we persist. Anything else in a submitted meta is dropped so a
# stray UI field can't quietly become part of the on-disk contract.
_META_KEYS = ("symbol", "timeframe", "source", "created", "oos_return_pct", "note")


def _coerce_entry(value) -> dict | None:
    """Normalize one preset to {"params": {...}, "meta": {...}}, or None if junk.

    Accepts both the current wrapper shape and the legacy bare-params shape.
    """
    if not isinstance(value, dict):
        return None
    # Wrapper shape: {"params": {...}, "meta": {...}}. Require `params` to be a
    # dict AND no unexpected top-level keys, so a legacy preset that happened to
    # contain a param literally named "params" is still read as legacy.
    if isinstance(value.get("params"), dict) and set(value.keys()) <= {"params", "meta"}:
        params = dict(value["params"])
        raw_meta = value.get("meta")
        meta = {k: raw_meta[k] for k in _META_KEYS if isinstance(raw_meta, dict) and k in raw_meta}
    else:
        params = dict(value)   # legacy: the whole dict is the params
        meta = {}
    if not params:
        return None
    return {"params": params, "meta": meta}


def _coerce(raw) -> dict:
    """Normalize to {strategy_id: {preset_name: {"params":…, "meta":…}}}. Drops junk."""
    out: dict[str, dict] = {}
    if not isinstance(raw, dict):
        return out
    for sid, presets in raw.items():
        if not isinstance(sid, str) or not isinstance(presets, dict):
            continue
        clean: dict[str, dict] = {}
        for name, value in presets.items():
            name = str(name).strip()
            entry = _coerce_entry(value)
            if not name or entry is None:
                continue
            clean[name] = entry
        if clean:
            out[sid] = clean
    return out


def _copy(store: dict) -> dict:
    return {s: {n: {"params": dict(e["params"]), "meta": dict(e["meta"])}
                for n, e in p.items()}
            for s, p in store.items()}


def load() -> dict:
    global _cache
    with _LOCK:
        if _cache is not None:
            return _copy(_cache)
        if os.path.exists(_PATH):
            try:
                with open(_PATH, "r") as f:
                    _cache = _coerce(json.load(f))
                    return _copy(_cache)
            except Exception as e:
                log.warning("could not read %s: %s — using empty presets", _PATH, e)
        _cache = {}
        return {}


def get_for(strategy_id: str) -> dict:
    """Return {preset_name: {"params":…, "meta":…}} for one strategy (empty if none)."""
    return load().get((strategy_id or "").strip(), {})


def save_for(strategy_id: str, presets: dict, meta: dict | None = None) -> dict:
    """Replace the full preset map for one strategy. Returns the saved map.

    `presets` is {name: params} (or the wrapper shape — both are accepted).
    `meta` is {name: provenance}. Passing meta=None PRESERVES whatever provenance
    is already stored for names that survive the replace, so an older caller that
    only knows about params (e.g. Market Lab's read-modify-write) cannot wipe it.
    """
    global _cache
    sid = (strategy_id or "").strip()
    if not sid:
        return {}
    with _LOCK:
        if _cache is None:
            # populate from disk so other strategies' presets aren't lost
            _cache = _coerce(_read_disk())
        prev = _cache.get(sid, {})

        clean = _coerce({sid: presets or {}}).get(sid, {})
        for name, entry in clean.items():
            if isinstance(meta, dict) and name in meta:
                raw = meta[name] if isinstance(meta[name], dict) else {}
                entry["meta"] = {k: raw[k] for k in _META_KEYS if k in raw}
            elif not entry["meta"]:
                # No meta supplied and none inline — inherit the stored provenance
                # so a params-only write doesn't strip it.
                entry["meta"] = dict(prev.get(name, {}).get("meta", {}))

        merged = dict(_cache)
        if clean:
            merged[sid] = clean
        else:
            merged.pop(sid, None)
        _cache = merged
        _write_disk(_cache)
        log.info("presets saved for %s: %d preset(s)", sid, len(clean))
        return {n: {"params": dict(e["params"]), "meta": dict(e["meta"])} for n, e in clean.items()}


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
