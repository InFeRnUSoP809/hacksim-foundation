"""Hackathon reads and admin configuration."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.core.security import AdminUser, CurrentUser, ScopedClient

router = APIRouter()

PRACTICE_COLUMNS = (
    "id, name, problem_statement, requirements, constraints, expected_outcome, "
    "evaluation_criteria, simulation_duration_minutes, status, practice_enabled, "
    "created_at, updated_at"
)


class HackathonPayload(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    problem_statement: str = Field(min_length=1)
    requirements: str = ""
    constraints: str = ""
    expected_outcome: str = ""
    evaluation_criteria: str = ""
    simulation_duration_minutes: int = Field(ge=1, le=10080)
    status: str = Field(default="draft", pattern="^(draft|active|archived)$")


@router.get("/practice")
def practice_hackathon(user: CurrentUser, client: ScopedClient) -> dict:
    """The practice hackathon, or 404 when practice is switched off.

    Row Level Security already limits a student to exactly this row, so when
    practice is off this genuinely returns nothing rather than hiding a link.
    """
    result = (
        client.table("hackathons")
        .select(PRACTICE_COLUMNS)
        .eq("practice_enabled", True)
        .eq("status", "active")
        .limit(1)
        .maybe_single()
        .execute()
    )

    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active practice hackathon.",
        )

    return result.data


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_hackathon(
    payload: HackathonPayload, user: AdminUser, client: ScopedClient
) -> dict:
    result = client.table("hackathons").insert({**payload.model_dump(), "practice_enabled": False}).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return result.data[0]


@router.put("/{hackathon_id}")
def update_hackathon(
    hackathon_id: str, payload: HackathonPayload, user: AdminUser, client: ScopedClient
) -> dict:
    result = (
        client.table("hackathons")
        .update(payload.model_dump())
        .eq("id", hackathon_id)
        .execute()
    )
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return result.data[0]


@router.post("/{hackathon_id}/practice", status_code=status.HTTP_204_NO_CONTENT)
def set_practice(hackathon_id: str, user: AdminUser, client: ScopedClient) -> None:
    """Enable practice for exactly one hackathon, disabling the previous one.

    The swap happens in a single SQL function, so the partial unique index can
    never be violated and no historical hackathon is deleted.
    """
    result = client.rpc("set_practice_hackathon", {"p_hackathon_id": hackathon_id}).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
