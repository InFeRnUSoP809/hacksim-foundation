"""Liveness and readiness probes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.config import Settings, get_settings
from app.core.security import get_anon_client

router = APIRouter()


class Health(BaseModel):
    status: str
    environment: str
    supabase_configured: bool


@router.get("/health", response_model=Health)
def health(settings: Annotated[Settings, Depends(get_settings)]) -> Health:
    """Liveness probe. Reports configuration without exposing any value."""
    return Health(
        status="ok",
        environment=settings.app_env,
        supabase_configured=bool(
            settings.supabase_url and settings.supabase_anon_key
        ),
    )


@router.get("/ready")
def ready(settings: Annotated[Settings, Depends(get_settings)]) -> dict:
    """Readiness probe: confirms Supabase actually answers."""
    client = get_anon_client(settings)
    client.table("hackathons").select("id", count="exact").limit(1).execute()
    return {"status": "ready", "supabase": "reachable"}
