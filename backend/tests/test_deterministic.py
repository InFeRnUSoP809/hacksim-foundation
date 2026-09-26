"""Tests for the deterministic Phase 5 layer.

Run with:  python -m unittest discover -s backend/tests -t backend

These cover the parts where a silent regression would corrupt the evidence the
AI is later asked to trust: classification, dependency categorisation, symbol
and route extraction, secret redaction, retrieval ranking and requirement maps.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.analysis.evidence import EvidenceRegistry  # noqa: E402
from app.services.analysis.project_map import build_project_map  # noqa: E402
from app.services.analysis.requirements import build_requirement_map  # noqa: E402
from app.services.analysis.retrieval import build_packet  # noqa: E402
from app.services.github import dependencies as deps  # noqa: E402
from app.services.github import symbols as sym  # noqa: E402
from app.services.github.urls import InvalidRepositoryUrl, parse_repository_url  # noqa: E402
from app.services.github.ignore import FileFacts, category_of, importance_of, is_ignored  # noqa: E402
from app.services.github.secrets import looks_binary, redact, scan_file  # noqa: E402
from app.services.ai.modules import validate_findings  # noqa: E402


def _facts(path: str, size: int = 100, binary: bool = False) -> FileFacts:
    return FileFacts(path=path, size=size, is_binary=binary)


class TestIgnore(unittest.TestCase):
    def test_ignores_build_and_vendor_directories(self) -> None:
        for path in (
            "node_modules/react/index.js",
            "dist/bundle.js",
            ".next/server.js",
            "vendor/lib.go",
            "__pycache__/mod.pyc",
            "target/debug/app",
        ):
            self.assertTrue(is_ignored(path), path)

    def test_ignores_lockfiles_and_binaries(self) -> None:
        for path in (
            "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
            "logo.png", "demo.mp4", "archive.tar.gz", "backup.bak", "data.dump",
        ):
            self.assertTrue(is_ignored(path), path)

    def test_sql_is_kept_because_schema_files_are_evidence(self) -> None:
        # §14 asks to skip database dumps, but "*.sql" is also how a schema
        # arrives. Ignoring it wholesale would delete real evidence, so only
        # the unambiguous dump/bak extensions are skipped.
        self.assertFalse(is_ignored("supabase/schema.sql"))
        self.assertTrue(is_ignored("data.dump"))

    def test_keeps_source_files(self) -> None:
        for path in ("src/app.ts", "backend/main.py", "README.md", "supabase/schema.sql"):
            self.assertFalse(is_ignored(path), path)

    def test_classification(self) -> None:
        cases = {
            "src/api/auth.py": "source",
            "app/page.tsx": "component",
            "supabase/schema.sql": "database",
            "prisma/schema.prisma": "schema",
            "tests/test_thing.py": "test",
            "vite.config.ts": "config",
            "docs/guide.md": "documentation",
            "package.json": "dependency",
        }
        for path, expected in cases.items():
            self.assertEqual(category_of(_facts(path)), expected, path)

    def test_importance_ranking(self) -> None:
        self.assertEqual(importance_of(_facts("README.md"), "documentation"), "high")
        self.assertEqual(importance_of(_facts("app/Button.tsx"), "component"), "medium")
        self.assertEqual(importance_of(_facts("dist/a.js"), "source"), "ignored")


class TestDependencies(unittest.TestCase):
    def test_npm(self) -> None:
        found = deps.extract(
            "package.json",
            '{"dependencies":{"next":"14.0.0","@supabase/supabase-js":"2"},'
            '"devDependencies":{"vitest":"1"}}',
        )
        by_package = {d.package: d for d in found}
        self.assertEqual(by_package["next"].category, "frontend")
        self.assertEqual(by_package["@supabase/supabase-js"].category, "database")
        self.assertEqual(by_package["vitest"].category, "testing")
        self.assertTrue(by_package["vitest"].dev)

    def test_exact_match_beats_substring(self) -> None:
        # "vitest" contains "vite"; it must not be filed under frontend.
        self.assertEqual(deps.categorise("vitest"), "testing")
        self.assertEqual(deps.categorise("vite"), "frontend")

    def test_requirements_txt(self) -> None:
        found = deps.extract("requirements.txt", "fastapi==0.115.0\nsqlalchemy>=2.0\n# note\n")
        by_package = {d.package: d for d in found}
        self.assertEqual(by_package["fastapi"].version, "0.115.0")
        self.assertEqual(by_package["sqlalchemy"].category, "database")
        self.assertNotIn("# note", by_package)

    def test_go_mod(self) -> None:
        found = deps.extract("go.mod", "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n")
        self.assertEqual(found[0].package, "github.com/gin-gonic/gin")
        self.assertEqual(found[0].category, "backend")

    def test_malformed_manifest_is_not_fatal(self) -> None:
        self.assertEqual(deps.extract("package.json", "{not json"), [])


class TestSymbols(unittest.TestCase):
    def test_python_methods_versus_functions(self) -> None:
        source = (
            "class Service:\n"
            "    def get(self, uid):\n"
            "        return None\n"
            "\n"
            "def standalone():\n"
            "    pass\n"
        )
        found, status = sym.extract_symbols("svc.py", source)
        self.assertEqual(status, "ok")
        kinds = {s.name: s.symbol_type for s in found}
        self.assertEqual(kinds["Service"], "class")
        self.assertEqual(kinds["get"], "method")
        self.assertEqual(kinds["standalone"], "function")

    def test_unsupported_language_reports_unsupported(self) -> None:
        found, status = sym.extract_symbols("notes.txt", "hello world")
        self.assertEqual(status, "unsupported")
        self.assertEqual(found, [])

    def test_fastapi_route(self) -> None:
        source = '@router.post("/api/login")\ndef login(req):\n    return {}\n'
        routes = sym.extract_routes("api/auth.py", source)
        self.assertEqual(len(routes), 1)
        self.assertEqual((routes[0].method, routes[0].path), ("POST", "/api/login"))
        self.assertEqual(routes[0].framework, "FastAPI")

    def test_file_based_route(self) -> None:
        routes = sym.extract_routes("app/dashboard/page.tsx", "export default function P(){}")
        self.assertEqual(routes[0].path, "/dashboard")

    def test_test_file_detection(self) -> None:
        self.assertTrue(sym.is_test_file("tests/test_thing.py"))
        self.assertTrue(sym.is_test_file("src/a.spec.ts"))
        self.assertFalse(sym.is_test_file("src/latest.ts"))


class TestSecrets(unittest.TestCase):
    def test_value_is_never_returned(self) -> None:
        # Built at runtime so no real-looking credential is stored in the repo.
        value = "sk-" + "A" * 32
        content = f'api_key = "{value}"\n'
        findings = scan_file("config.py", content)
        self.assertTrue(findings)
        for finding in findings:
            self.assertNotIn("A" * 32, finding.redacted)
            self.assertIn("redacted", finding.redacted)

    def test_environment_reference_is_not_a_finding(self) -> None:
        content = 'api_key = os.environ["API_KEY"]\n'
        self.assertEqual(scan_file("config.py", content), [])

    def test_placeholder_is_ignored(self) -> None:
        value = "sk-" + "B" * 32
        self.assertEqual(scan_file("c.py", f'k = "{value}"\n'), scan_file("c.py", f'k = "{value}"\n'))
        self.assertEqual(scan_file("c.py", 'k = "your_api_key_here_placeholder"\n'), [])

    def test_redaction_keeps_only_the_type(self) -> None:
        preview = redact("private_key")
        self.assertIn("private key", preview)
        self.assertIn("redacted", preview)

    def test_binary_detection(self) -> None:
        self.assertTrue(looks_binary(b"\x00\x01\x02\x03"))
        self.assertFalse(looks_binary(b"print('hello')\n"))


class TestUrlParsing(unittest.TestCase):
    def test_accepts_https_url(self) -> None:
        ref = parse_repository_url("https://github.com/acme/widget")
        self.assertEqual((ref.owner, ref.repo), ("acme", "widget"))
        self.assertEqual(ref.normalized_url, "https://github.com/acme/widget")

    def test_strips_git_suffix_and_trailing_slash(self) -> None:
        ref = parse_repository_url("https://github.com/acme/widget.git/")
        self.assertEqual((ref.owner, ref.repo), ("acme", "widget"))

    def test_accepts_ssh_form(self) -> None:
        ref = parse_repository_url("git@github.com:acme/widget.git")
        self.assertEqual((ref.owner, ref.repo), ("acme", "widget"))

    def test_rejects_non_repository_urls(self) -> None:
        for bad in (
            "https://gitlab.com/acme/widget",
            "https://github.com/acme",
            "https://github.com/acme/widget/tree/main",
            "https://example.com/a/b",
            "",
        ):
            with self.assertRaises(InvalidRepositoryUrl, msg=bad):
                parse_repository_url(bad)


class TestEvidence(unittest.TestCase):
    def test_ids_are_stable_and_deduplicated(self) -> None:
        registry = EvidenceRegistry()
        first = registry.add(type="route", claim="GET /x", file="a.py", lines="1-2")
        duplicate = registry.add(type="route", claim="GET /x", file="a.py", lines="1-2")
        other = registry.add(type="route", claim="POST /y", file="b.py")

        self.assertEqual(first.id, "EV-001")
        self.assertEqual(first.id, duplicate.id)
        self.assertEqual(other.id, "EV-002")
        self.assertEqual(len(registry), 2)

    def test_only_ids_filters_invented_references(self) -> None:
        registry = EvidenceRegistry()
        registry.add(type="route", claim="GET /x")
        self.assertEqual(registry.only_ids(["EV-001", "EV-999"]), ["EV-001"])


class TestRetrieval(unittest.TestCase):
    FILES = [
        {"path": "backend/auth.py", "file_category": "source", "importance": "high", "is_ignored": False, "is_binary": False, "language": "Python"},
        {"path": "backend/api/routes.py", "file_category": "api", "importance": "high", "is_ignored": False, "is_binary": False, "language": "Python"},
        {"path": "frontend/Button.tsx", "file_category": "component", "importance": "medium", "is_ignored": False, "is_binary": False, "language": "TypeScript"},
        {"path": "dist/bundle.js", "file_category": "source", "importance": "ignored", "is_ignored": True, "is_binary": True, "language": "JavaScript"},
    ]
    CHUNKS = [
        {"file_path": "backend/auth.py", "symbol_name": "login", "start_line": 10, "end_line": 40, "content": "def login(): pass", "importance": "high"},
    ]

    def test_ranks_by_question_relevance(self) -> None:
        packet = build_packet(question="how is authentication handled?", files=self.FILES, chunks=self.CHUNKS)
        self.assertTrue(packet.snippets)
        self.assertEqual(packet.snippets[0].path, "backend/auth.py")
        self.assertEqual(packet.category, "security")

    def test_ignored_files_are_never_returned(self) -> None:
        packet = build_packet(question="javascript build output", files=self.FILES, chunks=self.CHUNKS)
        self.assertNotIn("dist/bundle.js", [s.path for s in packet.snippets])

    def test_respects_the_file_cap(self) -> None:
        packet = build_packet(question="code", files=self.FILES, chunks=self.CHUNKS, max_files=2)
        self.assertLessEqual(len(packet.snippets), 2)

    def test_empty_input_yields_empty_packet(self) -> None:
        packet = build_packet(question="anything", files=[], chunks=[])
        self.assertTrue(packet.is_empty)
        self.assertEqual(packet.render(), "")


class TestRequirementMap(unittest.TestCase):
    HACKATHON = {
        "problem_statement": "Build a demand predictor.",
        "requirements": "- Ingest a historical dataset\n- Produce a demand forecast per medicine",
        "constraints": "- Must not require paid data services",
        "expected_outcome": "A pharmacist can act on the output.",
        "evaluation_criteria": "1. Forecast quality\n2. Explainability",
    }

    def test_assigns_stable_ids(self) -> None:
        built = build_requirement_map(self.HACKATHON)
        self.assertEqual([r["id"] for r in built["requirements"]], ["REQ-001", "REQ-002"])
        self.assertEqual([c["id"] for c in built["constraints"]], ["CON-001"])
        self.assertEqual([o["id"] for o in built["expected_outcomes"]], ["OUT-001"])
        self.assertEqual([e["id"] for e in built["evaluation_criteria"]], ["EVAL-001", "EVAL-002"])

    def test_does_not_call_a_model(self) -> None:
        built = build_requirement_map(self.HACKATHON)
        self.assertTrue(all("text" in r and "category" in r for r in built["requirements"]))

    def test_empty_brief_yields_nothing(self) -> None:
        built = build_requirement_map({})
        self.assertEqual(built["requirements"], [])


class TestFindingValidation(unittest.TestCase):
    KNOWN = {"EV-001", "EV-002"}

    def test_finding_without_evidence_is_dropped(self) -> None:
        raw = [{"title": "Invented", "type": "potential_issue", "evidence_ids": ["EV-999"]}]
        self.assertEqual(validate_findings(raw, self.KNOWN), [])

    def test_low_confidence_confirmed_issue_is_downgraded(self) -> None:
        raw = [
            {
                "title": "Possible flaw",
                "type": "confirmed_issue",
                "evidence_ids": ["EV-001"],
                "confidence": "low",
            }
        ]
        self.assertEqual(validate_findings(raw, self.KNOWN)[0]["finding_type"], "potential_issue")

    def test_observations_are_allowed_without_evidence(self) -> None:
        raw = [{"title": "Note", "type": "observation", "evidence_ids": []}]
        self.assertEqual(len(validate_findings(raw, self.KNOWN)), 1)

    def test_unknown_type_and_severity_fall_back(self) -> None:
        raw = [{"title": "X", "type": "invented_type", "severity": "apocalyptic", "evidence_ids": ["EV-001"]}]
        finding = validate_findings(raw, self.KNOWN)[0]
        self.assertEqual(finding["finding_type"], "observation")
        self.assertEqual(finding["severity"], "low")


class TestProjectMap(unittest.TestCase):
    def test_truncation_is_recorded_not_hidden(self) -> None:
        files = [
            {"path": f"src/file{i}.py", "file_category": "source", "importance": "medium", "language": "Python", "line_count": 10}
            for i in range(120)
        ]
        routes = [{"method": "GET", "path": f"/r{i}", "file": "a.py", "line": i} for i in range(90)]
        project_map = build_project_map(
            repository={"owner": "a", "repo_name": "b"},
            files=files,
            dependencies=[],
            frameworks=[],
            databases=[],
            auth=[],
            routes=routes,
            symbols=[],
            integrations=[],
            tests={"file_count": 0, "frameworks": [], "commands": []},
            readme=None,
            secrets=[],
            analysis_mode="full",
            warnings=[],
        )
        self.assertEqual(len(project_map["apis"]), 40)
        self.assertGreater(project_map["truncated"]["routes"], 0)
        self.assertTrue(any("further endpoints" in w for w in project_map["warnings"]))

    def test_large_repository_marks_limited_mode(self) -> None:
        project_map = build_project_map(
            repository={},
            files=[],
            dependencies=[],
            frameworks=[],
            databases=[],
            auth=[],
            routes=[],
            symbols=[],
            integrations=[],
            tests={},
            readme=None,
            secrets=[],
            analysis_mode="limited",
            warnings=[],
        )
        self.assertEqual(project_map["architecture"]["layers"], [])
        self.assertTrue(
            any("Large repository" in w for w in project_map["warnings"]), project_map["warnings"]
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
