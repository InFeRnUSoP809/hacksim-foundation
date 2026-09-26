"""GitHub REST client.

Deliberately small and boring: cache, retry, back off, and refuse to hammer a
rate limit. Everything the scanner needs is here, and nothing else is.

Two rules from the phase spec shape this module:

* §12 — rate limits are tracked, retried with exponential backoff up to a limit,
  and *never* blindly retried. A rate-limited request raises immediately so the
  scan can degrade instead of stalling.
* §13 — responses are cached for the life of the process, so a re-analysis of
  the same commit does not re-fetch the tree.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.core.config import Settings
from app.services.github.urls import (
    InvalidRepositoryUrl,
    normalized_url,
    parse_repository_url,
)

logger = logging.getLogger("hacksim.github")


class GitHubError(RuntimeError):
    """A GitHub call failed in a way the scanner must handle explicitly."""

    def __init__(self, message: str, code: str, status_code: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass
class RateLimitState:
    limit: int = 0
    # -1 means "unknown". It must not default to 0: a zero default reads as
    # "exhausted" and would refuse the very first request of every scan.
    remaining: int = -1
    reset_epoch: float = 0.0
    # Secondary (abuse) limits are not advertised through headers in a way we
    # can rely on, so we self-impose a small pause after a 403/429.
    cooldown_until: float = 0.0

    @property
    def exhausted(self) -> bool:
        return self.remaining == 0 or time.time() < self.cooldown_until

    def retry_after(self) -> float:
        if self.cooldown_until > time.time():
            return self.cooldown_until - time.time()
        return max(0.0, self.reset_epoch - time.time())

    def to_dict(self) -> dict[str, Any]:
        return {
            "limit": self.limit,
            "remaining": self.remaining,
            "reset_epoch": self.reset_epoch,
            "cooldown_remaining_seconds": round(max(0.0, self.cooldown_until - time.time()), 1),
        }


@dataclass
class GitHubClient:
    settings: Settings
    rate_limit: RateLimitState = field(default_factory=RateLimitState)
    _cache: dict[str, Any] = field(default_factory=dict)
    _client: httpx.Client | None = None

    # ── Lifecycle ─────────────────────────────────────────────

    def _http(self) -> httpx.Client:
        if self._client is None:
            headers = {
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "HackSim-Scanner",
            }
            if self.settings.github_token:
                headers["Authorization"] = f"Bearer {self.settings.github_token}"
            self._client = httpx.Client(
                base_url=self.settings.github_api_base,
                headers=headers,
                timeout=self.settings.github_timeout_seconds,
            )
        return self._client

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    # ── Core request ──────────────────────────────────────────

    def get(self, path: str, *, cache: bool = True) -> Any:
        """GET a GitHub path, returning decoded JSON.

        Raises :class:`GitHubError` with a stable ``code`` so the caller can
        decide whether to degrade (``rate_limited``) or give up (``not_found``).
        """
        if cache and path in self._cache:
            return self._cache[path]

        if self.rate_limit.exhausted:
            raise GitHubError(
                "GitHub rate limit reached; analysis cannot continue right now.",
                code="rate_limited",
                status_code=429,
            )

        last_error: GitHubError | None = None

        for attempt in range(self.settings.github_max_retries):
            try:
                response = self._http().get(path)
            except httpx.TimeoutException as exc:
                last_error = GitHubError(f"GitHub timed out: {exc}", code="timeout")
            except httpx.HTTPError as exc:
                last_error = GitHubError(f"GitHub request failed: {exc}", code="network")
            else:
                self._read_rate_limit_headers(response)

                if response.status_code == 200:
                    if cache:
                        self._cache[path] = response.json()
                    return response.json()

                if response.status_code == 404:
                    raise GitHubError(
                        "That repository, branch or file was not found on GitHub.",
                        code="not_found",
                        status_code=404,
                    )

                if response.status_code in (403, 429):
                    # §12 — never blindly retry a rate-limited request. We record
                    # a cooldown and stop; the caller degrades gracefully.
                    self.rate_limit.cooldown_until = time.time() + min(
                        60.0, 2.0 * (attempt + 1)
                    )
                    self.rate_limit.remaining = 0
                    raise GitHubError(
                        "GitHub rate limit reached; analysis cannot continue right now.",
                        code="rate_limited",
                        status_code=response.status_code,
                    )

                if 500 <= response.status_code < 600:
                    last_error = GitHubError(
                        f"GitHub is unavailable ({response.status_code}).",
                        code="provider_error",
                        status_code=response.status_code,
                    )
                else:
                    raise GitHubError(
                        "GitHub rejected the request.",
                        code="client_error",
                        status_code=response.status_code,
                    )

            # Exponential backoff, but only for retryable transport errors.
            if attempt < self.settings.github_max_retries - 1:
                time.sleep(min(8.0, 0.75 * (2**attempt)))

        raise last_error or GitHubError("GitHub request failed.", code="network")

    def _read_rate_limit_headers(self, response: httpx.Response) -> None:
        # A missing header leaves the previous value alone. Treating "absent" as
        # 0 would mark the client exhausted on any unannotated response.
        try:
            limit = response.headers.get("X-RateLimit-Limit")
            if limit is not None:
                self.rate_limit.limit = int(limit)

            remaining = response.headers.get("X-RateLimit-Remaining")
            if remaining is not None:
                self.rate_limit.remaining = int(remaining)

            reset = response.headers.get("X-RateLimit-Reset")
            if reset is not None and int(reset):
                self.rate_limit.reset_epoch = float(int(reset))
        except (TypeError, ValueError):
            # Malformed headers must never break a scan.
            pass

    # ── §10 URL validation + parsing ──────────────────────────

    def parse_repository_url(self, url: str) -> tuple[str, str]:
        """Return ``(owner, repo)`` or raise. Never touches the network.

        The parsing itself lives in :mod:`app.services.github.urls` so it can
        be tested without the HTTP stack; this wrapper only translates the
        error type.
        """
        try:
            ref = parse_repository_url(url)
        except InvalidRepositoryUrl as exc:
            raise GitHubError(str(exc), code="invalid_url") from exc
        return ref.owner, ref.repo

    @staticmethod
    def normalized_url(owner: str, repo: str) -> str:
        return normalized_url(owner, repo)

    # ── §11 endpoints the scanner uses ────────────────────────

    def repository(self, owner: str, repo: str) -> dict[str, Any]:
        return self.get(f"/repos/{owner}/{repo}")

    def latest_commit(self, owner: str, repo: str, branch: str) -> dict[str, Any]:
        return self.get(f"/repos/{owner}/{repo}/commits/{branch}")

    def git_tree(self, owner: str, repo: str, commit_sha: str) -> dict[str, Any]:
        """Recursive tree. Truncated trees are reported by the caller."""
        return self.get(f"/repos/{owner}/{repo}/git/trees/{commit_sha}?recursive=1")

    def blob(self, owner: str, repo: str, blob_sha: str) -> bytes:
        """Raw file bytes, cached.

        Uses the blob API rather than /contents so a file is fetched in one
        request regardless of size, and we never base64-decode a payload we
        would then throw away.
        """
        if blob_sha in self._cache:
            return self._cache[blob_sha]

        if self.rate_limit.exhausted:
            raise GitHubError(
                "GitHub rate limit reached; analysis cannot continue right now.",
                code="rate_limited",
                status_code=429,
            )

        response = self._http().get(f"/repos/{owner}/{repo}/git/blobs/{blob_sha}")
        self._read_rate_limit_headers(response)

        if response.status_code == 200:
            import base64

            payload = response.json()
            content = base64.b64decode(payload.get("content", ""))
            # Only small files are worth keeping in memory.
            if len(content) <= self.settings.analysis_max_file_bytes:
                self._cache[blob_sha] = content
            return content

        if response.status_code in (403, 429):
            self.rate_limit.cooldown_until = time.time() + 5.0
            self.rate_limit.remaining = 0
            raise GitHubError(
                "GitHub rate limit reached; analysis cannot continue right now.",
                code="rate_limited",
                status_code=response.status_code,
            )

        raise GitHubError(
            f"Could not read a file from the repository (HTTP {response.status_code}).",
            code="blob_error",
            status_code=response.status_code,
        )
