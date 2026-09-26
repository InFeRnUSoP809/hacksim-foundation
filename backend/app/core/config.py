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

    # ── GitHub (Phase 5) ───────────────────────────────────────
    # Optional. Without a token GitHub still answers, but at 60 requests/hour
    # per IP, which the scanner will exhaust on a real repository.
    github_token: str = ""
    github_api_base: str = "https://api.github.com"
    github_timeout_seconds: float = 20.0
    github_max_retries: int = 3

    # ── DeepSeek (Phase 6) ─────────────────────────────────────
    # SERVER-SIDE ONLY. Never exposed to React, never written to the database.
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-flash"
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_timeout_seconds: float = 60.0

    # ── Analysis budgets (defaults only) ───────────────────────
    # The live values live in `ai_budgets`; these are the fallbacks used when
    # no row has been created yet.
    analysis_max_files: int = 400
    analysis_large_repo_threshold: int = 2000
    analysis_max_file_bytes: int = 400_000
    retrieval_max_files: int = 6
    retrieval_max_snippet_lines: int = 120

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

    @property
    def has_deepseek(self) -> bool:
        """False means Phase 6 is unavailable; Phase 5 still works."""
        return bool(self.deepseek_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
