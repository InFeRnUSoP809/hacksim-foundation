"""Phase 5 scanner.

The orchestrator. It walks the tree once, decides what is worth reading,
reads as little as possible, and produces three things:

* ``repository_files`` — the inventory
* ``evidence``         — the facts, each with a stable id
* ``project_map``      — the compact summary Phase 6 consumes

Cost discipline, in order of importance:

1. §14 — never read an ignored or sensitive file.
2. §87 — read only what classification marks as important or medium.
3. §88 — a very large tree switches to ``limited`` mode and tightens further.
4. §9 — a blob fetch is a GitHub API request, so they are budgeted, not sprayed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from app.core.config import Settings
from app.services.analysis.evidence import EvidenceRegistry
from app.services.analysis.project_map import build_project_map
from app.services.github import dependencies as deps_module
from app.services.github import frameworks as framework_module
from app.services.github import symbols as symbols_module
from app.services.github.client import GitHubClient, GitHubError
from app.services.github.ignore import (
    FileFacts,
    category_of,
    extension_of,
    importance_of,
    is_ignored,
    is_sensitive,
    is_source_like,
    language_of,
)
from app.services.github.secrets import count_lines, decode_text, looks_binary, scan_file

logger = logging.getLogger("hacksim.scanner")

SCANNER_VERSION = "p5-1"

# §87 read priority. Anything not in these categories is never fetched.
READ_CATEGORIES = frozenset(
    {"source", "component", "api", "model", "schema", "database", "config", "documentation", "test"}
)
# Config/dependency files that are small and always worth reading.
ALWAYS_READ_NAMES = frozenset(
    {
        "readme.md", "package.json", "requirements.txt", "pyproject.toml",
        "go.mod", "cargo.toml", "pom.xml", "build.gradle", "dockerfile",
        "docker-compose.yml", "docker-compose.yaml", "composer.json",
        "pubspec.yaml", "alembic.ini", "manage.py", "schema.prisma",
    }
)
# Never read, even if the classification would allow it.
NEVER_READ = frozenset({"asset", "unknown"})


@dataclass
class ScanResult:
    owner: str
    repo_name: str
    default_branch: str | None
    commit_sha: str | None
    visibility: str | None
    language: str | None
    stars: int | None
    forks: int | None
    analysis_mode: str
    files: list[dict[str, Any]] = field(default_factory=list)
    chunks: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    project_map: dict[str, Any] = field(default_factory=dict)
    dependencies: list[dict[str, Any]] = field(default_factory=list)
    secret_findings: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    scanner_version: str = SCANNER_VERSION

    @property
    def file_count(self) -> int:
        return len(self.files)

    @property
    def secret_count(self) -> int:
        return len(self.secret_findings)


def scan_repository(
    client: GitHubClient,
    owner: str,
    repo: str,
    settings: Settings,
) -> ScanResult:
    """Run the full deterministic scan. Raises :class:`GitHubError` on failure."""

    metadata = client.repository(owner, repo)
    branch = metadata.get("default_branch") or "main"

    commit = client.latest_commit(owner, repo, branch)
    commit_sha = commit.get("sha")
    if not commit_sha:
        raise GitHubError("Could not determine the latest commit.", code="no_commit")

    tree = client.git_tree(owner, repo, commit_sha)
    entries = [e for e in (tree.get("tree") or []) if e.get("type") == "blob"]
    truncated_tree = bool(tree.get("truncated"))

    analysis_mode = "limited" if (
        truncated_tree or len(entries) > settings.analysis_large_repo_threshold
    ) else "full"

    warnings: list[str] = []
    if truncated_tree:
        warnings.append(
            "GitHub returned a truncated file tree; some paths are not listed by the API."
        )
    if len(entries) > settings.analysis_large_repo_threshold:
        warnings.append(
            f"Repository has {len(entries)} files. Analysis was limited to relevant files."
        )

    registry = EvidenceRegistry()

    # ── 1. Inventory every path, reading nothing yet ────────────────────────
    inventory: list[tuple[dict[str, Any], FileFacts, str, str]] = []
    for entry in entries:
        path = entry.get("path") or ""
        if not path:
            continue
        size = int(entry.get("size") or 0)
        # §14 — an ignored or sensitive file is recorded as ignored and never
        # becomes a fetch candidate.
        if is_ignored(path) or is_sensitive(path):
            facts = FileFacts(path=path, size=size, is_binary=False, sha=entry.get("sha"))
            category = category_of(facts)
            inventory.append(
                (
                    {
                        "path": path,
                        "file_name": path.rsplit("/", 1)[-1],
                        "extension": extension_of(path),
                        "language": language_of(path),
                        "file_size": size,
                        "line_count": None,
                        "is_binary": False,
                        "is_ignored": True,
                        "file_category": category,
                        "importance": "ignored",
                        "sha": entry.get("sha"),
                    },
                    facts,
                    category,
                    "ignored",
                )
            )
            continue

        extension = extension_of(path)
        provisional_binary = extension in (".png", ".jpg", ".pdf", ".zip", ".ico")
        facts = FileFacts(
            path=path,
            size=size,
            is_binary=provisional_binary,
            sha=entry.get("sha"),
        )
        category = category_of(facts)
        importance = importance_of(facts, category)
        inventory.append(
            (
                {
                    "path": path,
                    "file_name": path.rsplit("/", 1)[-1],
                    "extension": extension,
                    "language": language_of(path),
                    "file_size": size,
                    "line_count": None,
                    "is_binary": provisional_binary,
                    "is_ignored": False,
                    "file_category": category,
                    "importance": importance,
                    "sha": entry.get("sha"),
                },
                facts,
                category,
                importance,
            )
        )

    # ── 2. Choose the read set (§87, §88) ──────────────────────────────────
    read_candidates = [
        item
        for item in inventory
        if not item[0]["is_ignored"]
        and item[0]["file_category"] in READ_CATEGORIES
        and item[0]["file_category"] not in NEVER_READ
        and item[0]["file_size"] <= settings.analysis_max_file_bytes
    ]

    # Always read the small, high-signal files first.
    def priority(item: tuple[dict[str, Any], FileFacts, str, str]) -> tuple[int, int]:
        record = item[0]
        name = (record["file_name"] or "").lower()
        if name in ALWAYS_READ_NAMES:
            rank = 0
        elif record["importance"] == "high":
            rank = 1
        elif record["importance"] == "medium":
            rank = 2
        else:
            rank = 3
        return (rank, record["file_size"] or 0)

    read_candidates.sort(key=priority)

    max_reads = settings.analysis_max_files if analysis_mode == "full" else max(
        40, settings.analysis_max_files // 2
    )
    selected = read_candidates[:max_reads]
    if len(read_candidates) > len(selected):
        warnings.append(
            f"{len(read_candidates) - len(selected)} candidate files were not read "
            "to stay within the analysis budget."
        )

    # ── 3. Read, parse, record ─────────────────────────────────────────────
    files: list[dict[str, Any]] = []
    chunks: list[dict[str, Any]] = []
    dependencies: list[dict[str, Any]] = []
    detected_frameworks: list[framework_module.Detection] = []
    detected_databases: list[framework_module.Detection] = []
    detected_auth: list[framework_module.Detection] = []
    routes: list[symbols_module.Route] = []
    all_symbols: list[symbols_module.Symbol] = []
    integrations: list[dict[str, Any]] = []
    secret_findings: list[dict[str, Any]] = []
    test_paths: list[str] = []
    sources_for_code_scan: list[tuple[str, str, int]] = []
    readme: dict[str, Any] | None = None
    config_filenames = [item[0]["file_name"] for item in inventory if item[0]["file_name"]]
    blob_budget_exhausted = False

    for record, facts, category, importance in inventory:
        if record["is_ignored"]:
            files.append(record)
            continue
        if category == "asset":
            record["is_binary"] = True
            record["importance"] = "ignored"
            files.append(record)
            continue
        if symbols_module.is_test_file(record["path"]):
            test_paths.append(record["path"])

    for record, facts, category, importance in selected:
        path = record["path"]
        try:
            blob = client.blob(owner, repo, facts.sha or "")
        except GitHubError as exc:
            if exc.code == "rate_limited":
                blob_budget_exhausted = True
                warnings.append(
                    "GitHub rate limit reached partway through; later files were not read."
                )
                break
            warnings.append(f"Could not read `{path}`.")
            continue

        binary = looks_binary(blob)
        record["is_binary"] = binary
        record["file_size"] = len(blob)
        files.append(record)

        if binary:
            record["importance"] = "ignored"
            continue

        content = decode_text(blob)
        if content is None:
            record["is_binary"] = True
            continue

        record["line_count"] = count_lines(content)
        sources_for_code_scan.append((path, content, 1))

        # Secrets first: if a file leaks a key, we still record it, but the
        # content never leaves this process in a model prompt.
        for finding in scan_file(path, content):
            secret_findings.append(finding.to_dict())
            registry.add(
                type="secret",
                claim=f"Possible hard-coded {finding.secret_type.replace('_', ' ')}",
                file=path,
                lines=str(finding.line),
                confidence="medium",
                detail={"secret_type": finding.secret_type},
            )

        name = (record["file_name"] or "").lower()

        if name in ALWAYS_READ_NAMES or category == "dependency":
            found = deps_module.extract(path, content)
            dependencies.extend(found)

        if name.startswith("readme") and readme is None:
            readme = symbols_module.parse_readme(path, content)
            if readme.get("description"):
                registry.add(
                    type="readme",
                    claim=f"README describes the project: {readme['description'][:160]}",
                    file=path,
                    confidence="high",
                )

        if is_source_like(category):
            file_symbols, parser_status = symbols_module.extract_symbols(path, content)
            if parser_status == "ok":
                for symbol in file_symbols:
                    all_symbols.append(symbol)
                chunks.extend(
                    _chunks_for(path, record, file_symbols, content, importance)
                )
            routes.extend(symbols_module.extract_routes(path, content))
            integrations.extend(symbols_module.extract_external_integrations(content, path))

    # ── 4. Dependency-derived detections ───────────────────────────────────
    detected_frameworks = framework_module.detect_frameworks(dependencies, config_filenames)
    detected_databases = framework_module.detect_databases(
        dependencies, [item["path"] for item in files]
    )
    detected_auth = framework_module.detect_auth(dependencies)
    detected_auth.extend(framework_module.detect_auth_in_code(sources_for_code_scan))
    detected_databases.extend(framework_module.detect_database_in_code(sources_for_code_scan))

    tests = {
        "file_count": len(test_paths),
        "frameworks": symbols_module.detect_test_frameworks(config_filenames, [f["path"] for f in files]),
        "commands": symbols_module.detect_test_commands(
            [(item["path"], content) for item, _, content, _ in selected
             if (item["file_name"] or "").lower() in ("package.json", "makefile", "pyproject.toml")]
        ),
    }

    # ── 5. Evidence ────────────────────────────────────────────────────────
    _record_structural_evidence(
        registry,
        metadata,
        owner,
        repo,
        branch,
        commit_sha,
        detected_frameworks,
        dependencies,
        detected_databases,
        detected_auth,
        routes,
        tests,
        secret_findings,
        files,
        analysis_mode,
    )

    project_map = build_project_map(
        repository={
            "owner": owner,
            "repo_name": repo,
            "default_branch": branch,
            "analyzed_commit_sha": commit_sha,
            "visibility": metadata.get("visibility"),
            "language": metadata.get("language"),
            "stars": metadata.get("stargazers_count"),
            "forks": metadata.get("forks_count"),
            "total_files": len(entries),
        },
        files=files,
        dependencies=[d.to_dict() for d in dependencies],
        frameworks=[d.to_dict() for d in detected_frameworks],
        databases=[d.to_dict() for d in detected_databases],
        auth=[d.to_dict() for d in detected_auth],
        routes=[r.to_dict() for r in routes],
        symbols=[s.to_dict() for s in all_symbols],
        integrations=integrations,
        tests=tests,
        readme=readme,
        secrets=secret_findings,
        analysis_mode=analysis_mode,
        warnings=warnings,
    )

    if blob_budget_exhausted and not project_map.get("apis"):
        raise GitHubError(
            "GitHub rate limit reached before any endpoint could be detected.",
            code="rate_limited",
            status_code=429,
        )

    return ScanResult(
        owner=owner,
        repo_name=repo,
        default_branch=branch,
        commit_sha=commit_sha,
        visibility=metadata.get("visibility"),
        language=metadata.get("language"),
        stars=metadata.get("stargazers_count"),
        forks=metadata.get("forks_count"),
        analysis_mode=analysis_mode,
        files=files,
        chunks=chunks,
        evidence=registry.to_list(),
        project_map=project_map,
        dependencies=[d.to_dict() for d in dependencies],
        secret_findings=secret_findings,
        warnings=warnings,
    )


def _chunks_for(
    path: str,
    record: dict[str, Any],
    file_symbols: list[symbols_module.Symbol],
    content: str,
    importance: str,
) -> list[dict[str, Any]]:
    """One chunk per significant symbol, not per arbitrary line window (§9)."""
    lines = content.split("\n")
    chunks: list[dict[str, Any]] = []

    if not file_symbols:
        if importance == "high" and len(lines) <= 200:
            chunks.append(
                {
                    "file_path": path,
                    "chunk_index": 0,
                    "start_line": 1,
                    "end_line": len(lines),
                    "content": content[:20000],
                    "symbol_name": None,
                    "symbol_type": "file",
                    "language": record.get("language"),
                    "importance": importance,
                }
            )
        return chunks

    for index, symbol in enumerate(file_symbols[:20]):
        start = max(1, symbol.line)
        end = min(len(lines), start + 160)
        body = "\n".join(lines[start - 1 : end])
        if not body.strip():
            continue
        chunks.append(
            {
                "file_path": path,
                "chunk_index": index,
                "start_line": start,
                "end_line": end,
                "content": body[:20000],
                "symbol_name": symbol.name,
                "symbol_type": symbol.symbol_type,
                "language": record.get("language"),
                "importance": importance,
            }
        )
    return chunks


def _record_structural_evidence(
    registry: EvidenceRegistry,
    metadata: dict[str, Any],
    owner: str,
    repo: str,
    branch: str,
    commit_sha: str,
    frameworks: list[framework_module.Detection],
    dependencies: list[deps_module.Dependency],
    databases: list[framework_module.Detection],
    auth: list[framework_module.Detection],
    routes: list[symbols_module.Route],
    tests: dict[str, Any],
    secrets: list[dict[str, Any]],
    files: list[dict[str, Any]],
    analysis_mode: str,
) -> None:
    """Turn every detection into an evidence object (§26)."""

    registry.add(
        type="repository",
        claim=f"Repository {owner}/{repo} analysed at commit {commit_sha[:12]} on branch {branch}",
        confidence="high",
        detail={
            "visibility": metadata.get("visibility"),
            "language": metadata.get("language"),
            "stars": metadata.get("stargazers_count"),
        },
    )
    registry.add(
        type="analysis_mode",
        claim=(
            "Analysis mode limited to relevant files."
            if analysis_mode == "limited"
            else "Full repository analysis."
        ),
        confidence="high",
    )

    for item in frameworks:
        registry.add(
            type="framework",
            claim=f"{item.name} is in use ({item.evidence})",
            file=item.file,
            symbol=item.symbol,
            lines=item.lines,
            confidence="high" if item.file else "medium",
        )

    for dependency in dependencies:
        if dependency.category in ("utility", "testing"):
            continue
        registry.add(
            type="dependency",
            claim=f"Dependency `{dependency.package}` ({dependency.category})",
            symbol=dependency.package,
            confidence="high",
            detail={"category": dependency.category, "version": dependency.version},
        )

    for item in databases:
        registry.add(
            type="database",
            claim=f"{item.name} detected ({item.evidence})",
            file=item.file,
            lines=item.lines,
            confidence="high",
        )

    for item in auth:
        registry.add(
            type="authentication",
            claim=f"{item.name} detected ({item.evidence})",
            file=item.file,
            lines=item.lines,
            confidence="high" if item.file else "medium",
        )

    for route in routes[:120]:
        registry.add(
            type="route",
            claim=f"{route.method} {route.path} exists",
            file=route.file,
            symbol=route.symbol,
            lines=f"{route.line}-{route.line}",
            confidence="high",
            detail={"method": route.method, "framework": route.framework},
        )

    for framework in tests.get("frameworks", []):
        registry.add(
            type="test_framework",
            claim=f"Test framework {framework['name']} detected ({framework['evidence']})",
            confidence="medium",
        )

    if tests.get("file_count"):
        registry.add(
            type="testing",
            claim=f"{tests['file_count']} test files present",
            confidence="medium",
        )

    for secret in secrets:
        registry.add(
            type="secret",
            claim=f"Possible hard-coded {secret['secret_type'].replace('_', ' ')} at {secret['file']}:{secret['line']}",
            file=secret["file"],
            lines=str(secret["line"]),
            confidence="medium",
        )

    schema_files = [f["path"] for f in files if f.get("file_category") in ("schema", "database")]
    for path in schema_files[:20]:
        registry.add(
            type="database_schema",
            claim=f"Schema or migration file present: {path}",
            file=path,
            confidence="high",
        )

    config_files = [
        f["path"] for f in files if f.get("file_category") == "config" and f.get("importance") == "high"
    ]
    for path in config_files[:15]:
        registry.add(
            type="config",
            claim=f"Configuration file present: {path}",
            file=path,
            confidence="medium",
        )
