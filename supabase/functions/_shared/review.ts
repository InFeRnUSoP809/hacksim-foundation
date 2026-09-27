/**
 * Phase 6 review orchestrator.
 *
 * Runs the modules, decides per module whether the model is needed at all, and
 * writes every result to the database. The shape of a run:
 *
 *   requirements  → deterministic pass → AI only where ambiguous
 *   alignment     → deterministic pass → AI only where thin
 *   architecture  → always AI (interpretation, not counting)
 *   quality       → security/test facts pre-computed; AI only for the rest
 *   contributions → only for members whose claim is specific enough to check
 *
 * Every module is independently recoverable (§89): a failure is recorded, the
 * successful modules are not re-run, and the review is saved as `partial`.
 */

import { db } from "./http.ts";
import {
  aiConfigured,
  AIError,
  calculateCost,
  checkBudget,
  completeJson,
  contextHash,
  findCachedAnalysis,
  loadPricing,
  recordUsage,
  saveAnalysis,
  type AIResponse,
  type ModelPricing,
} from "./ai.ts";
import * as M from "./modules.ts";
import type { Evidence, ProjectMap } from "./github.ts";
import { buildPacket } from "./retrieval.ts";
import { getRequirementMap, type RequirementEntry, type RequirementMap } from "./requirements.ts";

const MAX_MEMBER_MODULES = 6;

export interface ContributionMember {
  id: string;
  user_id: string | null;
  full_name: string | null;
  email: string | null;
  contribution_description: string | null;
  contribution_areas: string[] | null;
  planned_responsibilities: string | null;
  ai_tools_used: string | null;
  ai_usage_description: string | null;
}

export interface ReviewOutcome {
  reviewId: string | null;
  status: string;
  modules: M.ModuleResult[];
  totalCostUsd: number;
  totalTokens: number;
  error?: string;
}

export interface ReviewInput {
  submission: Record<string, unknown>;
  hackathon: Record<string, unknown>;
  repository: Record<string, unknown>;
  files: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  evidence: Evidence[];
  projectMap: ProjectMap;
  members: ContributionMember[];
  actorId?: string | null;
  sessionId?: string | null;
  onlyModules?: string[] | null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function section(payload: unknown, evidenceIds: Set<string>): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { summary: "No result returned.", source: "skipped" };
  }
  const record = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "evidence_ids") result[key] = value;
  }
  const cited = ((record.evidence_ids as string[]) ?? []).filter((id) => evidenceIds.has(id));
  // Always present, even when empty. Omitting the key stored JSON with no
  // evidence_ids at all, and every reader that maps over it then crashed on
  // undefined — an empty citation list is a normal answer, not a missing field.
  result.evidence_ids = cited.slice(0, 12);
  return result;
}

function requirementsFromDeterministic(
  requirements: RequirementEntry[],
  alignment: Record<string, unknown>,
): Record<string, unknown>[] {
  const addressed = new Set((alignment.addressed_requirement_ids as string[]) ?? []);
  return requirements.map((requirement) =>
    addressed.has(requirement.id)
      ? {
          requirement_id: requirement.id,
          status: "partial_evidence",
          confidence: "low",
          evidence_ids: [],
          explanation:
            "A matching technology was detected, but the specific implementation " +
            "was not inspected for this requirement.",
        }
      : {
          requirement_id: requirement.id,
          status: "unable_to_determine",
          confidence: "none",
          evidence_ids: [],
          explanation:
            "No matching technology was detected. This does not mean the feature " +
            "is absent; the repository was not inspected at code level.",
        },
  );
}

/** Keep only rows for real requirement ids, with real evidence ids. */
function validateRequirementRows(
  raw: unknown,
  requirements: RequirementEntry[],
  evidenceIds: Set<string>,
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];

  const known = new Set(requirements.map((r) => r.id));
  const rows: Record<string, unknown>[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = String(record.requirement_id ?? "");
    // §49 — never invent a requirement that the brief does not contain.
    if (!known.has(id)) continue;

    rows.push({
      requirement_id: id,
      status: oneOf(record.status, M.REQUIREMENT_STATUSES, "unable_to_determine"),
      confidence: oneOf(record.confidence, M.CONFIDENCES, "low"),
      evidence_ids: ((record.evidence_ids as string[]) ?? [])
        .filter((e) => evidenceIds.has(e))
        .slice(0, 12),
      explanation: String(record.explanation ?? "").slice(0, 1500),
    });
  }
  return rows;
}

function claimsFrom(submission: Record<string, unknown>): string[] {
  const claims: string[] = [];
  for (const line of String(submission.key_features ?? "").split("\n")) {
    const cleaned = line.trim().replace(/^[-*•\s]+/, "").trim();
    if (cleaned.length > 8) claims.push(cleaned.slice(0, 200));
  }
  const description = String(submission.project_description ?? "").trim();
  if (description) claims.unshift(description.slice(0, 300));
  return claims.slice(0, 10);
}

function deterministicClaims(claims: string[]): Record<string, unknown> {
  return {
    claims: claims.map((claim) => ({
      claim,
      status: "not_evidenced",
      evidence_ids: [],
      explanation: "AI review unavailable; no deterministic evidence matched.",
    })),
  };
}

function overallStatus(modules: M.ModuleResult[]): string {
  if (modules.length === 0) return "pending";
  if (modules.every((m) => m.status === "failed")) return "failed";
  if (modules.some((m) => ["completed", "cached"].includes(m.status))) {
    return modules.some((m) => m.status === "failed") ? "partial" : "completed";
  }
  return modules.some((m) => m.status === "skipped") ? "partial" : "pending";
}

// ── The single call site: budget, cache, usage, errors ────────────────────

/** Running spend for one review. The cache path adds nothing, by design. */
export interface Spend {
  costUsd: number;
  tokens: number;
}

interface CallInput {
  operation: string;
  task: string;
  promptVersion: string;
  contextParts: unknown[];
  scopeKey: string;
  repositoryId: string | null;
  submissionId: string | null;
  pricing: ModelPricing;
  actorId: string | null;
  sessionId: string | null;
  estimateTokens: number;
  spend: Spend;
}

/**
 * One guarded AI call. Returns `null` when it was not allowed or failed.
 * Every rejection is still written to the ledger so the numbers explain
 * themselves (§91).
 */
async function call(input: CallInput): Promise<AIResponse | null> {
  const { pricing } = input;
  const ctxHash = await contextHash(input.contextParts, input.promptVersion, pricing.modelName);

  if (!aiConfigured()) {
    console.info("[hacksim.review] AI not configured; skipping", input.operation);
    return null;
  }

  // §58 — reuse before spending.
  const cached = await findCachedAnalysis({
    repositoryId: input.repositoryId,
    analysisType: input.scopeKey,
    promptVersion: input.promptVersion,
    model: pricing.modelName,
    ctxHash,
  });
  if (cached?.result) {
    console.info("[hacksim.review] cache hit for", input.scopeKey);
    return {
      content: JSON.stringify(cached.result),
      parsed: cached.result as Record<string, unknown>,
      requestId: null,
      model: pricing.modelName,
      inputTokens: Number(cached.input_tokens ?? 0),
      outputTokens: Number(cached.output_tokens ?? 0),
      totalTokens: Number(cached.total_tokens ?? 0),
      cachedTokens: Number(cached.cached_tokens ?? 0),
      cacheMissTokens: Number(cached.cache_miss_tokens ?? 0),
      durationMs: 0,
      promptVersion: input.promptVersion,
    };
  }

  // §52 — the gate.
  const decision = await checkBudget({
    pricing,
    submissionId: input.submissionId,
    estimatedInputTokens: input.estimateTokens,
    estimatedOutputTokens: pricing.maxOutputTokens,
    cacheRatio: ["alignment", "quality"].includes(input.scopeKey) ? 0.5 : 0,
  });

  if (!decision.allowed) {
    console.info("[hacksim.review] blocked", input.operation, decision.reason);
    await recordUsage({
      operation: input.operation,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: input.promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requestId: null,
      status: "rejected",
      durationMs: 0,
      userId: input.actorId,
      submissionId: input.submissionId,
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
      errorCode: decision.reason || "blocked",
    });
    return null;
  }

  // §59 — the stable half of the prompt, built once and reused verbatim.
  const contextStable = JSON.stringify({
    context_hash: ctxHash,
    modules: input.contextParts,
  }).slice(0, 12000);

  let response: AIResponse;
  try {
    response = await completeJson({
      systemStable: M.SYSTEM_STABLE,
      contextStable,
      task: input.task,
      promptVersion: input.promptVersion,
      maxOutputTokens: Math.min(pricing.maxOutputTokens, 2500),
    });
  } catch (error) {
    const code = error instanceof AIError ? error.code : "unknown";
    const message = (error as Error).message;
    console.warn("[hacksim.review]", input.operation, "failed:", message);

    await recordUsage({
      operation: input.operation,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: input.promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requestId: null,
      status: "failed",
      durationMs: 0,
      userId: input.actorId,
      submissionId: input.submissionId,
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
      errorCode: code,
      errorMessage: message,
    });
    await saveAnalysis({
      analysisType: input.scopeKey,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: input.promptVersion,
      ctxHash,
      status: "failed",
      resultPayload: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      repositoryId: input.repositoryId,
      submissionId: input.submissionId,
      scopeKey: input.scopeKey,
      errorCode: code,
      errorMessage: message,
    });
    return null;
  }

  // §57 — cost from the provider's own reported usage.
  const cost = calculateCost(pricing, {
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    outputTokens: response.outputTokens,
  });
  const valid = response.parsed !== null;
  const status = valid ? "success" : "failed";
  const errorCode = valid ? null : "invalid_json";
  const errorMessage = valid ? null : "Provider did not return valid JSON.";

  // A malformed reply still cost tokens, so it counts against the review total.
  input.spend.costUsd += cost;
  input.spend.tokens += response.inputTokens + response.outputTokens;

  await recordUsage({
    operation: input.operation,
    provider: pricing.provider,
    model: response.model,
    promptVersion: input.promptVersion,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    costUsd: cost,
    requestId: response.requestId,
    status,
    durationMs: response.durationMs,
    userId: input.actorId,
    submissionId: input.submissionId,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    errorCode,
    errorMessage,
  });

  await saveAnalysis({
    analysisType: input.scopeKey,
    provider: pricing.provider,
    model: response.model,
    promptVersion: input.promptVersion,
    ctxHash,
    status,
    resultPayload: response.parsed,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    totalTokens: response.totalTokens,
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    costUsd: cost,
    repositoryId: input.repositoryId,
    submissionId: input.submissionId,
    scopeKey: input.scopeKey,
    errorCode,
    errorMessage,
    completedAt: valid ? new Date().toISOString() : null,
  });

  return response;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runReview(input: ReviewInput): Promise<ReviewOutcome> {
  const repositoryId =
    (input.repository.repository_id as string) ?? (input.repository.id as string);
  const repositoryIdValue = repositoryId ?? null;
  const submissionId = (input.submission.id as string) ?? null;
  const evidenceIds = new Set(
    input.evidence.map((item) => item.id).filter((id): id is string => Boolean(id)),
  );

  const outcome: ReviewOutcome = {
    reviewId: null,
    status: "pending",
    modules: [],
    totalCostUsd: 0,
    totalTokens: 0,
  };

  const review = await loadReview(submissionId, repositoryIdValue);
  const requirementMap = await getRequirementMap(
    String(input.hackathon.id),
    input.hackathon,
  );

  const pricing = await loadPricing();
  if (!pricing) {
    outcome.status = "failed";
    outcome.error = "No AI model is configured.";
    await upsertReview(submissionId, repositoryIdValue, {}, outcome, null);
    return outcome;
  }

  const results: Record<string, unknown> = { ...((review?.data as Record<string, unknown>) ?? {}) };
  const spend: Spend = { costUsd: 0, tokens: 0 };
  const wants = (module: string) => !input.onlyModules || input.onlyModules.includes(module);

  // ── Module A: alignment, requirements, claims ─────────────────────────
  if (wants(M.MODULE_A)) {
    try {
      const result = await moduleAlignment({
        input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend,
      });
      outcome.modules.push(result);
      Object.assign(results, result.data);
    } catch (error) {
      console.error("[hacksim.review] module A failed", error);
      outcome.modules.push({
        ...M.moduleResult(M.MODULE_A, "failed", "ai", {}),
        errorMessage: (error as Error).message,
      });
    }
  }

  // ── Module B: architecture ───────────────────────────────────────────
  if (wants(M.MODULE_B)) {
    try {
      const result = await moduleGeneric({
        module: M.MODULE_B,
        promptVersion: M.PROMPT_VERSIONS.architecture,
        taskBuilder: (snippets) =>
          M.buildArchitectureTask({
            requirementMap, submission: input.submission,
            projectMap: input.projectMap, evidence: input.evidence, snippets,
          }),
        question: "How is this project architected, and what technical decisions does it make?",
        input, evidenceIds, submissionId, repositoryIdValue, pricing, spend, scope: "architecture",
      });
      outcome.modules.push(result);
      if (result.data.architecture) results.architecture = result.data.architecture;
      if (result.data.technical_decisions) results.technical_decisions = result.data.technical_decisions;
      if (result.data.implementation) results.implementation = result.data.implementation;
    } catch (error) {
      console.error("[hacksim.review] module B failed", error);
      outcome.modules.push({
        ...M.moduleResult(M.MODULE_B, "failed", "ai", {}),
        errorMessage: (error as Error).message,
      });
    }
  }

  // ── Module C: security, database, testing, scalability ────────────────
  if (wants(M.MODULE_C)) {
    try {
      const result = await moduleQuality({
        input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend,
      });
      outcome.modules.push(result);
      if (result.data.security) results.security = result.data.security;
      if (result.data.database) results.database_review = result.data.database;
      if (result.data.testing) results.testing = result.data.testing;
      if (result.data.scalability) results.scalability = result.data.scalability;
    } catch (error) {
      console.error("[hacksim.review] module C failed", error);
      outcome.modules.push({
        ...M.moduleResult(M.MODULE_C, "failed", "ai", {}),
        errorMessage: (error as Error).message,
      });
    }
  }

  // ── Module D: contributions, per member ───────────────────────────────
  if (wants(M.MODULE_D)) {
    try {
      const contributionResults = await moduleContributions({
        input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend,
      });
      outcome.modules.push(...contributionResults);
      if (contributionResults.length) {
        results.contributions = Object.fromEntries(
          contributionResults
            .filter((item) => item.data.user_id)
            .map((item) => [item.data.user_id as string, item.data]),
        );
      }
    } catch (error) {
      console.error("[hacksim.review] module D failed", error);
      outcome.modules.push({
        ...M.moduleResult(M.MODULE_D, "failed", "ai", {}),
        errorMessage: (error as Error).message,
      });
    }
  }

  // ── Persist ──────────────────────────────────────────────────────────
  outcome.status = overallStatus(outcome.modules);
  outcome.totalCostUsd = spend.costUsd;
  outcome.totalTokens = spend.tokens;
  outcome.reviewId = await upsertReview(submissionId, repositoryIdValue, results, outcome, pricing);
  await replaceRequirementEvaluations(submissionId, outcome.modules, evidenceIds);
  await replaceFindings(outcome.reviewId, outcome.modules, evidenceIds);
  await replaceDefenseTargets(submissionId, input.members, outcome.modules, requirementMap, evidenceIds);

  return outcome;
}

// ── Modules ────────────────────────────────────────────────────────────────

type CommonArgs = {
  input: ReviewInput;
  evidenceIds: Set<string>;
  submissionId: string | null;
  repositoryIdValue: string | null;
  pricing: ModelPricing;
  spend: Spend;
};

async function moduleAlignment(args: CommonArgs & { requirementMap: RequirementMap }) {
  const { input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend } = args;
  const requirements = requirementMap.requirements ?? [];
  const out: Record<string, unknown> = {};

  // §42 — deterministic first. Only ask the model when the deterministic pass
  // could not conclude, which is what keeps a normal project cheap.
  const deterministic = M.alignmentFromEvidence(requirementMap, input.projectMap);
  if (deterministic) {
    out.problem_alignment = deterministic;
    out.requirements = requirementsFromDeterministic(requirements, deterministic);
    const addressed = new Set((deterministic.addressed_requirement_ids as string[]) ?? []);
    out.summary = {
      headline: deterministic.explanation,
      strengths: [],
      areas_to_clarify: requirements
        .filter((r) => !addressed.has(r.id))
        .map((r) => `${r.id} has no matching detected technology`)
        .slice(0, 6),
      source: "deterministic",
    };
  } else {
    const packet = buildPacket({
      question: "Does this repository implement the hackathon requirements?",
      files: input.files,
      chunks: input.chunks,
      category: "api",
    });
    const response = await call({
      operation: `${M.MODULE_A}.alignment`,
      task: M.buildAlignmentTask({
        requirementMap,
        projectMap: input.projectMap,
        evidence: input.evidence,
        snippets: packet.render(),
        submission: input.submission,
      }),
      promptVersion: M.PROMPT_VERSIONS.alignment,
      contextParts: [requirementMap, input.projectMap],
      scopeKey: "alignment",
      repositoryId: repositoryIdValue,
      submissionId,
      pricing,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      estimateTokens: packet.estimateTokens() + 3500,
      spend,
    });

    if (response === null) {
      return M.moduleResult(M.MODULE_A, "skipped", "deterministic", {}, "no_call");
    }

    const payload = response.parsed ?? {};
    const alignment = (payload.problem_alignment ?? {}) as Record<string, unknown>;
    out.problem_alignment = {
      status: oneOf(alignment.status, M.ALIGNMENT_STATUSES, "unclear"),
      confidence: oneOf(alignment.confidence, ["high", "medium", "low"] as const, "low"),
      evidence_ids: ((alignment.evidence_ids as string[]) ?? [])
        .filter((id) => evidenceIds.has(id))
        .slice(0, 12),
      explanation: String(alignment.explanation ?? "").slice(0, 1500),
      source: "ai",
    };
    out.requirements = validateRequirementRows(payload.requirements, requirements, evidenceIds);

    const summary = (payload.summary ?? {}) as Record<string, unknown>;
    out.summary = {
      headline: String(summary.headline ?? "").slice(0, 300),
      strengths: ((summary.strengths as string[]) ?? []).map((s) => String(s).slice(0, 200)).slice(0, 6),
      areas_to_clarify: ((summary.areas_to_clarify as string[]) ?? [])
        .map((s) => String(s).slice(0, 200))
        .slice(0, 6),
      source: "ai",
    };
  }

  // Claims are checked in the same pass: same evidence, same context.
  const claims = claimsFrom(input.submission);
  if (claims.length) {
    const claimResult = await moduleGeneric({
      module: "claims",
      promptVersion: M.PROMPT_VERSIONS.claims,
      taskBuilder: (snippets) =>
        M.buildClaimsTask({
          claims, projectMap: input.projectMap, evidence: input.evidence, snippets,
        }),
      question: "Which claimed features are supported by the code?",
      input, evidenceIds, submissionId, repositoryIdValue, pricing, spend, scope: "claims",
      preComputed: deterministicClaims(claims),
    });

    if (claimResult.data.claims) out.claims = claimResult.data.claims;
    // Claim mismatches become findings on the review page.
    const mismatches = ((claimResult.data.findings as Record<string, unknown>[]) ?? []).filter(
      (finding) => finding.finding_type === "claim_mismatch",
    );
    if (mismatches.length) {
      out.findings = [...((out.findings as Record<string, unknown>[]) ?? []), ...mismatches];
    }
  }

  return M.moduleResult(
    M.MODULE_A, "completed", deterministic ? "deterministic" : "ai", out,
  );
}

async function moduleQuality(args: CommonArgs & { requirementMap: RequirementMap }) {
  const { input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend } = args;

  // Security secrets and test counts need no model.
  const securityFacts = M.securityFromEvidence(input.projectMap);
  const testingFacts = M.testingFromEvidence(input.projectMap);

  const packet = buildPacket({
    question: "authentication authorization middleware database schema and tests",
    files: input.files,
    chunks: input.chunks,
    category: "security",
  });

  const response = await call({
    operation: `${M.MODULE_C}.quality`,
    task: M.buildQualityTask({
      requirementMap, submission: input.submission,
      projectMap: input.projectMap, evidence: input.evidence, snippets: packet.render(),
    }),
    promptVersion: M.PROMPT_VERSIONS.quality,
    contextParts: [input.projectMap, testingFacts, securityFacts],
    scopeKey: "quality",
    repositoryId: repositoryIdValue,
    submissionId,
    pricing,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    estimateTokens: packet.estimateTokens() + 3500,
    spend,
  });

  const out: Record<string, unknown> = {};
  const findings: Record<string, unknown>[] = [];

  if (response?.parsed) {
    const payload = response.parsed;
    out.security = section(payload.security, evidenceIds);
    out.database = section(payload.database, evidenceIds);
    out.scalability = section(payload.scalability, evidenceIds);
    // §42 — a test count is arithmetic. Keep the deterministic answer.
    out.testing = { ...testingFacts, source: "deterministic" };
    findings.push(
      ...(M.validateFindings(payload.findings, evidenceIds) as unknown as Record<
        string,
        unknown
      >[]),
    );
  } else {
    out.security = securityFacts ?? { summary: "AI review unavailable.", source: "skipped" };
    out.database = { summary: "AI review unavailable.", source: "skipped" };
    out.scalability = { summary: "AI review unavailable.", source: "skipped" };
    out.testing = { ...testingFacts, source: "deterministic" };
  }

  if (securityFacts) {
    findings.push(
      ...(securityFacts.confirmed_issues as unknown as Record<string, unknown>[]),
    );
  }

  if (testingFacts.finding && testingFacts.testFileCount === 0) {
    findings.push({
      finding_type: "testing_gap",
      severity: "medium",
      title: "No automated tests detected",
      description: testingFacts.explanation,
      evidence_ids: [],
      files: [],
      symbols: [],
      why_it_matters: "Behaviour that is not covered by tests is unverified when it changes.",
      suggested_improvement: "Add tests for the main user path, starting with failure cases.",
      confidence: "medium",
    });
  }

  if (findings.length) out.findings = findings;
  return M.moduleResult(M.MODULE_C, "completed", "ai", out);
}

async function moduleGeneric(
  args: CommonArgs & {
    module: string;
    promptVersion: string;
    taskBuilder: (snippets: string) => string;
    question: string;
    scope: string;
    preComputed?: Record<string, unknown>;
  },
) {
  const { input, evidenceIds, submissionId, repositoryIdValue, pricing, spend, scope } = args;

  const packet = buildPacket({
    question: args.question,
    files: input.files,
    chunks: input.chunks,
  });

  const response = await call({
    operation: `${args.module}.${scope}`,
    task: args.taskBuilder(packet.render()),
    promptVersion: args.promptVersion,
    contextParts: [input.projectMap],
    scopeKey: scope,
    repositoryId: repositoryIdValue,
    submissionId,
    pricing,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    estimateTokens: packet.estimateTokens() + 3000,
    spend,
  });

  if (response === null || !response.parsed) {
    return M.moduleResult(
      args.module,
      "skipped",
      "deterministic",
      {
        ...(args.preComputed ?? {}),
        status: "skipped",
        reason: "AI unavailable or budget exhausted; deterministic facts only.",
      },
    );
  }

  const data: Record<string, unknown> = { ...response.parsed };
  data.findings = M.validateFindings(response.parsed.findings, evidenceIds);
  return M.moduleResult(args.module, "completed", "ai", data);
}

async function moduleContributions(args: CommonArgs & { requirementMap: RequirementMap }): Promise<M.ModuleResult[]> {
  const { input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend } = args;

  // §41 — only members whose claim is specific enough to check, capped.
  const checkable = input.members
    .filter((member) => (member.contribution_description ?? "").trim())
    .slice(0, MAX_MEMBER_MODULES);

  const results: M.ModuleResult[] = [];
  const otherNames = input.members.map(
    (member) => member.full_name || member.email || "member",
  );

  for (const member of checkable) {
    const question = (member.contribution_description ?? "").slice(0, 400);
    const packet = buildPacket({
      question, files: input.files, chunks: input.chunks, maxFiles: 4,
    });

    const response = await call({
      operation: `${M.MODULE_D}.contribution`,
      task: M.buildContributionTask({
        member: member as unknown as Record<string, unknown>,
        requirementMap, submission: input.submission,
        projectMap: input.projectMap,
        evidence: input.evidence,
        snippets: packet.render(),
        otherMembers: otherNames,
      }),
      promptVersion: M.PROMPT_VERSIONS.contribution,
      contextParts: [input.projectMap, member.id],
      scopeKey: `contribution:${member.id}`,
      repositoryId: repositoryIdValue,
      submissionId,
      pricing,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      estimateTokens: packet.estimateTokens() + 2000,
      spend,
    });

    if (response === null || !response.parsed) {
      results.push(
        M.moduleResult(M.MODULE_D, "skipped", "deterministic", {
          user_id: member.user_id,
          member_id: member.id,
          status: "not_yet_verified",
          confidence: "none",
          explanation: "Contribution analysis was unavailable.",
        }),
      );
      continue;
    }

    const payload = response.parsed;
    results.push(
      M.moduleResult(M.MODULE_D, "completed", "ai", {
        user_id: member.user_id,
        member_id: member.id,
        status: oneOf(payload.status, M.CONTRIBUTION_STATUSES, "not_yet_verified"),
        confidence: oneOf(payload.confidence, ["high", "medium", "low"] as const, "low"),
        evidence_ids: ((payload.evidence_ids as string[]) ?? [])
          .filter((id) => evidenceIds.has(id))
          .slice(0, 10),
        matched_files: ((payload.matched_files as string[]) ?? [])
          .map((f) => String(f).slice(0, 200))
          .slice(0, 10),
        matched_symbols: ((payload.matched_symbols as string[]) ?? [])
          .map((s) => String(s).slice(0, 120))
          .slice(0, 10),
        explanation: String(payload.explanation ?? "").slice(0, 1200),
      }),
    );
  }

  return results;
}

// ── Persistence ────────────────────────────────────────────────────────────

async function loadReview(submissionId: string | null, repositoryId: string | null) {
  if (!submissionId || !repositoryId) return null;
  const { data } = await db()
    .from("project_reviews")
    .select("*")
    .eq("submission_id", submissionId)
    .eq("repository_id", repositoryId)
    .limit(1);
  return ((data ?? []) as Record<string, unknown>[])[0] ?? null;
}

async function upsertReview(
  submissionId: string | null,
  repositoryId: string | null,
  results: Record<string, unknown>,
  outcome: ReviewOutcome,
  pricing: ModelPricing | null,
): Promise<string | null> {
  if (!submissionId || !repositoryId) return null;

  const service = db();
  const existing = await loadReview(submissionId, repositoryId);

  const payload: Record<string, unknown> = {
    submission_id: submissionId,
    repository_id: repositoryId,
    status: outcome.status,
    model: pricing?.modelName ?? null,
    prompt_version: M.PROMPT_VERSIONS.alignment,
    estimated_cost_usd: outcome.totalCostUsd,
    total_tokens: outcome.totalTokens,
  };
  for (const key of [
    "summary", "problem_alignment", "requirements", "constraints", "expected_outcomes",
    "evaluation_criteria", "architecture", "implementation", "security",
    "database_review", "testing", "scalability", "technical_decisions", "contributions",
  ]) {
    if (results[key] !== undefined && results[key] !== null) payload[key] = results[key];
  }

  try {
    if (existing?.id) {
      const { error } = await service
        .from("project_reviews")
        .update(payload)
        .eq("id", existing.id);
      if (error) throw error;
      return existing.id as string;
    }

    const { data, error } = await service
      .from("project_reviews")
      .insert(payload)
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("no row");
    return (data as { id: string }).id;
  } catch (error) {
    console.warn("[hacksim.review] could not persist review:", error);
    return null;
  }
}

interface EvaluationRow {
  requirement_id: string;
  status: string;
  evidence_ids: string[];
  confidence: string;
  explanation: string;
  source: string;
}

function rowsFromModule(module: M.ModuleResult, evidenceIds: Set<string>): EvaluationRow[] {
  const rows: EvaluationRow[] = [];
  const cite = (value: unknown) =>
    ((value as string[]) ?? []).filter((id) => evidenceIds.has(id)).slice(0, 12);

  for (const entry of (module.data.requirements as Record<string, unknown>[]) ?? []) {
    if (!entry?.requirement_id) continue;
    rows.push({
      requirement_id: String(entry.requirement_id).slice(0, 32),
      status: oneOf(entry.status, M.REQUIREMENT_STATUSES, "unable_to_determine"),
      evidence_ids: cite(entry.evidence_ids),
      confidence: oneOf(entry.confidence, M.CONFIDENCES, "low"),
      explanation: String(entry.explanation ?? "").slice(0, 1500),
      source: module.source === "deterministic" ? "deterministic" : "ai",
    });
  }

  for (const entry of (module.data.constraints as Record<string, unknown>[]) ?? []) {
    if (!entry?.constraint_id) continue;
    rows.push({
      requirement_id: String(entry.constraint_id).slice(0, 32),
      status: oneOf(entry.status, M.CONSTRAINT_STATUSES, "unable_to_determine"),
      evidence_ids: cite(entry.evidence_ids),
      confidence: oneOf(entry.confidence, M.CONFIDENCES, "low"),
      explanation: String(entry.explanation ?? "").slice(0, 1500),
      source: "ai",
    });
  }

  for (const entry of (module.data.expected_outcomes as Record<string, unknown>[]) ?? []) {
    if (!entry?.outcome_id) continue;
    rows.push({
      requirement_id: String(entry.outcome_id).slice(0, 32),
      status: oneOf(entry.status, M.OUTCOME_STATUSES, "unclear"),
      evidence_ids: cite(entry.evidence_ids),
      confidence: oneOf(entry.confidence, M.CONFIDENCES, "low"),
      explanation: String(entry.explanation ?? "").slice(0, 1500),
      source: "ai",
    });
  }

  return rows;
}

async function replaceRequirementEvaluations(
  submissionId: string | null,
  modules: M.ModuleResult[],
  evidenceIds: Set<string>,
): Promise<void> {
  if (!submissionId) return;

  const rows = modules.flatMap((module) => rowsFromModule(module, evidenceIds));
  if (rows.length === 0) return;

  try {
    // Replace rather than merge: a re-review is a new answer, not a delta.
    const { data: existing } = await db()
      .from("requirement_evaluations")
      .select("id")
      .eq("submission_id", submissionId);
    if ((existing ?? []).length) {
      await db().from("requirement_evaluations").delete().eq("submission_id", submissionId);
    }
    const { error } = await db()
      .from("requirement_evaluations")
      .upsert(
        rows.map((row) => ({ submission_id: submissionId, ...row })),
        { onConflict: "submission_id,requirement_id" },
      );
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.review] could not persist requirement evaluations:", error);
  }
}

async function replaceFindings(
  reviewId: string | null,
  modules: M.ModuleResult[],
  evidenceIds: Set<string>,
): Promise<void> {
  if (!reviewId) return;

  const rows = modules
    .flatMap((module) => (module.data.findings as Record<string, unknown>[]) ?? [])
    .map((finding) => ({
      project_review_id: reviewId,
      finding_type: (finding.finding_type as string) ?? "observation",
      severity: (finding.severity as string) ?? "low",
      title: String(finding.title ?? "Untitled finding").slice(0, 200),
      description: String(finding.description ?? "").slice(0, 2000),
      evidence_ids: ((finding.evidence_ids as string[]) ?? [])
        .filter((id) => evidenceIds.has(id))
        .slice(0, 12),
      files: ((finding.files as string[]) ?? []).slice(0, 12),
      symbols: ((finding.symbols as string[]) ?? []).slice(0, 12),
      why_it_matters: String(finding.why_it_matters ?? "").slice(0, 1000),
      suggested_improvement: String(finding.suggested_improvement ?? "").slice(0, 1000),
      confidence: (finding.confidence as string) ?? "low",
    }))
    // A finding with no resolvable evidence is not stored — §47, twice over.
    .filter((row) => row.evidence_ids.length > 0);

  try {
    await db().from("project_review_findings").delete().eq("project_review_id", reviewId);
    if (rows.length) {
      const { error } = await db().from("project_review_findings").insert(rows);
      if (error) throw error;
    }
  } catch (error) {
    console.warn("[hacksim.review] could not persist findings:", error);
  }
}

/** §50 — topics to prepare for, never questions. */
async function replaceDefenseTargets(
  submissionId: string | null,
  members: ContributionMember[],
  modules: M.ModuleResult[],
  requirementMap: RequirementMap,
  evidenceIds: Set<string>,
): Promise<void> {
  if (!submissionId) return;

  const targets: Record<string, unknown>[] = [];
  const requirementTexts = new Map(
    requirementMap.requirements.map((r) => [r.id, r.text]),
  );

  // P1: requirements with no evidence. These are the obvious weak spots.
  for (const module of modules) {
    for (const entry of (module.data.requirements as Record<string, unknown>[]) ?? []) {
      const status = entry.status;
      if (status !== "not_evidenced" && status !== "partial_evidence") continue;
      const id = String(entry.requirement_id ?? "");
      targets.push({
        submission_id: submissionId,
        topic: (requirementTexts.get(id) ?? id).slice(0, 300),
        reason:
          String(entry.explanation ?? "").slice(0, 600) ||
          "The analysed repository did not provide sufficient evidence for this requirement.",
        priority: status === "not_evidenced" ? "P1" : "P2",
        evidence_ids: ((entry.evidence_ids as string[]) ?? [])
          .filter((e) => evidenceIds.has(e))
          .slice(0, 10),
        question_area: "requirement_coverage",
        status: "open",
      });
    }
  }

  // P0: a member's own contribution that the repository could not support.
  for (const module of modules.filter((m) => m.module === M.MODULE_D)) {
    const data = module.data;
    if (data.status !== "not_yet_verified" && data.status !== "partially_supported") continue;
    const member = members.find((m) => m.id === data.member_id);
    if (!member) continue;
    targets.push({
      submission_id: submissionId,
      user_id: member.user_id,
      topic: (member.contribution_description || "Your contribution").slice(0, 300),
      reason: String(data.explanation ?? "").slice(0, 600),
      priority: "P0",
      evidence_ids: ((data.evidence_ids as string[]) ?? []).slice(0, 10),
      question_area: "personal_contribution",
      status: "open",
    });
  }

  // P5: confirmed security findings.
  for (const module of modules) {
    for (const finding of (module.data.findings as Record<string, unknown>[]) ?? []) {
      if (finding.finding_type !== "security_concern") continue;
      targets.push({
        submission_id: submissionId,
        topic: String(finding.title ?? "Security concern").slice(0, 300),
        reason: String(finding.why_it_matters ?? finding.description ?? "").slice(0, 600),
        priority: "P5",
        evidence_ids: finding.evidence_ids ?? [],
        question_area: "security",
        status: "open",
      });
    }
  }

  if (targets.length === 0) return;

  try {
    await db().from("defense_targets").delete().eq("submission_id", submissionId);
    // Cap the list; a long one is noise, not preparation.
    const { error } = await db().from("defense_targets").insert(targets.slice(0, 20));
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.review] could not persist defense targets:", error);
  }
}
