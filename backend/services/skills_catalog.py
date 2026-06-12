"""
Skills catalog — discovers the runnable AI "skills" defined as markdown files in
`backend/skills/`, and lists/reads the research output they produce in `docs/research/`.

A skill file is markdown with a `---`-fenced frontmatter block of simple `key: value`
lines (no YAML dependency) followed by a body that doubles as the skill's system prompt:

    ---
    id: quant-researcher
    name: Quant Researcher
    icon: 🔬
    category: Research
    kind: generator        # "generator" = runnable; anything else is informational
    summary: One-line description.
    ---
    <system prompt body...>

All filesystem access is constrained to SKILLS_DIR / RESEARCH_DIR with explicit
containment checks so a crafted `skill_id` / file name can't escape those folders.
"""
from __future__ import annotations

import os
from typing import Optional

from config import SKILLS_DIR, RESEARCH_DIR

_FRONTMATTER_KEYS = ("id", "name", "icon", "category", "kind", "summary")


# ---------------------------------------------------------------------------
# Frontmatter parsing
# ---------------------------------------------------------------------------

def _parse_skill_file(text: str) -> tuple[dict, str]:
    """Split a skill markdown file into (frontmatter dict, body).

    Tolerant: if there's no `---` fence, the whole file is treated as the body
    and the frontmatter is empty.
    """
    meta: dict = {}
    body = text
    stripped = text.lstrip()
    if stripped.startswith("---"):
        # Drop everything up to the first fence, then read until the closing fence.
        rest = stripped[3:]
        end = rest.find("\n---")
        if end != -1:
            fm = rest[:end]
            body = rest[end + 4:].lstrip("\n")
            for line in fm.splitlines():
                line = line.strip()
                if not line or line.startswith("#") or ":" not in line:
                    continue
                key, _, val = line.partition(":")
                key = key.strip().lower()
                val = val.strip()
                # Strip an inline `# comment` on value lines (e.g. kind: generator # note).
                if " #" in val:
                    val = val.split(" #", 1)[0].strip()
                if key in _FRONTMATTER_KEYS:
                    meta[key] = val
    return meta, body.strip()


def _skill_record(path: str, *, include_body: bool = False) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    meta, body = _parse_skill_file(text)
    skill_id = meta.get("id") or os.path.splitext(os.path.basename(path))[0]
    rec = {
        "id": skill_id,
        "name": meta.get("name") or skill_id,
        "icon": meta.get("icon") or "🧩",
        "category": meta.get("category") or "General",
        "kind": (meta.get("kind") or "info").lower(),
        "summary": meta.get("summary") or "",
    }
    if include_body:
        rec["prompt"] = body
    return rec


# ---------------------------------------------------------------------------
# Public API — skills
# ---------------------------------------------------------------------------

def list_skills() -> list[dict]:
    """All skills (frontmatter only — system-prompt body omitted), sorted by name."""
    if not os.path.isdir(SKILLS_DIR):
        return []
    out: list[dict] = []
    for fname in sorted(os.listdir(SKILLS_DIR)):
        if not fname.lower().endswith(".md"):
            continue
        rec = _skill_record(os.path.join(SKILLS_DIR, fname))
        if rec:
            out.append(rec)
    out.sort(key=lambda r: r["name"].lower())
    return out


def get_skill(skill_id: str) -> Optional[dict]:
    """Full record for one skill, including its system-prompt `prompt` body.

    Matches on the `id:` frontmatter first, then falls back to the file stem.
    Returns None if not found. Containment-guarded against path traversal.
    """
    if not skill_id or not os.path.isdir(SKILLS_DIR):
        return None
    # Direct filename match (guarded), then scan-by-id fallback.
    safe = os.path.basename(f"{skill_id}.md")
    candidate = os.path.realpath(os.path.join(SKILLS_DIR, safe))
    root = os.path.realpath(SKILLS_DIR)
    if candidate.startswith(root + os.sep) and os.path.isfile(candidate):
        rec = _skill_record(candidate, include_body=True)
        if rec and rec["id"] == skill_id:
            return rec
    for fname in os.listdir(SKILLS_DIR):
        if not fname.lower().endswith(".md"):
            continue
        rec = _skill_record(os.path.join(SKILLS_DIR, fname), include_body=True)
        if rec and rec["id"] == skill_id:
            return rec
    return None


# ---------------------------------------------------------------------------
# Public API — research output
# ---------------------------------------------------------------------------

def _first_heading(text: str) -> Optional[str]:
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return None


def list_research() -> list[dict]:
    """Generated theory files in docs/research, newest first. Skips README.md."""
    if not os.path.isdir(RESEARCH_DIR):
        return []
    items: list[dict] = []
    for fname in os.listdir(RESEARCH_DIR):
        if not fname.lower().endswith(".md") or fname.lower() == "readme.md":
            continue
        path = os.path.join(RESEARCH_DIR, fname)
        try:
            stat = os.stat(path)
            with open(path, "r", encoding="utf-8") as f:
                head = f.read(2000)
        except OSError:
            continue
        items.append({
            "name": fname,
            "title": _first_heading(head) or fname[:-3],
            "created": int(stat.st_mtime),
            "size": stat.st_size,
        })
    items.sort(key=lambda r: r["created"], reverse=True)
    return items


def read_research(name: str) -> str:
    """Return the markdown of one research file. Path-traversal guarded:
    `name` must be a bare filename resolving inside RESEARCH_DIR, else ValueError.
    """
    if not name or "/" in name or "\\" in name or os.path.basename(name) != name:
        raise ValueError("invalid research file name")
    if not name.lower().endswith(".md"):
        raise ValueError("invalid research file name")
    path = os.path.realpath(os.path.join(RESEARCH_DIR, name))
    root = os.path.realpath(RESEARCH_DIR)
    if not path.startswith(root + os.sep):
        raise ValueError("invalid research file name")
    if not os.path.isfile(path):
        raise FileNotFoundError(name)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()
