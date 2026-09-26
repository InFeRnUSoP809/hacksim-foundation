"""Database access helpers.

Supabase clients are provided by `app.core.security`; this module re-exports
them so route modules have one obvious import for anything database-shaped.
"""

from app.core.security import get_anon_client, get_service_client, get_scoped_client

__all__ = ["get_anon_client", "get_service_client", "get_scoped_client"]
