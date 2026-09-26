"""Phase 5 persistence.

Writes a :class:`ScanResult` into ``repositories`` / ``repository_files`` /
``code_chunks``, honouring the commit cache from §13: if this exact submission,
commit and scanner version is already analysed, nothing is re-scanned.
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from supabase import Client

from app.core.config import Settings
from app.services.analysis.scanner import SCANNER_VERSION, ScanResult
from app.services.github.client import GitHubClient, GitHubError

logger = logging.getLogger("hacksim.analysis")


class AnalysisStore:
    """All database writes for Phase 5, in one place."""

    def __init__(self, service: Client) -> None:
        self.service = service

    # ── Cache lookup (§13) ────────────────────────────────────

    def cached(self, submission_id: str, commit_sha: str | None) -> dict[str, Any] | None:
        if not commit_sha:
            return None
        result = (
            self.service.table("repositories")
            .select("id, analysis_status, project_map, evidence, analyzed_commit_sha, analysis_version")
            .eq("submission_id", submission_id)
            .eq("analyzed_commit_sha", commit_sha)
            .eq("analysis_version", SCANNER_VERSION)
            .in_("analysis_status", ["completed", "limited"])
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0] if rows else None

    # ── Status transitions ────────────────────────────────────

    def mark_scanning(self, submission_id: str, github_url: str) -> None:
        self.service.table("repositories").upsert(
            {
                "submission_id": submission_id,
                "github_url": github_url,
                "analysis_status": "scanning",
                "analysis_version": SCANNER_VERSION,
                "error_code": None,
                "error_message": None,
            },
            on_conflict="submission_id",
        ).execute()

    def mark_failed(self, submission_id: str, github_url: str, code: str, message: str) -> None:
        self.service.table("repositories").upsert(
            {
                "submission_id": submission_id,
                "github_url": github_url,
                "analysis_status": "failed",
                "analysis_version": SCANNER_VERSION,
                "error_code": code,
                "error_message": message[:500],
            },
            on_conflict="submission_id",
        ).execute()

    def persist(self, submission_id: str, result: ScanResult) -> str:
        """Write a completed scan. Returns the repository id."""
        from datetime import datetime, timezone

        row = (
            self.service.table("repositories")
            .upsert(
                {
                    "submission_id": submission_id,
                    "github_url": f"https://github.com/{result.owner}/{result.repo_name}",
                    "owner": result.owner,
                    "repo_name": result.repo_name,
                    "default_branch": result.default_branch,
                    "latest_commit_sha": result.commit_sha,
                    "analyzed_commit_sha": result.commit_sha,
                    "visibility": result.visibility,
                    "language": result.language,
                    "stars": result.stars,
                    "forks": result.forks,
                    # The column's check constraint is ('completed','limited'),
                    # not the mode names themselves.
                    "analysis_status": (
                        "completed" if result.analysis_mode == "full" else "limited"
                    ),
                    "analysis_version": result.scanner_version,
                    "analysis_mode": result.analysis_mode,
                    "project_map": result.project_map,
                    "evidence": result.evidence,
                    "file_count": result.file_count,
                    "chunk_count": len(result.chunks),
                    "secret_count": result.secret_count,
                    "error_code": None,
                    "error_message": None,
                    "last_analyzed_at": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="submission_id",
            )
            .execute()
        )
        rows = row.data or []
        if not rows:
            raise RuntimeError("Could not persist the repository row.")
        repository_id = rows[0]["id"]

        self._write_files(repository_id, result)
        self._write_chunks(repository_id, result)
        return repository_id

    def _write_files(self, repository_id: str, result: ScanResult) -> None:
        """Inventory rows are rewritten wholesale; a re-scan supersedes them."""
        self.service.table("repository_files").delete().eq("repository_id", repository_id).execute()

        rows: list[dict[str, Any]] = []
        for record in result.files:
            rows.append(
                {
                    "repository_id": repository_id,
                    "path": record["path"],
                    "file_name": record.get("file_name"),
                    "extension": record.get("extension") or None,
                    "language": record.get("language"),
                    "file_size": record.get("file_size"),
                    "line_count": record.get("line_count"),
                    "is_binary": bool(record.get("is_binary")),
                    "is_ignored": bool(record.get("is_ignored")),
                    "file_category": record.get("file_category"),
                    "importance": record.get("importance"),
                    "sha": record.get("sha"),
                }
            )

        for start in range(0, len(rows), 500):
            try:
                self.service.table("repository_files").upsert(
                    rows[start : start + 500], on_conflict="repository_id,path"
                ).execute()
            except Exception as exc:  # noqa: BLE001
                logger.warning("[hacksim.analysis] could not write file rows: %s", exc)
                return

    def _write_chunks(self, repository_id: str, result: ScanResult) -> None:
        """Chunks reference a file id, so they are written after the files."""
        file_ids = (
            self.service.table("repository_files")
            .select("id, path")
            .eq("repository_id", repository_id)
            .execute()
        ).data or []
        id_by_path = {row["path"]: row["id"] for row in file_ids}

        self.service.table("code_chunks").delete().eq("repository_id", repository_id).execute()

        rows: list[dict[str, Any]] = []
        for chunk in result.chunks:
            file_id = id_by_path.get(chunk.get("file_path"))
            if not file_id:
                continue
            rows.append(
                {
                    "repository_id": repository_id,
                    "file_id": file_id,
                    "chunk_index": chunk.get("chunk_index", 0),
                    "start_line": chunk.get("start_line"),
                    "end_line": chunk.get("end_line"),
                    "content": (chunk.get("content") or "")[:20000],
                    "symbol_name": chunk.get("symbol_name"),
                    "symbol_type": chunk.get("symbol_type"),
                    "language": chunk.get("language"),
                    "importance": chunk.get("importance"),
                }
            )

        for start in range(0, len(rows), 400):
            try:
                self.service.table("code_chunks").upsert(
                    rows[start : start + 400], on_conflict="file_id,chunk_index"
                ).execute()
            except Exception as exc:  # noqa: BLE001
                logger.warning("[hacksim.analysis] could not write chunk rows: %s", exc)
                return

    def load_for_review(self, submission_id: str) -> dict[str, Any] | None:
        """Everything the Phase 6 reviewer needs, in one read."""
        repository = (
            self.service.table("repositories")
            .select("*")
            .eq("submission_id", submission_id)
            .limit(1)
            .execute()
        ).data
        if not repository:
            return None
        repo = repository[0]

        files = (
            self.service.table("repository_files")
            .select("id, path, file_name, language, file_category, importance, is_ignored, is_binary, line_count")
            .eq("repository_id", repo["id"])
            .eq("is_ignored", False)
            .execute()
        ).data or []

        chunks = (
            self.service.table("code_chunks")
            .select("file_id, chunk_index, start_line, end_line, content, symbol_name, symbol_type, language, importance")
            .eq("repository_id", repo["id"])
            .eq("importance", "high")
            .limit(600)
            .execute()
        ).data or []

        # Chunks reference paths via file_id; restore it for retrieval ranking.
        path_by_id = {row["id"]: row["path"] for row in files}
        for chunk in chunks:
            chunk["file_path"] = path_by_id.get(chunk["file_id"])

        return {
            "repository": repo,
            "files": files,
            "chunks": [c for c in chunks if c.get("file_path")],
            "evidence": repo.get("evidence") or [],
            "project_map": repo.get("project_map") or {},
        }


def analyze_submission(
    *,
    service: "Client",
    settings: Settings,
    client: GitHubClient,
    submission_id: str,
    github_url: str,
) -> dict[str, Any]:
    """Run Phase 5 for one submission, with the commit cache in front.

    Never raises for an expected failure: a GitHub outage records a ``failed``
    repository and leaves the submission untouched (§89).
    """
    store = AnalysisStore(service)

    try:
        owner, repo = client.parse_repository_url(github_url)
    except GitHubError as exc:
        store.mark_failed(submission_id, github_url, exc.code, str(exc))
        return {"status": "failed", "error": str(exc), "code": exc.code}

    store.mark_scanning(submission_id, github_url)

    try:
        result = scan_repository_safe(client, owner, repo, settings)
    except GitHubError as exc:
        store.mark_failed(submission_id, github_url, exc.code, str(exc))
        return {"status": "failed", "error": str(exc), "code": exc.code}
    except Exception as exc:  # noqa: BLE001
        logger.exception("[hacksim.analysis] scan failed")
        store.mark_failed(submission_id, github_url, "scanner_error", str(exc))
        return {"status": "failed", "error": str(exc), "code": "scanner_error"}

    cached = store.cached(submission_id, result.commit_sha)
    if cached:
        logger.info("[hacksim.analysis] commit %s already analysed; reusing", result.commit_sha[:12])
        return {
            "status": "cached",
            "repository_id": cached["id"],
            "project_map": cached.get("project_map"),
        }

    repository_id = store.persist(submission_id, result)
    return {
        "status": result.analysis_mode,
        "repository_id": repository_id,
        "commit_sha": result.commit_sha,
        "file_count": result.file_count,
        "evidence_count": len(result.evidence),
    }


def scan_repository_safe(client: GitHubClient, owner: str, repo: str, settings: Settings) -> ScanResult:
    from app.services.analysis.scanner import scan_repository

    return scan_repository(client, owner, repo, settings)
