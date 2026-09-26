"""HackSim API.

A thin, well-layered FastAPI service. Business rules stay in Postgres (RLS
policies and SECURITY DEFINER functions), because that is the only place they
can be trusted: the browser holds just the anon key. This service exists for
work that genuinely needs a server — scheduled sweeps, privileged reads, and
operations that will call out to external providers in later phases.
"""

from __future__ import annotations

import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import Settings, get_settings
from app.core.security import rate_limit
from app.routers import (
    admin,
    checkpoints,
    hackathons,
    health,
    sessions,
    submissions,
    teams,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hacksim")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="HackSim API",
        version="1.0.0",
        description=(
            "Server-side operations for HackSim. The database remains the "
            "source of truth; this service never holds a client session."
        ),
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Rate limiting is a dependency rather than middleware so each route can opt
    # in with a stricter budget where it matters.
    app.include_router(health.router, tags=["health"])
    app.include_router(
        hackathons.router, prefix="/api/hackathons", tags=["hackathons"],
        dependencies=[Depends(rate_limit)],
    )
    app.include_router(
        teams.router, prefix="/api/teams", tags=["teams"],
        dependencies=[Depends(rate_limit)],
    )
    app.include_router(
        sessions.router, prefix="/api/sessions", tags=["sessions"],
        dependencies=[Depends(rate_limit)],
    )
    app.include_router(
        checkpoints.router, prefix="/api/checkpoints", tags=["checkpoints"],
        dependencies=[Depends(rate_limit)],
    )
    app.include_router(
        submissions.router, prefix="/api/submissions", tags=["submissions"],
        dependencies=[Depends(rate_limit)],
    )
    app.include_router(
        admin.router, prefix="/api/admin", tags=["admin"],
        dependencies=[Depends(rate_limit)],
    )

    if settings.is_production and not settings.supabase_service_role_key:
        # Fail loudly rather than silently degrading in production.
        logger.error(
            "SUPABASE_SERVICE_ROLE_KEY is not set. "
            "Admin endpoints will return 503 until it is configured."
        )

    return app


app = create_app()
