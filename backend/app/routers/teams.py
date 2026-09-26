"""Team reads and membership."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.core.security import CurrentUser, ScopedClient

router = APIRouter()


class CreateTeamPayload(BaseModel):
    name: str = Field(min_length=2, max_length=60)


class AddMemberPayload(BaseModel):
    email: str


@router.get("/mine")
def my_team(user: CurrentUser, client: ScopedClient) -> dict:
    result = (
        client.table("team_members")
        .select("team_id")
        .eq("user_id", user["id"])
        .limit(1)
        .maybe_single()
        .execute()
    )
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    if not result.data:
        return {"team": None, "members": []}

    team_id = result.data["team_id"]
    team = (
        client.table("teams")
        .select("id, name, created_by, created_at, updated_at")
        .eq("id", team_id)
        .maybe_single()
        .execute()
    )
    roster = client.rpc("team_roster", {"p_team_id": team_id}).execute()

    return {"team": team.data, "members": roster.data or []}


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_team(payload: CreateTeamPayload, user: CurrentUser, client: ScopedClient) -> dict:
    result = client.rpc("create_team", {"p_name": payload.name.strip()}).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return {"team_id": result.data}


@router.post("/{team_id}/members", status_code=status.HTTP_201_CREATED)
def add_member(
    team_id: str, payload: AddMemberPayload, user: CurrentUser, client: ScopedClient
) -> dict:
    result = client.rpc(
        "add_team_member", {"p_team_id": team_id, "p_email": payload.email.strip()}
    ).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return {"member_id": result.data}


@router.post("/{session_id}/start", status_code=status.HTTP_201_CREATED)
def start_simulation(
    session_id: str, hackathon_id: str, user: CurrentUser, client: ScopedClient
) -> dict:
    """Start a run after re-validating team, practice availability, and conflicts.

    ``session_id`` is accepted for route symmetry; the new id comes back from
    the database.
    """
    del session_id
    result = client.rpc("start_build_session", {"p_hackathon_id": hackathon_id}).execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return {"session_id": result.data}
