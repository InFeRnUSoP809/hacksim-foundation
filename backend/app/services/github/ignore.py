"""File ignore rules, classification and importance (§14, §16, §17).

Pure functions over a path. No network, no AI, no database — the same input
always produces the same answer, which is what makes the evidence trustworthy.
"""

from __future__ import annotations

import posixpath
from dataclasses import dataclass

# ── §14 ignore list ───────────────────────────────────────────────────────

IGNORED_DIRECTORIES = frozenset(
    {
        ".git", "node_modules", "venv", ".venv", "env", "__pycache__",
        "dist", "build", "out", "coverage", ".coverage", ".cache", ".next",
        ".nuxt", ".svelte-kit", "target", "vendor", "bower_components",
        ".gradle", ".idea", ".vscode", "migrations_wrong", "site-packages",
        ".terraform", ".mypy_cache", ".pytest_cache", ".tox", "htmlcov",
    }
)

IGNORED_SUFFIXES = frozenset(
    {
        ".lock", ".map", ".min.js", ".min.css", ".pyc", ".pyo", ".so", ".dylib",
        ".dll", ".exe", ".class", ".jar", ".war", ".zip", ".tar", ".gz", ".bz2",
        ".xz", ".7z", ".rar", ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3",
        ".wav", ".flac", ".ogg", ".aac", ".png", ".jpg", ".jpeg", ".gif", ".bmp",
        ".ico", ".svgz", ".webp", ".psd", ".ai", ".ttf", ".otf", ".woff",
        ".woff2", ".eot", ".db", ".sqlite", ".sqlite3", ".dump", ".bak",
        ".pack", ".idx", ".pdf", ".docx", ".xlsx", ".pptx",
    }
)

# Never read, never store, never send to an AI provider (§15).
SENSITIVE_FILENAMES = frozenset({".env", ".env.local", ".env.production", ".npmrc", ".netrc", ".pgpass"})

# Lockfiles: huge, and §19 says never parse them. Skipped outright.
IGNORED_FILENAMES = frozenset(
    {
        "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
        "bun.lockb", "composer.lock", "cargo.lock", "gemfile.lock", "poetry.lock",
        "pdm.lock", "uv.lock", "mix.lock", "packages.lock.json",
    }
)

# ── §16 categories ─────────────────────────────────────────────────────────

CATEGORY_BY_EXTENSION: dict[str, str] = {
    ".py": "source", ".ts": "source", ".tsx": "component", ".jsx": "component",
    ".js": "source", ".mjs": "source", ".cjs": "source", ".go": "source",
    ".rs": "source", ".rb": "source", ".java": "source", ".kt": "source",
    ".swift": "source", ".dart": "source", ".c": "source", ".h": "source",
    ".cpp": "source", ".hpp": "source", ".cs": "source", ".php": "source",
    ".vue": "component", ".svelte": "component",

    ".sql": "database", ".prisma": "schema", ".graphql": "schema",
    ".gql": "schema", ".proto": "schema",

    ".json": "config", ".yaml": "config", ".yml": "config", ".toml": "config",
    ".ini": "config", ".cfg": "config", ".conf": "config", ".properties": "config",
    ".env": "config",

    ".md": "documentation", ".mdx": "documentation", ".rst": "documentation",
    ".txt": "documentation", ".adoc": "documentation",

    ".html": "component", ".css": "component", ".scss": "component",
    ".sass": "component", ".less": "component",

    ".sh": "deployment", ".bash": "deployment", ".zsh": "deployment",
    ".ps1": "deployment", ".tf": "deployment", ".dockerfile": "deployment",
    ".gradle": "dependency", ".kts": "dependency", ".bat": "deployment",
}

MANIFEST_FILENAMES: dict[str, str] = {
    "package.json": "dependency",
    "requirements.txt": "dependency",
    "pyproject.toml": "dependency",
    "pipfile": "dependency",
    "poetry.lock": "dependency",
    "pom.xml": "dependency",
    "build.gradle": "dependency",
    "go.mod": "dependency",
    "cargo.toml": "dependency",
    "composer.json": "dependency",
    "gemfile": "dependency",
    "pubspec.yaml": "dependency",
    "deno.json": "dependency",
}

DEPLOYMENT_FILENAMES = frozenset(
    {
        "dockerfile", "docker-compose.yml", "docker-compose.yaml",
        "vercel.json", "netlify.toml", "fly.toml", "render.yaml",
        "railway.json", "heroku.yml", "procfile", "makefile", "justfile",
        "serverless.yml", "k8s.yaml", "helmfile.yaml", "app.yaml",
    }
)

CONFIG_FILENAMES = frozenset(
    {
        "vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs",
        "nuxt.config.ts", "angular.json", "svelte.config.js", "astro.config.mjs",
        "tailwind.config.js", "tailwind.config.ts", "postcss.config.js",
        "tsconfig.json", "jsconfig.json", "eslint.config.js", ".eslintrc.js",
        ".eslintrc.json", ".prettierrc", "babel.config.js", "jest.config.js",
        "vitest.config.ts", "pytest.ini", "tox.ini", "setup.cfg", "ruff.toml",
        "mypy.ini", "alembic.ini", "manage.py", "wsgi.py", "asgi.py",
    }
)

TEST_NAME_HINTS = ("test", "tests", "spec", "__tests__")
TEST_FRAMEWORK_FILES = ("jest.config", "vitest.config", "pytest.ini", "playwright.config", "cypress.config")

# ── §16 importance ─────────────────────────────────────────────────────────

HIGH_IMPORTANCE = frozenset(
    {
        "readme.md", "package.json", "requirements.txt", "pyproject.toml",
        "go.mod", "cargo.toml", "pom.xml", "build.gradle", "dockerfile",
        "docker-compose.yml", "docker-compose.yaml", "supabase/schema.sql",
    }
)

MEDIUM_IMPORTANCE_HINTS = (
    "schema", "migration", "model", "auth", "route", "router", "controller",
    "api", "service", "middleware", "config", "settings", "requirements",
    "prisma", "supabase",
)


@dataclass(frozen=True)
class FileFacts:
    """Everything the classifier can know about a path, before any content."""

    path: str
    size: int
    is_binary: bool
    sha: str | None = None


def normalize(path: str) -> str:
    # ``lstrip("./")`` would eat every leading dot, turning ``.next/x`` into
    # ``next/x`` and defeating the dotfile-directory rules below.
    normalized = posixpath.normpath(path.replace("\\", "/"))
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def extension_of(path: str) -> str:
    name = posixpath.basename(path).lower()
    if name in MANIFEST_FILENAMES or name.startswith("dockerfile"):
        return ""
    _, _, ext = name.rpartition(".")
    return f".{ext}" if ext and ext != name else ""


def basename_of(path: str) -> str:
    return posixpath.basename(path)


def is_ignored(path: str) -> bool:
    """§14. A path is ignored if any directory segment or the name matches."""
    normalized = normalize(path)
    parts = normalized.split("/")

    for part in parts[:-1]:
        if part in IGNORED_DIRECTORIES or part.endswith(".egg-info"):
            return True

    name = parts[-1].lower()

    if name in SENSITIVE_FILENAMES:
        return True
    if name.startswith(".env."):
        return True
    if name in IGNORED_FILENAMES:
        return True
    if name in IGNORED_DIRECTORIES:
        return True

    for suffix in IGNORED_SUFFIXES:
        if name.endswith(suffix):
            return True

    return False


def is_sensitive(path: str) -> bool:
    """True for files whose content must never be read or stored (§15)."""
    name = basename_of(normalize(path)).lower()
    return name in SENSITIVE_FILENAMES or name.startswith(".env")


def category_of(facts: FileFacts) -> str:
    """§16. Returns one of the documented categories, or ``unknown``."""
    normalized = normalize(facts.path)
    name = basename_of(normalized).lower()
    lower_parts = [p.lower() for p in normalized.split("/")[:-1]]

    if facts.is_binary:
        return "asset"
    if name in SENSITIVE_FILENAMES or name.startswith(".env"):
        return "config"
    if name in MANIFEST_FILENAMES or name.endswith((".lock",)):
        return "dependency"
    if name.startswith("dockerfile") or name in DEPLOYMENT_FILENAMES:
        return "deployment"
    if any(p in TEST_NAME_HINTS for p in lower_parts) or name.startswith(TEST_NAME_HINTS):
        return "test"
    if any(hint in name for hint in TEST_FRAMEWORK_FILES):
        return "test"
    if name in CONFIG_FILENAMES:
        return "config"
    if name.endswith((".md", ".mdx", ".rst")):
        return "documentation"

    extension = extension_of(normalized)
    category = CATEGORY_BY_EXTENSION.get(extension)
    if category:
        return category

    if any(p in ("routes", "routers", "api", "controllers", "endpoints") for p in lower_parts):
        return "api"
    if any(p in ("models", "entities", "db", "database") for p in lower_parts):
        return "model"
    if any(p in ("pages", "views", "components", "app") for p in lower_parts):
        return "component"

    return "unknown"


def importance_of(facts: FileFacts, category: str) -> str:
    """§16 importance: high / medium / low / ignored."""
    normalized = normalize(facts.path)
    name = basename_of(normalized).lower()

    if is_ignored(normalized):
        return "ignored"
    if category == "asset":
        return "ignored"
    if name in HIGH_IMPORTANCE:
        return "high"
    if category in ("schema", "database", "deployment"):
        return "high"
    if any(hint in name for hint in MEDIUM_IMPORTANCE_HINTS):
        return "high"
    if category in ("api", "model", "component", "config", "source", "test"):
        return "medium"
    if category == "documentation":
        return "low"
    return "low"


def is_source_like(category: str) -> bool:
    return category in ("source", "component", "api", "model", "schema", "database")


# ── §17 language ───────────────────────────────────────────────────────────

# Extension wins. GitHub's aggregate `language` is only used for the repository
# headline, so we never spend a request per file to ask.
LANGUAGE_BY_EXTENSION: dict[str, str] = {
    ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript",
    ".cjs": "JavaScript", ".vue": "Vue", ".svelte": "Svelte",
    ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java",
    ".kt": "Kotlin", ".swift": "Swift", ".dart": "Dart", ".php": "PHP",
    ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++", ".cs": "C#",
    ".sql": "SQL", ".sh": "Shell", ".bash": "Shell", ".ps1": "PowerShell",
    ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".json": "JSON",
    ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".md": "Markdown",
    ".graphql": "GraphQL", ".prisma": "Prisma", ".tf": "Terraform",
    ".dockerfile": "Dockerfile", ".ipynb": "Jupyter Notebook",
}


def language_of(path: str) -> str | None:
    normalized = normalize(path)
    name = basename_of(normalized).lower()
    if name.startswith("dockerfile"):
        return "Dockerfile"
    return LANGUAGE_BY_EXTENSION.get(extension_of(normalized))
