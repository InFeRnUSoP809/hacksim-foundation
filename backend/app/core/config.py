"""Application configuration.

Every secret is read from the environment. Nothing here has a default that
would let the service start with a real credential baked in.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven settings for the HackSim API."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Supabase ───────────────────────────────────────────────
    supabase_url: str = ""
    supabase_anon_key: str = ""
    # SERVER-SIDE ONLY. This key bypasses Row Level Security and must never be
    # shipped to a browser. It is what lets the API perform privileged work
    # (session expiry sweeps, admin reads) while RLS still protects the client.
    supabase_service_role_key: str = ""

    # ── App ────────────────────────────────────────────────────
    app_env: str = "development"
    cors_origins: str = "http://localhost:5173"

    # ── Guards ─────────────────────────────────────────────────
    # Simple fixed-window rate limit, per client, in memory. Swap for Redis
    # before running more than one process.
    rate_limit_per_minute: int = 60

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
