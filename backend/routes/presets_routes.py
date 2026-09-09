"""
Server-side strategy preset CRUD.

GET  /api/presets?strategy_id=…
       → {"presets": {name: params}, "meta": {name: provenance}}
PUT  /api/presets  {strategy_id, presets, meta?}
       → {"presets": {name: params}, "meta": {name: provenance}}   (full replace)

The response keeps `presets` in the flat {name: params} shape older callers
already expect, and carries provenance in a PARALLEL `meta` map rather than
nesting it — so Market Lab and the walk-forward base-params picker keep working
without touching them. Omitting `meta` on a PUT preserves the stored provenance
(see presets_config.save_for); sending it replaces it.

Rename and delete both go through the same full-replace PUT — the client sends
the map it wants to end up with.
"""
from flask import Blueprint, jsonify, request

from services import presets_config

presets_bp = Blueprint("presets", __name__, url_prefix="/api")


def _split(store: dict) -> tuple[dict, dict]:
    """{name: {params, meta}} → ({name: params}, {name: meta})."""
    params = {n: e.get("params", {}) for n, e in store.items()}
    meta = {n: e.get("meta", {}) for n, e in store.items() if e.get("meta")}
    return params, meta


@presets_bp.get("/presets")
def get_presets():
    strategy_id = (request.args.get("strategy_id") or "").strip()
    if not strategy_id:
        return jsonify({"error": "strategy_id required"}), 400
    params, meta = _split(presets_config.get_for(strategy_id))
    return jsonify({"presets": params, "meta": meta})


@presets_bp.put("/presets")
def put_presets():
    body = request.get_json(silent=True) or {}
    strategy_id = (body.get("strategy_id") or "").strip()
    presets = body.get("presets") if isinstance(body, dict) else None
    # Absent `meta` means "don't touch provenance"; an explicit {} means "clear it".
    meta = body.get("meta") if isinstance(body.get("meta"), dict) else None
    if not strategy_id:
        return jsonify({"error": "strategy_id required"}), 400
    saved = presets_config.save_for(strategy_id, presets or {}, meta)
    params, meta_out = _split(saved)
    return jsonify({"presets": params, "meta": meta_out})
