"""Framework, database and auth detection (§18, §22, §23).

Every signal here is deterministic: a dependency name, a config file, an import
line, a decorator. Nothing is inferred from prose, and nothing is guessed when
the evidence is absent — the framework is simply reported as not detected.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.services.github.dependencies import Dependency

# ── §18 frameworks ─────────────────────────────────────────────────────────

# Each rule: framework -> dependency names that prove it is in use.
FRAMEWORK_SIGNALS: dict[str, tuple[str, ...]] = {
    "React": ("react", "react-dom", "preact", "preact/compat"),
    "Next.js": ("next",),
    "Vue": ("vue",),
    "Nuxt": ("nuxt", "nuxt3", "nuxt-edge"),
    "Angular": ("@angular/core", "@ngx-"),
    "Svelte": ("svelte",),
    "SvelteKit": ("@sveltejs/kit",),
    "Astro": ("astro",),
    "Remix": ("@remix-run/react", "@remix-run/node"),
    "Vite": ("vite",),
    "FastAPI": ("fastapi",),
    "Flask": ("flask", "flask-cors", "flask-sqlalchemy"),
    "Django": ("django", "djangorestframework"),
    "Express": ("express",),
    "NestJS": ("@nestjs/core", "@nestjs/common"),
    "Spring": ("spring-boot", "spring-boot-starter", "spring-web"),
    "Laravel": ("laravel/framework", "laravel/sanctum"),
    "Rails": ("rails", "railties"),
    "Gin": ("gin-gonic/gin",),
    "Fiber": ("gofiber/fiber",),
    "Actix": ("actix-web",),
    "Axum": ("axum",),
    "Sinatra": ("sinatra",),
    "Flutter": ("flutter",),
    "React Native": ("react-native", "expo"),
    "Flask-SocketIO": ("flask-socketio",),
}

# Config files that prove a framework even with no manifest (e.g. a CDN build).
FRAMEWORK_CONFIG_SIGNALS: dict[str, str] = {
    "next.config.js": "Next.js",
    "next.config.mjs": "Next.js",
    "next.config.ts": "Next.js",
    "nuxt.config.ts": "Nuxt",
    "nuxt.config.js": "Nuxt",
    "svelte.config.js": "Svelte",
    "angular.json": "Angular",
    "astro.config.mjs": "Astro",
    "vite.config.ts": "Vite",
    "vite.config.js": "Vite",
    "manage.py": "Django",
    "alembic.ini": "SQLAlchemy",
    "Procfile": "PaaS",
    "vercel.json": "Vercel",
    "netlify.toml": "Netlify",
    "serverless.yml": "Serverless",
    "app.yaml": "GCP App Engine",
    "fly.toml": "Fly.io",
}

# ── §22 database technologies ──────────────────────────────────────────────

DATABASE_SIGNALS: dict[str, tuple[str, ...]] = {
    "PostgreSQL": ("pg", "psycopg", "psycopg2", "asyncpg", "postgres", "@supabase/supabase-js"),
    "MySQL": ("mysql2", "pymysql", "mysql-connector", "mysqlclient"),
    "MongoDB": ("mongoose", "mongodb", "pymongo", "motor"),
    "SQLite": ("sqlite3", "better-sqlite3"),
    "Redis": ("redis", "ioredis"),
    "SQLAlchemy": ("sqlalchemy",),
    "Prisma": ("prisma", "@prisma/client"),
    "TypeORM": ("typeorm",),
    "Sequelize": ("sequelize",),
    "Drizzle": ("drizzle-orm",),
    "Django ORM": ("django",),
    "Supabase": ("@supabase/supabase-js", "@supabase/ supabase-py", "supabase"),
    "Mongoose": ("mongoose",),
}

# SQL / schema files prove a relational model even without a driver.
DATABASE_PATH_SIGNALS: dict[str, str] = {
    ".sql": "SQL",
    "schema.prisma": "Prisma",
    "schema.sql": "SQL schema",
    "docker-compose.yml": "SQL (docker compose)",
    "docker-compose.yaml": "SQL (docker compose)",
}

ORM_KEYWORDS: dict[str, tuple[str, ...]] = {
    "SQLAlchemy": ("from sqlalchemy", "import sqlalchemy", "sqlalchemy.orm", "declarative_base"),
    "Prisma": ("@prisma/client", "prisma."),
    "TypeORM": ("typeorm", "@Entity(", "@Column("),
    "Sequelize": ("sequelize", "Model.init"),
    "Drizzle": ("drizzle-orm", "drizzle("),
    "Django ORM": ("from django.db", "models.Model"),
    "Mongoose": ("new mongoose.Schema", "mongoose.model"),
    "Supabase": ("createClient", "supabase.from", "supabase.co"),
}

# ── §23 auth ────────────────────────────────────────────────────────────────

AUTH_SIGNALS: dict[str, tuple[str, ...]] = {
    "Supabase Auth": ("@supabase/supabase-js", "@supabase/auth-js", "supabase.auth"),
    "JWT": ("jsonwebtoken", "pyjwt", "python-jose", "jose"),
    "OAuth": ("passport", "oauthlib", "auth0", "next-auth", "@auth/core", "@clerk/nextjs"),
    "Passport": ("passport", "passport-local", "passport-google-oauth20"),
    "NextAuth": ("next-auth",),
    "Clerk": ("@clerk/nextjs",),
    "Auth0": ("auth0", "@auth0/auth0-react"),
    "bcrypt": ("bcrypt", "argon2", "passlib"),
    "Django sessions": ("django.contrib.auth",),
    "Laravel Sanctum": ("laravel/sanctum",),
    "Lucia": ("lucia",),
    "Better Auth": ("better-auth",),
}

AUTH_CODE_SIGNALS: dict[str, tuple[str, ...]] = {
    "Supabase Auth": ("supabase.auth.signIn", "supabase.auth.signUp", "getSession("),
    "JWT verification": ("jwt.decode", "jwt.verify", "verify(", "getUser("),
    "Session cookies": ("setCookie", "document.cookie", "Set-Cookie", "res.cookie"),
    "Authorization middleware": ("requireAuth", "authenticate", "get_current_user", "verifyToken", "requireLogin"),
    "Authorization checks": ("is_admin", "isAdmin", "role ===", "hasRole", "require_role", "allowed_roles"),
    "OAuth redirect": ("/auth/", "callback", "redirect_uri", "oauth/callback"),
}

SECRET_KEY_SIGNALS: tuple[str, ...] = (
    "process.env.SECRET_KEY",
    "os.environ[\"SECRET_KEY\"]",
    "settings.SECRET_KEY",
    "JWT_SECRET",
    "AUTH_SECRET",
    "NEXTAUTH_SECRET",
)


@dataclass
class Detection:
    """A detected technology plus the concrete thing that proves it."""

    name: str
    category: str
    evidence: str
    file: str | None = None
    symbol: str | None = None
    lines: str | None = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "category": self.category,
            "evidence": self.evidence,
            "file": self.file,
            "symbol": self.symbol,
            "lines": self.lines,
        }


@dataclass
class DetectionResult:
    frameworks: list[Detection] = field(default_factory=list)
    databases: list[Detection] = field(default_factory=list)
    auth: list[Detection] = field(default_factory=list)


def _match_names(dependencies: list[Dependency], signals: dict[str, tuple[str, ...]]) -> list[Detection]:
    found: list[Detection] = []
    seen: set[str] = set()

    by_package = {d.package.lower(): d for d in dependencies}

    for technology, needles in signals.items():
        for needle in needles:
            for package, dependency in by_package.items():
                if needle.lower() not in package:
                    continue
                if technology in seen:
                    break
                seen.add(technology)
                found.append(
                    Detection(
                        name=technology,
                        category=_category_for(technology),
                        evidence=f"dependency `{dependency.package}`",
                        symbol=dependency.package,
                    )
                )
                break
    return found


def _category_for(technology: str) -> str:
    if technology in FRAMEWORK_SIGNALS or technology in FRAMEWORK_CONFIG_SIGNALS.values():
        return "framework"
    if technology in DATABASE_SIGNALS or technology in ORM_KEYWORDS:
        return "database"
    return "authentication"


def detect_frameworks(
    dependencies: list[Dependency], config_filenames: list[str]
) -> list[Detection]:
    found = _match_names(dependencies, FRAMEWORK_SIGNALS)
    present = {name.lower() for name in found}

    for filename in config_filenames:
        technology = FRAMEWORK_CONFIG_SIGNALS.get(filename.lower())
        if technology and technology not in present:
            present.add(technology)
            found.append(
                Detection(
                    name=technology,
                    category="framework",
                    evidence=f"configuration file `{filename}`",
                    file=filename,
                )
            )
    return found


def detect_databases(
    dependencies: list[Dependency], paths: list[str]
) -> list[Detection]:
    found = _match_names(dependencies, DATABASE_SIGNALS)

    # A schema or compose file is proof of a relational store regardless of
    # which driver the application happens to use.
    if any(p.endswith(".sql") for p in paths) and not any(
        d.name == "SQLAlchemy" for d in found
    ):
        found.append(
            Detection(
                name="SQL",
                category="database",
                evidence="SQL files in the repository",
            )
        )
    if any(p.endswith("schema.prisma") for p in paths):
        found.append(
            Detection(
                name="Prisma",
                category="database",
                evidence="`schema.prisma` present",
                file="schema.prisma",
            )
        )
    return found


def detect_auth(dependencies: list[Dependency]) -> list[Detection]:
    return _match_names(dependencies, AUTH_SIGNALS)


def detect_auth_in_code(sources: list[tuple[str, str, int]]) -> list[Detection]:
    """Scan already-fetched source for auth patterns.

    ``sources`` is a list of ``(path, content, start_line)``. Only files the
    scanner already decided to read are inspected, so this costs nothing extra.
    """
    found: dict[str, Detection] = {}

    for technology, needles in AUTH_CODE_SIGNALS.items():
        for path, content, start_line in sources:
            for needle in needles:
                match = re.search(re.escape(needle), content)
                if not match:
                    continue
                line = start_line + content[: match.start()].count("\n")
                found.setdefault(
                    technology,
                    Detection(
                        name=technology,
                        category="authentication",
                        evidence=f"`{needle}` used in source",
                        file=path,
                        lines=f"{line}-{line}",
                    ),
                )
                break

    return list(found.values())


def detect_database_in_code(sources: list[tuple[str, str, int]]) -> list[Detection]:
    found: dict[str, Detection] = {}
    for technology, needles in ORM_KEYWORDS.items():
        for path, content, start_line in sources:
            for needle in needles:
                match = re.search(re.escape(needle), content)
                if not match:
                    continue
                line = start_line + content[: match.start()].count("\n")
                found.setdefault(
                    technology,
                    Detection(
                        name=technology,
                        category="database",
                        evidence=f"`{needle.strip()}` used in source",
                        file=path,
                        lines=f"{line}-{line}",
                    ),
                )
                break
    return list(found.values())


def secret_key_in_config(content: str) -> bool:
    """True when the config references a server-side secret key."""
    return any(signal in content for signal in SECRET_KEY_SIGNALS)
