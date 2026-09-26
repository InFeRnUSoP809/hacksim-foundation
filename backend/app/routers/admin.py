"""Admin-only operations.

Everything here is gated twice: the caller must hold the ``admin`` role, and
privileged reads use the service-role client, which is the one place that key
is appropriate. No response ever includes another secret.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from supabase import Client

from app.core.security import AdminUser, ScopedClient, get_service_client
from app.core.config import Settings, get_settings
from typing import Annotated
from fastapi import Depends

router = APIRouter()


@router.get("/stats")
def stats(user: AdminUser, client: ScopedClient) -> dict:
    """Overview counts for the admin dashboard.

    The caller's scoped client is enough here because the underlying
    ``admin_stats`` function is itself ``SECURITY DEFINER`` and refuses
    non-admins.
    """
    result = client.rpc("admin_stats").execute()
    if result.error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=result.error.message
        )
    return result.data


@router.post("/sweep-expired", status_code=status.HTTP_200_OK)
def sweep_expired(
    user: AdminUser,
    service: Annotated[Client, Depends(get_service_client)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    """Mark every elapsed run as expired.

    Students never see a stale ``running`` status: the ``session_state`` RPC
    self-heals on read. This endpoint exists so an operator can reconcile the
    table in bulk, and to give a later phase a hook for a scheduled job.
    """
    now_iso = _now_iso(settings)
    result = (
        service.table("build_sessions")
        .update({"status": "expired"})
        .lte("ends_at", now_iso)
        .in_("status", ["running", "break"])
        .execute()
    )

    if result.error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not reconcile sessions.",
        )

    return {"expired": len(result.data or [])}


def _now_iso(_settings: Settings) -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
