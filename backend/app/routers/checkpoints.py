"""Checkpoint reads and writes for a running simulation."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.core.security import CurrentUser, ScopedClient

router = APIRouter()

CHECKPOINT_TYPES = {
    "planning",
    "building",
    "progress",
    "remaining_work",
    "final_preparation",
}


class CheckpointPayload(BaseModel):
    checkpoint_type: str
    response: str = Field(max_length=4000)


@router.get("/{session_id}")
def list_checkpoints(session_id: str, user: CurrentUser, client: ScopedClient) -> list[dict]:
    result = (
        client.table("build_checkpoints")
        .select(
            "id, session_id, checkpoint_type, response, completed_at, created_at, updated_at"
        )
        .eq("session_id", session_id)
        .execute()
    )
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return result.data or []


@router.put("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def save_checkpoint(
    session_id: str, payload: CheckpointPayload, user: CurrentUser, client: ScopedClient
) -> None:
    if payload.checkpoint_type not in CHECKPOINT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Unknown checkpoint type.",
        )

    # The RLS policy on build_checkpoints only allows writes while the session
    # is 'running', so an expired run is rejected by the database rather than
    # by a check here.
    result = (
        client.table("build_checkpoints")
        .upsert(
            {
                "session_id": session_id,
                "checkpoint_type": payload.checkpoint_type,
                "response": payload.response.strip(),
                "completed_at": _now_iso(),
            },
            on_conflict="session_id,checkpoint_type",
        )
        .execute()
    )

    if result.error:
        detail = result.error.message
        code = (
            status.HTTP_409_CONFLICT
            if "expired" in detail.lower() or "finished" in detail.lower()
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(status_code=code, detail=detail or "Could not save the checkpoint.")


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
