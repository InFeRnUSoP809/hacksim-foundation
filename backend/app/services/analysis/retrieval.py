"""Targeted code retrieval (§28).

This module is the reason Phase 6 is affordable. For a given question it
assembles the smallest useful packet:

    ≤ 6 files
    ≤ 120 lines per snippet

Selection is deterministic and ranked, never a blind "first N files that look
relevant". If nothing ranks, the caller gets an empty packet and is expected to
record ``not_evidenced`` rather than pad the prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from app.core.config import Settings

# Terms that, when present in a question, point at a kind of file.
QUESTION_SIGNALS: dict[str, tuple[str, ...]] = {
    "security": (
        "auth", "login", "password", "token", "jwt", "session", "cookie",
        "permission", "role", "secret", "key", "credential", "encrypt", "hash",
    ),
    "database": (
        "database", "db", "schema", "migration", "table", "query", "sql",
        "model", "orm", "index", "postgres", "supabase", "storage", "data",
    ),
    "api": (
        "api", "endpoint", "route", "request", "response", "controller",
        "handler", "rest", "graphql", "webhook", "fetch", "http",
    ),
    "frontend": (
        "ui", "component", "page", "screen", "form", "render", "view",
        "react", "vue", "dashboard", "interface", "click", "button",
    ),
    "testing": ("test", "spec", "coverage", "assert", "mock", "fixture"),
    "prediction": (
        "predict", "forecast", "model", "train", "inference", "ml",
        "machine learning", "algorithm", "score", "accuracy", "dataset",
    ),
    "deployment": ("deploy", "docker", "build", "ci", "pipeline", "hosting", "vercel"),
    "configuration": ("config", "setting", "environment", "env", "variable", "option"),
}

# Path fragments that indicate a file answers a category.
PATH_SIGNALS: dict[str, tuple[str, ...]] = {
    "security": ("auth", "login", "session", "permission", "middleware", "guard", "acl"),
    "database": ("schema", "migration", "model", "db", "database", "sql", "prisma", "repository"),
    "api": ("route", "router", "controller", "api", "endpoint", "handler", "view"),
    "frontend": ("component", "page", "view", "screen", "ui", "app/", "layout"),
    "testing": ("test", "spec", "__tests__", "fixtures"),
    "deployment": ("docker", "workflow", "deploy", "ci", "vercel", "netlify"),
    "configuration": ("config", "settings", ".env", "settings.py", "constants"),
}

# Category → file_category preference, used when the question has no signal.
CATEGORY_PREFERENCE: dict[str, tuple[str, ...]] = {
    "security": ("source", "api", "config", "model"),
    "database": ("database", "schema", "model", "source"),
    "api": ("api", "source", "component"),
    "frontend": ("component", "source"),
    "testing": ("test",),
    "deployment": ("deployment", "config"),
    "configuration": ("config", "deployment", "source"),
}

DEFAULT_MAX_FILES = 6
DEFAULT_MAX_LINES = 120


@dataclass
class Snippet:
    path: str
    symbol: str | None
    start_line: int
    end_line: int
    content: str
    language: str | None
    score: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "symbol": self.symbol,
            "lines": f"{self.start_line}-{self.end_line}",
            "language": self.language,
            "content": self.content,
        }


@dataclass
class ContextPacket:
    """The small, bounded context handed to one AI task."""

    question: str
    category: str
    snippets: list[Snippet] = field(default_factory=list)
    files_considered: int = 0
    truncated: bool = False

    @property
    def is_empty(self) -> bool:
        return not self.snippets

    def estimate_tokens(self) -> int:
        chars = sum(len(s.content) for s in self.snippets)
        return chars // 4

    def render(self, max_snippet_lines: int = DEFAULT_MAX_LINES) -> str:
        if not self.snippets:
            return ""
        blocks: list[str] = []
        for snippet in self.snippets:
            lines = snippet.content.split("\n")[:max_snippet_lines]
            body = "\n".join(lines)
            if len(lines) < len(snippet.content.split("\n")):
                body += "\n… (truncated)"
            blocks.append(
                f"--- {snippet.path} [{snippet.symbol or 'file'}] "
                f"lines {snippet.start_line}-{snippet.end_line} ---\n{body}"
            )
        return "\n\n".join(blocks)


def classify_question(question: str, categories: list[str] | None = None) -> str:
    """Pick the single most relevant retrieval category for a question."""
    lowered = (question or "").lower()
    wanted = categories or list(QUESTION_SIGNALS)

    best_category = "general"
    best_score = 0
    for category in wanted:
        score = sum(1 for term in QUESTION_SIGNALS.get(category, ()) if term in lowered)
        if score > best_score:
            best_score = score
            best_category = category
    return best_category


def build_packet(
    *,
    question: str,
    files: list[dict[str, Any]],
    chunks: list[dict[str, Any]],
    category: str | None = None,
    settings: "Settings | None" = None,
    max_files: int | None = None,
    max_lines: int | None = None,
) -> ContextPacket:
    """Assemble the packet for one question.

    ``files`` is the Phase 5 inventory and ``chunks`` its symbol-level chunks.
    Files are ranked by category signal, then by lexical overlap with the
    question, then by Phase 5 importance.
    """
    limit_files = max_files or (settings.retrieval_max_files if settings else DEFAULT_MAX_FILES)
    limit_lines = max_lines or (
        settings.retrieval_max_snippet_lines if settings else DEFAULT_MAX_LINES
    )

    resolved_category = category or classify_question(question)
    packet = ContextPacket(question=question, category=resolved_category)
    packet.files_considered = len(files)

    if not files:
        return packet

    question_terms = {
        term for term in re.split(r"\W+", (question or "").lower()) if len(term) > 3
    }
    path_terms = PATH_SIGNALS.get(resolved_category, ())
    preferred_categories = CATEGORY_PREFERENCE.get(resolved_category, ())
    importance_weight = {"high": 30.0, "medium": 15.0, "low": 5.0, "ignored": 0.0}

    chunks_by_file: dict[str, list[dict[str, Any]]] = {}
    for chunk in chunks:
        path = chunk.get("file_path") or chunk.get("path")
        if path:
            chunks_by_file.setdefault(path, []).append(chunk)

    ranked: list[tuple[float, dict[str, Any], list[dict[str, Any]]]] = []

    for record in files:
        path = record.get("path") or ""
        if not path or record.get("is_ignored") or record.get("is_binary"):
            continue
        if record.get("importance") == "ignored":
            continue

        lowered = path.lower()
        score = importance_weight.get(record.get("importance") or "low", 5.0)

        if any(fragment in lowered for fragment in path_terms):
            score += 40.0
        if record.get("file_category") in preferred_categories:
            score += 20.0

        overlap = sum(1 for term in question_terms if term in lowered)
        score += overlap * 6.0

        candidate_chunks = chunks_by_file.get(path, [])
        for chunk in candidate_chunks:
            symbol = (chunk.get("symbol_name") or "").lower()
            if symbol and any(term in symbol for term in question_terms):
                score += 18.0
                break

        if score <= 5.0:
            continue

        ranked.append((score, record, candidate_chunks))

    ranked.sort(key=lambda item: item[0], reverse=True)

    selected = ranked[:limit_files]
    if len(ranked) > len(selected):
        packet.truncated = True

    for score, record, candidate_chunks in selected:
        path = record.get("path") or ""
        language = record.get("language")

        if candidate_chunks:
            # Prefer a chunk whose symbol matches the question.
            chosen = max(
                candidate_chunks,
                key=lambda chunk: (
                    chunk.get("importance") == "high",
                    sum(
                        1
                        for term in question_terms
                        if term in (chunk.get("symbol_name") or "").lower()
                    ),
                ),
            )
            start = int(chosen.get("start_line") or 1)
            end = min(start + limit_lines - 1, int(chosen.get("end_line") or start + limit_lines))
            content = chosen.get("content") or ""
            symbol = chosen.get("symbol_name")
        else:
            # A file with no symbol chunk contributes its identity only — we
            # never fetch content the scanner did not already read.
            start = 1
            end = limit_lines
            content = ""
            symbol = None

        packet.snippets.append(
            Snippet(
                path=path,
                symbol=symbol,
                start_line=start,
                end_line=end,
                content=content,
                language=language,
                score=score,
            )
        )

    return packet

