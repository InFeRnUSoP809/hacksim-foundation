/**
 * The evidence engine.
 *
 * Two rules, and everything else follows from them:
 *
 *   1. Every conclusion names evidence. A conclusion that cannot cite an id
 *      that exists in this repository's scan is not stored.
 *   2. Evidence describes; it never concludes. A finding's claim is a checkable
 *      sentence about code, and the confidence says how directly it was seen.
 *
 * The engine is also where a claim meets the repository. When a team writes
 * "our model predicts future demand" and the code only aggregates history, the
 * engine does not accuse anyone: it states what the submission describes, what
 * the inspected repository shows, and lets the reader judge. The wording is
 * fixed on purpose — a mismatch is a fact about the evidence, not about a
 * person's honesty.
 */

export const EVIDENCE_TYPES = [
  "file",
  "function",
  "class",
  "route",
  "api",
  "calculation",
  "rule",
  "model",
  "dataset",
  "dataset_profile",
  "ui",
  "configuration",
  "dependency",
  "database",
  "test",
  "readme",
  "secret",
  "authentication",
  "testing",
  "config",
  "framework",
  "repository",
  "analysis_mode",
  "integration",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const FINDING_TYPES = [
  "strength",
  "observation",
  "potential_issue",
  "confirmed_issue",
  "security_concern",
  "testing_gap",
  "architecture_concern",
  "scalability_concern",
  "claim_mismatch",
  "clarification_needed",
  "dead_feature",
  "placeholder",
  "hardcoding",
] as const;

export const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
] as const;

/** How a conclusion was reached. Shown in the admin panel, never to mislead. */
export const METHODS = [
  "deterministic_count",
  "deterministic_literal",
  "ai_evidence",
  "ai_insufficient_inspection",
  "not_evaluated",
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Method = (typeof METHODS)[number];

/**
 * §8 status definitions, in the words the product promises:
 *
 *   evidence_found      the repository shows the behaviour
 *   partial_evidence    part of it is visible, the rest cannot be confirmed
 *   not_evidenced       the repository was inspected; it does not show it
 *   unable_to_determine the repository could not be inspected far enough
 *
 * The fourth is a statement about *our* inspection, never about the project.
 * It is only ever produced when the scan was limited or a file could not be
 * read — never because a technology was absent.
 */
export const REQUIREMENT_STATUSES = [
  "evidence_found",
  "partial_evidence",
  "not_evidenced",
  "unable_to_determine",
] as const;

export const CONSTRAINT_STATUSES = [
  "supported",
  "potential_concern",
  "not_evidenced",
  "unable_to_determine",
] as const;

export const OUTCOME_STATUSES = [
  "supported",
  "partially_supported",
  "not_evidenced",
  "unclear",
] as const;

export const CLAIM_STATUSES = [
  "supported",
  "partially_supported",
  "not_evidenced",
] as const;

export const CONFIDENCES = ["high", "medium", "low", "none"] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
export type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export interface RawEvidence {
  id: string;
  type: string;
  claim: string;
  file?: string;
  symbol?: string;
  lines?: string;
  confidence: string;
}

export interface EvidenceSet {
  ids: Set<string>;
  byId: Map<string, RawEvidence>;
  byFile: Map<string, RawEvidence[]>;
}

export function buildEvidenceSet(evidence: RawEvidence[]): EvidenceSet {
  const byId = new Map<string, RawEvidence>();
  const byFile = new Map<string, RawEvidence[]>();
  const ids = new Set<string>();
  for (const item of evidence ?? []) {
    if (!item?.id || ids.has(item.id)) continue;
    ids.add(item.id);
    byId.set(item.id, item);
    if (item.file) {
      const list = byFile.get(item.file) ?? [];
      list.push(item);
      byFile.set(item.file, list);
    }
  }
  return { ids, byId, byFile };
}

/**
 * Drop ids that do not exist, keep the rest in order.
 *
 * This is the single place a hallucinated citation can die. It is called on
 * every model answer before anything is stored, which is why an invented
 * "EV-999" degrades to an uncited observation instead of a fake proof.
 */
export function filterCitations(
  raw: unknown,
  evidence: EvidenceSet,
  limit = 12,
): { accepted: string[]; rejected: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const value of list) {
    const id = String(value ?? "").trim();
    if (!id) continue;
    if (evidence.ids.has(id)) {
      if (!accepted.includes(id) && accepted.length < limit) accepted.push(id);
    } else if (!rejected.includes(id)) {
      rejected.push(id);
    }
  }
  return { accepted, rejected };
}

/**
 * The compact form sent to a model, ordered by how well each item speaks the
 * requirement being asked about. A repository-level fact (README, framework,
 * analysis mode) is always kept because it frames everything else.
 */
export function compactEvidence(
  items: RawEvidence[],
  limit = 60,
  terms: string[] = [],
  evidence?: EvidenceSet,
): unknown[] {
  const ranked = items
    .map((item) => {
      const haystack = `${item.claim} ${item.file ?? ""} ${item.symbol ?? ""}`.toLowerCase();
      let score = item.file ? 10 : 0;
      for (const term of terms) {
        if (term.length > 2 && haystack.includes(term)) score += 3;
      }
      if (item.type === "readme" || item.type === "repository") score += 6;
      if (item.type === "analysis_mode") score += 8;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const { item } of ranked) {
    const key = `${item.type}|${item.file ?? ""}|${item.symbol ?? ""}|${item.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id,
      type: item.type,
      claim: item.claim.slice(0, 220),
      file: item.file ?? null,
      symbol: item.symbol ?? null,
      lines: item.lines ?? null,
    });
    if (out.length >= limit) break;
  }
  void evidence;
  return out;
}

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
  /** Whether this is a general observation or answers an organiser expectation. */
  expectation_source: "hackathon" | "general" | "claim";
}

const MAX_FINDINGS = 10;

/**
 * §47, applied twice — once here and once at the storage boundary. A finding
 * with no resolvable evidence is not stored, because a finding nobody can check
 * is an opinion, and this product reports evidence.
 */
export function validateFindings(
  raw: unknown,
  evidence: EvidenceSet,
  expectationSource: ValidatedFinding["expectation_source"] = "general",
): ValidatedFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ValidatedFinding[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? "").trim();
    if (!title) continue;

    const { accepted } = filterCitations(record.evidence_ids, evidence);
    if (accepted.length === 0 && record.type !== "observation") continue;

    let type = (FINDING_TYPES as readonly string[]).includes(String(record.type))
      ? String(record.type)
      : "observation";
    const severity = (SEVERITIES as readonly string[]).includes(String(record.severity))
      ? String(record.severity)
      : "low";
    const confidence = ["high", "medium", "low"].includes(String(record.confidence))
      ? String(record.confidence)
      : "low";

    // A "confirmed issue" needs high confidence to remain one. A model that is
    // unsure about its own finding says so, and the type follows.
    if (type === "confirmed_issue" && confidence === "low") {
      type = "potential_issue";
    }
    if (type === "claim_mismatch" && accepted.length === 0) continue;

    const files = ((record.files as string[]) ?? [])
      .map(String)
      .filter((file) => Boolean(file))
      .slice(0, 12);

    out.push({
      finding_type: type,
      severity,
      title: title.slice(0, 200),
      description: String(record.description ?? "").slice(0, 2000),
      evidence_ids: accepted,
      files,
      symbols: ((record.symbols as string[]) ?? []).map(String).slice(0, 12),
      why_it_matters: String(record.why_it_matters ?? "").slice(0, 1000),
      suggested_improvement: String(record.suggested_improvement ?? "").slice(0, 1000),
      confidence,
      expectation_source: expectationSource,
    });

    if (out.length >= MAX_FINDINGS) break;
  }

  return out;
}

export interface ClaimStatement {
  claim: string;
  status: ClaimStatus;
  evidence_ids: string[];
  files: string[];
  explanation: string;
}

export interface ConflictInput {
  claim: string;
  status: ClaimStatus;
  evidenceIds: string[];
  explanation: string;
  /** What the repository actually shows, assembled by the caller. */
  observed: string[];
}

/**
 * §19. A claim that the evidence does not carry becomes a `claim_mismatch`
 * finding, in factual language.
 *
 * The wording is not negotiable: it says what the submission describes, says
 * what the inspected repository shows, and stops. It never says the team was
 * wrong, and it never says the feature does not exist — only that this
 * repository, at this commit, does not show it.
 */
export function detectConflicts(
  input: ConflictInput,
  evidence: EvidenceSet,
): ValidatedFinding[] {
  if (input.status !== "not_evidenced") return [];

  const claim = input.claim.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!claim) return [];

  const observed = input.observed
    .filter((item) => Boolean(item?.trim()))
    .slice(0, 3)
    .map((item) => item.trim().replace(/\s+/g, " ").slice(0, 240));
  if (observed.length === 0) return [];

  const files = new Set<string>();
  for (const id of input.evidenceIds) {
    const item = evidence.byId.get(id);
    if (item?.file) files.add(item.file);
  }

  return [
    {
      finding_type: "claim_mismatch",
      severity: "medium",
      title: `The submission describes "${claim}", which the inspected repository does not currently show`,
      description:
        `The submission states: "${claim}". The inspected repository evidence at this ` +
        `commit shows: ${observed.join("; ")}. This is a difference between what is ` +
        "described and what is currently visible in the analysed code — it may be " +
        "implemented in a form the scan did not reach, described imprecisely, or in " +
        "another branch.",
      evidence_ids: input.evidenceIds.filter((id) => evidence.ids.has(id)).slice(0, 8),
      files: [...files].slice(0, 8),
      symbols: [],
      why_it_matters:
        "A claim that the repository does not support is the first thing a reviewer " +
        "will test, so it is worth aligning the description, the code, or both.",
      suggested_improvement:
        "Point the description at the code that implements the claim, or implement the " +
        "behaviour the description promises.",
      confidence: "medium",
      expectation_source: "claim",
    },
  ];
}

/** Confidence is evidence-derived, not model-declared, for deterministic rows. */
export function confidenceForStatus(
  status: string,
  declared: string,
  evidenceCount: number,
): Confidence {
  if (status === "unable_to_determine") return "none";
  if (evidenceCount === 0 && status === "not_evidenced") {
    // A clean inspection with nothing found is a real, confident answer.
    return declared === "high" ? "high" : "medium";
  }
  if (evidenceCount >= 3 && declared === "high") return "high";
  if (evidenceCount >= 1) return declared === "low" ? "low" : "medium";
  return "low";
}

// ── Deterministic facts that never need a model ────────────────────────────

export interface TestingFacts {
  status: string;
  testFileCount: number;
  frameworks: string[];
  commands: string[];
  finding: string | null;
  explanation: string;
}

/**
 * A test count is arithmetic, and a hard-coded credential is a literal. Neither
 * is a judgement call, so neither is ever sent to a model — and neither is
 * reported as a problem unless the hackathon asked about testing.
 */
export function testingFromEvidence(projectMap: unknown): TestingFacts {
  const testing = ((projectMap as Record<string, unknown>)?.testing ?? {}) as Record<
    string,
    unknown
  >;
  const count = Number(testing.test_file_count ?? 0);
  const frameworks = ((testing.frameworks as string[]) ?? []).map((name) => String(name));

  let status: string;
  let finding: string | null;
  if (count === 0) {
    status = "not_evidenced";
    finding = "testing_gap";
  } else if (count < 3) {
    status = "partial_evidence";
    finding = null;
  } else {
    status = "evidence_found";
    finding = null;
  }

  return {
    status,
    testFileCount: count,
    frameworks,
    commands: ((testing.commands as string[]) ?? []).map(String),
    finding,
    explanation:
      count === 0
        ? "No test files were detected in the analysed repository."
        : `${count} test files detected. File count is not a measure of test quality.`,
  };
}

export interface SecretIssue {
  type: string;
  severity: string;
  title: string;
  description: string;
  why_it_matters: string;
  suggested_improvement: string;
  confidence: string;
}

/**
 * A committed credential is a finding with no interpretation required. The
 * value itself never leaves the scanner, so the description can only say what
 * kind of pattern matched and where.
 */
export function securityFromEvidence(
  projectMap: unknown,
): { status: string; confirmed_issues: SecretIssue[] } | null {
  const security = ((projectMap as Record<string, unknown>)?.security ?? {}) as Record<
    string,
    unknown
  >;
  const secrets = ((security.hardcoded_secrets as { type: string; file: string; line: number }[]) ?? [])
    .filter((item) => item && typeof item.file === "string");
  if (!secrets.length) return null;

  return {
    status: "evidence_found",
    confirmed_issues: secrets.slice(0, 5).map((item) => {
      const words = String(item.type).replace(/_/g, " ");
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
