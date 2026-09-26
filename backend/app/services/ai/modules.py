"""AI review modules (§41, §42, §43, §44).

Four modules, never one giant prompt:

    A  problem alignment + requirements + claims
    B  architecture + implementation + technical decisions
    C  security + database + testing
    D  contribution + claim verification (per member)

Each module decides for itself whether to call the model at all (§42). The
deterministic pre-pass below is what keeps a normal project inside a few thousand
tokens: when the evidence already answers the question, the answer is recorded
with ``source = 'deterministic'`` and no request is made.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.analysis.evidence import compact_evidence

# Bump when a prompt changes materially. It is part of the AI cache identity
# (§58), so a prompt edit invalidates cached results rather than serving stale
# reasoning.
PROMPT_VERSIONS = {
    "alignment": "align-v1",
    "architecture": "arch-v1",
    "quality": "quality-v1",
    "contribution": "contrib-v1",
    "claims": "claims-v1",
    "requirements_fallback": "reqmap-v1",
}

MODULE_A = "alignment"
MODULE_B = "architecture"
MODULE_C = "quality"
MODULE_D = "contribution"

# ── The stable system prompt (§59) ─────────────────────────────────────────
# Byte-identical between runs so the provider can cache it.
SYSTEM_STABLE = """You are a technical reviewer assessing a hackathon submission against its \
brief. You are given FACTS extracted deterministically from a GitHub repository, \
and small targeted code snippets. The facts are the source of truth.

Rules you must follow:
1. Never invent files, functions, endpoints, tables, dependencies, features, \
metrics or vulnerabilities. If something is not in the evidence, say it is not \
evidenced.
2. Every conclusion must cite evidence ids from the list you are given.
3. "not_evidenced" means the analysed repository did not show sufficient evidence. \
It does NOT mean the feature does not exist.
4. Never claim a real-world impact or benchmark number unless the evidence \
contains a measurement. Describe intent instead.
5. Prefer "potential_issue" over "confirmed_issue". Use "confirmed_issue" only \
when the evidence unambiguously establishes the problem.
6. Do not rank, score, or compare teams. This is a training analysis.
7. Reply with a single JSON object matching the requested shape. No prose."""


@dataclass
class ModuleResult:
    """One module's outcome, whether or not a request was made."""

    module: str
    status: str  # "skipped" | "completed" | "failed" | "cached"
    source: str  # "deterministic" | "ai"
    data: dict[str, Any]
    reason: str = ""
    prompt_version: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    cache_miss_tokens: int = 0
    cost_usd: float = 0.0
    request_id: str | None = None
    model: str = ""
    duration_ms: int = 0
    error_code: str | None = None
    error_message: str | None = None


# ── §42 deterministic pre-passes ───────────────────────────────────────────


def alignment_from_evidence(
    requirement_map: dict[str, Any], project_map: dict[str, Any]
) -> dict[str, Any] | None:
    """Answer the alignment question without a model when we safely can.

    Only returns a result when the repository has substantial evidence. A thin
    or empty repository is exactly the case that needs interpretation, so it
    falls through to the model rather than being guessed at.
    """
    requirements = requirement_map.get("requirements") or []
    if not requirements:
        return None

    stats = project_map.get("repository_stats", {})
    endpoints = len(project_map.get("apis") or [])
    files = stats.get("file_count", 0)
    dependencies = sum(
        len(v) for v in (project_map.get("stack", {}).get("dependencies_by_category") or {}).values()
    )

    # Below this bar the evidence is too thin to conclude anything.
    if endpoints < 2 and files < 15 and dependencies < 5:
        return None

    detected = set(project_map.get("authentication", {}).get("detected") or [])
    has_database = bool(project_map.get("database", {}).get("technologies"))

    critical = [r for r in requirements if r.get("importance") == "critical"]
    checkable = critical or requirements

    addressed: list[str] = []
    for requirement in checkable:
        text = requirement.get("text", "").lower()
        signals = _signals_for(text)
        if signals and any(signal in detected for signal in signals):
            addressed.append(requirement["id"])

    ratio = len(addressed) / len(checkable) if checkable else 0.0

    if has_database and any(requirement.get("category") == "ai_ml" for requirement in checkable):
        status = "partially_aligned"
        explanation = (
            "The repository contains a data layer and a machine-learning "
            "dependency, but no direct evidence links a model to the feature."
        )
    elif ratio >= 0.6:
        status = "strongly_aligned"
        explanation = (
            f"{len(addressed)} of {len(checkable)} core requirements have a matching "
            "detected technology in the repository."
        )
    elif ratio >= 0.25:
        status = "partially_aligned"
        explanation = (
            f"{len(addressed)} of {len(checkable)} core requirements have a matching "
            "detected technology. The remainder are not evidenced by detection alone."
        )
    else:
        status = "weakly_evidenced"
        explanation = (
            "Detected technologies do not clearly correspond to the stated core "
            "requirements. Code inspection is needed to determine coverage."
        )

    return {
        "status": status,
        "confidence": "medium",
        "addressed_requirement_ids": addressed,
        "explanation": explanation,
    }


_REQUIREMENT_SIGNALS: dict[str, tuple[str, ...]] = {
    "auth": ("Supabase Auth", "JWT", "Passport", "NextAuth", "Clerk", "Auth0"),
    "predict": ("TensorFlow", "PyTorch", "scikit-learn", "XGBoost", "OpenAI"),
    "database": ("PostgreSQL", "Supabase", "SQLAlchemy", "Prisma", "MongoDB", "SQL"),
}


def _signals_for(text: str) -> set[str]:
    found: set[str] = set()
    for keyword, names in _REQUIREMENT_SIGNALS.items():
        if keyword in text:
            found.update(names)
    return found


def testing_from_evidence(project_map: dict[str, Any]) -> dict[str, Any]:
    """Test coverage is a count, not a judgement. Never needs a model."""
    testing = project_map.get("testing", {})
    count = testing.get("test_file_count", 0)
    frameworks = testing.get("frameworks", [])

    if count == 0:
        status = "not_evidenced"
        finding = "testing_gap"
    elif count < 3:
        status = "partial_evidence"
        finding = "testing_gap"
    else:
        status = "evidence_found"
        finding = None

    return {
        "status": status,
        "test_file_count": count,
        "frameworks": [f.get("name") for f in frameworks],
        "commands": testing.get("commands", []),
        "finding": finding,
        "explanation": (
            "No test files were detected in the analysed repository."
            if count == 0
            else f"{count} test files detected. File count is not a measure of test quality."
        ),
    }


def security_from_evidence(project_map: dict[str, Any]) -> dict[str, Any] | None:
    """Hard-coded secrets are a finding with no interpretation required."""
    security = project_map.get("security", {})
    findings = security.get("hardcoded_secrets") or []
    if not findings:
        return None

    return {
        "status": "evidence_found",
        "confirmed_issues": [
            {
                "type": "security_concern",
                "severity": "high",
                "title": f"Hard-coded {item['type'].replace('_', ' ')} in {item['file']}",
                "description": (
                    f"A value matching a {item['type'].replace('_', ' ')} pattern was "
                    f"found at {item['file']} line {item['line']}. The value itself is "
                    "redacted and was not transmitted."
                ),
                "why_it_matters": "A committed credential should be rotated, not just removed.",
                "suggested_improvement": "Rotate the credential and load it from the environment.",
                "confidence": "medium",
            }
            for item in findings[:5]
        ],
    }


# ── §44 prompt builders ────────────────────────────────────────────────────


def build_alignment_task(
    *,
    requirement_map: dict[str, Any],
    project_map: dict[str, Any],
    evidence: list[dict[str, Any]],
    snippets: str,
    submission: dict[str, Any],
) -> str:
    """Module A. The requirement-aware question — the heart of the product."""
    facts = compact_evidence(evidence, limit=120)
    return f"""Assess whether this submission addresses THIS specific hackathon.

Return JSON:
{{
  "problem_alignment": {{
    "status": "strongly_aligned|partially_aligned|weakly_evidenced|unclear",
    "confidence": "high|medium|low",
    "evidence_ids": ["EV-001"],
    "explanation": "How the implementation relates to the stated problem."
  }},
  "requirements": [
    {{
      "requirement_id": "REQ-001",
      "status": "evidence_found|partial_evidence|not_evidenced|unable_to_determine",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What in the repository shows this, or why it is not evidenced."
    }}
  ],
  "summary": {{
    "headline": "One sentence.",
    "strengths": ["..."],
    "areas_to_clarify": ["..."]
  }}
}}

Only include a requirement entry for the requirement ids listed below.

PROJECT PROBLEM
{(requirement_map.get("problem_summary") or "")[:1500]}

REQUIREMENTS
{_format_items(requirement_map.get("requirements"))}

CONSTRAINTS
{_format_items(requirement_map.get("constraints"))}

EXPECTED OUTCOME
{_format_items(requirement_map.get("expected_outcomes"))}

EVALUATION CRITERIA
{_format_items(requirement_map.get("evaluation_criteria"))}

WHAT THE STUDENT CLAIMED
Project: {submission.get("project_name") or "(none)"}
Description: {(submission.get("project_description") or "")[:900]}
Key features: {(submission.get("key_features") or "")[:900]}
Tech stack claimed: {(submission.get("tech_stack") or "")[:400]}

PROJECT MAP (deterministic facts)
{_truncate_json(project_map, 6000)}

REPOSITORY FACTS
{_truncate_json(facts, 6000)}

TARGETED CODE
{snippets or "(no relevant code could be retrieved)"}"""


def build_architecture_task(
    *,
    project_map: dict[str, Any],
    evidence: list[dict[str, Any]],
    snippets: str,
) -> str:
    """Module B."""
    facts = compact_evidence(evidence, limit=80)
    return f"""Assess the technical architecture and implementation of this project.

Return JSON:
{{
  "architecture": {{
    "summary": "How the project is structured.",
    "layers": ["..."],
    "entry_points": ["..."],
    "evidence_ids": ["EV-001"]
  }},
  "technical_decisions": [
    {{"decision":"...","rationale":"... (only if the evidence supports it)","evidence_ids":["EV-001"]}}
  ],
  "implementation": {{
    "summary": "...",
    "strengths": ["..."],
    "observations": ["..."]
  }},
  "findings": [
    {{
      "type": "strength|observation|potential_issue|architecture_concern|scalability_concern",
      "severity": "critical|high|medium|low|informational",
      "title": "...",
      "description": "...",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "why_it_matters": "...",
      "suggested_improvement": "...",
      "confidence": "high|medium|low"
    }}
  ]
}}

Do not invent a technical decision rationale the repository does not show. If the \
reason for a choice is not in the evidence, omit the rationale.

PROJECT MAP
{_truncate_json(project_map, 5000)}

REPOSITORY FACTS
{_truncate_json(facts, 5000)}

TARGETED CODE
{snippets or "(no relevant code could be retrieved)"}"""


def build_quality_task(
    *,
    project_map: dict[str, Any],
    evidence: list[dict[str, Any]],
    snippets: str,
    testing_facts: dict[str, Any] | None = None,
) -> str:
    """Module C. Testing and scalability get one call each at most."""
    facts = compact_evidence(evidence, limit=80)
    return f"""Assess security, data handling, testing and scalability of this project.

Return JSON:
{{
  "security": {{
    "summary": "...",
    "authentication_present": true,
    "authorization_checks_present": true,
    "concerns": ["..."],
    "evidence_ids": ["EV-001"]
  }},
  "database": {{
    "summary": "...",
    "technologies": ["..."],
    "schema_present": true,
    "evidence_ids": ["EV-001"]
  }},
  "testing": {{
    "summary": "...",
    "evidence_ids": ["EV-001"]
  }},
  "scalability": {{
    "summary": "...",
    "concerns": ["..."],
    "evidence_ids": ["EV-001"]
  }},
  "findings": [
    {{
      "type": "security_concern|testing_gap|scalability_concern|potential_issue|observation",
      "severity": "critical|high|medium|low|informational",
      "title": "...",
      "description": "...",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "why_it_matters": "...",
      "suggested_improvement": "...",
      "confidence": "high|medium|low"
    }}
  ]
}}

Report only what the evidence supports. A concern you cannot evidence must be \
omitted, not softened.

PROJECT MAP
{_truncate_json(project_map, 5000)}

REPOSITORY FACTS
{_truncate_json(facts, 5000)}

TARGETED CODE
{snippets or "(no relevant code could be retrieved)"}"""


def build_contribution_task(
    *,
    member: dict[str, Any],
    project_map: dict[str, Any],
    evidence: list[dict[str, Any]],
    snippets: str,
    other_members: list[str],
) -> str:
    """Module D. Per member, and only where a claim is specific enough to check."""
    facts = compact_evidence(evidence, limit=60)
    return f"""Assess one team member's claimed contribution against the repository.

Return JSON:
{{
  "status": "supported_by_repository|partially_supported|not_yet_verified",
  "confidence": "high|medium|low",
  "evidence_ids": ["EV-001"],
  "matched_files": ["path"],
  "matched_symbols": ["name"],
  "explanation": "What the repository shows about this contribution, or why it cannot be determined."
}}

Absence of evidence is not evidence of absence. If the claim is broad or the \
repository cannot speak to it, use "not_yet_verified" and say so plainly.

CLAIMED CONTRIBUTION ({member.get("full_name") or member.get("email")})
Description: {(member.get("contribution_description") or "(none)")[:700]}
Areas: {", ".join(member.get("contribution_areas") or []) or "(none)"}
Planned responsibilities: {(member.get("planned_responsibilities") or "(none)")[:500]}
AI tools disclosed: {(member.get("ai_tools_used") or "(none)")[:300]}

OTHER TEAM MEMBERS (so you do not attribute their work to this person)
{", ".join(other_members) or "(none)"}

PROJECT MAP
{_truncate_json(project_map, 3500)}

REPOSITORY FACTS
{_truncate_json(facts, 3500)}

TARGETED CODE
{snippets or "(no relevant code could be retrieved)"}"""


def build_claims_task(
    *,
    claims: list[str],
    project_map: dict[str, Any],
    evidence: list[dict[str, Any]],
    snippets: str,
) -> str:
    """Claim verification (§38)."""
    facts = compact_evidence(evidence, limit=80)
    return f"""Check each feature the student claimed against the repository.

Return JSON:
{{
  "claims": [
    {{
      "claim": "...",
      "status": "supported|partially_supported|not_evidenced",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "symbols": ["name"],
      "explanation": "..."
    }}
  ]
}}

"not_evidenced" means the analysed repository did not show evidence. It is not a \
statement that the claim is false.

CLAIMS
{chr(10).join(f"- {c}" for c in claims)}

PROJECT MAP
{_truncate_json(project_map, 4000)}

REPOSITORY FACTS
{_truncate_json(facts, 4000)}

TARGETED CODE
{snippets or "(no relevant code could be retrieved)"}"""


# ── Output validation (§44) ───────────────────────────────────────────────

ALIGNMENT_STATUSES = ("strongly_aligned", "partially_aligned", "weakly_evidenced", "unclear")
REQUIREMENT_STATUSES = ("evidence_found", "partial_evidence", "not_evidenced", "unable_to_determine")
CONSTRAINT_STATUSES = ("supported", "potential_concern", "not_evidenced", "unable_to_determine")
OUTCOME_STATUSES = ("supported", "partially_supported", "not_evidenced", "unclear")
CLAIM_STATUSES = ("supported", "partially_supported", "not_evidenced")
CONTRIBUTION_STATUSES = ("supported_by_repository", "partially_supported", "not_yet_verified")
CONFIDENCES = ("high", "medium", "low", "none")
FINDING_TYPES = (
    "strength", "observation", "potential_issue", "confirmed_issue",
    "security_concern", "testing_gap", "architecture_concern",
    "scalability_concern", "claim_mismatch", "clarification_needed",
)
SEVERITIES = ("critical", "high", "medium", "low", "informational")

MAX_FINDINGS_PER_MODULE = 8


def validate_findings(raw: Any, evidence_ids: set[str]) -> list[dict[str, Any]]:
    """§47 — a finding without resolvable evidence is dropped, not stored."""
    if not isinstance(raw, list):
        return []

    findings: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("title"):
            continue

        cited = [i for i in (item.get("evidence_ids") or []) if i in evidence_ids]
        # §47 — insufficient evidence means the finding does not exist.
        if not cited and item.get("type") not in ("observation",):
            continue

        finding_type = item.get("type") if item.get("type") in FINDING_TYPES else "observation"
        severity = item.get("severity") if item.get("severity") in SEVERITIES else "low"
        confidence = item.get("confidence") if item.get("confidence") in ("high", "medium", "low") else "low"

        # §48 — a "confirmed_issue" needs high-confidence evidence to stay one.
        if finding_type == "confirmed_issue" and confidence == "low":
            finding_type = "potential_issue"

        findings.append(
            {
                "finding_type": finding_type,
                "severity": severity,
                "title": str(item.get("title"))[:200],
                "description": str(item.get("description") or "")[:2000],
                "evidence_ids": cited[:12],
                "files": [str(f) for f in (item.get("files") or [])][:12],
                "symbols": [str(s) for s in (item.get("symbols") or [])][:12],
                "why_it_matters": str(item.get("why_it_matters") or "")[:1000],
                "suggested_improvement": str(item.get("suggested_improvement") or "")[:1000],
                "confidence": confidence,
            }
        )
        if len(findings) >= MAX_FINDINGS_PER_MODULE:
            break
    return findings


def _format_items(items: list[dict[str, Any]] | None) -> str:
    if not items:
        return "(none provided)"
    return "\n".join(
        f"- [{item.get('id')}] ({item.get('category')}, {item.get('importance')}) {item.get('text')}"
        for item in items[:30]
    )


def _truncate_json(payload: Any, limit: int) -> str:
    import json

    text = json.dumps(payload, indent=None, default=str)
    return text if len(text) <= limit else text[:limit] + " …(truncated)"
