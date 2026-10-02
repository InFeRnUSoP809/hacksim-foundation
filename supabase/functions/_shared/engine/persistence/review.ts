import { db } from "../../http.ts";
import type {
  BriefVerificationPayload,
  ValidatedAlignment,
  ValidatedConclusion,
} from "../../validate.ts";
import type { FindingType, Severity, ValidatedFinding } from "../../evidence.ts";
import { ENGINE_VERIFY_PROMPT_VERSION } from "../constants.ts";
import type { VerificationTaskRecord } from "../verify/orchestrator.ts";
import type {
  ValidatedClaimsVerification,
  ValidatedEngineeringVerification,
  ValidatedImplementationVerification,
} from "../verify/validation.ts";
import { mergeFindings } from "./merge.ts";

type FindingRow = ValidatedFinding;

export type LoadedEngineReview = {
  reviewId: string | null;
  brief: BriefVerificationPayload;
  implementation: ValidatedImplementationVerification | null;
  engineering: ValidatedEngineeringVerification | null;
  claims: ValidatedClaimsVerification | null;
  verificationTasks: VerificationTaskRecord[];
  findings: ValidatedFinding[];
  cumulativeCostUsd: number;
  cumulativeTokens: number;
};

function rehydrateEngineering(row: Record<string, unknown>): ValidatedEngineeringVerification | null {
  const summary = row.summary as Record<string, unknown> | null;
  const stored = summary?.engineering_verification as ValidatedEngineeringVerification | undefined;
  if (stored?.verification_type === "engineering") return stored;

  const observations = (summary?.engineering_observations ?? []) as ValidatedEngineeringVerification["observations"];
  const architecture = row.architecture as { summary?: string } | null;
  const security = row.security as { summary?: string } | null;
  const database_review = row.database_review as { summary?: string } | null;
  const testing = row.testing as { summary?: string } | null;

  if (
    !observations.length &&
    !architecture?.summary &&
    !security?.summary &&
    !database_review?.summary &&
    !testing?.summary
  ) {
    return null;
  }

  return {
    verification_type: "engineering",
    architecture_summary: architecture?.summary ?? "",
    database_summary: database_review?.summary ?? "",
    security_summary: security?.summary ?? "",
    testing_summary: testing?.summary ?? "",
    observations,
    findings: [],
    additional_files_needed: [],
    errors: [],
  };
}

export async function loadExistingEngineReview(
  submissionId: string,
  repositoryId: string,
): Promise<LoadedEngineReview | null> {
  const { data } = await db()
    .from("project_reviews")
    .select(
      "id, problem_alignment, requirement_rows, constraint_rows, outcome_rows, criterion_rows, " +
        "implementation, summary, technical_decisions, contributions, architecture, security, " +
        "database_review, testing, estimated_cost_usd, total_tokens",
    )
    .eq("submission_id", submissionId)
    .eq("repository_id", repositoryId)
    .maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const reviewId = (row.id as string) ?? null;

  let findings: ValidatedFinding[] = [];
  if (reviewId) {
    const { data: findingRows } = await db()
      .from("project_review_findings")
      .select(
        "finding_type, severity, title, description, evidence_ids, files, symbols, " +
          "why_it_matters, suggested_improvement, confidence",
      )
      .eq("project_review_id", reviewId);
    findings = ((findingRows ?? []) as Record<string, unknown>[]).map((f) => ({
      finding_type: f.finding_type as FindingType,
      severity: f.severity as Severity,
      title: String(f.title ?? ""),
      description: String(f.description ?? ""),
      evidence_ids: (f.evidence_ids as string[]) ?? [],
      files: (f.files as string[]) ?? [],
      symbols: (f.symbols as string[]) ?? [],
      why_it_matters: String(f.why_it_matters ?? ""),
      suggested_improvement: String(f.suggested_improvement ?? ""),
      confidence: String(f.confidence ?? "low"),
      expectation_source: "general" as const,
    }));
  }

  const brief: BriefVerificationPayload = {
    alignment: (row.problem_alignment as ValidatedAlignment | null) ?? null,
    requirements: (row.requirement_rows as ValidatedConclusion[]) ?? [],
    constraints: (row.constraint_rows as ValidatedConclusion[]) ?? [],
    outcomes: (row.outcome_rows as ValidatedConclusion[]) ?? [],
    criteria: (row.criterion_rows as ValidatedConclusion[]) ?? [],
    additional_files_needed: [],
    rejectedEvidenceIds: [],
    errors: [],
  };

  const summary = row.summary as { verification_tasks?: VerificationTaskRecord[] } | null;
  const technical = row.technical_decisions as {
    engine_verification?: VerificationTaskRecord[];
  } | null;

  return {
    reviewId,
    brief,
    implementation: (row.implementation as ValidatedImplementationVerification | null) ?? null,
    engineering: rehydrateEngineering(row),
    claims: (row.contributions as ValidatedClaimsVerification | null) ?? null,
    verificationTasks:
      summary?.verification_tasks ?? technical?.engine_verification ?? [],
    findings,
    cumulativeCostUsd: Number(row.estimated_cost_usd ?? 0),
    cumulativeTokens: Number(row.total_tokens ?? 0),
  };
}

export async function persistEngineReview(input: {
  submissionId: string;
  repositoryId: string;
  commitSha: string;
  contextVersion: string;
  alignment: ValidatedAlignment | null;
  requirements: ValidatedConclusion[];
  constraints: ValidatedConclusion[];
  outcomes: ValidatedConclusion[];
  criteria: ValidatedConclusion[];
  findings: FindingRow[];
  findingsMode: "replace_all" | "merge";
  priorFindings?: ValidatedFinding[];
  runCostUsd: number;
  runTokens: number;
  cumulativeCostUsd: number;
  cumulativeTokens: number;
  lastRunMeta: {
    at: string;
    tasks: string[];
    run_cost_usd: number;
    run_tokens: number;
  };
  engineId: string;
  implementation: ValidatedImplementationVerification | null;
  engineering: ValidatedEngineeringVerification | null;
  claims: ValidatedClaimsVerification | null;
  verificationTasks: VerificationTaskRecord[];
}): Promise<string | null> {
  const service = db();

  const architecture = input.engineering
    ? {
      summary: input.engineering.architecture_summary,
      observations: input.engineering.observations.filter((o) =>
        o.topic.toLowerCase().includes("arch")
      ),
    }
    : null;

  const security = input.engineering
    ? { summary: input.engineering.security_summary }
    : null;

  const database_review = input.engineering
    ? { summary: input.engineering.database_summary }
    : null;

  const testing = input.engineering
    ? { summary: input.engineering.testing_summary }
    : null;

  const findingsToStore = input.findingsMode === "merge"
    ? mergeFindings(input.priorFindings ?? [], input.findings)
    : input.findings;

  const payload = {
    submission_id: input.submissionId,
    repository_id: input.repositoryId,
    status: "completed",
    prompt_version: ENGINE_VERIFY_PROMPT_VERSION,
    estimated_cost_usd: input.cumulativeCostUsd,
    total_tokens: input.cumulativeTokens,
    analysis_version: input.engineId,
    hackathon_version: input.contextVersion,
    commit_sha: input.commitSha,
    problem_alignment: input.alignment,
    requirement_rows: input.requirements,
    constraint_rows: input.constraints,
    outcome_rows: input.outcomes,
    criterion_rows: input.criteria,
    implementation: input.implementation,
    architecture,
    security,
    database_review,
    testing,
    contributions: input.claims,
    summary: {
      verification_tasks: input.verificationTasks,
      engineering_observations: input.engineering?.observations ?? [],
      engineering_verification: input.engineering,
      last_verification_run: input.lastRunMeta,
      cumulative_cost_usd: input.cumulativeCostUsd,
      cumulative_tokens: input.cumulativeTokens,
    },
    technical_decisions: {
      engine_verification: input.verificationTasks,
    },
  };

  const { data, error } = await service
    .from("project_reviews")
    .upsert(payload, { onConflict: "submission_id,repository_id" })
    .select("id")
    .single();
  if (error || !data) return null;
  const reviewId = (data as { id: string }).id;

  const rows = input.requirements.map((row) => ({
    submission_id: input.submissionId,
    requirement_id: row.subject_id,
    status: row.status,
    confidence: row.confidence,
    evidence_ids: row.evidence_ids,
    explanation: row.explanation,
    missing_or_unclear: row.missing_or_unclear,
  }));
  if (rows.length) {
    await service.from("requirement_evaluations").delete().eq("submission_id", input.submissionId);
    await service.from("requirement_evaluations").insert(rows);
  }

  await service.from("project_review_findings").delete().eq("project_review_id", reviewId);
  if (findingsToStore.length) {
    await service.from("project_review_findings").insert(
      findingsToStore.map((finding) => ({
        project_review_id: reviewId,
        finding_type: finding.finding_type,
        severity: finding.severity,
        title: finding.title.slice(0, 200),
        description: finding.description.slice(0, 2000),
        evidence_ids: finding.evidence_ids.slice(0, 12),
        files: finding.files.slice(0, 12),
        symbols: finding.symbols.slice(0, 12),
        why_it_matters: finding.why_it_matters.slice(0, 1000),
        suggested_improvement: finding.suggested_improvement.slice(0, 1000),
        confidence: finding.confidence,
      })),
    );
  }

  return reviewId;
}
