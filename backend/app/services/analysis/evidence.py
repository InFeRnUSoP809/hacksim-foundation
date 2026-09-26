"""Evidence registry (§26).

Every fact the scanner produces becomes an evidence object with a stable id
(``EV-001``, ``EV-002``, …) scoped to one analysis. Downstream — requirement
evaluations, findings, defence targets — reference those ids, so any conclusion
can be traced back to a file, a symbol and a line range.

Ids are assigned in detection order, which is deterministic for a given commit.
That is what makes the AI cache in §58 valid: same commit, same ids.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Iterable

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"
CONFIDENCE_LOW = "low"


@dataclass
class Evidence:
    """One verifiable fact about the repository."""

    type: str
    claim: str
    file: str | None = None
    symbol: str | None = None
    lines: str | None = None
    confidence: str = CONFIDENCE_MEDIUM
    detail: dict[str, Any] = field(default_factory=dict)

    id: str = ""
    #: Set when the id is derived from content rather than position, which keeps
    #: it stable even if detection order changes.
    fingerprint: str = ""

    def to_dict(self) -> dict:
        payload: dict[str, Any] = {
            "id": self.id,
            "type": self.type,
            "claim": self.claim,
            "confidence": self.confidence,
        }
        if self.file:
            payload["file"] = self.file
        if self.symbol:
            payload["symbol"] = self.symbol
        if self.lines:
            payload["lines"] = self.lines
        if self.detail:
            payload["detail"] = self.detail
        return payload


class EvidenceRegistry:
    """Collects evidence and hands out the stable ids."""

    def __init__(self) -> None:
        self._items: list[Evidence] = []
        self._by_fingerprint: dict[str, Evidence] = {}
        self._by_id: dict[str, Evidence] = {}

    def add(
        self,
        *,
        type: str,
        claim: str,
        file: str | None = None,
        symbol: str | None = None,
        lines: str | None = None,
        confidence: str = CONFIDENCE_MEDIUM,
        detail: dict[str, Any] | None = None,
    ) -> Evidence:
        """Register a fact. Identical facts are deduplicated, not repeated."""
        fingerprint = hashlib.sha1(
            json.dumps(
                [type, claim, file or "", symbol or "", lines or ""],
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()[:16]

        existing = self._by_fingerprint.get(fingerprint)
        if existing is not None:
            return existing

        evidence = Evidence(
            type=type,
            claim=claim,
            file=file,
            symbol=symbol,
            lines=lines,
            confidence=confidence,
            detail=detail or {},
            fingerprint=fingerprint,
        )
        evidence.id = f"EV-{len(self._items) + 1:03d}"
        self._items.append(evidence)
        self._by_fingerprint[fingerprint] = evidence
        self._by_id[evidence.id] = evidence
        return evidence


    def get(self, evidence_id: str) -> Evidence | None:
        return self._by_id.get(evidence_id)


    def by_file(self, path: str) -> list[Evidence]:
        return [item for item in self._items if item.file == path]

    def ids_for(self, items: Iterable[Evidence]) -> list[str]:
        return [item.id for item in items if item.id]

    def only_ids(self, ids: Iterable[str]) -> list[str]:
        """Filter to ids that actually exist, so a model can never invent one."""
        return [i for i in ids if i in self._by_id]

    def to_list(self) -> list[dict]:
        return [item.to_dict() for item in self._items]

    def __len__(self) -> int:
        return len(self._items)


def compact_evidence(items: list[dict], limit: int | None = None) -> list[dict]:
    """The trimmed form handed to a model: id, type, claim, file, lines only.

    Everything else — detail dictionaries, signatures, payloads — is the scanner's
    business and would only burn tokens.
    """
    compact = [
        {
            "id": item["id"],
            "type": item["type"],
            "claim": item["claim"][:220],
            "file": item.get("file"),
            "lines": item.get("lines"),
        }
        for item in items
    ]
    compact = [item for item in compact if item["file"] or item["type"] in
               ("repository", "readme", "framework", "dependency", "test_framework", "analysis_mode")]
    return compact[:limit] if limit else compact
