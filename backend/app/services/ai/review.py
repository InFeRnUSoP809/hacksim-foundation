"""Phase 6 review orchestrator.

Runs the modules, decides per module whether the model is needed at all, and
writes every result to the database. The shape of a run:

    requirements → deterministic pass → AI only where ambiguous
    alignment    → deterministic pass → AI only where thin
    architecture → always AI (interpretation, not counting)
    quality      → security/test facts pre-computed; AI only for the rest
    contributions→ only for members whose claim is specific enough to check

Every module is independently recoverable (§89): a failure is recorded, the
successful modules are not re-run, and the review is saved as ``partial``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from supabase import Client

from app.core.config import Settings
from app.services.ai import modules as M
from app.services.ai.client import AIError, AIResponse, DeepSeekClient
from app.services.ai.cost import (
    BudgetDecision,
    ModelPricing,
    calculate_cost,
    check_budget,
    context_hash,
    find_cached_analysis,
    record_usage,
    save_analysis,
)
from app.services.analysis.retrieval import build_packet
from app.services.analysis.requirements import get_requirement_map

logger = logging.getLogger("hacksim.review")

MAX_MEMBER_MODULES = 6


@dataclass
class ReviewOutcome:
    review_id: str | None
    status: str
    modules: list[M.ModuleResult] = field(default_factory=list)
    total_cost_usd: Decimal = Decimal(0)
    total_tokens: int = 0
    error: str | None = None

    @property
    def succeeded(self) -> int:
        return sum(1 for m in self.modules if m.status in ("completed", "cached"))

    @property
    def failed(self) -> int:
        return sum(1 for m in self.modules if m.status == "failed")


class Reviewer:
    """One review of one submission. Holds no state between submissions."""

    def __init__(
        self,
        *,
        service: "Client",
        settings: Settings,
        client: DeepSeekClient | None = None,
    ) -> None:
        self.service = service
        self.settings = settings
        self.ai = client or DeepSeekClient(settings)

    # ── Entry point ────────────────────────────────────────────

    def run(
        self,
        *,
        submission: dict[str, Any],
        hackathon: dict[str, Any],
        repository: dict[str, Any],
        files: list[dict[str, Any]],
        chunks: list[dict[str, Any]],
        evidence: list[dict[str, Any]],
        project_map: dict[str, Any],
        members: list[dict[str, Any]],
        actor_id: str | None = None,
        session_id: str | None = None,
        only_modules: list[str] | None = None,
    ) -> ReviewOutcome:
        repository_id = repository.get("id")
        submission_id = submission.get("id")
        evidence_ids = {item.get("id") for item in evidence if item.get("id")}

        outcome = ReviewOutcome(review_id=None, status="pending")
        review = self._load_review(submission_id, repository_id)

        requirement_map = get_requirement_map(self.service, hackathon["id"], hackathon)

        pricing = self._pricing()
        if pricing is None:
            outcome.status = "failed"
            outcome.error = "No AI model is configured."
            self._upsert_review(submission_id, repository_id, {"status": "failed"}, outcome)
            return outcome

        results: dict[str, Any] = dict(review.get("data") or {})

        # ── Module A: alignment, requirements, claims ──────────
        if not only_modules or M.MODULE_A in only_modules:
            try:
                result = self._module_alignment(
                    submission=submission,
                    requirement_map=requirement_map,
                    project_map=project_map,
                    evidence=evidence,
                    evidence_ids=evidence_ids,
                    files=files,
                    chunks=chunks,
                    repository=repository,
                    submission_id=submission_id,
                    pricing=pricing,
                    actor_id=actor_id,
                    session_id=session_id,
                )
                outcome.modules.append(result)
                if result.data:
                    results.update(result.data)
            except Exception as exc:  # noqa: BLE001
                logger.exception("[hacksim.review] module A failed")
                outcome.modules.append(
                    M.ModuleResult(M.MODULE_A, "failed", "ai", {}, error_message=str(exc))
                )

        # ── Module B: architecture ──────────────────────────────
        if not only_modules or M.MODULE_B in only_modules:
            try:
                result = self._module_generic(
                    module=M.MODULE_B,
                    prompt_version=M.PROMPT_VERSIONS["architecture"],
                    task_builder=lambda snippets: M.build_architecture_task(
                        project_map=project_map, evidence=evidence, snippets=snippets
                    ),
                    question="How is this project architected, and what technical decisions does it make?",
                    project_map=project_map,
                    evidence=evidence,
                    files=files,
                    chunks=chunks,
                    repository=repository,
                    submission_id=submission_id,
                    pricing=pricing,
                    actor_id=actor_id,
                    session_id=session_id,
                    scope="architecture",
                )
                outcome.modules.append(result)
                if result.data:
                    results["architecture"] = result.data.get("architecture")
                    results["technical_decisions"] = result.data.get("technical_decisions")
                    results["implementation"] = result.data.get("implementation")
            except Exception as exc:  # noqa: BLE001
                logger.exception("[hacksim.review] module B failed")
                outcome.modules.append(
                    M.ModuleResult(M.MODULE_B, "failed", "ai", {}, error_message=str(exc))
                )

        # ── Module C: security, database, testing, scalability ──
        if not only_modules or M.MODULE_C in only_modules:
            try:
                result = self._module_quality(
                    project_map=project_map,
                    evidence=evidence,
                    evidence_ids=evidence_ids,
                    files=files,
                    chunks=chunks,
                    repository=repository,
                    submission_id=submission_id,
                    pricing=pricing,
                    actor_id=actor_id,
                    session_id=session_id,
                )
                outcome.modules.append(result)
                if result.data:
                    results["security"] = result.data.get("security")
                    results["database_review"] = result.data.get("database")
                    results["testing"] = result.data.get("testing")
                    results["scalability"] = result.data.get("scalability")
            except Exception as exc:  # noqa: BLE001
                logger.exception("[hacksim.review] module C failed")
                outcome.modules.append(
                    M.ModuleResult(M.MODULE_C, "failed", "ai", {}, error_message=str(exc))
                )

        # ── Module D: contributions, per member ─────────────────
        if not only_modules or M.MODULE_D in only_modules:
            try:
                contribution_results = self._module_contributions(
                    members=members,
                    project_map=project_map,
                    evidence=evidence,
                    files=files,
                    chunks=chunks,
                    repository=repository,
                    submission_id=submission_id,
                    pricing=pricing,
                    actor_id=actor_id,
                    session_id=session_id,
                )
                outcome.modules.extend(contribution_results)
                if contribution_results:
                    results["contributions"] = {
                        item.data.get("user_id"): item.data
                        for item in contribution_results
                        if item.data
                    }
            except Exception as exc:  # noqa: BLE001
                logger.exception("[hacksim.review] module D failed")
                outcome.modules.append(
                    M.ModuleResult(M.MODULE_D, "failed", "ai", {}, error_message=str(exc))
                )

        # ── Persist ─────────────────────────────────────────────
        status = self._overall_status(outcome.modules)
        outcome.status = status
        outcome.total_cost_usd = sum((Decimal(str(m.cost_usd)) for m in outcome.modules), Decimal(0))
        outcome.total_tokens = sum(
            m.input_tokens + m.output_tokens for m in outcome.modules
        )

        outcome.review_id = self._upsert_review(submission_id, repository_id, results, outcome, pricing)
        self._replace_requirement_evaluations(submission_id, outcome.modules, evidence_ids)
        self._replace_findings(outcome.review_id, outcome.modules, evidence_ids)
        self._replace_defense_targets(
            submission_id, members, outcome.modules, requirement_map, evidence_ids
        )

        return outcome

    # ── Modules ────────────────────────────────────────────────

    def _module_alignment(
        self,
        *,
        submission: dict[str, Any],
        requirement_map: dict[str, Any],
        project_map: dict[str, Any],
        evidence: list[dict[str, Any]],
        evidence_ids: set[str],
        files: list[dict[str, Any]],
        chunks: list[dict[str, Any]],
        repository: dict[str, Any],
        submission_id: str | None,
        pricing: ModelPricing,
        actor_id: str | None,
        session_id: str | None,
    ) -> M.ModuleResult:
        requirements = requirement_map.get("requirements") or []
        out: dict[str, Any] = {}

        # §42 — deterministic first. Only ask the model when the deterministic
        # pass could not conclude, which is what keeps a normal project cheap.
        deterministic = M.alignment_from_evidence(requirement_map, project_map)
        if deterministic:
            out["problem_alignment"] = deterministic
            out["requirements"] = _requirements_from_deterministic(
                requirements, deterministic
            )
            out["summary"] = {
                "headline": deterministic["explanation"],
                "strengths": [],
                "areas_to_clarify": [
                    f"{r['id']} has no matching detected technology"
                    for r in requirements
                    if r["id"] not in (deterministic.get("addressed_requirement_ids") or [])
                ][:6],
                "source": "deterministic",
            }
        else:
            packet = build_packet(
                question="Does this repository implement the hackathon requirements?",
                files=files,
                chunks=chunks,
                category="api",
                settings=self.settings,
            )
            task = M.build_alignment_task(
                requirement_map=requirement_map,
                project_map=project_map,
                evidence=evidence,
                snippets=packet.render(),
                submission=submission,
            )
            response = self._call(
                operation=f"{M.MODULE_A}.alignment",
                task=task,
                prompt_version=M.PROMPT_VERSIONS["alignment"],
                context_parts=[requirement_map, project_map],
                scope_key="alignment",
                repository=repository,
                submission_id=submission_id,
                pricing=pricing,
                actor_id=actor_id,
                session_id=session_id,
                estimate_tokens=packet.estimate_tokens() + 3500,
            )

            if response is None:
                return M.ModuleResult(M.MODULE_A, "skipped", "deterministic", {}, reason="no_call")

            payload = response.parsed or {}
            alignment = payload.get("problem_alignment") or {}
            out["problem_alignment"] = {
                "status": _one_of(alignment.get("status"), M.ALIGNMENT_STATUSES, "unclear"),
                "confidence": _one_of(alignment.get("confidence"), ("high", "medium", "low"), "low"),
                "evidence_ids": [i for i in (alignment.get("evidence_ids") or []) if i in evidence_ids][:12],
                "explanation": str(alignment.get("explanation") or "")[:1500],
                "source": "ai",
            }
            out["requirements"] = _validate_requirement_rows(
                payload.get("requirements"), requirements, evidence_ids
            )
            summary = payload.get("summary") or {}
            out["summary"] = {
                "headline": str(summary.get("headline") or "")[:300],
                "strengths": [str(s)[:200] for s in (summary.get("strengths") or [])][:6],
                "areas_to_clarify": [str(s)[:200] for s in (summary.get("areas_to_clarify") or [])][:6],
                "source": "ai",
            }

        # Claims are checked in the same pass: same evidence, same context.
        claims = _claims_from(submission, project_map)
        if claims:
            claim_result = self._module_generic(
                module="claims",
                prompt_version=M.PROMPT_VERSIONS["claims"],
                task_builder=lambda snippets: M.build_claims_task(
                    claims=claims,
                    project_map=project_map,
                    evidence=evidence,
                    snippets=snippets,
                ),
                question="Which claimed features are supported by the code?",
                project_map=project_map,
                evidence=evidence,
                files=files,
                chunks=chunks,
                repository=repository,
                submission_id=submission_id,
                pricing=pricing,
                actor_id=actor_id,
                session_id=session_id,
                scope="claims",
                pre_computed={"claims": _deterministic_claims(claims, project_map)},
            )
            if claim_result.data:
                out["claims"] = claim_result.data.get("claims")
                # Claim mismatches become findings on the review page.
                for finding in claim_result.data.get("findings") or []:
                    if finding.get("finding_type") == "claim_mismatch":
                        out.setdefault("findings", []).append(finding)

        return M.ModuleResult(
            M.MODULE_A, "completed", "deterministic" if deterministic else "ai", out
        )

    def _module_quality(
        self,
        *,
        project_map: dict[str, Any],
        evidence: list[dict[str, Any]],
        evidence_ids: set[str],
        files: list[dict[str, Any]],
        chunks: list[dict[str, Any]],
        repository: dict[str, Any],
        submission_id: str | None,
        pricing: ModelPricing,
        actor_id: str | None,
        session_id: str | None,
    ) -> M.ModuleResult:
        # Security secrets and test counts need no model.
        security_facts = M.security_from_evidence(project_map)
        testing_facts = M.testing_from_evidence(project_map)

        packet = build_packet(
            question="authentication authorization middleware database schema and tests",
            files=files,
            chunks=chunks,
            category="security",
            settings=self.settings,
        )
        task = M.build_quality_task(
            project_map=project_map,
            evidence=evidence,
            snippets=packet.render(),
            testing_facts=testing_facts,
        )
        response = self._call(
            operation=f"{M.MODULE_C}.quality",
            task=task,
            prompt_version=M.PROMPT_VERSIONS["quality"],
            context_parts=[project_map, testing_facts, security_facts],
            scope_key="quality",
            repository=repository,
            submission_id=submission_id,
            pricing=pricing,
            actor_id=actor_id,
            session_id=session_id,
            estimate_tokens=packet.estimate_tokens() + 3500,
        )

        out: dict[str, Any] = {}
        findings: list[dict[str, Any]] = []

        if response is not None and response.parsed:
            payload = response.parsed
            out["security"] = _section(payload.get("security"), evidence_ids)
            out["database"] = _section(payload.get("database"), evidence_ids)
            out["scalability"] = _section(payload.get("scalability"), evidence_ids)
            # §42 — a test count is arithmetic. Keep the deterministic answer.
            out["testing"] = {
                "status": testing_facts["status"],
                "test_file_count": testing_facts["test_file_count"],
                "frameworks": testing_facts["frameworks"],
                "commands": testing_facts["commands"],
                "explanation": testing_facts["explanation"],
                "source": "deterministic",
            }
            findings.extend(M.validate_findings(payload.get("findings"), evidence_ids))

        if not response:
            out["security"] = security_facts or {"summary": "AI review unavailable.", "source": "skipped"}
            out["database"] = {"summary": "AI review unavailable.", "source": "skipped"}
            out["scalability"] = {"summary": "AI review unavailable.", "source": "skipped"}
            out["testing"] = {
                "status": testing_facts["status"],
                "test_file_count": testing_facts["test_file_count"],
                "frameworks": testing_facts["frameworks"],
                "explanation": testing_facts["explanation"],
                "source": "deterministic",
            }

        if security_facts:
            findings.extend(security_facts.get("confirmed_issues", []))

        if testing_facts.get("finding") and testing_facts["test_file_count"] == 0:
            findings.append(
                {
                    "finding_type": "testing_gap",
                    "severity": "medium",
                    "title": "No automated tests detected",
                    "description": testing_facts["explanation"],
                    "evidence_ids": [],
                    "files": [],
                    "symbols": [],
                    "why_it_matters": (
                        "Behaviour that is not covered by tests is unverified when it changes."
                    ),
                    "suggested_improvement": (
                        "Add tests for the main user path, starting with failure cases."
                    ),
                    "confidence": "medium",
                }
            )

        if findings:
            out["findings"] = findings

        return M.ModuleResult(M.MODULE_C, "completed", "ai", out)

    def _module_generic(
        self,
        *,
        module: str,
        prompt_version: str,
        task_builder: Any,
        question: str,
        project_map: dict[str, Any],
        evidence: list[dict[str, Any]],
        files: list[dict[str, Any]],
        chunks: list[dict[str, Any]],
        repository: dict[str, Any],
        submission_id: str | None,
        pricing: ModelPricing,
        actor_id: str | None,
        session_id: str | None,
        scope: str,
        pre_computed: dict[str, Any] | None = None,
    ) -> M.ModuleResult:
        packet = build_packet(
            question=question, files=files, chunks=chunks, settings=self.settings
        )
        response = self._call(
            operation=f"{module}.{scope}",
            task=task_builder(packet.render()),
            prompt_version=prompt_version,
            context_parts=[project_map],
            scope_key=scope,
            repository=repository,
            submission_id=submission_id,
            pricing=pricing,
            actor_id=actor_id,
            session_id=session_id,
            estimate_tokens=packet.estimate_tokens() + 3000,
        )

        if response is None or not response.parsed:
            data = dict(pre_computed or {})
            data["status"] = "skipped"
            data["reason"] = "AI unavailable or budget exhausted; deterministic facts only."
            return M.ModuleResult(module, "skipped", "deterministic", data)

        payload = response.parsed
        data: dict[str, Any] = dict(payload)
        data["findings"] = M.validate_findings(
            payload.get("findings"), {e.get("id") for e in evidence if e.get("id")}
        )
        return M.ModuleResult(module, "completed", "ai", data)

    def _module_contributions(
        self,
        *,
        members: list[dict[str, Any]],
        project_map: dict[str, Any],
        evidence: list[dict[str, Any]],
        files: list[dict[str, Any]],
        chunks: list[dict[str, Any]],
        repository: dict[str, Any],
        submission_id: str | None,
        pricing: ModelPricing,
        actor_id: str | None,
        session_id: str | None,
    ) -> list[M.ModuleResult]:
        # §41 — only members whose claim is specific enough to check, capped.
        checkable = [m for m in members if (m.get("contribution_description") or "").strip()]
        checkable = checkable[:MAX_MEMBER_MODULES]

        results: list[M.ModuleResult] = []
        other_names = [
            m.get("full_name") or m.get("email") or "member"
            for m in members
        ]

        for member in checkable:
            question = (member.get("contribution_description") or "")[:400]
            packet = build_packet(
                question=question,
                files=files,
                chunks=chunks,
                settings=self.settings,
                max_files=4,
            )
            task = M.build_contribution_task(
                member=member,
                project_map=project_map,
                evidence=evidence,
                snippets=packet.render(),
                other_members=other_names,
            )
            response = self._call(
                operation=f"{M.MODULE_D}.contribution",
                task=task,
                prompt_version=M.PROMPT_VERSIONS["contribution"],
                context_parts=[project_map, member.get("id")],
                scope_key=f"contribution:{member.get('id')}",
                repository=repository,
                submission_id=submission_id,
                pricing=pricing,
                actor_id=actor_id,
                session_id=session_id,
                estimate_tokens=packet.estimate_tokens() + 2000,
            )

            if response is None or not response.parsed:
                results.append(
                    M.ModuleResult(
                        M.MODULE_D,
                        "skipped",
                        "deterministic",
                        {
                            "user_id": member.get("user_id"),
                            "member_id": member.get("id"),
                            "status": "not_yet_verified",
                            "confidence": "none",
                            "explanation": "Contribution analysis was unavailable.",
                        },
                    )
                )
                continue

            payload = response.parsed
            evidence_ids = {e.get("id") for e in evidence if e.get("id")}
            results.append(
                M.ModuleResult(
                    M.MODULE_D,
                    "completed",
                    "ai",
                    {
                        "user_id": member.get("user_id"),
                        "member_id": member.get("id"),
                        "status": _one_of(
                            payload.get("status"), M.CONTRIBUTION_STATUSES, "not_yet_verified"
                        ),
                        "confidence": _one_of(
                            payload.get("confidence"), ("high", "medium", "low"), "low"
                        ),
                        "evidence_ids": [
                            i for i in (payload.get("evidence_ids") or []) if i in evidence_ids
                        ][:10],
                        "matched_files": [str(f)[:200] for f in (payload.get("matched_files") or [])][:10],
                        "matched_symbols": [str(s)[:120] for s in (payload.get("matched_symbols") or [])][:10],
                        "explanation": str(payload.get("explanation") or "")[:1200],
                    },
                )
            )

        return results

    # ── The single call site: budget, cache, usage, errors ────

    def _call(
        self,
        *,
        operation: str,
        task: str,
        prompt_version: str,
        context_parts: list[Any],
        scope_key: str,
        repository: dict[str, Any],
        submission_id: str | None,
        pricing: ModelPricing,
        actor_id: str | None,
        session_id: str | None,
        estimate_tokens: int,
    ) -> AIResponse | None:
        """One guarded AI call. Returns ``None`` when it was not allowed or failed."""
        repository_id = repository.get("id")
        ctx_hash = context_hash(*context_parts, prompt_version, pricing.model_name)

        if not self.ai.configured:
            logger.info("[hacksim.review] AI not configured; skipping %s", operation)
            return None

        # §58 — reuse before spending.
        cached = find_cached_analysis(
            self.service,
            repository_id=repository_id,
            analysis_type=scope_key,
            prompt_version=prompt_version,
            model=pricing.model_name,
            ctx_hash=ctx_hash,
        )
        if cached and cached.get("result"):
            logger.info("[hacksim.review] cache hit for %s", scope_key)
            return AIResponse(
                content=json.dumps(cached["result"]),
                parsed=cached["result"],
                request_id=None,
                model=pricing.model_name,
                input_tokens=int(cached.get("input_tokens") or 0),
                output_tokens=int(cached.get("output_tokens") or 0),
                total_tokens=int(cached.get("total_tokens") or 0),
                cached_tokens=int(cached.get("cached_tokens") or 0),
                cache_miss_tokens=int(cached.get("cache_miss_tokens") or 0),
                duration_ms=0,
                prompt_version=prompt_version,
            )

        # §52 — the gate.
        decision: BudgetDecision = check_budget(
            self.service,
            pricing,
            submission_id,
            estimated_input_tokens=estimate_tokens,
            estimated_output_tokens=pricing.max_output_tokens,
            cache_ratio=0.5 if scope_key in ("alignment", "quality") else 0.0,
        )
        if not decision:
            logger.info("[hacksim.review] blocked %s: %s", operation, decision.reason)
            record_usage(
                self.service,
                operation=operation,
                provider=pricing.provider,
                model=pricing.model_name,
                prompt_version=prompt_version,
                input_tokens=0,
                output_tokens=0,
                cached_tokens=0,
                cache_miss_tokens=0,
                cost_usd=Decimal(0),
                request_id=None,
                status="rejected",
                duration_ms=0,
                user_id=actor_id,
                submission_id=submission_id,
                repository_id=repository_id,
                session_id=session_id,
                error_code=decision.reason or "blocked",
            )
            return None

        # §59 — the stable half of the prompt, built once and reused verbatim.
        system_stable = M.SYSTEM_STABLE
        context_stable = json.dumps(
            {"context_hash": ctx_hash, "modules": context_parts},
            default=str,
        )[:12000]

        try:
            response = self.ai.complete_json(
                system_stable=system_stable,
                context_stable=context_stable,
                task=task,
                prompt_version=prompt_version,
                max_output_tokens=min(pricing.max_output_tokens, 2500),
            )
        except AIError as exc:
            logger.warning("[hacksim.review] %s failed: %s", operation, exc)
            record_usage(
                self.service,
                operation=operation,
                provider=pricing.provider,
                model=pricing.model_name,
                prompt_version=prompt_version,
                input_tokens=0,
                output_tokens=0,
                cached_tokens=0,
                cache_miss_tokens=0,
                cost_usd=Decimal(0),
                request_id=None,
                status="failed",
                duration_ms=0,
                user_id=actor_id,
                submission_id=submission_id,
                repository_id=repository_id,
                session_id=session_id,
                error_code=exc.code,
                error_message=str(exc),
            )
            save_analysis(
                self.service,
                analysis_type=scope_key,
                provider=pricing.provider,
                model=pricing.model_name,
                prompt_version=prompt_version,
                ctx_hash=ctx_hash,
                status="failed",
                result_payload=None,
                input_tokens=0,
                output_tokens=0,
                total_tokens=0,
                cached_tokens=0,
                cache_miss_tokens=0,
                cost_usd=Decimal(0),
                repository_id=repository_id,
                submission_id=submission_id,
                scope_key=scope_key,
                error_code=exc.code,
                error_message=str(exc),
            )
            return None

        # §57 — cost from the provider's own reported usage.
        cost = calculate_cost(
            pricing,
            cached_tokens=response.cached_tokens,
            cache_miss_tokens=response.cache_miss_tokens,
            output_tokens=response.output_tokens,
        )
        status = "success" if response.valid_json else "failed"
        error_code = None if response.valid_json else "invalid_json"

        record_usage(
            self.service,
            operation=operation,
            provider=pricing.provider,
            model=response.model,
            prompt_version=prompt_version,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            cached_tokens=response.cached_tokens,
            cache_miss_tokens=response.cache_miss_tokens,
            cost_usd=cost,
            request_id=response.request_id,
            status=status,
            duration_ms=response.duration_ms,
            user_id=actor_id,
            submission_id=submission_id,
            repository_id=repository_id,
            session_id=session_id,
            error_code=error_code,
            error_message=None if response.valid_json else "Provider did not return valid JSON.",
        )

        save_analysis(
            self.service,
            analysis_type=scope_key,
            provider=pricing.provider,
            model=response.model,
            prompt_version=prompt_version,
            ctx_hash=ctx_hash,
            status=status,
            result_payload=response.parsed,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            total_tokens=response.total_tokens,
            cached_tokens=response.cached_tokens,
            cache_miss_tokens=response.cache_miss_tokens,
            cost_usd=cost,
            repository_id=repository_id,
            submission_id=submission_id,
            scope_key=scope_key,
            error_code=error_code,
            error_message=None if response.valid_json else "Provider did not return valid JSON.",
        )

        return response

    # ── Persistence ────────────────────────────────────────────

    def _pricing(self) -> ModelPricing | None:
        from app.services.ai.cost import load_pricing

        return load_pricing(self.service)

    def _load_review(self, submission_id: str | None, repository_id: str | None) -> dict:
        if not submission_id or not repository_id:
            return {"data": {}}
        result = (
            self.service.table("project_reviews")
            .select("*")
            .eq("submission_id", submission_id)
            .eq("repository_id", repository_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0] if rows else {"data": {}}

    def _upsert_review(
        self,
        submission_id: str | None,
        repository_id: str | None,
        results: dict[str, Any],
        outcome: ReviewOutcome,
        pricing: ModelPricing | None = None,
    ) -> str | None:
        if not submission_id or not repository_id:
            return None

        payload = {
            "submission_id": submission_id,
            "repository_id": repository_id,
            "status": outcome.status,
            "model": pricing.model_name if pricing else None,
            "prompt_version": M.PROMPT_VERSIONS["alignment"],
            "estimated_cost_usd": float(outcome.total_cost_usd),
            "total_tokens": outcome.total_tokens,
            "summary": results.get("summary"),
            "problem_alignment": results.get("problem_alignment"),
            "requirements": results.get("requirements"),
            "constraints": results.get("constraints"),
            "expected_outcomes": results.get("expected_outcomes"),
            "evaluation_criteria": results.get("evaluation_criteria"),
            "architecture": results.get("architecture"),
            "implementation": results.get("implementation"),
            "security": results.get("security"),
            "database_review": results.get("database"),
            "testing": results.get("testing"),
            "scalability": results.get("scalability"),
            "technical_decisions": results.get("technical_decisions"),
            "contributions": results.get("contributions"),
        }
        payload = {k: v for k, v in payload.items() if v is not None}

        try:
            existing = (
                self.service.table("project_reviews")
                .select("id")
                .eq("submission_id", submission_id)
                .eq("repository_id", repository_id)
                .limit(1)
                .execute()
            )
            rows = existing.data or []
            if rows:
                self.service.table("project_reviews").update(payload).eq("id", rows[0]["id"]).execute()
                return rows[0]["id"]

            inserted = self.service.table("project_reviews").insert(payload).execute()
            created = inserted.data or []
            return created[0]["id"] if created else None
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hacksim.review] could not persist review: %s", exc)
            return None

    def _replace_requirement_evaluations(
        self, submission_id: str | None, modules: list[M.ModuleResult], evidence_ids: set[str]
    ) -> None:
        if not submission_id:
            return

        rows: list[dict[str, Any]] = []
        for module in modules:
            data = module.data or {}

            for entry in data.get("requirements") or []:
                if not isinstance(entry, dict) or not entry.get("requirement_id"):
                    continue
                rows.append(
                    {
                        "submission_id": submission_id,
                        "requirement_id": str(entry["requirement_id"])[:32],
                        "status": _one_of(entry.get("status"), M.REQUIREMENT_STATUSES, "unable_to_determine"),
                        "evidence_ids": [
                            i for i in (entry.get("evidence_ids") or []) if i in evidence_ids
                        ][:12],
                        "confidence": _one_of(entry.get("confidence"), M.CONFIDENCES, "low"),
                        "explanation": str(entry.get("explanation") or "")[:1500],
                        "source": "deterministic" if module.source == "deterministic" else "ai",
                    }
                )

            for entry in data.get("constraints") or []:
                if isinstance(entry, dict) and entry.get("constraint_id"):
                    rows.append(
                        {
                            "submission_id": submission_id,
                            "requirement_id": str(entry["constraint_id"])[:32],
                            "status": _one_of(entry.get("status"), M.CONSTRAINT_STATUSES, "unable_to_determine"),
                            "evidence_ids": [
                                i for i in (entry.get("evidence_ids") or []) if i in evidence_ids
                            ][:12],
                            "confidence": _one_of(entry.get("confidence"), M.CONFIDENCES, "low"),
                            "explanation": str(entry.get("explanation") or "")[:1500],
                            "source": "ai",
                        }
                    )

            for entry in data.get("expected_outcomes") or []:
                if isinstance(entry, dict) and entry.get("outcome_id"):
                    rows.append(
                        {
                            "submission_id": submission_id,
                            "requirement_id": str(entry["outcome_id"])[:32],
                            "status": _one_of(entry.get("status"), M.OUTCOME_STATUSES, "unclear"),
                            "evidence_ids": [
                                i for i in (entry.get("evidence_ids") or []) if i in evidence_ids
                            ][:12],
                            "confidence": _one_of(entry.get("confidence"), M.CONFIDENCES, "low"),
                            "explanation": str(entry.get("explanation") or "")[:1500],
                            "source": "ai",
                        }
                    )

        if not rows:
            return

        # Replace rather than merge: a re-review is a new answer, not a delta.
        try:
            existing_ids = [
                r["id"]
                for r in (
                    self.service.table("requirement_evaluations")
                    .select("id")
                    .eq("submission_id", submission_id)
                    .execute()
                ).data
                or []
            ]
            if existing_ids:
                self.service.table("requirement_evaluations").delete().eq("submission_id", submission_id).execute()
            self.service.table("requirement_evaluations").upsert(rows, on_conflict="submission_id,requirement_id").execute()
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hacksim.review] could not persist requirement evaluations: %s", exc)

    def _replace_findings(
        self, review_id: str | None, modules: list[M.ModuleResult], evidence_ids: set[str]
    ) -> None:
        if not review_id:
            return

        rows: list[dict[str, Any]] = []
        for module in modules:
            for finding in (module.data or {}).get("findings") or []:
                cited = [i for i in (finding.get("evidence_ids") or []) if i in evidence_ids]
                if not cited:
                    continue
                rows.append(
                    {
                        "project_review_id": review_id,
                        "finding_type": finding.get("finding_type", "observation"),
                        "severity": finding.get("severity", "low"),
                        "title": finding.get("title", "Untitled finding")[:200],
                        "description": (finding.get("description") or "")[:2000],
                        "evidence_ids": cited[:12],
                        "files": (finding.get("files") or [])[:12],
                        "symbols": (finding.get("symbols") or [])[:12],
                        "why_it_matters": (finding.get("why_it_matters") or "")[:1000],
                        "suggested_improvement": (finding.get("suggested_improvement") or "")[:1000],
                        "confidence": finding.get("confidence", "low"),
                    }
                )

        try:
            self.service.table("project_review_findings").delete().eq("project_review_id", review_id).execute()
            if rows:
                self.service.table("project_review_findings").insert(rows).execute()
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hacksim.review] could not persist findings: %s", exc)

    def _replace_defense_targets(
        self,
        submission_id: str | None,
        members: list[dict[str, Any]],
        modules: list[M.ModuleResult],
        requirement_map: dict[str, Any],
        evidence_ids: set[str],
    ) -> None:
        """§50 — topics to prepare for, never questions."""
        if not submission_id:
            return

        targets: list[dict[str, Any]] = []

        # P1: requirements with no evidence. These are the obvious weak spots.
        requirement_texts = {r.get("id"): r.get("text") for r in (requirement_map.get("requirements") or [])}
        for module in modules:
            for entry in (module.data or {}).get("requirements") or []:
                if not isinstance(entry, dict):
                    continue
                status = entry.get("status")
                if status not in ("not_evidenced", "partial_evidence"):
                    continue
                rid = str(entry.get("requirement_id"))
                targets.append(
                    {
                        "submission_id": submission_id,
                        "topic": (requirement_texts.get(rid) or rid)[:300],
                        "reason": (
                            str(entry.get("explanation") or "")[:600]
                            or "The analysed repository did not provide sufficient evidence for this requirement."
                        ),
                        "priority": "P1" if status == "not_evidenced" else "P2",
                        "evidence_ids": [
                            i for i in (entry.get("evidence_ids") or []) if i in evidence_ids
                        ][:10],
                        "question_area": "requirement_coverage",
                        "status": "open",
                    }
                )

        # P0: a member's own contribution that the repository could not support.
        for module in modules:
            if module.module != M.MODULE_D:
                continue
            data = module.data or {}
            if data.get("status") not in ("not_yet_verified", "partially_supported"):
                continue
            member = next(
                (m for m in members if m.get("id") == data.get("member_id")), None
            )
            if not member:
                continue
            targets.append(
                {
                    "submission_id": submission_id,
                    "user_id": member.get("user_id"),
                    "topic": (member.get("contribution_description") or "Your contribution")[:300],
                    "reason": str(data.get("explanation") or "")[:600],
                    "priority": "P0",
                    "evidence_ids": (data.get("evidence_ids") or [])[:10],
                    "question_area": "personal_contribution",
                    "status": "open",
                }
            )

        # P5: confirmed security findings.
        for module in modules:
            for finding in (module.data or {}).get("findings") or []:
                if finding.get("finding_type") != "security_concern":
                    continue
                targets.append(
                    {
                        "submission_id": submission_id,
                        "topic": finding.get("title", "Security concern")[:300],
                        "reason": str(finding.get("why_it_matters") or finding.get("description") or "")[:600],
                        "priority": "P5",
                        "evidence_ids": finding.get("evidence_ids") or [],
                        "question_area": "security",
                        "status": "open",
                    }
                )

        if not targets:
            return

        try:
            self.service.table("defense_targets").delete().eq("submission_id", submission_id).execute()
            # Cap the list; a long one is noise, not preparation.
            self.service.table("defense_targets").insert(targets[:20]).execute()
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hacksim.review] could not persist defense targets: %s", exc)

    @staticmethod
    def _overall_status(modules: list[M.ModuleResult]) -> str:
        if not modules:
            return "pending"
        if all(m.status == "failed" for m in modules):
            return "failed"
        if any(m.status in ("completed", "cached") for m in modules):
            return "completed" if not any(m.status == "failed" for m in modules) else "partial"
        return "partial" if any(m.status == "skipped" for m in modules) else "pending"


# ── Helpers ────────────────────────────────────────────────────────────────


def _one_of(value: Any, allowed: tuple[str, ...], fallback: str) -> str:
    return value if value in allowed else fallback


def _section(payload: Any, evidence_ids: set[str]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"summary": "No result returned.", "source": "skipped"}
    result = {k: v for k, v in payload.items() if k != "evidence_ids"}
    cited = [i for i in (payload.get("evidence_ids") or []) if i in evidence_ids][:12]
    if cited:
        result["evidence_ids"] = cited
    return result


def _requirements_from_deterministic(
    requirements: list[dict[str, Any]], alignment: dict[str, Any]
) -> list[dict[str, Any]]:
    addressed = set(alignment.get("addressed_requirement_ids") or [])
    rows: list[dict[str, Any]] = []
    for requirement in requirements:
        if requirement.get("id") in addressed:
            status = "partial_evidence"
            confidence = "low"
            explanation = (
                "A matching technology was detected, but the specific implementation "
                "was not inspected for this requirement."
            )
        else:
            status = "unable_to_determine"
            confidence = "none"
            explanation = (
                "No matching technology was detected. This does not mean the feature "
                "is absent; the repository was not inspected at code level."
            )
        rows.append(
            {
                "requirement_id": requirement.get("id"),
                "status": status,
                "confidence": confidence,
                "evidence_ids": [],
                "explanation": explanation,
            }
        )
    return rows


def _validate_requirement_rows(
    raw: Any, requirements: list[dict[str, Any]], evidence_ids: set[str]
) -> list[dict[str, Any]]:
    """Keep only rows for real requirement ids, with real evidence ids."""
    if not isinstance(raw, list):
        return []

    known = {r.get("id") for r in requirements}
    rows: list[dict[str, Any]] = []

    for entry in raw:
        if not isinstance(entry, dict):
            continue
        rid = str(entry.get("requirement_id") or "")
        if rid not in known:
            # §49 — never invent a requirement that the brief does not contain.
            continue
        rows.append(
            {
                "requirement_id": rid,
                "status": _one_of(entry.get("status"), M.REQUIREMENT_STATUSES, "unable_to_determine"),
                "confidence": _one_of(entry.get("confidence"), M.CONFIDENCES, "low"),
                "evidence_ids": [
                    i for i in (entry.get("evidence_ids") or []) if i in evidence_ids
                ][:12],
                "explanation": str(entry.get("explanation") or "")[:1500],
            }
        )
    return rows


def _claims_from(submission: dict[str, Any], project_map: dict[str, Any]) -> list[str]:
    claims: list[str] = []
    features = submission.get("key_features") or ""
    for line in features.split("\n"):
        cleaned = line.strip().lstrip("-*• ").strip()
        if len(cleaned) > 8:
            claims.append(cleaned[:200])
    description = (submission.get("project_description") or "").strip()
    if description:
        claims.insert(0, description[:300])
    return claims[:10]


def _deterministic_claims(claims: list[str], project_map: dict[str, Any]) -> dict[str, Any]:
    return {
        "claims": [
            {"claim": claim, "status": "not_evidenced", "evidence_ids": [],
             "explanation": "AI review unavailable; no deterministic evidence matched."}
            for claim in claims
        ]
    }
