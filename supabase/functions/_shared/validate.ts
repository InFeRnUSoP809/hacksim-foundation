/**
 * AI response validation.
 *
 * A model reply is untrusted input. It is parsed, shape-checked, enum-clamped
 * and citation-filtered before a single row is stored, and a reply that cannot
 * be repaired in one attempt is recorded as a failure rather than retried
 * forever.
 *
 * The one rule that matters most here: **a positive conclusion must cite
 * evidence.** A model that answers "evidence_found" with no ids is describing
 * something it was not shown, so the status is downgraded and the downgrade is
 * recorded. `not_evidenced` with no citations is perfectly valid — that is the
 * honest answer after a real inspection.
 */

import {
  CLAIM_STATUSES,
  CONFIDENCES,
  CONSTRAINT_STATUSES,
  OUTCOME_STATUSES,
  REQUIREMENT_STATUSES,
  filterCitations,
  type Confidence,
  type EvidenceSet,
  type RawEvidence,
} from "./evidence.ts";

export type SubjectKind = "requirement" | "constraint" | "outcome" | "criterion" | "claim";

export interface ValidatedConclusion {
  subject_id: string;
  kind: SubjectKind;
  status: string;
  confidence: Confidence;
  evidence_ids: string[];
  explanation: string;
  missing_or_unclear: string[];
  /** True when a positive status was downgraded for lack of citations. */
  downgraded: boolean;
  files: string[];
}

export interface ValidationResult<T> {
  items: T[];
  /** Ids the model invented, or subjects it was not asked about. */
  rejectedSubjects: string[];
  /** Evidence ids that do not exist in this scan. */
  rejectedEvidenceIds: string[];
  /** Human-readable problems, used to build one repair request. */
  errors: string[];
}

const STATUSES: Record<SubjectKind, readonly string[]> = {
  requirement: REQUIREMENT_STATUSES,
  constraint: CONSTRAINT_STATUSES,
  outcome: OUTCOME_STATUSES,
  criterion: OUTCOME_STATUSES,
  claim: CLAIM_STATUSES,
};

/** Statuses that assert something positive, and therefore need a citation. */
const POSITIVE = new Set([
  "confirmed",
  "partially_confirmed",
  "weakly_evidenced",
  "contradicted",
  "evidence_found",
  "supported",
  "partially_supported",
  "partial_evidence",
]);

function clampStatus(
  kind: SubjectKind,
  raw: unknown,
): string {
  const allowed = STATUSES[kind];
  const value = String(raw ?? "");
  return allowed.includes(value) ? value : allowed[allowed.length - 1];
}

function clampConfidence(raw: unknown): Confidence {
  const value = String(raw ?? "");
  return (CONFIDENCES as readonly string[]).includes(value)
    ? (value as Confidence)
    : "low";
}

function stringList(raw: unknown, limit = 8, itemLimit = 300): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item ?? "").trim().slice(0, itemLimit))
    .filter((item) => item.length > 2)
    .slice(0, limit);
}

/**
 * Validate a list of per-subject conclusions.
 *
 * `allowedSubjects` is the exact list this call was asked about. A model that
 * volunteers an answer about a requirement it was not shown cannot have seen
 * the evidence for it, so that row is dropped rather than stored.
 */
export function validateConclusions(
  payload: unknown,
  options: {
    kind: SubjectKind;
    allowedSubjects: string[];
    evidence: EvidenceSet;
  },
): ValidationResult<ValidatedConclusion> {
  const { kind, allowedSubjects, evidence } = options;
  const errors: string[] = [];
  const rejectedSubjects: string[] = [];
  const rejectedEvidenceIds = new Set<string>();
  const items: ValidatedConclusion[] = [];
  const seen = new Set<string>();

  // The prompts ask for `conclusions`; `items` and a bare array are accepted
  // too, because a model that renames the key should not lose a real answer.
  const record = (payload ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(record.conclusions)
    ? (record.conclusions as unknown[])
    : Array.isArray(record.items)
    ? (record.items as unknown[])
    : [];
  const list = raw;

  if (!Array.isArray(list)) {
    errors.push("the reply did not contain a list of conclusions");
  }

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      errors.push("a conclusion was not an object");
      continue;
    }
    const record = entry as Record<string, unknown>;
    const subjectId = String(
      record.subject_id ?? record.requirement_id ?? record.constraint_id ??
        record.outcome_id ?? record.criterion_id ?? record.id ?? "",
    ).trim();

    if (!subjectId) {
      errors.push("a conclusion had no subject id");
      continue;
    }
    if (!allowedSubjects.includes(subjectId)) {
      rejectedSubjects.push(subjectId);
      continue;
    }
    if (seen.has(subjectId)) {
      errors.push(`${subjectId} was answered more than once`);
      continue;
    }

    const explanation = String(record.explanation ?? "").trim().slice(0, 2000);
    if (explanation.length < 12) {
      errors.push(`${subjectId} had no usable explanation`);
      continue;
    }

    const citations = filterCitations(record.evidence_ids, evidence);
    for (const id of citations.rejected) rejectedEvidenceIds.add(id);

    let status = clampStatus(kind, record.status);
    let downgraded = false;
    if (POSITIVE.has(status) && citations.accepted.length === 0) {
      // The model asserted something without citing anything it was shown.
      // Downgrade rather than delete: the explanation may still be useful, but
      // the status must reflect what can be checked.
      status = kind === "claim" ? "partially_supported" : "partial_evidence";
      downgraded = true;
      errors.push(
        `${subjectId} claimed a positive status with no valid evidence id and was downgraded`,
      );
    }

    const files = citations.accepted
      .map((id) => evidence.byId.get(id)?.file)
      .filter((file): file is string => Boolean(file));

    seen.add(subjectId);
    items.push({
      subject_id: subjectId,
      kind,
      status,
      confidence: clampConfidence(record.confidence),
      evidence_ids: citations.accepted,
      explanation,
      missing_or_unclear: stringList(record.missing_or_unclear),
      downgraded,
      files: [...new Set(files)].slice(0, 10),
    });
  }

  const missing = allowedSubjects.filter((id) => !seen.has(id));
  if (missing.length) {
    errors.push(`no conclusion was returned for: ${missing.join(", ")}`);
  }

  return {
    items,
    rejectedSubjects,
    rejectedEvidenceIds: [...rejectedEvidenceIds],
    errors: errors.slice(0, 12),
  };
}

export interface ValidatedAlignment {
  status: string;
  confidence: Confidence;
  evidence_ids: string[];
  explanation: string;
  /** What the project does about the problem, in the model's words. */
  approach: string;
  approach_notes: string[];
  downgraded: boolean;
}

export const ALIGNMENT_STATUSES = [
  "strongly_aligned",
  "partially_aligned",
  "weakly_evidenced",
  "unclear",
] as const;

export interface BriefVerificationPayload {
  alignment: ValidatedAlignment | null;
  requirements: ValidatedConclusion[];
  constraints: ValidatedConclusion[];
  outcomes: ValidatedConclusion[];
  criteria: ValidatedConclusion[];
  additional_files_needed: string[];
  rejectedEvidenceIds: string[];
  errors: string[];
}

export function validateBriefVerification(
  payload: unknown,
  evidence: EvidenceSet,
  allowed: {
    requirements: string[];
    constraints: string[];
    outcomes: string[];
    criteria: string[];
  },
): BriefVerificationPayload {
  const record = (payload ?? {}) as Record<string, unknown>;
  const alignResult = validateAlignment(payload, evidence);
  const alignment = alignResult.items[0] ?? null;

  const mapConclusions = (
    raw: unknown,
    kind: SubjectKind,
    subjects: string[],
  ): ValidatedConclusion[] => {
    const result = validateConclusions(raw, {
      kind,
      allowedSubjects: subjects,
      evidence,
    });
    return result.items;
  };

  const requirements = mapConclusions(
    record.requirement_conclusions,
    "requirement",
    allowed.requirements,
  );
  const constraints = mapConclusions(
    record.constraint_conclusions,
    "constraint",
    allowed.constraints,
  );
  const outcomes = mapConclusions(
    record.outcome_conclusions,
    "outcome",
    allowed.outcomes,
  );
  const criteria = mapConclusions(
    record.criterion_conclusions,
    "criterion",
    allowed.criteria,
  );

  const additional = stringList(record.additional_files_needed, 4, 200);
  const rejectedEvidenceIds = [
    ...alignResult.rejectedEvidenceIds,
  ];

  return {
    alignment,
    requirements,
    constraints,
    outcomes,
    criteria,
    additional_files_needed: additional,
    rejectedEvidenceIds,
    errors: alignResult.errors,
  };
}

export function validateAlignment(
  payload: unknown,
  evidence: EvidenceSet,
): ValidationResult<ValidatedAlignment> {
  const errors: string[] = [];
  const rejectedEvidenceIds: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  const raw = (record.problem_alignment ?? record) as Record<string, unknown>;

  const citations = filterCitations(raw.evidence_ids, evidence);
  rejectedEvidenceIds.push(...citations.rejected);
  const explanation = String(raw.explanation ?? "").trim().slice(0, 2000);
  const approach = String(raw.approach ?? "").trim().slice(0, 1500);

  if (explanation.length < 12) errors.push("the alignment explanation was empty");
  if (approach.length < 8) errors.push("no approach was described");

  const declared = String(raw.status ?? "");
  let status = (ALIGNMENT_STATUSES as readonly string[]).includes(declared)
    ? declared
    : "unclear";
  let downgraded = false;
  if (status === "strongly_aligned" && citations.accepted.length === 0) {
    status = "unclear";
    downgraded = true;
    errors.push("strong alignment was claimed with no valid evidence id");
  }

  return {
    items: [
      {
        status,
        confidence: clampConfidence(raw.confidence),
        evidence_ids: citations.accepted,
        explanation,
        approach,
        approach_notes: stringList(raw.approach_notes),
        downgraded,
      },
    ],
    rejectedSubjects: [],
    rejectedEvidenceIds,
    errors,
  };
}

export interface ValidatedAssessment {
  headline: string;
  understanding: string;
  problem_relevance: string;
  solution_coherence: string;
  implementation_evidence: string;
  functional_completeness: string;
  technical_quality: string;
  claim_accuracy: string;
  hackathon_alignment: string;
  engineering_concerns: string[];
  uncertainties: string[];
  gaps: string[];
  strengths: string[];
  evidence_ids: string[];
  downgraded: boolean;
}

/**
 * §50: a structured factual assessment, not a score.
 *
 * Every text field is kept even when empty, so the page can say "not assessed"
 * honestly instead of showing a blank card. Nothing here is numeric.
 */
export function validateAssessment(
  payload: unknown,
  evidence: EvidenceSet,
): ValidationResult<ValidatedAssessment> {
  const errors: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  const raw = (record.assessment ?? record) as Record<string, unknown>;
  const citations = filterCitations(raw.evidence_ids, evidence);

  const text = (key: string) => String(raw[key] ?? "").trim().slice(0, 2000);
  const headline = text("headline");
  if (headline.length < 8) errors.push("no headline was produced");

  return {
    items: [
      {
        headline,
        understanding: text("understanding"),
        problem_relevance: text("problem_relevance"),
        solution_coherence: text("solution_coherence"),
        implementation_evidence: text("implementation_evidence"),
        functional_completeness: text("functional_completeness"),
        technical_quality: text("technical_quality"),
        claim_accuracy: text("claim_accuracy"),
        hackathon_alignment: text("hackathon_alignment"),
        engineering_concerns: stringList(raw.engineering_concerns),
        uncertainties: stringList(raw.uncertainties, 10),
        gaps: stringList(raw.gaps, 10),
        strengths: stringList(raw.strengths, 10),
        evidence_ids: citations.accepted,
        downgraded: citations.rejected.length > 0,
      },
    ],
    rejectedSubjects: [],
    rejectedEvidenceIds: citations.rejected,
    errors,
  };
}

export interface ValidatedClaim {
  claim: string;
  status: string;
  confidence: Confidence;
  evidence_ids: string[];
  files: string[];
  explanation: string;
  downgraded: boolean;
}

export function validateClaims(
  payload: unknown,
  evidence: EvidenceSet,
  expectedClaims: string[],
): ValidationResult<ValidatedClaim> {
  const errors: string[] = [];
  const rejectedSubjects: string[] = [];
  const items: ValidatedClaim[] = [];
  const list = Array.isArray((payload as Record<string, unknown>)?.claims)
    ? ((payload as Record<string, unknown>).claims as unknown[])
    : [];

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const claim = String(record.claim ?? "").trim().slice(0, 300);
    if (!claim) continue;
    if (expectedClaims.length && !expectedClaims.some((item) => item === claim)) {
      // Only claims the team actually made are checked; a model may not invent
      // a claim in order to reject it.
      rejectedSubjects.push(claim);
      continue;
    }
    const citations = filterCitations(record.evidence_ids, evidence);
    const explanation = String(record.explanation ?? "").trim().slice(0, 1500);
    if (explanation.length < 10) {
      errors.push(`claim "${claim.slice(0, 40)}" had no explanation`);
      continue;
    }
    let status = String(record.status ?? "");
    if (!(CLAIM_STATUSES as readonly string[]).includes(status)) {
      status = "not_evidenced";
    }
    let downgraded = false;
    if (status !== "not_evidenced" && citations.accepted.length === 0) {
      status = "partially_supported";
      downgraded = true;
      errors.push(`claim "${claim.slice(0, 40)}" asserted support with no citation`);
    }
    items.push({
      claim,
      status,
      confidence: clampConfidence(record.confidence),
      evidence_ids: citations.accepted,
      files: [...new Set(
        citations.accepted
          .map((id) => evidence.byId.get(id)?.file)
          .filter((file): file is string => Boolean(file)),
      )].slice(0, 8),
      explanation,
      downgraded,
    });
  }

  return { items, rejectedSubjects, rejectedEvidenceIds: [], errors: errors.slice(0, 10) };
}

/** The envelope every task reply must satisfy. */
export function envelopeError(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return "not a JSON object";
  if (Array.isArray(payload)) return "a JSON array where an object was required";
  return null;
}

/** The single repair request built from validation errors. No more than one. */
export function repairPrompt(task: string, errors: string[]): string {
  return (
    task +
    "\n\nYour previous reply could not be accepted:\n" +
    errors.slice(0, 8).map((error) => `- ${error}`).join("\n") +
    "\n\nReply again with a single JSON object that fixes exactly these problems. " +
    "Use only evidence ids that appear in the evidence list you were given. " +
    "If a conclusion genuinely has no supporting evidence, say so with status " +
    "\"not_evidenced\" and cite nothing rather than inventing an id. " +
    "No prose, no code fence."
  );
}

/** Evidence in the shape the validator expects. */
export function asRawEvidence(
  items: { id: string; type: string; claim: string; file?: string; symbol?: string; lines?: string; confidence: string }[],
): RawEvidence[] {
  return items.map((item) => ({
    id: String(item.id),
    type: String(item.type ?? "file"),
    claim: String(item.claim ?? ""),
    file: item.file,
    symbol: item.symbol,
    lines: item.lines,
    confidence: String(item.confidence ?? "medium"),
  }));
}
