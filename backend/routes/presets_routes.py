"""
Server-side strategy preset CRUD.

GET  /api/presets?strategy_id=…   → {"presets": {name: params}}
PUT  /api/presets  {strategy_id, presets} → {"presets": {name: params}}  (full replace)
"""
from flask import Blueprint, jsonify, request

from services import presets_config

presets_bp = Blueprint("presets", __name__, url_prefix="/api")


@presets_bp.get("/presets")
def get_presets():
    strategy_id = (request.args.get("strategy_id") or "").strip()
    if not strategy_id:
        return jsonify({"error": "strategy_id required"}), 400
    return jsonify({"presets": presets_config.get_for(strategy_id)})


@presets_bp.put("/presets")
def put_presets():
    body = request.get_json(silent=True) or {}
    strategy_id = (body.get("strategy_id") or "").strip()
    presets = body.get("presets") if isinstance(body, dict) else None
    if not strategy_id:
        return jsonify({"error": "strategy_id required"}), 400
    saved = presets_config.save_for(strategy_id, presets or {})
    return jsonify({"presets": saved})
