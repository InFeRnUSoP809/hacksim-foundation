"""Requirement map construction (§30, §31).

Turns a hackathon's free-text brief into stable, addressable requirements with
ids the rest of the system can reference. Deterministic first: a bullet list is
already a requirement list, so no model is involved. Only a brief with no
structure at all is sent to a model, and only once — the result is cached in
``hackathon_requirement_maps`` forever.

Ids are positional and stable (``REQ-001``…), which is what lets requirement
evaluations, findings and defence targets refer to a requirement across runs.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - import cost, not runtime behaviour
    from supabase import Client

    from app.services.ai.client import AIResponse

logger = logging.getLogger("hacksim.requirements")

PROMPT_VERSION = "reqmap-v1"

# Categorisation is keyword-based, not model-based: these are stable, auditable
# and free.
CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "ai_ml": (
        "predict", "forecast", "model", "machine learning", "ml", "ai",
        "algorithm", "classify", "anomaly", "recommend", "score", "learn",
        "dataset", "training", "inference", "accuracy",
    ),
    "data": (
        "data", "dataset", "ingest", "import", "export", "store", "database",
        "record", "track", "log", "history", "metric", "report", "dashboard",
    ),
    "interface": (
        "ui", "interface", "screen", "page", "form", "button", "display",
        "visual", "user can", "view", "click", "navigate", "responsive",
    ),
    "api": ("api", "endpoint", "rest", "graphql", "webhook", "integration", "service"),
    "authentication": ("auth", "login", "sign in", "role", "permission", "user account"),
    "deployment": ("deploy", "hosting", "docker", "ci", "pipeline", "run locally"),
    "quality": (
        "test", "testing", "documentation", "readme", "explain", "explainable",
        "confidence", "error handling", "edge case", "maintainable", "structure",
    ),
    "core_functionality": (),
}

IMPORTANCE_KEYWORDS: dict[str, tuple[str, ...]] = {
    "critical": ("must", "required", "requirement", "core", "essential", "need to", "has to"),
    "important": ("should", "provide", "expose", "surface", "support"),
    "optional": ("optional", "if you have the time", "nice to have", "bonus", "ideally"),
}

# Markdown structure to strip before treating a line as one requirement.
_HEADING = re.compile(r"^#{1,6}\s+")
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_TASK = re.compile(r"^\s*-\s*\[\s*[ xX]?\s*\]\s*")
_NOISE = re.compile(r"^(?:[-*+]\s*)?(?:usage|contents|table of contents)\s*:?\s*$", re.IGNORECASE)


def _clean(line: str) -> str:
    text = _TASK.sub("", _BULLET.sub("", _HEADING.sub("", line)))
    return text.strip().strip("*_` ").strip()


def split_items(text: str | None) -> list[str]:
    """Turn a brief field into a clean list of one-line statements.

    Bullets win when they exist. Otherwise paragraphs become items, and
    otherwise sentences do — in that order of preference, so a well-structured
    brief never gets re-fragmented.
    """
    if not text or not text.strip():
        return []

    lines = text.split("\n")
    bullets: list[str] = []
    for line in lines:
        if _BULLET.match(line) and _clean(line):
            cleaned = _clean(line)
            if not _NOISE.match(cleaned) and len(cleaned) > 2:
                bullets.append(cleaned)

    if len(bullets) >= 2:
        return _dedupe([_truncate(b) for b in bullets])

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(paragraphs) >= 2:
        return _dedupe([_truncate(p) for p in paragraphs])

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if len(s.strip()) > 20]
    if sentences:
        return _dedupe([_truncate(s) for s in sentences])

    return [_truncate(text.strip())]


def _truncate(text: str, limit: int = 300) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 1].rstrip() + "…"


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result[:40]


def categorise(text: str) -> str:
    lowered = text.lower()
    best = "core_functionality"
    best_hits = 0
    for category, keywords in CATEGORY_KEYWORDS.items():
        hits = sum(1 for keyword in keywords if keyword in lowered)
        if hits > best_hits:
            best_hits = hits
            best = category
    return best


def importance_of(text: str) -> str:
    lowered = text.lower()
    for level, keywords in IMPORTANCE_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            return level
    return "important"


def _entries(prefix: str, items: list[str], category: str) -> list[dict[str, Any]]:
    return [
        {
            "id": f"{prefix}-{index:03d}",
            "text": item,
            "category": category if category else categorise(item),
            "importance": importance_of(item),
        }
        for index, item in enumerate(items, 1)
    ]


def build_requirement_map(hackathon: dict[str, Any]) -> dict[str, Any]:
    """Deterministic map. No model, no tokens."""
    return {
        "requirements": _entries("REQ", split_items(hackathon.get("requirements")), "core_functionality"),
        "constraints": _entries("CON", split_items(hackathon.get("constraints")), "constraint"),
        "expected_outcomes": _entries("OUT", split_items(hackathon.get("expected_outcome")), "outcome"),
        "evaluation_criteria": _entries("EVAL", split_items(hackathon.get("evaluation_criteria")), "evaluation"),
        "problem_summary": _truncate(hackathon.get("problem_statement") or "", 1500),
    }


def requirement_map_hash(hackathon: dict[str, Any]) -> str:
    """Identity of a brief's structure, so we can tell when it changed."""
    payload = "|".join(
        str(hackathon.get(field) or "")
        for field in (
            "problem_statement", "requirements", "constraints",
            "expected_outcome", "evaluation_criteria",
        )
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


# ── Persistence ────────────────────────────────────────────────────────────


def get_requirement_map(
    service: "Client", hackathon_id: str, hackathon: dict[str, Any]
) -> dict[str, Any]:
    """Return the cached map, building and storing one if the brief changed.

    §31 — a structured brief is never sent to a model again once parsed.
    """
    wanted_hash = requirement_map_hash(hackathon)

    result = (
        service.table("hackathon_requirement_maps")
        .select("*")
        .eq("hackathon_id", hackathon_id)
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    rows = result.data or []

    if rows:
        row = rows[0]
        # The map is keyed on a hash of the source fields, stored alongside it.
        if row.get("input_hash") == wanted_hash:
            return {
                "version": row.get("version", 1),
                "input_hash": wanted_hash,
                "problem_summary": row.get("problem_summary"),
                "requirements": row.get("requirements") or [],
                "constraints": row.get("constraints") or [],
                "expected_outcomes": row.get("expected_outcomes") or [],
                "evaluation_criteria": row.get("evaluation_criteria") or [],
            }

    fresh = build_requirement_map(hackathon)
    version = (rows[0].get("version", 1) + 1) if rows else 1

    try:
        service.table("hackathon_requirement_maps").insert(
            {
                "hackathon_id": hackathon_id,
                "version": version,
                "problem_summary": fresh["problem_summary"],
                "requirements": fresh["requirements"],
                "constraints": fresh["constraints"],
                "expected_outcomes": fresh["expected_outcomes"],
                "evaluation_criteria": fresh["evaluation_criteria"],
                "input_hash": wanted_hash,
            }
        ).execute()
    except Exception as exc:  # noqa: BLE001 — a cache write must never block a review
        logger.warning("[hacksim.requirements] could not cache requirement map: %s", exc)

    return {"version": version, "input_hash": wanted_hash, **fresh}


# ── Optional AI fallback (§31, only for unstructured briefs) ───────────────


def needs_ai_fallback(requirement_map: dict[str, Any]) -> bool:
    """True only when the brief yielded nothing usable at all."""
    return not requirement_map.get("requirements") and not requirement_map.get("expected_outcomes")


def fallback_prompt(hackathon: dict[str, Any]) -> str:
    return (
        "This hackathon brief has no usable structure. Split it into atomic, "
        "individually checkable statements.\n\n"
        f"Problem:\n{(hackathon.get('problem_statement') or '')[:3000]}\n\n"
        f"Expected outcome:\n{(hackathon.get('expected_outcome') or '')[:1500]}\n\n"
        'Return JSON: {"requirements":[{"text":"...","category":"core_functionality|'
        'ai_ml|data|interface|api|authentication|deployment|quality","importance":'
        '"critical|important|optional"}],"expected_outcomes":[{"text":"...",'
        '"category":"outcome","importance":"important"}]}'
    )


def parse_fallback(response: "AIResponse") -> dict[str, Any]:
    """Validate the fallback shape. Anything malformed yields nothing."""
    payload = response.parsed or {}
    requirements = [
        {
            "id": f"REQ-{index:03d}",
            "text": _truncate(str(item.get("text", ""))),
            "category": str(item.get("category") or "core_functionality"),
            "importance": str(item.get("importance") or "important"),
        }
        for index, item in enumerate(payload.get("requirements") or [], 1)
        if isinstance(item, dict) and item.get("text")
    ]
    outcomes = [
        {
            "id": f"OUT-{index:03d}",
            "text": _truncate(str(item.get("text", ""))),
            "category": "outcome",
            "importance": "important",
        }
        for index, item in enumerate(payload.get("expected_outcomes") or [], 1)
        if isinstance(item, dict) and item.get("text")
    ]

    return {
        "requirements": requirements[:40],
        "constraints": [],
        "expected_outcomes": outcomes[:20],
        "evaluation_criteria": [],
    }
