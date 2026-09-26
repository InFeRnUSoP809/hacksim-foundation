"""GitHub URL parsing (§10).

Kept separate from the HTTP client, and free of third-party imports, so
validation is trivially testable and can be reused by any caller. This never
touches the network: it answers "is this a repository URL, and which one?"
rather than "does this repository exist?".
"""

from __future__ import annotations

import re
from dataclasses import dataclass

ALLOWED = re.compile(r"^[A-Za-z0-9._-]+$")
GITHUB_HOSTS = ("github.com", "www.github.com")


class InvalidRepositoryUrl(ValueError):
    """The URL is not a usable GitHub repository reference."""


@dataclass(frozen=True)
class RepositoryRef:
    owner: str
    repo: str

    @property
    def normalized_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}"


def parse_repository_url(url: str) -> RepositoryRef:
    """Parse any common GitHub repository reference.

    Accepts ``https://github.com/owner/repo``, the ``.git`` suffix, a trailing
    slash, ``git@github.com:owner/repo.git`` and the bare ``github.com/owner/repo``
    form. Anything else raises :class:`InvalidRepositoryUrl` — including a
    ``/tree/main`` or ``/blob/...`` path, which points at a file, not a
    repository.
    """
    raw = (url or "").strip()
    if not raw:
        raise InvalidRepositoryUrl("No repository URL was provided.")

    candidate = raw

    if candidate.startswith("git@github.com:"):
        # SSH form. Convert to the https shape and fall through to the same
        # host + path handling below.
        candidate = candidate.split(":", 1)[1]
    else:
        # Strip the scheme, then require the host to actually be GitHub.
        scheme, separator, rest = candidate.partition("://")
        rest = rest if separator else scheme
        host, _, path = rest.partition("/")
        if host.lower() not in GITHUB_HOSTS:
            raise InvalidRepositoryUrl("Only GitHub repository URLs are supported.")
        candidate = path

    candidate = candidate.split("?", 1)[0].split("#", 1)[0].strip("/")

    if candidate.lower().endswith(".git"):
        candidate = candidate[: -len(".git")]

    parts = [part for part in candidate.split("/") if part]

    if len(parts) != 2:
        raise InvalidRepositoryUrl(
            "Enter a GitHub repository URL, like https://github.com/user/repo"
        )

    owner, repo = parts
    if not ALLOWED.match(owner) or not ALLOWED.match(repo):
        raise InvalidRepositoryUrl(
            "Enter a GitHub repository URL, like https://github.com/user/repo"
        )

    return RepositoryRef(owner=owner, repo=repo)


def normalized_url(owner: str, repo: str) -> str:
    return f"https://github.com/{owner}/{repo}"
