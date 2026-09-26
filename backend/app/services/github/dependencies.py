"""Dependency extraction (§19).

Reads the manifests a hackathon team actually ships — never the lockfiles, which
are huge and add no signal. Pure parsing, no network, no AI.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from app.services.github.ignore import basename_of, normalize

# ── §19 categories ─────────────────────────────────────────────────────────

CATEGORY_RULES: list[tuple[str, tuple[str, ...]]] = [
    (
        "frontend",
        (
            "react", "react-dom", "next", "vue", "nuxt", "svelte", "@angular/core",
            "angular", "preact", "solid-js", "astro", "remix", "redux", "@reduxjs/toolkit",
            "zustand", "tailwindcss", "bootstrap", "material-ui", "@mui/material",
            "antd", "chakra-ui", "framer-motion", "vite", "webpack", "esbuild",
        ),
    ),
    (
        "backend",
        (
            "express", "fastapi", "flask", "django", "nestjs", "@nestjs/core",
            "spring-boot", "spring-boot-starter", "laravel/framework", "gin-gonic/gin",
            "fiber", "echo", "actix-web", "axum", "rails", "sinatra", "hapi",
        ),
    ),
    (
        "database",
        (
            "pg", "postgres", "psycopg", "psycopg2", "asyncpg", "mysql2", "pymysql",
            "sqlalchemy", "prisma", "@prisma/client", "mongoose", "mongodb", "redis",
            "ioredis", "typeorm", "sequelize", "drizzle-orm", "knex", "supabase",
            "@supabase/supabase-js", "diesel", "sqlite3", "better-sqlite3",
        ),
    ),
    (
        "ai_ml",
        (
            "openai", "anthropic", "langchain", "llama-index", "transformers",
            "torch", "pytorch", "tensorflow", "keras", "scikit-learn", "sklearn",
            "xgboost", "lightgbm", "statsmodels", "prophet", "faiss", "pinecone-client",
            "chromadb", "sentence-transformers", "replicate", "deepseek",
        ),
    ),
    (
        "testing",
        (
            "pytest", "unittest2", "jest", "vitest", "mocha", "chai", "cypress",
            "@playwright/test", "playwright", "testing-library", "@testing-library/react",
            "supertest", "robotframework", "hypothesis", "faker", "msw",
        ),
    ),
    (
        "authentication",
        (
            "passport", "jsonwebtoken", "pyjwt", "python-jose", "auth0", "next-auth",
            "@auth/core", "@clerk/nextjs", "bcrypt", "argon2", "passlib", "oauthlib",
            "social-auth", "lucia", "better-auth", "@supabase/auth-js",
        ),
    ),
    (
        "deployment",
        (
            "vercel", "netlify", "docker", "kubernetes", "@kubernetes/client-node",
            "serverless", "pm2", "flyctl", "terraform", "pulumi", "aws-sdk",
            "@aws-sdk/client-s3", "firebase", "firebase-admin", "cloudflare-workers",
        ),
    ),
]

UTILITY_CATEGORY = "utility"

# Names we never resolve, even though they appear in a requirements file.
PYTHON_NOISE = frozenset(
    {"python-dateutil", "typing-extensions", "charset-normalizer", "urllib3", "idna", "certifi"}
)


@dataclass(frozen=True)
class Dependency:
    package: str
    version: str | None
    category: str
    ecosystem: str
    dev: bool = False

    def to_dict(self) -> dict:
        return {
            "package": self.package,
            "version": self.version,
            "category": self.category,
            "ecosystem": self.ecosystem,
            "dev": self.dev,
        }


def categorise(package: str) -> str:
    """Category for one package name.

    Exact matches win over substring matches, otherwise ``vitest`` lands in
    ``frontend`` because it contains ``vite``. Longer needles are tried first
    for the same reason.
    """
    lowered = package.lower()

    for category, needles in CATEGORY_RULES:
        if lowered in {n.lower() for n in needles}:
            return category

    for category, needles in CATEGORY_RULES:
        ordered = sorted(needles, key=len, reverse=True)
        if any(needle.lower() in lowered for needle in ordered):
            return category

    return UTILITY_CATEGORY


def _clean_python_version(spec: str) -> str | None:
    spec = spec.strip()
    spec = re.sub(r"^[<>=!~\[\s]+", "", spec)
    match = re.match(r"^(\d+(?:\.\d+)*)", spec)
    return match.group(1) if match else None


def parse_requirements_txt(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for raw in content.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        if "git+" in line or "http" in line:
            # A VCS or URL dependency still tells us the package name.
            name_match = re.search(r"([A-Za-z0-9_.\-]+)", line.split("@")[0])
            if not name_match:
                continue
            package = name_match.group(1)
            version = None
        else:
            name, _, spec = line.partition("==")
            if "==" not in line:
                name, _, spec = line.partition(">=")
            if "==" not in line and ">=" not in line:
                name, _, spec = line.partition("~=")
            package = name.strip().split("[", 1)[0].strip()
            version = _clean_python_version(spec)

        if not package or package.lower() in PYTHON_NOISE:
            continue
        dependencies.append(
            Dependency(
                package=package,
                version=version,
                category=categorise(package),
                ecosystem="pypi",
            )
        )
    return dependencies


def parse_pyproject(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return dependencies

    project = data.get("project", {}) if isinstance(data.get("project"), dict) else {}
    for spec in project.get("dependencies", []) or []:
        name, _, version_spec = str(spec).partition(">=")
        package = name.split("[", 1)[0].split(";", 1)[0].strip()
        if not package:
            continue
        dependencies.append(
            Dependency(
                package=package,
                version=_clean_python_version(version_spec) if version_spec else None,
                category=categorise(package),
                ecosystem="pypi",
            )
        )

    optional = project.get("optional-dependencies", {}) or {}
    if isinstance(optional, dict):
        for group, specs in optional.items():
            for spec in specs or []:
                name, _, version_spec = str(spec).partition(">=")
                package = name.split("[", 1)[0].strip()
                if not package:
                    continue
                dependencies.append(
                    Dependency(
                        package=package,
                        version=_clean_python_version(version_spec) if version_spec else None,
                        category=categorise(package),
                        ecosystem="pypi",
                        dev=group in ("dev", "test", "tests"),
                    )
                )

    tool_poetry = data.get("tool", {}).get("poetry", {}) if isinstance(data.get("tool"), dict) else {}
    for section, is_dev in (("dependencies", False), ("dev-dependencies", True)):
        for package, spec in (tool_poetry.get(section, {}) or {}).items():
            if not isinstance(spec, str):
                continue
            dependencies.append(
                Dependency(
                    package=package,
                    version=_clean_python_version(spec),
                    category=categorise(package),
                    ecosystem="pypi",
                    dev=is_dev,
                )
            )

    return dependencies


def parse_package_json(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return dependencies

    for section, is_dev in (
        ("dependencies", False),
        ("devDependencies", True),
        ("peerDependencies", True),
    ):
        block = data.get(section) or {}
        if not isinstance(block, dict):
            continue
        for package, spec in block.items():
            version = str(spec).lstrip("^~>=< ") if spec else None
            dependencies.append(
                Dependency(
                    package=package,
                    version=version,
                    category=categorise(package),
                    ecosystem="npm",
                    dev=is_dev,
                )
            )
    return dependencies


_MAVEN_COORD = re.compile(r"<groupId>([^<]+)</groupId>\s*<artifactId>([^<]+)</artifactId>(?:\s*<version>([^<]+)</version>)?")


def parse_pom_xml(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for match in _MAVEN_COORD.finditer(content):
        group, artifact, version = match.group(1), match.group(2), match.group(3)
        package = f"{group}:{artifact}"
        dependencies.append(
            Dependency(
                package=package,
                version=version,
                category=categorise(package),
                ecosystem="maven",
            )
        )
    return dependencies


def parse_composer_json(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return dependencies
    for section, is_dev in (("require", False), ("require-dev", True)):
        block = data.get(section) or {}
        if not isinstance(block, dict):
            continue
        for package, spec in block.items():
            if package in ("php", "ext-*"):
                continue
            dependencies.append(
                Dependency(
                    package=package,
                    version=str(spec).lstrip("^~>=< ") if spec else None,
                    category=categorise(package),
                    ecosystem="composer",
                    dev=is_dev,
                )
            )
    return dependencies


def parse_pubspec(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    in_block = False
    for raw in content.splitlines():
        line = raw.strip()
        if line == "dependencies:":
            in_block = True
            continue
        if line and not line.startswith((" ", "\t")) and line.endswith(":"):
            in_block = False
            continue
        if not in_block or ":" not in line or not line.startswith((" ", "\t")):
            continue
        name, _, spec = line.partition(":")
        package = name.strip()
        if not package or package.startswith("#"):
            continue
        dependencies.append(
            Dependency(
                package=package,
                version=spec.strip() or None,
                category=categorise(package),
                ecosystem="pub",
            )
        )
    return dependencies


def _parse_go_mod(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith(("module", "go ", "//")):
            continue
        match = re.match(r"(?:require\s+)?([\w./\-]+)\s+(v[\w.\-+]+)", line)
        if match:
            package, version = match.group(1), match.group(2)
            dependencies.append(
                Dependency(
                    package=package,
                    version=version.lstrip("v"),
                    category=categorise(package),
                    ecosystem="go",
                )
            )
    return dependencies


def _parse_cargo(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    in_deps = False
    for raw in content.splitlines():
        line = raw.strip()
        if line.startswith("[dependencies]"):
            in_deps = True
            continue
        if line.startswith("[") and in_deps:
            in_deps = False
            continue
        if not in_deps or "=" not in line:
            continue
        name, _, spec = line.partition("=")
        package = name.strip().strip('"')
        version = re.search(r'version\s*=\s*"([^"]+)"', spec)
        if not package:
            continue
        dependencies.append(
            Dependency(
                package=package,
                version=version.group(1) if version else None,
                category=categorise(package),
                ecosystem="cargo",
            )
        )
    return dependencies


def _parse_gradle(content: str) -> list[Dependency]:
    dependencies: list[Dependency] = []
    for match in re.finditer(
        r"""(?:implementation|api|compile|testImplementation|compileOnly)\s*[('"]+([\w.\-]+):([\w.\-]+):?([\w.\-]*)""",
        content,
    ):
        package = f"{match.group(1)}:{match.group(2)}"
        dependencies.append(
            Dependency(
                package=package,
                version=match.group(3) or None,
                category=categorise(package),
                ecosystem="maven",
                dev=match.group(0).startswith("test"),
            )
        )
    return dependencies


_PARSERS = {
    "package.json": lambda c: parse_package_json(c),
    "requirements.txt": parse_requirements_txt,
    "pyproject.toml": parse_pyproject,
    "pipfile": parse_requirements_txt,
    "pom.xml": parse_pom_xml,
    "build.gradle": _parse_gradle,
    "go.mod": _parse_go_mod,
    "cargo.toml": _parse_cargo,
    "composer.json": parse_composer_json,
    "pubspec.yaml": parse_pubspec,
}


def extract(path: str, content: str) -> list[Dependency]:
    """Parse whichever manifest ``path`` names. Unknown names return []."""
    name = basename_of(normalize(path)).lower()
    parser = _PARSERS.get(name)
    if parser is None:
        return []
    try:
        return parser(content)
    except Exception:  # noqa: BLE001 — a malformed manifest must not stop a scan
        return []
