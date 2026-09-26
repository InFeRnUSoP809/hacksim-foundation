"""Project map (§27).

The single most important token decision in Phase 6: the model never sees the
repository. It sees this — a compact, structured summary — plus a handful of
retrieved snippets per task.

Everything here is sized deliberately. Long lists are truncated and the fact
that a list was truncated is recorded, so the model is never misled into
believing a repository contains only eight routes when it contains two hundred.
"""

from __future__ import annotations

from typing import Any

# Caps. These are the difference between a 5k-token prompt and a 200k one.
MAX_ROUTES = 40
MAX_DEPENDENCIES = 45
MAX_FEATURES = 15
MAX_IMPORTANT_FILES = 25
MAX_WARNINGS = 12
MAX_INTEGRATIONS = 12


def _truncated(items: list[Any], cap: int) -> tuple[list[Any], int]:
    return items[:cap], max(0, len(items) - cap)


def build_project_map(
    *,
    repository: dict[str, Any],
    files: list[dict[str, Any]],
    dependencies: list[dict[str, Any]],
    frameworks: list[dict[str, Any]],
    databases: list[dict[str, Any]],
    auth: list[dict[str, Any]],
    routes: list[dict[str, Any]],
    symbols: list[dict[str, Any]],
    integrations: list[dict[str, Any]],
    tests: dict[str, Any],
    readme: dict[str, Any] | None,
    secrets: list[dict[str, Any]],
    analysis_mode: str,
    warnings: list[str],
) -> dict[str, Any]:
    """Assemble the compact map from scanner output."""

    warnings = list(warnings)
    languages = _language_breakdown(files)

    shown_routes, hidden_routes = _truncated(routes, MAX_ROUTES)
    shown_deps, hidden_deps = _truncated(dependencies, MAX_DEPENDENCIES)
    shown_files, hidden_files = _truncated(
        sorted(files, key=lambda f: _importance_rank(f.get("importance"))),
        MAX_IMPORTANT_FILES,
    )
    shown_integrations, hidden_integrations = _truncated(integrations, MAX_INTEGRATIONS)
    shown_auth, hidden_auth = _truncated(auth, 12)
    shown_frameworks, hidden_frameworks = _truncated(frameworks, 15)

    if hidden_routes:
        warnings.append(
            f"{hidden_routes} further endpoints exist and were not listed here."
        )
    if hidden_deps:
        warnings.append(f"{hidden_deps} further dependencies were not listed here.")
    if hidden_files:
        warnings.append(f"{hidden_files} further files exist and were not listed here.")
    if analysis_mode == "limited":
        warnings.append(
            "Large repository detected. Analysis was limited to relevant files."
        )

    shown_warnings, hidden_warnings = _truncated(warnings, MAX_WARNINGS)

    return {
        "analysis_mode": analysis_mode,
        "identity": {
            "owner": repository.get("owner"),
            "repo": repository.get("repo_name"),
            "default_branch": repository.get("default_branch"),
            "commit": (repository.get("analyzed_commit_sha") or "")[:12],
            "visibility": repository.get("visibility"),
            "stars": repository.get("stars"),
            "forks": repository.get("forks"),
        },
        "stack": {
            "primary_language": repository.get("language"),
            "languages": languages,
            "frameworks": [item["name"] for item in shown_frameworks],
            "dependencies_by_category": _by_category(shown_deps),
            "package_managers": sorted(
                {
                    f["name"]
                    for f in files
                    if f.get("file_category") == "dependency"
                }
            ),
        },
        "architecture": {
            "layers": sorted(
                {
                    f.get("file_category")
                    for f in files
                    if f.get("file_category") in
                    ("source", "component", "api", "model", "schema", "database")
                }
            ),
            "has_frontend": any(
                f.get("file_category") in ("component",) or f.get("file_name") in
                ("package.json",)
                for f in files
            ),
            "has_backend": any(
                f.get("file_category") in ("api", "source", "database")
                and f.get("language") in ("Python", "Go", "Java", "Ruby", "PHP", "Rust", "C#")
                for f in files
            ),
            "monorepo": _looks_like_monorepo(files),
        },
        "frontend": {
            "components": sum(1 for f in files if f.get("file_category") == "component"),
            "pages": [f["path"] for f in files if _is_page(f["path"])][:MAX_IMPORTANT_FILES],
            "state_management": _detect_state(dependencies),
            "styling": _detect_styling(dependencies, files),
        },
        "backend": {
            "languages": sorted(
                {
                    f.get("language")
                    for f in files
                    if f.get("language") in ("Python", "Go", "Java", "Ruby", "PHP", "Rust", "C#", "Kotlin")
                }
            ),
            "endpoint_count": len(routes),
            "entrypoints": [
                f["path"]
                for f in files
                if f.get("file_name") in ("main.py", "app.py", "server.js", "index.js", "main.go", "manage.py")
            ][:MAX_IMPORTANT_FILES],
        },
        "database": {
            "technologies": [item["name"] for item in databases],
            "schema_files": [
                f["path"] for f in files if f.get("file_category") in ("schema", "database")
            ][:MAX_IMPORTANT_FILES],
            "orm_evidence": [item["evidence"] for item in databases][:10],
        },
        "authentication": {
            "detected": [item["name"] for item in shown_auth],
            "evidence": [item["evidence"] for item in shown_auth][:10],
            "authorization_checks": any(
                "Authorization" in item["name"] for item in auth
            ),
        },
        "apis": shown_routes,
        "external_integrations": shown_integrations,
        "features": (readme or {}).get("features", [])[:MAX_FEATURES],
        "testing": {
            "test_file_count": tests.get("file_count", 0),
            "frameworks": [f["name"] for f in tests.get("frameworks", [])],
            "commands": tests.get("commands", []),
            "has_tests": tests.get("file_count", 0) > 0,
        },
        "deployment": {
            "files": [
                f["path"] for f in files if f.get("file_category") == "deployment"
            ][:MAX_IMPORTANT_FILES],
            "ci": [f["path"] for f in files if f["path"].startswith((".github/workflows", ".gitlab-ci"))][:10],
        },
        "repository_stats": {
            "file_count": len(files),
            "total_files_seen": repository.get("total_files", len(files)),
            "line_count": sum(f.get("line_count") or 0 for f in files),
            "symbol_count": len(symbols),
            "secret_findings": len(secrets),
        },
        "readme": {
            "present": bool((readme or {}).get("present")),
            "description": ((readme or {}).get("description") or "")[:600],
            "technologies": (readme or {}).get("technologies", [])[:MAX_FEATURES],
        },
        "security": {
            "hardcoded_secrets": [
                {
                    "type": item["secret_type"],
                    "file": item["file"],
                    "line": item["line"],
                }
                for item in secrets[:MAX_WARNINGS]
            ],
            "secret_file_present": any(
                f.get("file_name", "").startswith(".env") for f in files
            ),
        },
        "important_files": [
            {
                "path": f["path"],
                "category": f.get("file_category"),
                "importance": f.get("importance"),
                "lines": f.get("line_count"),
            }
            for f in shown_files
        ],
        "warnings": shown_warnings,
        "truncated": {
            "routes": hidden_routes,
            "dependencies": hidden_deps,
            "files": hidden_files,
            "integrations": hidden_integrations,
            "auth": hidden_auth,
            "frameworks": hidden_frameworks,
            "warnings": hidden_warnings,
        },
    }


def _importance_rank(importance: str | None) -> int:
    return {"high": 0, "medium": 1, "low": 2, "ignored": 3}.get(importance or "", 4)


def _language_breakdown(files: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in files:
        language = item.get("language")
        if not language or language in ("JSON", "YAML", "TOML", "Markdown"):
            continue
        counts[language] = counts.get(language, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:8])


def _by_category(dependencies: list[dict[str, Any]]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for dependency in dependencies:
        grouped.setdefault(dependency.get("category", "utility"), []).append(
            dependency.get("package", "?")
        )
    return {key: value[:20] for key, value in sorted(grouped.items())}


def _looks_like_monorepo(files: list[dict[str, Any]]) -> bool:
    workspace_roots = {"apps", "packages", "services", "libs", "backend", "frontend"}
    return any(
        part in workspace_roots
        for file in files
        for part in file.get("path", "").split("/")[:-1]
    )


def _is_page(path: str) -> bool:
    return (
        path.startswith(("app/", "pages/", "src/pages/", "src/app/"))
        and path.endswith((".tsx", ".jsx", ".vue", ".svelte", ".ts"))
    )


_STATE_PACKAGES = {
    "redux": "Redux", "@reduxjs/toolkit": "Redux Toolkit", "zustand": "Zustand",
    "jotai": "Jotai", "recoil": "Recoil", "mobx": "MobX", "pinia": "Pinia",
    "vuex": "Vuex", "@tanstack/react-query": "TanStack Query",
    "swr": "SWR", "react-hook-form": "React Hook Form",
}


def _detect_state(dependencies: list[dict[str, Any]]) -> list[str]:
    packages = {d.get("package", "").lower() for d in dependencies}
    return sorted({label for key, label in _STATE_PACKAGES.items() if key in packages})


def _detect_styling(dependencies: list[dict[str, Any]], files: list[dict[str, Any]]) -> list[str]:
    packages = {d.get("package", "").lower() for d in dependencies}
    found: list[str] = []
    for package, label in (
        ("tailwindcss", "Tailwind CSS"),
        ("@mui/material", "Material UI"),
        ("antd", "Ant Design"),
        ("@chakra-ui/react", "Chakra UI"),
        ("bootstrap", "Bootstrap"),
        ("styled-components", "styled-components"),
        ("sass", "Sass"),
    ):
        if package in packages:
            found.append(label)
    if any(f.get("path", "").endswith((".css", ".scss")) for f in files):
        found.append("plain CSS")
    return found

