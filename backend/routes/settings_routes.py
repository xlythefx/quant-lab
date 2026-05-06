"""
Global risk-management config endpoints.
"""
from flask import Blueprint, jsonify, request

from services import risk_config

settings_bp = Blueprint("settings", __name__, url_prefix="/api")


@settings_bp.get("/risk-config")
def get_risk_config():
    return jsonify(risk_config.get())


@settings_bp.put("/risk-config")
def put_risk_config():
    body = request.get_json(silent=True) or {}
    return jsonify(risk_config.update(body))
