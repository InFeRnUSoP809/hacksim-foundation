/**
 * AI review modules (§41, §42, §43, §44).
 *
 * Four modules, never one giant prompt:
 *
 *   A  problem alignment + requirements + claims
 *   B  architecture + implementation + technical decisions
 *   C  security + database + testing
 *   D  contribution + claim verification (per member)
 *
 * Each module decides for itself whether to call the model at all (§42). The
 * deterministic pre-pass below is what keeps a normal project inside a few
 * thousand tokens: when the evidence already answers the question, the answer
 * is recorded with `source = 'deterministic'` and no request is made.
 */

import { compactEvidence, type Evidence, type ProjectMap } from "./github.ts";
import type { RequirementEntry, RequirementMap } from "./requirements.ts";

// Bump when a prompt changes materially. It is part of the AI cache identity
// (§58), so a prompt edit invalidates cached results rather than serving stale
// reasoning.
export const PROMPT_VERSIONS = {
  alignment: "align-v1",
  architecture: "arch-v1",
  quality: "quality-v1",
  contribution: "contrib-v1",
  claims: "claims-v1",
  requirements_fallback: "reqmap-v1",
} as const;

export const MODULE_A = "alignment";
export const MODULE_B = "architecture";
export const MODULE_C = "quality";
export const MODULE_D = "contribution";

// ── The stable system prompt (§59) ─────────────────────────────────────────
// Byte-identical between runs so the provider can cache it.
export const SYSTEM_STABLE = `You are a technical reviewer assessing a hackathon submission against its
brief. You are given FACTS extracted deterministically from a GitHub repository,
and small targeted code snippets. The facts are the source of truth.

Rules you must follow:
1. Never invent files, functions, endpoints, tables, dependencies, features,
metrics or vulnerabilities. If something is not in the evidence, say it is not
evidenced.
2. Every conclusion must cite evidence ids from the list you are given.
3. "not_evidenced" means the analysed repository did not show sufficient evidence.
It does NOT mean the feature does not exist.
4. Never claim a real-world impact or benchmark number unless the evidence
contains a measurement. Describe intent instead.
5. Prefer "potential_issue" over "confirmed_issue". Use "confirmed_issue" only
when the evidence unambiguously establishes the problem.
6. Do not rank, score, or compare teams. This is a training analysis.
7. Reply with a single JSON object matching the requested shape. No prose.`;

export interface ModuleResult {
  module: string;
  /** "skipped" | "completed" | "failed" | "cached" */
  status: string;
  /** "deterministic" | "ai" */
  source: string;
  data: Record<string, unknown>;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
}

export function moduleResult(
  module: string,
  status: string,
  source: string,
  data: Record<string, unknown>,
  reason = "",
): ModuleResult {
  return { module, status, source, data, reason };
}

// ── §42 deterministic facts ─────────────────────────────────────────────────
// Only facts that are a count or a lookup live here. Judgement calls belong to
// the model: the alignment pre-pass that used to sit in this section answered
// "does this solve the problem?" by matching a three-keyword table against the
// authentication detectors, and reported every unfamiliar brief as unaligned.


export interface TestingFacts {
  status: string;
  testFileCount: number;
  frameworks: (string | null)[];
  commands: string[];
  finding: string | null;
  explanation: string;
}

/** Test coverage is a count, not a judgement. Never needs a model. */
export function testingFromEvidence(projectMap: ProjectMap): TestingFacts {
  const testing = projectMap.testing ?? {};
  const count = Number(testing.test_file_count ?? 0);
  const frameworks = ((testing.frameworks as string[]) ?? []).map((name) => name);

  let status: string;
  let finding: string | null;
  if (count === 0) {
    status = "not_evidenced";
    finding = "testing_gap";
  } else if (count < 3) {
    status = "partial_evidence";
    finding = "testing_gap";
  } else {
    status = "evidence_found";
    finding = null;
  }

  return {
    status,
    testFileCount: count,
    frameworks,
    commands: (testing.commands as string[]) ?? [],
    finding,
    explanation:
      count === 0
        ? "No test files were detected in the analysed repository."
        : `${count} test files detected. File count is not a measure of test quality.`,
  };
}

/** Hard-coded secrets are a finding with no interpretation required. */
export function securityFromEvidence(
  projectMap: ProjectMap,
): { status: string; confirmed_issues: Record<string, unknown>[] } | null {
  const secrets = (projectMap.security as { hardcoded_secrets?: { type: string; file: string; line: number }[] })
    ?.hardcoded_secrets ?? [];
  if (secrets.length === 0) return null;

  return {
    status: "evidence_found",
    confirmed_issues: secrets.slice(0, 5).map((item) => {
      const words = item.type.replace(/_/g, " ");
      return {
        type: "security_concern",
        severity: "high",
        title: `Hard-coded ${words} in ${item.file}`,
        description:
          `A value matching a ${words} pattern was found at ${item.file} line ` +
          `${item.line}. The value itself is redacted and was not transmitted.`,
        why_it_matters: "A committed credential should be rotated, not just removed.",
        suggested_improvement: "Rotate the credential and load it from the environment.",
        confidence: "medium",
      };
    }),
  };
}

// ── §44 prompt builders ────────────────────────────────────────────────────

function formatItems(items: RequirementEntry[] | undefined | null): string {
  if (!items || items.length === 0) return "(none provided)";
  return items
    .slice(0, 30)
    .map((item) => `- [${item.id}] (${item.category}, ${item.importance}) ${item.text}`)
    .join("\n");
}

function truncateJson(payload: unknown, limit: number): string {
  const text = JSON.stringify(payload ?? null);
  return text.length <= limit ? text : `${text.slice(0, limit)} …(truncated)`;
}

const NO_SNIPPETS = "(no relevant code could be retrieved)";

/**
 * The hackathon brief plus what the team claimed they built.
 *
 * Module A gets the long form because it IS the question. The other modules
 * get the short form: enough to judge whether an implementation choice serves
 * the stated problem, small enough that four modules carrying it does not
 * inflate the token bill. Without it a reviewer sees code and no brief, and
 * can only describe what exists — which is not the same as saying whether it
 * answers the challenge.
 */
function briefContext(
  requirementMap: RequirementMap,
  submission: Record<string, unknown> | undefined,
  length: "full" | "short",
): string {
  const submissionRow = submission ?? {};
  const claims = [
    `Project: ${(submissionRow.project_name as string) || "(none)"}`,
    `Description: ${String(submissionRow.project_description ?? "").slice(0, length === "full" ? 900 : 320)}`,
    `Key features: ${String(submissionRow.key_features ?? "").slice(0, length === "full" ? 900 : 320)}`,
    `Tech stack claimed: ${String(submissionRow.tech_stack ?? "").slice(0, length === "full" ? 400 : 200)}`,
  ].join("\n");

  if (length === "short") {
    const top = (requirementMap.requirements ?? []).slice(0, 6);
    return `THE CHALLENGE
${(requirementMap.problem_summary || "").slice(0, 700)}

KEY REQUIREMENTS
${top.length ? formatItems(top) : "(none listed)"}

WHAT THE TEAM CLAIMED
${claims}`;
  }

  return `PROJECT PROBLEM
${(requirementMap.problem_summary || "").slice(0, 1500)}

REQUIREMENTS
${formatItems(requirementMap.requirements)}

CONSTRAINTS
${formatItems(requirementMap.constraints)}

EXPECTED OUTCOME
${formatItems(requirementMap.expected_outcomes)}

EVALUATION CRITERIA
${formatItems(requirementMap.evaluation_criteria)}

WHAT THE STUDENT CLAIMED
${claims}`;
}

/** Module A. The requirement-aware question — the heart of the product. */
export function buildAlignmentTask(input: {
  requirementMap: RequirementMap;
  projectMap: ProjectMap;
  evidence: Evidence[];
  snippets: string;
  submission: Record<string, unknown>;
}): string {
  const facts = compactEvidence(input.evidence, 120);
  return `Assess whether this submission addresses THIS specific hackathon.

Return JSON:
{
  "problem_alignment": {
    "status": "strongly_aligned|partially_aligned|weakly_evidenced|unclear",
    "confidence": "high|medium|low",
    "evidence_ids": ["EV-001"],
    "explanation": "How the implementation relates to the stated problem."
  },
  "requirements": [
    {
      "requirement_id": "REQ-001",
      "status": "evidence_found|partial_evidence|not_evidenced|unable_to_determine",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What in the repository shows this, or why it is not evidenced."
    }
  ],
  "constraints": [
    {
      "constraint_id": "CON-001",
      "status": "supported|potential_concern|not_evidenced|unable_to_determine",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What shows this constraint is respected, or where it looks broken."
    }
  ],
  "summary": {
    "headline": "One sentence.",
    "strengths": ["..."],
    "areas_to_clarify": ["..."]
  }
}

Only include a requirement entry for the requirement ids listed below, and a
constraint entry only for the constraint ids listed below.

Judge each one against the problem statement and the code in front of you — not
against a checklist of technologies you expect to find. A repository that
solves the problem with a different stack is aligned; one that carries the
right stack but does not solve the problem is not. Where the code neither
answers nor contradicts the item, say "unable_to_determine" rather than
guessing.

${briefContext(input.requirementMap, input.submission, "full")}

PROJECT MAP (deterministic facts)
${truncateJson(input.projectMap, 6000)}

REPOSITORY FACTS
${truncateJson(facts, 6000)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}

/** Module B. */
export function buildArchitectureTask(input: {
  requirementMap: RequirementMap;
  submission: Record<string, unknown>;
  projectMap: ProjectMap;
  evidence: Evidence[];
  snippets: string;
}): string {
  const facts = compactEvidence(input.evidence, 80);
  return `Assess the technical architecture and implementation of this project.

Return JSON:
{
  "architecture": {
    "summary": "How the project is structured.",
    "layers": ["..."],
    "entry_points": ["..."],
    "evidence_ids": ["EV-001"]
  },
  "technical_decisions": [
    {"decision":"...","rationale":"... (only if the evidence supports it)","evidence_ids":["EV-001"]}
  ],
  "implementation": {
    "summary": "...",
    "strengths": ["..."],
    "observations": ["..."]
  },
  "findings": [
    {
      "type": "strength|observation|potential_issue|architecture_concern|scalability_concern",
      "severity": "critical|high|medium|low|informational",
      "title": "...",
      "description": "...",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "why_it_matters": "...",
      "suggested_improvement": "...",
      "confidence": "high|medium|low"
    }
  ]
}

Do not invent a technical decision rationale the repository does not show. If the
reason for a choice is not in the evidence, omit the rationale.

${briefContext(input.requirementMap, input.submission, "short")}

PROJECT MAP
${truncateJson(input.projectMap, 5000)}

REPOSITORY FACTS
${truncateJson(facts, 5000)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}

/** Module C. Testing and scalability get one call each at most. */
export function buildQualityTask(input: {
  requirementMap: RequirementMap;
  submission: Record<string, unknown>;
  projectMap: ProjectMap;
  evidence: Evidence[];
  snippets: string;
}): string {
  const facts = compactEvidence(input.evidence, 80);
  return `Assess security, data handling, testing and scalability of this project.

Return JSON:
{
  "security": {
    "summary": "...",
    "authentication_present": true,
    "authorization_checks_present": true,
    "concerns": ["..."],
    "evidence_ids": ["EV-001"]
  },
  "database": {
    "summary": "...",
    "technologies": ["..."],
    "schema_present": true,
    "evidence_ids": ["EV-001"]
  },
  "testing": {
    "summary": "...",
    "evidence_ids": ["EV-001"]
  },
  "scalability": {
    "summary": "...",
    "concerns": ["..."],
    "evidence_ids": ["EV-001"]
  },
  "findings": [
    {
      "type": "security_concern|testing_gap|scalability_concern|potential_issue|observation",
      "severity": "critical|high|medium|low|informational",
      "title": "...",
      "description": "...",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "why_it_matters": "...",
      "suggested_improvement": "...",
      "confidence": "high|medium|low"
    }
  ]
}

Report only what the evidence supports. A concern you cannot evidence must be
omitted, not softened.

${briefContext(input.requirementMap, input.submission, "short")}

PROJECT MAP
${truncateJson(input.projectMap, 5000)}

REPOSITORY FACTS
${truncateJson(facts, 5000)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}

/** Module D. Per member, and only where a claim is specific enough to check. */
export function buildContributionTask(input: {
  member: Record<string, unknown>;
  requirementMap: RequirementMap;
  submission: Record<string, unknown>;
  projectMap: ProjectMap;
  evidence: Evidence[];
  snippets: string;
  otherMembers: string[];
}): string {
  const facts = compactEvidence(input.evidence, 60);
  const member = input.member;
  return `Assess one team member's claimed contribution against the repository.

Return JSON:
{
  "status": "supported_by_repository|partially_supported|not_yet_verified",
  "confidence": "high|medium|low",
  "evidence_ids": ["EV-001"],
  "matched_files": ["path"],
  "matched_symbols": ["name"],
  "explanation": "What the repository shows about this contribution, or why it cannot be determined."
}

Absence of evidence is not evidence of absence. If the claim is broad or the
repository cannot speak to it, use "not_yet_verified" and say so plainly.

CLAIMED CONTRIBUTION (${(member.full_name as string) || (member.email as string) || "member"})
Description: ${String(member.contribution_description ?? "(none)").slice(0, 700)}
Areas: ${((member.contribution_areas as string[]) ?? []).join(", ") || "(none)"}
Planned responsibilities: ${String(member.planned_responsibilities ?? "(none)").slice(0, 500)}
AI tools disclosed: ${String(member.ai_tools_used ?? "(none)").slice(0, 300)}

OTHER TEAM MEMBERS (so you do not attribute their work to this person)
${input.otherMembers.join(", ") || "(none)"}

${briefContext(input.requirementMap, input.submission, "short")}

PROJECT MAP
${truncateJson(input.projectMap, 3500)}

REPOSITORY FACTS
${truncateJson(facts, 3500)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}

/** Claim verification (§38). */
export function buildClaimsTask(input: {
  claims: string[];
  projectMap: ProjectMap;
  evidence: Evidence[];
  snippets: string;
}): string {
  const facts = compactEvidence(input.evidence, 80);
  return `Check each feature the student claimed against the repository.

Return JSON:
{
  "claims": [
    {
      "claim": "...",
      "status": "supported|partially_supported|not_evidenced",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "symbols": ["name"],
      "explanation": "..."
    }
  ]
}

"not_evidenced" means the analysed repository did not show evidence. It is not a
statement that the claim is false.

CLAIMS
${input.claims.map((claim) => `- ${claim}`).join("\n")}

PROJECT MAP
${truncateJson(input.projectMap, 4000)}

REPOSITORY FACTS
${truncateJson(facts, 4000)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}

// ── Output validation (§44) ───────────────────────────────────────────────

export const ALIGNMENT_STATUSES = [
  "strongly_aligned", "partially_aligned", "weakly_evidenced", "unclear",
];
export const REQUIREMENT_STATUSES = [
  "evidence_found", "partial_evidence", "not_evidenced", "unable_to_determine",
];
export const CONSTRAINT_STATUSES = [
  "supported", "potential_concern", "not_evidenced", "unable_to_determine",
];
export const OUTCOME_STATUSES = ["supported", "partially_supported", "not_evidenced", "unclear"];
export const CONTRIBUTION_STATUSES = [
  "supported_by_repository", "partially_supported", "not_yet_verified",
];
export const CONFIDENCES = ["high", "medium", "low", "none"];
export const FINDING_TYPES = [
  "strength", "observation", "potential_issue", "confirmed_issue",
  "security_concern", "testing_gap", "architecture_concern",
  "scalability_concern", "claim_mismatch", "clarification_needed",
];
export const SEVERITIES = ["critical", "high", "medium", "low", "informational"];

export const MAX_FINDINGS_PER_MODULE = 8;

export interface ValidatedFinding {
  finding_type: string;
  severity: string;
  title: string;
  description: string;
  evidence_ids: string[];
  files: string[];
  symbols: string[];
  why_it_matters: string;
  suggested_improvement: string;
  confidence: string;
}

/** §47 — a finding without resolvable evidence is dropped, not stored. */
export function validateFindings(
  raw: unknown,
  evidenceIds: Set<string>,
): ValidatedFinding[] {
  if (!Array.isArray(raw)) return [];

  const findings: ValidatedFinding[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (!record.title) continue;

    const cited = ((record.evidence_ids as string[]) ?? []).filter((id) => evidenceIds.has(id));
    // §47 — insufficient evidence means the finding does not exist.
    if (cited.length === 0 && record.type !== "observation") continue;

    let findingType = FINDING_TYPES.includes(record.type as string)
      ? (record.type as string)
      : "observation";
    const severity = SEVERITIES.includes(record.severity as string)
      ? (record.severity as string)
      : "low";
    const confidence = ["high", "medium", "low"].includes(record.confidence as string)
      ? (record.confidence as string)
      : "low";

    // §48 — a "confirmed_issue" needs high-confidence evidence to stay one.
    if (findingType === "confirmed_issue" && confidence === "low") {
      findingType = "potential_issue";
    }

    findings.push({
      finding_type: findingType,
      severity,
      title: String(record.title).slice(0, 200),
      description: String(record.description ?? "").slice(0, 2000),
      evidence_ids: cited.slice(0, 12),
      files: ((record.files as string[]) ?? []).map(String).slice(0, 12),
      symbols: ((record.symbols as string[]) ?? []).map(String).slice(0, 12),
      why_it_matters: String(record.why_it_matters ?? "").slice(0, 1000),
      suggested_improvement: String(record.suggested_improvement ?? "").slice(0, 1000),
      confidence,
    });

    if (findings.length >= MAX_FINDINGS_PER_MODULE) break;
  }
  return findings;
}
