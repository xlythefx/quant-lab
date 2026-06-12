"""
Skills endpoints — the catalog of runnable AI "skills" and the research output they
produce.

Endpoints (prefix /api/skills):
  GET  /                      -> {skills: [...]}            list the catalog
  POST /run                   body {skill_id, params}       run a generator skill
  GET  /research              -> {items: [...]}             list generated theories
  GET  /research/<name>       -> {name, markdown}           read one theory

Generation runs through services.quant_researcher, which reuses the shared Anthropic
client — so a missing API key surfaces the same AIDisabledError (-> 503) as AI Insights.
"""
import logging

from flask import Blueprint, jsonify, request

from services import skills_catalog, quant_researcher
from services import ai_insights  # for AIDisabledError

log = logging.getLogger(__name__)

skills_bp = Blueprint("skills", __name__, url_prefix="/api/skills")

# Maps a runnable skill id to its generator function.
_RUNNERS = {
    "quant-researcher": quant_researcher.generate,
}


def _handle(fn):
    try:
        return jsonify(fn())
    except ai_insights.AIDisabledError as e:
        return jsonify({"error": str(e)}), 503
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("skills call failed")
        return jsonify({"error": str(e)}), 500


@skills_bp.get("")
def list_skills():
    return _handle(lambda: {"skills": skills_catalog.list_skills()})


@skills_bp.post("/run")
def run_skill():
    body = request.get_json(silent=True) or {}
    skill_id = (body.get("skill_id") or "").strip()
    params = body.get("params") or {}
    if not skill_id:
        return jsonify({"error": "skill_id is required"}), 400
    runner = _RUNNERS.get(skill_id)
    if runner is None:
        # Distinguish "exists but not runnable" from "unknown" for a clearer message.
        skill = skills_catalog.get_skill(skill_id)
        if skill is None:
            return jsonify({"error": f"unknown skill: {skill_id}"}), 404
        return jsonify({"error": f"skill '{skill_id}' is not runnable"}), 400
    if not isinstance(params, dict):
        return jsonify({"error": "params must be an object"}), 400
    return _handle(lambda: runner(params))


@skills_bp.get("/research")
def list_research():
    return _handle(lambda: {"items": skills_catalog.list_research()})


@skills_bp.get("/research/<path:name>")
def read_research(name):
    return _handle(lambda: {"name": name, "markdown": skills_catalog.read_research(name)})
