"""Analysis endpoints (Phase 5 + Phase 6).

Three verbs, and the split between them is the whole authorisation story:

* ``POST /api/analysis/submissions/{id}/repository``  — run Phase 5
* ``POST /api/analysis/submissions/{id}/review``      — run Phase 6
* ``GET  /api/analysis/submissions/{id}``              — read the result

Students may only act on a submission their team owns. Everything is re-checked
server-side with the service client, because the browser holds the anon key and
cannot be trusted to have done it.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from supabase import Client

from app.core.config import Settings, get_settings
from app.core.security import CurrentUser, get_service_client
from app.services.analysis.pipeline import AnalysisStore, analyze_submission
from app.services.ai.review import Reviewer
from app.services.github.client import GitHubClient

logger = logging.getLogger("hacksim.api.analysis")

router = APIRouter()


def _github_client(settings: Annotated[Settings, Depends(get_settings)]) -> GitHubClient:
    return GitHubClient(settings)


GitHubDep = Annotated[GitHubClient, Depends(_github_client)]


# ── Authorisation ──────────────────────────────────────────────────────────


def _load_submission(service: Client, submission_id: str) -> dict[str, Any]:
    result = (
        service.table("submissions")
        .select("*")
        .eq("id", submission_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="That submission was not found."
        )
    return rows[0]


def _require_team_access(
    service: Client, submission: dict[str, Any], user: dict
) -> None:
    """Admins pass. Everyone else must be on the session's team.

    Membership is resolved from ``team_members`` server-side rather than from a
    client-supplied claim.
    """
    if user.get("role") == "admin":
        return

    user_id = user.get("id")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session."
        )

    session_id = submission.get("session_id")
    if not session_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to perform this action.",
        )

    result = (
        service.table("build_sessions")
        .select("team_id")
        .eq("id", session_id)
        .limit(1)
        .execute()
    )
    sessions = result.data or []
    if not sessions:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="That simulation was not found."
        )

    membership = (
        service.table("team_members")
        .select("id")
        .eq("team_id", sessions[0]["team_id"])
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not membership.data:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to perform this action.",
        )


def _hackathon_for(service: Client, submission: dict[str, Any]) -> dict[str, Any]:
    result = (
        service.table("hackathons")
        .select("*")
        .eq("id", submission["hackathon_id"])
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="That hackathon was not found."
        )
    return rows[0]


def _members_for(service: Client, submission: dict[str, Any]) -> list[dict[str, Any]]:
    result = (
        service.table("submission_members")
        .select(
            "id, user_id, contribution_description, contribution_areas, "
            "planned_responsibilities, ai_tools_used, ai_usage_description"
        )
        .eq("submission_id", submission["id"])
        .execute()
    )
    members = result.data or []

    if not members:
        return []

    user_ids = [m["user_id"] for m in members if m.get("user_id")]
    if not user_ids:
        return members

    profiles = (
        service.table("profiles")
        .select("id, full_name, email")
        .in_("id", user_ids)
        .execute()
    ).data or []
    by_id = {p["id"]: p for p in profiles}

    for member in members:
        profile = by_id.get(member.get("user_id"))
        if profile:
            member["full_name"] = profile.get("full_name")
            member["email"] = profile.get("email")
    return members


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("/submissions/{submission_id}")
def get_analysis(
    submission_id: str,
    user: CurrentUser,
    service: Annotated[Client, Depends(get_service_client)],
) -> dict[str, Any]:
    """The full analysis payload. Students get it minus the AI cost fields."""
    submission = _load_submission(service, submission_id)
    _require_team_access(service, submission, user)

    result = service.rpc("submission_analysis", {"p_submission_id": submission_id}).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not load the analysis.",
        )
    return result.data or {}


@router.post("/submissions/{submission_id}/repository")
def analyze_repository(
    submission_id: str,
    user: CurrentUser,
    service: Annotated[Client, Depends(get_service_client)],
    github: GitHubDep,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Phase 5. Deterministic, and free of AI tokens."""
    submission = _load_submission(service, submission_id)
    _require_team_access(service, submission, user)

    github_url = (submission.get("github_url") or "").strip()
    if not github_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Add a GitHub repository URL to the submission first.",
        )

    try:
        outcome = analyze_submission(
            service=service,
            settings=settings,
            client=github,
            submission_id=submission_id,
            github_url=github_url,
        )
    finally:
        github.close()

    if outcome["status"] == "failed":
        # §89 — the submission itself is untouched and the failure is recorded.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=outcome.get("error") or "Repository analysis failed.",
        )

    return outcome


@router.post("/submissions/{submission_id}/review")
def run_review(
    submission_id: str,
    user: CurrentUser,
    service: Annotated[Client, Depends(get_service_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    only_module: str | None = None,
) -> dict[str, Any]:
    """Phase 6. Runs the modules the budget and evidence allow.

    ``only_module`` retries a single failed module without re-running the
    successful ones (§89).
    """
    submission = _load_submission(service, submission_id)
    _require_team_access(service, submission, user)

    store = AnalysisStore(service)
    loaded = store.load_for_review(submission_id)
    if not loaded or loaded["repository"].get("analysis_status") not in ("completed", "limited"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Analyse the repository before running an AI review.",
        )

    hackathon = _hackathon_for(service, submission)
    members = _members_for(service, submission)

    reviewer = Reviewer(service=service, settings=settings)
    outcome = reviewer.run(
        submission=submission,
        hackathon=hackathon,
        repository=loaded["repository"],
        files=loaded["files"],
        chunks=loaded["chunks"],
        evidence=loaded["evidence"],
        project_map=loaded["project_map"],
        members=members,
        actor_id=user.get("id"),
        session_id=submission.get("session_id"),
        only_modules=[only_module] if only_module else None,
    )

    return {
        "status": outcome.status,
        "review_id": outcome.review_id,
        "modules": [
            {
                "module": m.module,
                "status": m.status,
                "source": m.source,
                "reason": m.reason,
                "input_tokens": m.input_tokens,
                "output_tokens": m.output_tokens,
                "error": m.error_code,
            }
            for m in outcome.modules
        ],
        "error": outcome.error,
    }


@router.post("/submissions/{submission_id}/reanalyze")
def reanalyze(
    submission_id: str,
    user: CurrentUser,
    service: Annotated[Client, Depends(get_service_client)],
    github: GitHubDep,
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict[str, Any]:
    """Force a fresh Phase 5 scan, bypassing the commit cache."""
    submission = _load_submission(service, submission_id)
    _require_team_access(service, submission, user)

    github_url = (submission.get("github_url") or "").strip()
    if not github_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This submission has no GitHub repository URL.",
        )

    # Mark the cached row stale so analyze_submission does not short-circuit.
    service.table("repositories").update({"analysis_status": "stale"}).eq(
        "submission_id", submission_id
    ).execute()

    try:
        return analyze_submission(
            service=service,
            settings=settings,
            client=github,
            submission_id=submission_id,
            github_url=github_url,
        )
    finally:
        github.close()


@router.post("/submissions/{submission_id}/retry-module")
def retry_module(
    submission_id: str,
    user: CurrentUser,
    service: Annotated[Client, Depends(get_service_client)],
    settings: Annotated[Settings, Depends(get_settings)],
    module: str,
) -> dict[str, Any]:
    """Retry one failed module only (§89)."""
    submission = _load_submission(service, submission_id)
    _require_team_access(service, submission, user)

    store = AnalysisStore(service)
    loaded = store.load_for_review(submission_id)
    if not loaded:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="No repository analysis to review."
        )

    reviewer = Reviewer(service=service, settings=settings)
    outcome = reviewer.run(
        submission=submission,
        hackathon=_hackathon_for(service, submission),
        repository=loaded["repository"],
        files=loaded["files"],
        chunks=loaded["chunks"],
        evidence=loaded["evidence"],
        project_map=loaded["project_map"],
        members=_members_for(service, submission),
        actor_id=user.get("id"),
        session_id=submission.get("session_id"),
        only_modules=[module],
    )

    return {"status": outcome.status, "review_id": outcome.review_id}
