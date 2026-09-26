"""Secret detection (§15) and binary handling.

Two rules are absolute:

* A matched secret value is **never** returned, logged, or stored. Only its
  type, the file, the line and a redacted preview leave this module.
* A file that looks sensitive (``.env`` and friends) is never read at all — the
  scanner skips it upstream, so this module never sees one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Each pattern names the secret type and captures the sensitive group. The
# group is only ever used to build a redacted preview.
SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("service_role_key", re.compile(r"\bey[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("supabase_anon_key", re.compile(r"\b(?:supabase|anon)[-_]?(?:key|token)\s*[:=]\s*['\"]?[A-Za-z0-9_.-]{40,}")),
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("stripe_key", re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    (
        "credential_url",
        re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s:@/]+:[^\s:@/]+@[^\s/]+", re.IGNORECASE),
    ),
    (
        "api_key_assignment",
        re.compile(
            r"\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\b"
            r"\s*[:=]\s*['\"][^'\"\s]{12,}['\"]",
            re.IGNORECASE,
        ),
    ),
    ("connection_string", re.compile(r"\bpostgres(?:ql)?://[^\s:@/]+:[^\s:@/]+@[^\s/]+", re.IGNORECASE)),
)

# Values that look like secrets but are placeholders.
PLACEHOLDER_TOKENS = (
    "your_", "your-", "example", "changeme", "change-me", "placeholder",
    "xxxxx", "<", "dummy", "fake", "test-key", "todo", "insert_", "replace_",
    "process.env", "os.environ", "getenv",
)

# Environment variable *references* are the safe pattern; only a hard-coded
# literal is a finding.
SAFE_ASSIGNMENT = re.compile(
    r"(?:process\.env\.|os\.environ|getenv\(|import\.meta\.env\.|Deno\.env\.|env\[)"
)


@dataclass(frozen=True)
class SecretFinding:
    """A suspected secret. Deliberately carries no secret material."""

    secret_type: str
    file: str
    line: int
    redacted: str

    def to_dict(self) -> dict:
        return {
            "secret_type": self.secret_type,
            "file": self.file,
            "line": self.line,
            "redacted": self.redacted,
        }


def redact(secret_type: str) -> str:
    """A fixed-shape preview that cannot contain any part of the secret.

    Deliberately takes only the *type*, never the matched text. An earlier
    version tried to keep the surrounding label and leaked the whole value for
    patterns that had no ``=`` or ``:`` in them.
    """
    return f"{secret_type.replace('_', ' ')}: [redacted]"


def scan_file(path: str, content: str) -> list[SecretFinding]:
    """Return suspected secrets with values redacted. Never raises."""
    findings: list[SecretFinding] = []
    seen_types: set[str] = set()

    for secret_type, pattern in SECRET_PATTERNS:
        for match in pattern.finditer(content):
            matched = match.group(0)
            lowered = matched.lower()

            # An env-var reference is the correct way to do this, not a leak.
            if SAFE_ASSIGNMENT.search(matched):
                continue
            if any(token in lowered for token in PLACEHOLDER_TOKENS):
                continue

            line = content[: match.start()].count("\n") + 1
            if secret_type not in seen_types:
                seen_types.add(secret_type)
                findings.append(
                    SecretFinding(
                        secret_type=secret_type,
                        file=path,
                        line=line,
                        redacted=redact(secret_type),
                    )
                )
                # One finding per type per file keeps the report readable.
                break
    return findings


# ── Binary heuristic ───────────────────────────────────────────────────────

_BINARY_NULL_RATIO = 0.02
_TEXT_DECODE_LIMIT = 8000


def looks_binary(content: bytes) -> bool:
    """Cheap check: a NUL byte in the first slice means binary.

    We never decode the whole file for this, which keeps the scan cheap on
    large binaries.
    """
    sample = content[:_TEXT_DECODE_LIMIT]
    if not sample:
        return False
    if b"\x00" in sample:
        return True

    printable = sum(
        1 for byte in sample if 0x20 <= byte <= 0x7E or byte in (0x09, 0x0A, 0x0D)
    )
    return (printable / len(sample)) < (1 - _BINARY_NULL_RATIO)


def decode_text(content: bytes) -> str | None:
    """Decode as UTF-8, tolerating a little damage. ``None`` if it is not text."""
    if looks_binary(content):
        return None
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return content.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return None


def count_lines(content: str) -> int:
    if not content:
        return 0
    return content.count("\n") + (0 if content.endswith("\n") else 1)
