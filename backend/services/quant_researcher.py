"""
Quant Researcher skill — calls Claude to invent ONE new, testable trading theory and
writes it to docs/research/ as a markdown strategy spec.

Reuses the platform's existing Anthropic plumbing (services.ai_insights._client /
_usage_dict / AIDisabledError) so the API key handling lives in exactly one place. The
generation call uses structured output (json_schema), mirroring
ai_insights.suggest_walkforward — Claude returns a strategy-spec object, which we render
to markdown via a local template.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from config import RESEARCH_DIR, TIMEFRAMES
from services import skills_catalog
from services.ai_insights import _client, _usage_dict  # reuse the shared Anthropic client

log = logging.getLogger(__name__)

_SKILL_ID = "quant-researcher"
_MODEL = "claude-sonnet-4-6"   # stronger creativity than the haiku used for summaries; easy to swap
_MAX_TOKENS = 4000

_CATEGORIES = {"MR", "TF", "BK", "BS"}
_HORIZONS = {"ID", "MD"}
_INSTRUMENTS = {"ES", "NQ", "CL", "GC", "BTCUSDT", "FETUSDT"}

# Structured-output contract — Claude must return exactly this shape.
_SCHEMA = {
    "type": "object",
    "properties": {
        "code":      {"type": "string", "enum": ["MR", "TF", "BK", "BS"],
                      "description": "Edge family: MR/TF/BK/BS"},
        "horizon":   {"type": "string", "enum": ["ID", "MD"],
                      "description": "ID=intraday, MD=multiday"},
        "name":      {"type": "string",
                      "description": "Short PascalCase nickname, e.g. VolFade or MomoBreak"},
        "instrument": {"type": "string", "description": "ES/NQ/CL/GC/BTCUSDT/FETUSDT"},
        "timeframe": {"type": "string", "description": "Bar size, e.g. 15m, 1h, 1d"},
        "title":     {"type": "string", "description": "Human-readable strategy title"},
        "hypothesis": {"type": "string",
                       "description": "The falsifiable claim + why the edge plausibly exists"},
        "market_inefficiency": {"type": "string",
                                "description": "The specific behavior/inefficiency exploited"},
        "entry_logic": {"type": "string", "description": "Exact entry rules"},
        "exit_logic":  {"type": "string", "description": "Exact exit/target/time-stop rules"},
        "risk_management": {"type": "string", "description": "Stop, sizing, max exposure"},
        "indicators": {"type": "array", "items": {"type": "string"},
                       "description": "Indicators/features used"},
        "parameters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name":    {"type": "string"},
                    "default": {"type": "string"},
                    "note":    {"type": "string"},
                },
                "required": ["name", "default", "note"],
                "additionalProperties": False,
            },
            "description": "Tunable parameters with defaults for the chosen instrument/timeframe",
        },
        "pseudocode": {"type": "string",
                       "description": "EasyLanguage-flavored sketch (inputs, indicators, entry/exit)"},
        "caveats":    {"type": "string",
                       "description": "Most likely failure mode / overfitting risk / honest caveats"},
    },
    "required": [
        "code", "horizon", "name", "instrument", "timeframe", "title", "hypothesis",
        "market_inefficiency", "entry_logic", "exit_logic", "risk_management",
        "indicators", "parameters", "pseudocode", "caveats",
    ],
    "additionalProperties": False,
}


def _norm(value: Any, allowed: set[str]) -> str:
    """Normalize a steering field to an allowed token (upper-cased) or 'any'."""
    if not value:
        return "any"
    v = str(value).strip()
    if v.lower() in ("any", "", "auto"):
        return "any"
    up = v.upper()
    return up if up in allowed else v  # pass odd values through; Claude will sanity-check


def _build_request(params: dict) -> str:
    category = _norm(params.get("category"), _CATEGORIES)
    horizon = _norm(params.get("horizon"), _HORIZONS)
    instrument = _norm(params.get("instrument"), _INSTRUMENTS)
    timeframe = (params.get("timeframe") or "any").strip() or "any"
    notes = (params.get("notes") or "").strip()

    lines = [
        "Invent one new trading theory with these constraints "
        "(\"any\" means you choose and justify it):",
        f"- category: {category}",
        f"- horizon: {horizon}",
        f"- instrument: {instrument}",
        f"- timeframe: {timeframe}",
    ]
    if notes:
        lines.append(f"- researcher notes / seed idea: {notes}")
    lines.append("\nReturn ONLY the JSON object matching the provided schema.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Markdown rendering + file naming
# ---------------------------------------------------------------------------

def _sanitize_component(s: str, *, fallback: str) -> str:
    """Filename-safe PascalCase-ish token: alnum only."""
    cleaned = re.sub(r"[^A-Za-z0-9]+", "", str(s or ""))
    return cleaned or fallback


def _next_index(prefix: str) -> int:
    """Next free 3-digit index for files starting with `prefix` in RESEARCH_DIR."""
    if not os.path.isdir(RESEARCH_DIR):
        return 1
    hi = 0
    pat = re.compile(re.escape(prefix) + r"(\d{3})\.md$", re.IGNORECASE)
    for fname in os.listdir(RESEARCH_DIR):
        m = pat.match(fname)
        if m:
            hi = max(hi, int(m.group(1)))
    return hi + 1


def _render_markdown(spec: dict) -> str:
    indicators = spec.get("indicators") or []
    params = spec.get("parameters") or []
    ind_md = "\n".join(f"- {i}" for i in indicators) if indicators else "_none specified_"

    if params:
        rows = "\n".join(
            f"| {p.get('name','')} | {p.get('default','')} | {p.get('note','')} |"
            for p in params
        )
        params_md = "| Name | Default | Note |\n|---|---|---|\n" + rows
    else:
        params_md = "_none specified_"

    return f"""# {spec.get('title', 'Untitled strategy')}

> **{spec.get('code','?')}-{spec.get('horizon','?')}** · {spec.get('instrument','?')} · {spec.get('timeframe','?')} · _generated by the Quant Researcher skill_

## Hypothesis

{spec.get('hypothesis', '')}

## Market inefficiency exploited

{spec.get('market_inefficiency', '')}

## Entry logic

{spec.get('entry_logic', '')}

## Exit logic

{spec.get('exit_logic', '')}

## Risk management

{spec.get('risk_management', '')}

## Indicators

{ind_md}

## Parameters

{params_md}

## Pseudocode (EasyLanguage-flavored)

```
{spec.get('pseudocode', '')}
```

## Caveats & failure modes

{spec.get('caveats', '')}

---
_Machine-generated research lead — not backtested, not validated. See [README](README.md)._
"""


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def generate(params: dict) -> dict:
    """Generate a theory and persist it.

    params: {category, horizon, instrument, timeframe, notes} — all optional / "any".
    Returns {name, path, title, markdown, spec, model, usage}.
    Raises AIDisabledError (from ai_insights) when no API key is configured.
    """
    params = params or {}
    skill = skills_catalog.get_skill(_SKILL_ID)
    if not skill:
        raise FileNotFoundError(f"skill '{_SKILL_ID}' definition not found")
    system_prompt = skill.get("prompt") or ""

    client = _client()  # raises AIDisabledError if ANTHROPIC_API_KEY is unset
    msg = client.messages.create(
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
        system=[{
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"},
        }],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": _SCHEMA,
            }
        },
        messages=[{"role": "user", "content": _build_request(params)}],
    )

    text = next((b.text for b in msg.content if b.type == "text"), "{}")
    try:
        spec = json.loads(text)
    except json.JSONDecodeError:
        log.warning("Quant Researcher returned non-JSON: %r", text[:200])
        raise ValueError("model did not return a valid strategy spec")

    markdown = _render_markdown(spec)

    code = _sanitize_component(spec.get("code"), fallback="XX")[:4].upper()
    horizon = _sanitize_component(spec.get("horizon"), fallback="XX")[:2].upper()
    name = _sanitize_component(spec.get("name"), fallback="Strategy")[:32]
    sym = _sanitize_component(spec.get("instrument"), fallback="NA")[:8].upper()
    prefix = f"{code}-{horizon}-{name}-{sym}-"
    idx = _next_index(prefix)
    fname = f"{prefix}{idx:03d}.md"

    os.makedirs(RESEARCH_DIR, exist_ok=True)
    path = os.path.join(RESEARCH_DIR, fname)
    with open(path, "w", encoding="utf-8") as f:
        f.write(markdown)
    log.info("Quant Researcher wrote %s", fname)

    return {
        "name": fname,
        "path": path,
        "title": spec.get("title", fname[:-3]),
        "markdown": markdown,
        "spec": spec,
        "model": msg.model,
        "usage": _usage_dict(msg),
    }
