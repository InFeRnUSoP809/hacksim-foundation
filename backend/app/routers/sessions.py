"""Server-authoritative simulation clock and status transitions.

The endpoints here are thin: the real validation lives in the ``session_state``
and ``set_session_status`` SQL functions, so the browser and this API enforce
identical rules.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from supabase import Client

from app.core.security import CurrentUser, ScopedClient

router = APIRouter()

LIVE_STATUSES = {"running", "break"}


class SessionState(BaseModel):
    id: str
    status: str
    remaining_seconds: int = Field(ge=0)
    break_remaining_seconds: int = Field(ge=0)
    server_now: str


class StatusChange(BaseModel):
    status: str = Field(pattern="^(running|break|completed)$")
    break_minutes: int | None = Field(default=None, ge=1, le=120)


@router.get("/{session_id}/state", response_model=SessionState)
def get_state(session_id: str, user: CurrentUser, client: ScopedClient) -> SessionState:
    """Return the countdown, computed from the database clock.

    The client uses this to correct for a wrong device clock; it never derives
    remaining time on its own.
    """
    result = client.rpc("session_state", {"p_session_id": session_id}).execute()

    rows = result.data or []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Simulation not found.",
        )

    row = rows[0]
    return SessionState(
        id=session_id,
        status=row["status"],
        remaining_seconds=int(row.get("remaining_seconds") or 0),
        break_remaining_seconds=int(row.get("break_remaining_seconds") or 0),
        server_now=row["server_now"],
    )


@router.post("/{session_id}/status", status_code=status.HTTP_204_NO_CONTENT)
def change_status(
    session_id: str,
    change: StatusChange,
    user: CurrentUser,
    client: ScopedClient,
) -> None:
    """Move a live run into break, back to running, or to completed."""
    result = client.rpc(
        "set_session_status",
        {
            "p_session_id": session_id,
            "p_status": change.status,
            "p_break_minutes": change.break_minutes,
        },
    ).execute()

    if result.error:
        # Surface the database's own message, which is already user-facing,
        # rather than a stack trace or a raw driver message.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.error.message,
        )
