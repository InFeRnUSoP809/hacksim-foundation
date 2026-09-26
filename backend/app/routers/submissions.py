"""Submission validation, drafts, and finalisation.

The database owns the finalisation lock, so this router only pre-validates for
a better error message and then calls the guarded RPC.
"""

from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.core.security import CurrentUser, ScopedClient

router = APIRouter()

GITHUB_REPO_RE = re.compile(
    r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$"
)
HTTP_URL_RE = re.compile(r"^https?://[^\s/$.?#].[^\s]*$")


class DraftPayload(BaseModel):
    project_name: str = Field(min_length=1, max_length=160)
    project_description: str = ""
    github_url: str = ""
    live_demo_url: str = ""
    tech_stack: str = ""
    key_features: str = ""


class ContributionPayload(BaseModel):
    contribution_description: str = ""
    contribution_areas: list[str] = Field(default_factory=list)
    planned_responsibilities: str = ""
    ai_tools_used: str = ""
    ai_usage_description: str = ""


def _validate(payload: DraftPayload) -> None:
    """Shape-only checks. Phase 4 never fetches or analyses either URL."""
    github = payload.github_url.strip()
    demo = payload.live_demo_url.strip()

    if github and not GITHUB_REPO_RE.match(github):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid GitHub URL.",
        )
    if demo and not HTTP_URL_RE.match(demo):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid live demo URL.",
        )


@router.post("/{session_id}/draft", status_code=status.HTTP_200_OK)
def save_draft(
    session_id: str,
    payload: DraftPayload,
    user: CurrentUser,
    client: ScopedClient,
) -> dict:
    _validate(payload)

    result = client.rpc(
        "save_submission_draft",
        {
            "p_session_id": session_id,
            "p_project_name": payload.project_name,
            "p_project_description": payload.project_description,
            "p_github_url": payload.github_url,
            "p_live_demo_url": payload.live_demo_url,
            "p_tech_stack": payload.tech_stack,
            "p_key_features": payload.key_features,
        },
    ).execute()

    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )

    return {"submission_id": result.data}


@router.post("/{submission_id}/contribution", status_code=status.HTTP_204_NO_CONTENT)
def save_contribution(
    submission_id: str,
    payload: ContributionPayload,
    user: CurrentUser,
    client: ScopedClient,
) -> None:
    """Save only the caller's own contribution.

    The RPC pins ``user_id`` to the authenticated caller, so this cannot be used
    to write another member's disclosure.
    """
    result = client.rpc(
        "save_my_contribution",
        {
            "p_submission_id": submission_id,
            "p_contribution_description": payload.contribution_description,
            "p_contribution_areas": payload.contribution_areas,
            "p_planned_responsibilities": payload.planned_responsibilities,
            "p_ai_tools_used": payload.ai_tools_used,
            "p_ai_usage_description": payload.ai_usage_description,
        },
    ).execute()

    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )


@router.post("/{session_id}/finalize", status_code=status.HTTP_200_OK)
def finalize(session_id: str, user: CurrentUser, client: ScopedClient) -> dict:
    """Finalise the submission and lock it.

    The lock is a database trigger, so it holds for the browser, this API, and
    any direct PostgREST call alike.
    """
    result = client.rpc("finalize_submission", {"p_session_id": session_id}).execute()

    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )

    return {"submission_id": result.data}
