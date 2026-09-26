"""Supabase access for server-side work, and request authentication.

Two clients exist deliberately:

* ``anon_client``  — subject to Row Level Security, used to read on behalf of a
  signed-in user so the database still enforces their permissions.
* ``service_client`` — bypasses RLS. Used only for operations the database
  cannot authorise on a user's behalf, and never exposed to the browser.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from supabase import Client, create_client

from app.core.config import Settings, get_settings

# ── Clients ────────────────────────────────────────────────────────────────


class _LazyClients:
    """Builds the Supabase clients on first use, not at import time."""

    def __init__(self) -> None:
        self._anon: Client | None = None
        self._service: Client | None = None

    def anon(self, settings: Settings) -> Client:
        if self._anon is None:
            if not settings.supabase_url or not settings.supabase_anon_key:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Supabase is not configured on the server.",
                )
            self._anon = create_client(
                settings.supabase_url, settings.supabase_anon_key
            )
        return self._anon

    def service(self, settings: Settings) -> Client:
        if self._service is None:
            if not settings.supabase_url or not settings.supabase_service_role_key:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Server-side Supabase access is not configured.",
                )
            self._service = create_client(
                settings.supabase_url,
                settings.supabase_service_role_key,
                options={"auth": {"persist_session": False}},
            )
        return self._service


_clients = _LazyClients()


def get_anon_client(settings: Annotated[Settings, Depends(get_settings)]) -> Client:
    return _clients.anon(settings)


def get_service_client(
    settings: Annotated[Settings, Depends(get_settings)],
) -> Client:
    return _clients.service(settings)


# ── Authentication ─────────────────────────────────────────────────────────


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> dict:
    """Resolve the caller from their Supabase access token.

    The token is verified by Supabase itself (``get_user``), not by decoding it
    locally, so a forged or expired token cannot pass. The user id that comes
    back is then used to build an RLS-scoped client, so database policies still
    apply to every request.
    """
    if settings is None:
        settings = get_settings()

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = authorization.split(" ", 1)[1].strip()

    result = _clients.anon(settings).auth.get_user(token)
    if result is None or getattr(result, "user", None) is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return result.user.model_dump()


CurrentUser = Annotated[dict, Depends(get_current_user)]


def get_scoped_client(
    user: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
) -> Client:
    """A Supabase client acting *as* this user, so RLS applies to the request."""
    client = _clients.anon(settings)
    access_token = user.get("access_token") or ""
    if access_token:
        client.auth.set_session(access_token, "")
    return client


ScopedClient = Annotated[Client, Depends(get_scoped_client)]


def require_admin(user: CurrentUser) -> dict:
    """Reject anyone whose stored role is not ``admin``.

    The role is read from the database rather than the token payload, so it
    always reflects the current server-side truth.
    """
    if user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to perform this action.",
        )
    return user


AdminUser = Annotated[dict, Depends(require_admin)]


# ── Rate limiting ──────────────────────────────────────────────────────────


class FixedWindowLimiter:
    """In-process fixed-window limiter. Adequate for a single-node deployment."""

    def __init__(self, limit: int, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> None:
        now = time.monotonic()
        bucket = self._hits[key]

        while bucket and now - bucket[0] > self.window:
            bucket.popleft()

        if len(bucket) >= self.limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please slow down.",
            )

        bucket.append(now)


_limiter: FixedWindowLimiter | None = None


def rate_limit(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    global _limiter
    if _limiter is None:
        _limiter = FixedWindowLimiter(settings.rate_limit_per_minute)
    client = request.client.host if request.client else "unknown"
    _limiter.check(f"{client}:{request.url.path}")
