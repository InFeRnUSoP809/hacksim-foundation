"""Lightweight symbol and route extraction (§20, §21).

Deliberately *not* a universal AST. Regexes over line-by-line structure catch
the overwhelming majority of real code and, crucially, fail honestly: a language
we do not understand reports ``parser_status = "unsupported"`` and yields
nothing. We never fabricate a symbol we did not literally see.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ── §21 symbols ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Symbol:
    name: str
    symbol_type: str  # function | class | method | export | constant | type
    line: int
    end_line: int | None = None
    signature: str | None = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "symbol_type": self.symbol_type,
            "line": self.line,
            "end_line": self.end_line,
            "signature": self.signature,
        }


# (language group, pattern, captured group, symbol type)
_SYMBOL_RULES: tuple[tuple[str, re.Pattern[str], int, str], ...] = (
    # Python
    ("python", re.compile(r"^\s*def\s+(\w+)\s*\("), 1, "function"),
    ("python", re.compile(r"^\s*async\s+def\s+(\w+)\s*\("), 1, "function"),
    ("python", re.compile(r"^\s*class\s+(\w+)\s*[\(:]"), 1, "class"),
    # JavaScript / TypeScript
    ("javascript", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\("), 1, "function"),
    ("javascript", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\("), 1, "function"),
    ("javascript", re.compile(r"^\s*(?:export\s+)?class\s+(\w+)"), 1, "class"),
    ("javascript", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function"), 1, "function"),
    # TypeScript interfaces / types
    ("javascript", re.compile(r"^\s*(?:export\s+)?(?:interface|type)\s+(\w+)"), 1, "type"),
    # Go
    ("go", re.compile(r"^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\("), 1, "function"),
    ("go", re.compile(r"^type\s+(\w+)\s+struct"), 1, "type"),
    # Java / Kotlin
    ("java", re.compile(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)"), 1, "class"),
    ("java", re.compile(r"^\s*(?:public|private|protected)[\w\s<>\[\],]*\s(\w+)\s*\([^;]*\)\s*\{"), 1, "method"),
    ("kotlin", re.compile(r"^\s*(?:suspend\s+)?fun\s+(\w+)\s*\("), 1, "function"),
    ("kotlin", re.compile(r"^\s*(?:data\s+)?class\s+(\w+)"), 1, "class"),
    # Ruby
    ("ruby", re.compile(r"^\s*def\s+([\w?!.]+)"), 1, "method"),
    ("ruby", re.compile(r"^\s*class\s+(\w+)"), 1, "class"),
    ("ruby", re.compile(r"^\s*module\s+(\w+)"), 1, "module"),
    # Rust
    ("rust", re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)"), 1, "function"),
    ("rust", re.compile(r"^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)"), 1, "type"),
    # PHP
    ("php", re.compile(r"^\s*(?:public|private|protected)?\s*function\s+(\w+)\s*\("), 1, "method"),
    ("php", re.compile(r"^\s*(?:abstract\s+|final\s+)?class\s+(\w+)"), 1, "class"),
    # C#
    ("csharp", re.compile(r"^\s*(?:public|private|protected|internal)[\w\s<>\[\],]*\s(\w+)\s*\([^;]*\)\s*\{"), 1, "method"),
    ("csharp", re.compile(r"^\s*(?:public\s+)?(?:class|record|struct|interface)\s+(\w+)"), 1, "class"),
)

_LANGUAGE_GROUPS = {"python", "javascript", "go", "java", "kotlin", "ruby", "rust", "php", "csharp"}

SUPPORTED_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".java",
    ".kt", ".rb", ".rs", ".php", ".cs",
}

# ── §20 routes and API endpoints ───────────────────────────────────────────

HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")

@dataclass(frozen=True)
class Route:
    method: str
    path: str
    file: str
    line: int
    symbol: str | None = None
    framework: str | None = None

    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "path": self.path,
            "file": self.file,
            "line": self.line,
            "symbol": self.symbol,
            "framework": self.framework,
        }


# FastAPI / Flask decorators
_FASTAPI_ROUTE = re.compile(
    r"""@(?:app|router|api)\.(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']""",
    re.IGNORECASE,
)
_FASTAPI_ROUTE_PLAIN = re.compile(
    r"""^\s*@(app|router|api)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']""",
    re.IGNORECASE,
)
_NODE_ROUTE = re.compile(
    r"""\b(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]""",
    re.IGNORECASE,
)
_DJANGO_URL = re.compile(r"""^\s*(?:path|re_path|url)\s*\(\s*r?["']([^"']+)["']""")
_FLASK_ROUTE = re.compile(r"""@(\w+)\.route\s*\(\s*["']([^"']+)["']([^)]*)\)""")
_SPRING_MAPPING = re.compile(
    r"""@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']?(/?[\w/{}\-]*)["']?"""
)
_GO_ROUTE = re.compile(r"""\b(\w+)\.(Get|Post|Put|Patch|Delete)\s*\(\s*["`]([^"`]+)["`]""")
_LARAVEL_ROUTE = re.compile(r"""Route::(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']""")
_RAILS_ROUTE = re.compile(r"""^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]""")

# Frontend route declarations
_REACT_ROUTE = re.compile(
    r"""<Route[^>]*\bpath\s*=\s*["']([^"']+)["'][^>]*>""", re.IGNORECASE
)
_NUXT_PAGE = re.compile(r"""definePageMeta|defineNuxtRouteMiddleware""")
_FILE_BASED_ROUTE = re.compile(
    r"""^app/(.*/)?page\.(tsx|jsx|ts|js)$|^pages/(.*)\.(tsx|jsx|ts|js)$"""
)
_VUE_ROUTER = re.compile(r"""path\s*:\s*["'](/[^"']*)["']""")

_EXTERNAL_CALL = re.compile(
    r"""(?:fetch|axios(?:\.\w+)?)\s*\(\s*["'`](https?://[^"'`]+)["'`]"""
)
_REQUESTS_CALL = re.compile(r"""requests\.(get|post|put|patch|delete)\s*\(\s*f?["'](https?://[^"']+)["']""")


def extract_symbols(path: str, content: str) -> tuple[list[Symbol], str]:
    """Return ``(symbols, parser_status)``.

    ``parser_status`` is ``ok`` or ``unsupported`` — never ``partial`` dressed
    up as a success.
    """
    extension = _extension_of(path)
    if extension not in SUPPORTED_EXTENSIONS:
        return [], "unsupported"

    lines = content.split("\n")
    symbols: list[Symbol] = []
    seen: set[tuple[str, str]] = set()

    # Track the indent of the nearest enclosing class so a function defined
    # inside one is reported as a method rather than a free function.
    class_indents: list[int] = []

    for index, line in enumerate(lines, 1):
        stripped = line.rstrip()
        if not stripped.strip() or stripped.lstrip().startswith(("#", "//", "*", "/*")):
            continue

        indent = len(stripped) - len(stripped.lstrip())
        while class_indents and indent <= class_indents[-1]:
            class_indents.pop()

        for group, pattern, capture, symbol_type in _SYMBOL_RULES:
            if not _matches_group(extension, group):
                continue
            match = pattern.match(stripped)
            if not match:
                continue
            name = match.group(capture)
            if not name or name in ("if", "for", "while", "switch", "catch", "return"):
                continue

            if symbol_type == "class":
                class_indents.append(indent)
            elif symbol_type == "function" and class_indents:
                # Inside a class body, a `def`/`function` is a method.
                symbol_type = "method"

            key = (name, symbol_type)
            if key in seen:
                break
            seen.add(key)
            symbols.append(
                Symbol(
                    name=name,
                    symbol_type=symbol_type,
                    line=index,
                    signature=stripped.strip()[:200],
                )
            )
            break

    return symbols, "ok"


def _matches_group(extension: str, group: str) -> bool:
    mapping = {
        "python": {".py"},
        "javascript": {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"},
        "go": {".go"},
        "java": {".java"},
        "kotlin": {".kt"},
        "ruby": {".rb"},
        "rust": {".rs"},
        "php": {".php"},
        "csharp": {".cs"},
    }
    return extension in mapping.get(group, set())


def _extension_of(path: str) -> str:
    name = path.rsplit("/", 1)[-1].lower()
    return f".{name.rsplit('.', 1)[1]}" if "." in name else ""


def extract_routes(path: str, content: str) -> list[Route]:
    """Detect backend endpoints and frontend routes from one file."""
    routes: list[Route] = []
    extension = _extension_of(path)
    seen: set[tuple[str, str]] = set()

    def add(method: str, route_path: str, line: int, symbol: str | None, framework: str) -> None:
        key = (method.upper(), route_path)
        if key in seen:
            return
        seen.add(key)
        routes.append(
            Route(
                method=method.upper(),
                path=route_path,
                file=path,
                line=line,
                symbol=symbol,
                framework=framework,
            )
        )

    for index, line in enumerate(content.split("\n"), 1):
        match = _FASTAPI_ROUTE_PLAIN.search(line)
        if match:
            add(match.group(2), match.group(3), index, None, "FastAPI")
            continue

        match = _FLASK_ROUTE.search(line)
        if match:
            methods = re.findall(r"(get|post|put|patch|delete)", match.group(3), re.IGNORECASE)
            for method in methods or ["GET"]:
                add(method, match.group(2), index, match.group(1), "Flask")
            continue

        match = _SPRING_MAPPING.search(line)
        if match:
            method = "GET" if match.group(1) == "Request" else match.group(1).upper()
            add(method, match.group(2) or "/", index, None, "Spring")
            continue

        match = _GO_ROUTE.search(line)
        if match:
            add(match.group(2), match.group(3), index, match.group(1), "Go")
            continue

        match = _LARAVEL_ROUTE.search(line)
        if match:
            add(match.group(1), match.group(2), index, None, "Laravel")
            continue

        match = _RAILS_ROUTE.match(line)
        if match:
            add(match.group(1), match.group(2), index, None, "Rails")
            continue

        match = _DJANGO_URL.match(line)
        if match:
            add("ANY", match.group(1), index, None, "Django")
            continue

        match = _NODE_ROUTE.search(line)
        if match:
            add(match.group(1), match.group(2), index, None, "Express")
            continue

        if extension == ".py":
            continue

        match = _REACT_ROUTE.search(line)
        if match:
            add("GET", match.group(1), index, None, "React Router")
            continue

    # File-based routing: the file path *is* the route.
    file_route = _FILE_BASED_ROUTE.match(path)
    if file_route:
        segments = [s for s in (file_route.group(1) or file_route.group(3) or "").split("/") if s and s != "index"]
        add("GET", "/" + "/".join(segments), 1, None, "File-based routing")

    return routes


def extract_external_integrations(content: str, file: str) -> list[dict]:
    """Outbound calls to third-party services (§20)."""
    integrations: dict[str, dict] = {}

    for match in _EXTERNAL_CALL.finditer(content):
        integrations.setdefault(
            match.group(1),
            {
                "url": match.group(1),
                "file": file,
                "line": content[: match.start()].count("\n") + 1,
                "method": None,
            },
        )

    for match in _REQUESTS_CALL.finditer(content):
        integrations.setdefault(
            match.group(2),
            {
                "url": match.group(2),
                "file": file,
                "line": content[: match.start()].count("\n") + 1,
                "method": match.group(1).upper(),
            },
        )

    return list(integrations.values())


# ── §24 tests ──────────────────────────────────────────────────────────────

_TEST_FRAMEWORKS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Jest", ("jest.config",)),
    ("Vitest", ("vitest.config",)),
    ("Pytest", ("pytest.ini", "conftest.py")),
    ("Playwright", ("playwright.config",)),
    ("Cypress", ("cypress.config", "cypress.json")),
    ("Mocha", (".mocharc",)),
    ("Testing Library", ("setupTests", "jest.setup")),
    ("Django test runner", ("manage.py",)),
)

_TEST_FILE_PATTERNS = (
    re.compile(r"(^|/)(test_[^/]+\.py|[^/]+_test\.py)$"),
    re.compile(r"(^|/)(tests?/.*\.(py|ts|tsx|js|jsx))$"),
    re.compile(r"\.(test|spec)\.(ts|tsx|js|jsx)$"),
    re.compile(r"(__tests__/.*\.(ts|tsx|js|jsx))$"),
)

_TEST_COMMAND_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("npm test", re.compile(r'"test"\s*:\s*"([^"]+)"')),
    ("pytest", re.compile(r"\bpytest\b")),
    ("go test", re.compile(r"\bgo test\b")),
    ("cargo test", re.compile(r"\bcargo test\b")),
)


def is_test_file(path: str) -> bool:
    return any(pattern.search(path) for pattern in _TEST_FILE_PATTERNS)


def detect_test_frameworks(config_filenames: list[str], paths: list[str]) -> list[dict]:
    found: list[dict] = []
    lowered_configs = {name.lower() for name in config_filenames}
    lowered_paths = {path.lower() for path in paths}

    for framework, needles in _TEST_FRAMEWORKS:
        for needle in needles:
            if any(needle in name for name in lowered_configs | lowered_paths):
                found.append({"name": framework, "evidence": f"`{needle}` present"})
                break

    if any(is_test_file(path) for path in paths) and not found:
        found.append(
            {
                "name": "Unidentified",
                "evidence": "test files present but no known test configuration found",
            }
        )
    return found


def detect_test_commands(contents: list[tuple[str, str]]) -> list[str]:
    commands: set[str] = set()
    for _, content in contents:
        for command, pattern in _TEST_COMMAND_PATTERNS:
            if pattern.search(content):
                commands.add(command)
    return sorted(commands)


# ── §25 README ─────────────────────────────────────────────────────────────

README_MAX_BYTES = 60_000

_SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "description": ("description", "about", "overview", "introduction", "what is", "summary"),
    "setup": ("installation", "getting started", "setup", "quick start", "how to run", "running locally"),
    "features": ("features", "functionality", "capabilities", "key features", "what it does"),
    "technologies": ("tech stack", "technologies", "built with", "stack", "tools"),
    "usage": ("usage", "how to use", "examples", "example"),
}

_HEADING = re.compile(r"^(#{1,4})\s+(.+?)\s*$", re.MULTILINE)
_BULLET = re.compile(r"^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+)$", re.MULTILINE)
_NUMBERED = re.compile(r"^\s*\d+[.)]\s+(.+)$", re.MULTILINE)
_CODE_BLOCK = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)
_FENCE_LANG = re.compile(r"```([\w+\-]+)")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def parse_readme(path: str, content: str) -> dict:
    """Extract description, setup, features, technologies and usage (§25)."""
    if len(content.encode("utf-8", errors="ignore")) > README_MAX_BYTES:
        content = content[:README_MAX_BYTES]

    sections: dict[str, list[str]] = {}
    current = "_preamble"
    sections[current] = []

    for match in _HEADING.finditer(content):
        current = match.group(2).strip().lower()
        sections.setdefault(current, [])
        sections[current].append("")

    # Split once by heading so a section keeps its own body.
    parts = _HEADING.split(content)
    preambles = parts[0] if parts else ""
    for index in range(1, len(parts) - 2, 3):
        title = parts[index + 1].strip().lower()
        body = parts[index + 3] if index + 3 < len(parts) else ""
        sections[title] = [body]

    def body_for(keys: tuple[str, ...]) -> str:
        for key, blocks in sections.items():
            if any(alias in key for alias in keys):
                return "\n".join(blocks)
        return ""

    description = preambles.strip() or body_for(_SECTION_ALIASES["description"])
    features = _bullets(body_for(_SECTION_ALIASES["features"])) or _bullets(description)
    technologies = _technologies(content)

    return {
        "path": path,
        "present": bool(content.strip()),
        "description": _first_paragraph(description),
        "features": features[:20],
        "technologies": technologies,
        "setup": _first_code_block(body_for(_SECTION_ALIASES["setup"])) or "",
        "usage": _first_code_block(body_for(_SECTION_ALIASES["usage"])) or "",
        "sections": sorted(title for title in sections if title != "_preamble")[:30],
        "links": [
            {"text": m.group(1).strip()[:80], "href": m.group(2).strip()[:200]}
            for m in _LINK.finditer(content)
        ][:20],
    }


def _bullets(body: str) -> list[str]:
    items = [m.group(1).strip() for m in _BULLET.finditer(body)]
    if not items:
        items = [m.group(1).strip() for m in _NUMBERED.finditer(body)]
    return [item for item in items if 3 < len(item) < 200][:25]


def _first_paragraph(body: str) -> str:
    for block in re.split(r"\n\s*\n", body):
        cleaned = block.strip()
        if not cleaned or cleaned.startswith(("#", "!", "[", "<", "-", "*", "|", "```")):
            continue
        return cleaned[:1200]
    return ""


def _first_code_block(body: str) -> str:
    match = _CODE_BLOCK.search(body)
    return match.group(1).strip()[:800] if match else ""


_TECH_HINTS = (
    "react", "next.js", "nextjs", "vue", "nuxt", "angular", "svelte", "vite",
    "typescript", "javascript", "python", "django", "flask", "fastapi",
    "express", "nestjs", "spring", "laravel", "rails", "flutter",
    "supabase", "postgres", "postgresql", "mysql", "mongodb", "redis",
    "prisma", "tailwind", "openai", "tensorflow", "pytorch", "scikit-learn",
    "docker", "vercel", "aws", "tensorflow.js", "node.js", "php", "java",
)


def _technologies(content: str) -> list[str]:
    body = body_for_readme_technologies = content
    stack_section = ""
    for title, blocks in _sections_by_title(content).items():
        if any(alias in title for alias in _SECTION_ALIASES["technologies"]):
            stack_section = "\n".join(blocks)
            break

    haystack = f"{stack_section}\n{body_for_readme_technologies}".lower()
    found = [hint for hint in _TECH_HINTS if hint in haystack]
    return found[:20]


def _sections_by_title(content: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    parts = _HEADING.split(content)
    for index in range(1, len(parts) - 2, 3):
        sections.setdefault(parts[index + 1].strip().lower(), []).append(
            parts[index + 3] if index + 3 < len(parts) else ""
        )
    return sections
