/**
 * The analysis orchestrator.
 *
 * This is the pipeline the product spec describes, in the order it describes it:
 *
 *   hackathon context → requirement concepts → retrieval plan → deterministic
 *   gate → (DeepSeek, only if the gate cannot conclude) → validated JSON →
 *   conflict detection → conclusions → review → defence targets → knowledge
 *
 * Design decisions worth stating plainly:
 *
 * • **Planning is explicit.** `planner.ts` decides which dimensions matter and
 *   which calls are worth making, from this hackathon and this repository. The
 *   reasons are stored with the result.
 *
 * • **A missing technology cannot fail a requirement.** There is no code path
 *   from a dependency list to a status. The only deterministic verdicts are
 *   counts and named literals, and everything else is the model's reading of
 *   retrieved code.
 *
 * • **Coverage limits are never a project verdict.** If the scan was limited,
 *   "not found" becomes `unable_to_determine` and the reason is recorded.
 *
 * • **Uncertainty is output, not an error.** `uncertainty`, `gaps` and
 *   `unable_to_determine` are normal, expected results, and the UI shows them
 *   as findings rather than hiding them.
 *
 * Individual contribution analysis is gone. There is no code path to it, no
 * prompt for it, and no column written for it.
 */

import { db } from "./http.ts";
import {
  AIError,
  aiConfigured,
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
import * as C from "./concepts.ts";
import * as E from "./evidence.ts";
import * as V from "./validate.ts";
import * as P from "./planner.ts";
import * as RET from "./retrieval.ts";
import * as DET from "./deterministic.ts";
import { buildHackathonContext, type HackathonContext } from "./context.ts";
import { getRequirementMap, type RequirementMap } from "./requirements.ts";
import type { DatasetProfile } from "./datasets.ts";
import type { SemanticsResult } from "./semantics.ts";
import type { Evidence } from "./github.ts";

// ── Input / output ─────────────────────────────────────────────────────────

export interface AnalysisInput {
  submission: Record<string, unknown>;
  hackathon: Record<string, unknown>;
  repository: Record<string, unknown>;
  files: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  evidence: Evidence[];
  projectMap: Record<string, unknown>;
  datasetProfiles?: DatasetProfile[];
  semantics?: SemanticsResult[];
  routes?: RET.IndexRoute[];
  inspection?: {
    mode: "full" | "limited";
    warnings: string[];
    filesSeen: number;
    filesRead: number;
  };
  actorId?: string | null;
  sessionId?: string | null;
  onlyTasks?: string[] | null;
  /**
   * An alternative model client. Used by the offline regression harness so the
   * pipeline can be exercised end to end — retrieval, validation, citation
   * filtering, repair, persistence — without a provider key. Never populated
   * from a request body.
   */
  provider?: ((args: {
    task: string;
    promptVersion: string;
    maxOutputTokens: number;
  }) => Promise<AIResponse>) | null;
}

export interface TaskOutcome {
  key: string;
  kind: string;
  scope: string;
  status: "executed" | "cached" | "avoided" | "failed" | "skipped";
  reason: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  validationErrors: string[];
  rejectedEvidenceIds: string[];
  repairs: number;
  evidenceIds: string[];
}

export interface ConclusionRow {
  subject_id: string;
  kind: V.SubjectKind;
  status: string;
  confidence: string;
  evidence_ids: string[];
  explanation: string;
  missing_or_unclear: string[];
  method: string;
  files: string[];
  retrieval_queries: string[];
  relevant_files: string[];
  evidence_count: number;
  ai_used: boolean;
  ai_reason: string;
}

export interface AnalysisOutcome {
  reviewId: string | null;
  status: string;
  context: HackathonContext;
  plan: P.AnalysisPlan;
  conclusions: ConclusionRow[];
  findings: E.ValidatedFinding[];
  claims: V.ValidatedClaim[];
  assessment: V.ValidatedAssessment | null;
  alignment: V.ValidatedAlignment | null;
  architecture: Record<string, unknown> | null;
  implementation: Record<string, unknown> | null;
  engineering: Record<string, unknown>[];
  testing: DET.DeterministicVerdict | E.TestingFacts | null;
  tasks: TaskOutcome[];
  diagnostics: Record<string, unknown>;
  diff: Record<string, unknown> | null;
  totalCostUsd: number;
  totalTokens: number;
  error?: string;
}

interface Spend {
  costUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  calls: number;
  cacheHits: number;
  failures: number;
  validationFailures: number;
  repairs: number;
}

// ── The single guarded call site ───────────────────────────────────────────

interface CallInput {
  operation: string;
  task: string;
  promptVersion: string;
  scopeKey: string;
  /** Subjects this call is responsible for. Part of the cache identity. */
  subjectIds: string[];
  contextParts: unknown[];
  repositoryId: string | null;
  commitSha: string | null;
  submissionId: string | null;
  pricing: ModelPricing;
  actorId: string | null;
  sessionId: string | null;
  estimateTokens: number;
  spend: Spend;
  /** Injected only by the offline harness; see AnalysisInput.provider. */
  provider?: AnalysisInput["provider"];
}

/**
 * One guarded DeepSeek call.
 *
 * Order: hash → configured? → cache → budget → request → ledger. A rejection
 * never reaches the provider and is still recorded, so the numbers explain
 * themselves whether or not the money was spent.
 */
async function call(input: CallInput): Promise<AIResponse | null> {
  const { pricing } = input;
  const ctxHash = await contextHash(
    [input.subjectIds, input.contextParts],
    input.promptVersion,
    pricing.modelName,
  );

  if (!aiConfigured()) {
    console.info("[hacksim.analysis] AI not configured; skipping", input.operation);
    return null;
  }

  // §22 — the cache identity is commit + subjects + prompt version + context +
  // model. Same commit and same question means the same answer.
  const cached = await findCachedAnalysis({
    repositoryId: input.repositoryId,
    analysisType: input.scopeKey,
    promptVersion: input.promptVersion,
    model: pricing.modelName,
    ctxHash,
  });
  if (cached?.result) {
    input.spend.cacheHits += 1;
    console.info("[hacksim.analysis] cache hit for", input.scopeKey, input.subjectIds);
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

  const decision = await checkBudget({
    pricing,
    submissionId: input.submissionId,
    estimatedInputTokens: input.estimateTokens,
    estimatedOutputTokens: pricing.maxOutputTokens,
    cacheRatio: input.scopeKey === "properness" ? 0.5 : 0,
  });

  if (!decision.allowed) {
    console.info("[hacksim.analysis] blocked", input.operation, decision.reason);
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

  // The stable half: identical across every call in a run, so the provider
  // caches it once and every later task reads it from cache.
  const contextStable = JSON.stringify({
    context_hash: ctxHash,
    hackathon: input.contextParts[0],
    project_map: input.contextParts[1],
  }).slice(0, 12000);

  let response: AIResponse;
  try {
    response = input.provider
      ? await input.provider({
        task: input.task,
        promptVersion: input.promptVersion,
        maxOutputTokens: Math.min(pricing.maxOutputTokens, 3000),
      })
      : await completeJson({
        systemStable: M.SYSTEM_STABLE,
        contextStable,
        task: input.task,
        promptVersion: input.promptVersion,
        maxOutputTokens: Math.min(pricing.maxOutputTokens, 3000),
      });
  } catch (error) {
    const code = error instanceof AIError ? error.code : "unknown";
    const message = (error as Error).message;
    console.warn("[hacksim.analysis]", input.operation, "failed:", message);
    input.spend.failures += 1;
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

  const cost = calculateCost(pricing, {
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    outputTokens: response.outputTokens,
  });
  const valid = response.parsed !== null;

  input.spend.calls += 1;
  input.spend.costUsd += cost;
  input.spend.tokens += response.inputTokens + response.outputTokens;
  input.spend.inputTokens += response.inputTokens;
  input.spend.outputTokens += response.outputTokens;
  input.spend.cachedTokens += response.cachedTokens;
  if (!valid) input.spend.failures += 1;

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
    status: valid ? "success" : "failed",
    durationMs: response.durationMs,
    userId: input.actorId,
    submissionId: input.submissionId,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    errorCode: valid ? null : "invalid_json",
    errorMessage: valid ? null : "Provider did not return valid JSON.",
  });

  await saveAnalysis({
    analysisType: input.scopeKey,
    provider: pricing.provider,
    model: response.model,
    promptVersion: input.promptVersion,
    ctxHash,
    status: valid ? "success" : "failed",
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
    errorCode: valid ? null : "invalid_json",
    errorMessage: valid ? null : "Provider did not return valid JSON.",
    completedAt: valid ? new Date().toISOString() : null,
  });

  return response;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export async function runAnalysis(input: AnalysisInput): Promise<AnalysisOutcome> {
  const submissionId = (input.submission.id as string) ?? null;
  const repositoryId =
    ((input.repository.repository_id as string) ?? (input.repository.id as string)) ?? null;
  const commitSha = (input.repository.analyzed_commit_sha as string) ?? null;

  const hackathonId = String(input.hackathon.id ?? "");
  const requirementMap: RequirementMap = await getRequirementMap(hackathonId, input.hackathon);
  const context = await buildHackathonContext(
    input.hackathon,
    requirementMap,
    input.submission,
  );

  const evidenceSet = E.buildEvidenceSet(
    V.asRawEvidence((input.evidence ?? []) as never),
  );
  const datasetProfiles = input.datasetProfiles ?? [];
  const semantics = input.semantics ?? [];
  const projectMap = input.projectMap ?? {};

  const index = RET.buildRepoIndex({
    files: input.files as unknown as RET.IndexFile[],
    chunks: input.chunks as unknown as RET.IndexChunk[],
    evidence: evidenceSet.byId ? [...evidenceSet.byId.values()] : [],
    routes: input.routes ?? [],
    datasetProfiles,
    semantics: semantics as unknown as RET.IndexSemantics[],
  });

  // ── Concepts and grouping ───────────────────────────────────────────────
  const vocabulary = C.briefVocabulary(requirementMap);
  const requirementConcepts = new Map<string, C.ConceptSet>();
  for (const entry of requirementMap.requirements ?? []) {
    requirementConcepts.set(
      entry.id,
      C.analyseRequirement(entry.text, vocabulary, requirementMap),
    );
  }
  const groups = C.groupRequirements(requirementMap);
  const constraintConcepts = C.analyseBriefItems(requirementMap.constraints ?? [], requirementMap);
  const outcomeConcepts = C.analyseBriefItems(requirementMap.expected_outcomes ?? [], requirementMap);
  const criteriaConcepts = C.analyseBriefItems(requirementMap.evaluation_criteria ?? [], requirementMap);

  // ── Counts the deterministic layer is allowed to use ────────────────────
  const facts = countFacts(input, projectMap, index);

  // ── Inspection coverage ────────────────────────────────────────────────
  const inspection = input.inspection ?? {
    mode: (projectMap.analysis_mode as "full" | "limited") ?? "full",
    warnings: ((projectMap.warnings as string[]) ?? []).slice(0, 5),
    filesSeen: facts.fileCount,
    filesRead: facts.fileCount,
  };
  const coverage = DET.inspectionCovers(inspection);
  const inspectionNote = coverage.covered
    ? ""
    : coverage.note + " Prefer 'unable_to_determine' over a negative status for anything not found.";

  // ── Plan ───────────────────────────────────────────────────────────────
  const plan = P.planAnalysis(
    context,
    facts,
    groups.map((group) => ({
      focus: group.focus,
      label: group.label,
      ids: group.entries.map((entry) => entry.id),
      questions: P.questionsForGroup(group.concepts),
    })),
    (requirementMap.expected_outcomes ?? []).map((entry) => entry.id),
    (requirementMap.constraints ?? []).map((entry) => entry.id),
    (requirementMap.evaluation_criteria ?? []).map((entry) => entry.id),
    alignmentQuestions(context),
  );

  const pricing = await loadPricing();
  const spend: Spend = {
    costUsd: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    calls: 0,
    cacheHits: 0,
    failures: 0,
    validationFailures: 0,
    repairs: 0,
  };

  const conclusions: ConclusionRow[] = [];
  const findings: E.ValidatedFinding[] = [];
  const tasks: TaskOutcome[] = [];
  let claims: V.ValidatedClaim[] = [];
  let alignment: V.ValidatedAlignment | null = null;
  let architecture: Record<string, unknown> | null = null;
  let implementation: Record<string, unknown> | null = null;
  let engineering: Record<string, unknown>[] = [];
  let assessment: V.ValidatedAssessment | null = null;

  const wants = (key: string) => !input.onlyTasks?.length || input.onlyTasks.includes(key);

  if (!pricing) {
    return failure(context, plan, {
      reviewId: null,
      status: "failed",
      conclusions: [],
      findings: [],
      tasks: [],
      diagnostics: {},
      totalCostUsd: 0,
      totalTokens: 0,
      error: "No AI model is configured.",
    } as unknown as AnalysisOutcome);
  }

  // ── Deterministic conclusions, before any model is consulted ───────────
  const deterministicRows = new Map<string, ConclusionRow>();
  for (const entry of requirementMap.requirements ?? []) {
    if (!wants("requirements")) break;
    const concept = requirementConcepts.get(entry.id);
    if (!concept) continue;
    const planForRequirement = RET.buildRetrievalPlan(entry.id, concept);
    const retrieval = RET.retrieve({ plan: planForRequirement, index });

    const counted = DET.deterministicCount(entry.text, facts.countables);
    const literal = DET.deterministicLiteral(entry.text, index, evidenceSet);
    const verdict = counted.status ? counted : literal;

    if (verdict.status) {
      deterministicRows.set(entry.id, {
        subject_id: entry.id,
        kind: "requirement",
        status: verdict.status,
        confidence: verdict.status === "evidence_found" ? "high" : "medium",
        evidence_ids: verdict.evidenceIds,
        explanation: verdict.explanation,
        missing_or_unclear: [],
        method: verdict.method ?? "deterministic_count",
        files: retrieval.files.map((hit) => hit.path).slice(0, 6),
        retrieval_queries: planForRequirement.questions.slice(0, 2),
        relevant_files: retrieval.files.map((hit) => hit.path).slice(0, 6),
        evidence_count: verdict.evidenceIds.length,
        ai_used: false,
        ai_reason:
          "A count or a named artefact settled this; the deterministic pass is " +
          "authoritative and no model call was made.",
      });
    }
  }

  // ── Task loop ──────────────────────────────────────────────────────────
  for (const planned of plan.tasks) {
    if (!wants(planned.key)) continue;

    // 1. Alignment
    if (planned.kind === "alignment") {
      const retrieval = retrieveFor(conceptFromTask(planned, requirementConcepts, context, index), index);
      const outcome = await runAi({
        planned,
        prompt: M.buildAlignmentTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, []),
        ),
        promptVersion: M.PROMPT_VERSIONS.alignment,
        scopeKey: "alignment",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => V.validateAlignment(payload, evidenceSet),
        pick: (items) => items[0],
        evidenceIdsFrom: (item) => item.evidence_ids,
      });
      if (outcome.item) {
        alignment = outcome.item;
        findings.push(
          ...E.validateFindings((outcome.payload?.findations ?? null), evidenceSet, "hackathon"),
        );
        if (alignment.downgraded) spend.validationFailures += 1;
      }
      continue;
    }

    // 2. Requirements, one group at a time
    if (planned.kind === "requirements") {
      const group = groups.find((item) => item.focus === planned.focus);
      if (!group) continue;
      const pending: typeof group.entries = [];
      for (const entry of group.entries) {
        if (deterministicRows.has(entry.id)) continue;
        pending.push(entry);
      }
      if (!pending.length) {
        tasks.push({
          key: planned.key,
          kind: planned.kind,
          scope: planned.scope,
          status: "avoided",
          reason: "The deterministic pass settled every requirement in this group.",
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          validationErrors: [],
          rejectedEvidenceIds: [],
          repairs: 0,
          evidenceIds: [],
        });
        continue;
      }

      const retrievals = new Map<string, RET.RetrievalResult>();
      for (const entry of pending) {
        const concept = requirementConcepts.get(entry.id);
        if (!concept) continue;
        retrievals.set(entry.id, RET.retrieve({ plan: RET.buildRetrievalPlan(entry.id, concept), index }));
      }
      const merged = mergeRetrievals([...retrievals.values()]);

      const outcome = await runAi({
        planned,
        prompt: M.buildRequirementsTask(
          promptContext(context, input, index, evidenceSet, merged, projectMap, datasetProfiles, semantics, inspectionNote, group.concepts),
          pending.map((entry) => ({
            id: entry.id,
            text: entry.text,
            importance: entry.importance,
          })),
          group.label,
        ),
        promptVersion: M.PROMPT_VERSIONS.requirements,
        scopeKey: "requirements",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) =>
          V.validateConclusions(payload, {
            kind: "requirement",
            allowedSubjects: pending.map((entry) => entry.id),
            evidence: evidenceSet,
          }),
        evidenceIdsFrom: () => [],
      });

      for (const item of outcome.items) {
        const retrieval = retrievals.get(item.subject_id);
        const coverageNote = coverage.covered
          ? ""
          : " The repository was not fully inspected, so absence of evidence here is inconclusive.";
        const finalStatus = item.status === "not_evidenced" && !coverage.covered
          ? "unable_to_determine"
          : item.status;
        conclusions.push({
          subject_id: item.subject_id,
          kind: "requirement",
          status: finalStatus,
          confidence: finalStatus === "unable_to_determine" ? "none" : item.confidence,
          evidence_ids: item.evidence_ids,
          explanation: item.explanation + coverageNote,
          missing_or_unclear: item.missing_or_unclear,
          method: "ai_evidence",
          files: item.files,
          retrieval_queries: (retrieval?.plan.questions ?? []).slice(0, 2),
          relevant_files: (retrieval?.files ?? []).map((hit) => hit.path).slice(0, 6),
          evidence_count: item.evidence_ids.length,
          ai_used: true,
          ai_reason: outcome.reason,
        });
      }
      findings.push(
        ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon"),
      );
      continue;
    }

    // 3. Constraints
    if (planned.kind === "constraints") {
      const subjects = requirementMap.constraints ?? [];
      const retrieval = retrieveForBrief(constraintConcepts, index);
      const outcome = await runAi({
        planned,
        prompt: M.buildConstraintsTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, constraintConcepts),
          subjects.map((entry) => ({ id: entry.id, text: entry.text, importance: entry.importance })),
        ),
        promptVersion: M.PROMPT_VERSIONS.constraints,
        scopeKey: "constraints",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) =>
          V.validateConclusions(payload, {
            kind: "constraint",
            allowedSubjects: subjects.map((entry) => entry.id),
            evidence: evidenceSet,
          }),
        evidenceIdsFrom: () => [],
      });
      pushConclusions(conclusions, outcome.items, "constraint", "ai_evidence", outcome.reason, []);
      findings.push(
        ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon"),
      );
      continue;
    }

    // 4. Expected outcomes
    if (planned.kind === "outcomes") {
      const subjects = requirementMap.expected_outcomes ?? [];
      const retrieval = retrieveForBrief(outcomeConcepts, index);
      const outcome = await runAi({
        planned,
        prompt: M.buildOutcomesTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, outcomeConcepts),
          subjects.map((entry) => ({ id: entry.id, text: entry.text })),
        ),
        promptVersion: M.PROMPT_VERSIONS.outcomes,
        scopeKey: "outcomes",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) =>
          V.validateConclusions(payload, {
            kind: "outcome",
            allowedSubjects: subjects.map((entry) => entry.id),
            evidence: evidenceSet,
          }),
        evidenceIdsFrom: () => [],
      });
      pushConclusions(conclusions, outcome.items, "outcome", "ai_evidence", outcome.reason, []);
      findings.push(
        ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon"),
      );
      continue;
    }

    // 5. Evaluation criteria — descriptive only, never a score
    if (planned.kind === "criteria") {
      const subjects = requirementMap.evaluation_criteria ?? [];
      const retrieval = retrieveForBrief(criteriaConcepts, index);
      const outcome = await runAi({
        planned,
        prompt: M.buildCriteriaTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, criteriaConcepts),
          subjects.map((entry) => ({ id: entry.id, text: entry.text })),
        ),
        promptVersion: M.PROMPT_VERSIONS.criteria,
        scopeKey: "criteria",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) =>
          V.validateConclusions(payload, {
            kind: "criterion",
            allowedSubjects: subjects.map((entry) => entry.id),
            evidence: evidenceSet,
          }),
        evidenceIdsFrom: () => [],
      });
      pushConclusions(conclusions, outcome.items, "criterion", "ai_evidence", outcome.reason, []);
      findings.push(
        ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon"),
      );
      continue;
    }

    // 6. Claims
    if (planned.kind === "claims") {
      const claimList = claimsFrom(input.submission);
      if (!claimList.length) continue;
      const retrieval = retrieveForText(planned.question, index);
      const outcome = await runAi({
        planned,
        prompt: M.buildClaimsTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, []),
          claimList,
        ),
        promptVersion: M.PROMPT_VERSIONS.claims,
        scopeKey: "claims",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => V.validateClaims(payload, evidenceSet, claimList),
        evidenceIdsFrom: () => [],
      });
      claims = outcome.items;
      for (const claim of claims) {
        const observed = observationFor(claim, evidenceSet);
        findings.push(...E.detectConflicts(
          {
            claim: claim.claim,
            status: claim.status as E.ClaimStatus,
            evidenceIds: claim.evidence_ids,
            explanation: claim.explanation,
            observed,
          },
          evidenceSet,
        ));
      }
      findings.push(
        ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "claim"),
      );
      continue;
    }

    // 7. Implementation and coherence
    if (planned.kind === "implementation") {
      const retrieval = retrieveForText(planned.question, index);
      const outcome = await runAi({
        planned,
        prompt: M.buildImplementationTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, []),
        ),
        promptVersion: M.PROMPT_VERSIONS.implementation,
        scopeKey: "implementation",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: () => ({ items: [], rejectedSubjects: [], rejectedEvidenceIds: [], errors: [] }),
        pick: () => null,
        evidenceIdsFrom: () => [],
      });
      const payload = outcome.payload ?? {};
      architecture = (payload.architecture as Record<string, unknown>) ?? null;
      implementation = (payload.implementation as Record<string, unknown>) ?? null;
      findings.push(
        ...E.validateFindings(payload.findings ?? null, evidenceSet, "general"),
      );
      const dead = (implementation?.incomplete_or_dead as string[]) ?? [];
      for (const item of dead.slice(0, 5)) {
        findings.push({
          finding_type: "dead_feature",
          severity: "low",
          title: `Present but not doing anything: ${item.slice(0, 120)}`,
          description: String(item).slice(0, 600),
          evidence_ids: [],
          files: [],
          symbols: [],
          why_it_matters:
            "A feature that exists but has no effect is misleading in a write-up and in a demo.",
          suggested_improvement: "Complete it or remove the claim that it is part of the solution.",
          confidence: "low",
          expectation_source: "general",
        });
      }
      continue;
    }

    // 8. Engineering observations
    if (planned.kind === "engineering") {
      const retrieval = retrieveForText(planned.question, index);
      const topics = plan.dimensions
        .filter((item) => item.relevance !== "not_applicable" && item.method === "ai" && item.key !== "problem_alignment")
        .map((item) => item.label);
      const outcome = await runAi({
        planned,
        prompt: M.buildEngineeringTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, []),
          topics.slice(0, 6),
        ),
        promptVersion: M.PROMPT_VERSIONS.engineering,
        scopeKey: "engineering",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: () => ({ items: [], rejectedSubjects: [], rejectedEvidenceIds: [], errors: [] }),
        pick: () => null,
        evidenceIdsFrom: () => [],
      });
      const list = Array.isArray(outcome.payload?.observations)
        ? (outcome.payload!.observations as Record<string, unknown>[])
        : [];
      engineering = list
        .filter((item) => item && typeof item === "object")
        .slice(0, 8)
        .map((item) => {
          const citations = E.filterCitations(item.evidence_ids, evidenceSet);
          return {
            topic: String(item.topic ?? "general").slice(0, 60),
            status: ["observed", "not_applicable", "concern"].includes(String(item.status))
              ? String(item.status)
              : "observed",
            summary: String(item.summary ?? "").slice(0, 900),
            evidence_ids: citations.accepted,
            concern: String(item.concern ?? "").slice(0, 600),
            improvement: String(item.improvement ?? "").slice(0, 600),
            expectation_source: "general",
          };
        });
      findings.push(
        ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "general"),
      );
      continue;
    }

    // 9. Properness — reads the conclusions, not the code
    if (planned.kind === "properness") {
      const prior = [
        ...(alignment
          ? [{ label: "problem alignment", status: alignment.status, summary: alignment.explanation }]
          : []),
        ...conclusions.map((row) => ({
          label: row.subject_id,
          status: row.status,
          summary: row.explanation,
        })),
        ...claims.map((claim) => ({
          label: `claim: ${claim.claim.slice(0, 60)}`,
          status: claim.status,
          summary: claim.explanation,
        })),
      ];
      const outcome = await runAi({
        planned,
        prompt: M.buildPropernessTask(
          promptContext(context, input, index, evidenceSet, emptyRetrieval(), projectMap, datasetProfiles, semantics, inspectionNote, []),
          prior.slice(0, 24),
        ),
        promptVersion: M.PROMPT_VERSIONS.properness,
        scopeKey: "properness",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => V.validateAssessment(payload, evidenceSet),
        pick: (items) => items[0],
        evidenceIdsFrom: (item) => item.evidence_ids,
      });
      if (outcome.item) {
        assessment = outcome.item;
        findings.push(
          ...E.validateFindings(outcome.payload?.findings ?? null, evidenceSet, "general"),
        );
      }
      continue;
    }
  }

  // Deterministic rows join the conclusion set, before the AI rows so the order
  // on the page follows the brief.
  const allConclusions = [
    ...deterministicOrdered(requirementMap, deterministicRows, conclusions),
  ];

  // Testing and secrets: literal facts, always recorded, never model output.
  const testing = E.testingFromEvidence(projectMap);
  const secrets = E.securityFromEvidence(projectMap);
  if (secrets) {
    for (const issue of secrets.confirmed_issues) {
      findings.push({
        finding_type: "security_concern",
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        evidence_ids: [],
        files: [],
        symbols: [],
        why_it_matters: issue.why_it_matters,
        suggested_improvement: issue.suggested_improvement,
        confidence: "medium",
        expectation_source: "general",
      });
    }
  }
  if (testing.finding === "testing_gap" && testing.testFileCount === 0) {
    const testingRequired = plan.dimensions.some(
      (item) => item.key === "testing" && item.relevance === "required",
    );
    findings.push({
      finding_type: "testing_gap",
      severity: testingRequired ? "medium" : "informational",
      title: "No automated tests were detected",
      description: testing.explanation,
      evidence_ids: [],
      files: [],
      symbols: [],
      why_it_matters: testingRequired
        ? "This hackathon asks about testing, and no test file was found in the analysed repository."
        : "Behaviour that is not covered by tests is unverified when it changes. This was not a requirement here.",
      suggested_improvement: "Add a test for the main user path, starting with failure cases.",
      confidence: "medium",
      expectation_source: testingRequired ? "hackathon" : "general",
    });
  }

  // Defence targets: topics to prepare for, never questions. §28.
  const defenseTargets = buildDefenseTargets(allConclusions, findings, claimListOf(claims));

  // ── Persist ───────────────────────────────────────────────────────────
  const reviewId = await upsertReview({
    submissionId,
    repositoryId,
    context,
    plan,
    alignment,
    allConclusions,
    assessment,
    architecture,
    implementation,
    engineering,
    testing,
    spend,
    commitSha,
  });
  await replaceRequirementEvaluations(submissionId, allConclusions);
  await replaceFindings(reviewId, findings);
  await replaceDefenseTargets(submissionId, defenseTargets);
  await saveSnapshot({
    submissionId,
    repositoryId,
    commitSha,
    context,
    plan,
    evidence: evidenceSet.byId.size,
    allConclusions,
    spend,
  });

  const previous = await previousEvaluations(submissionId);
  const diff = diffAgainst(previous, allConclusions, commitSha);

  const diagnostics = buildDiagnostics({
    context,
    plan,
    facts,
    allConclusions,
    tasks,
    spend,
    inspection,
    coverage: coverage.covered,
    datasetProfiles,
    evidenceCount: evidenceSet.byId.size,
    diff,
  });

  return {
    reviewId,
    status: statusFor(allConclusions, tasks, findings),
    context,
    plan,
    conclusions: allConclusions,
    findings: dedupeFindings(findings),
    claims,
    assessment,
    alignment,
    architecture,
    implementation,
    engineering,
    testing,
    tasks,
    diagnostics,
    diff,
    totalCostUsd: spend.costUsd,
    totalTokens: spend.tokens,
  };
}

/** Kept so the edge entry point's import keeps working. */
export const runReview = runAnalysis;

// ── Task execution ─────────────────────────────────────────────────────────

interface RunAiArgs<T> {
  planned: P.PlannedTask;
  prompt: string;
  promptVersion: string;
  scopeKey: string;
  promptContextItems: unknown[];
  repositoryId: string | null;
  commitSha: string | null;
  submissionId: string | null;
  pricing: ModelPricing;
  input: AnalysisInput;
  spend: Spend;
  tasks: TaskOutcome[];
  validate: (payload: unknown) => V.ValidationResult<T>;
  pick?: (items: T[]) => T | null;
  evidenceIdsFrom: (item: T) => string[];
}

/**
 * One planned call: request, validate, and — at most once — repair.
 *
 * The retry budget is deliberately finite. A model that cannot produce a valid,
 * correctly cited answer to a schema it was shown twice is recorded as failed
 * and the pipeline continues without it, which is a visible, honest outcome
 * rather than an infinite loop.
 */
async function runAi<T>(args: RunAiArgs<T>): Promise<{
  payload: Record<string, unknown> | null;
  items: T[];
  item: T | null;
  reason: string;
}> {
  const { planned, spend, tasks } = args;
  const record: TaskOutcome = {
    key: planned.key,
    kind: planned.kind,
    scope: planned.scope,
    status: "executed",
    reason: planned.reason,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    validationErrors: [],
    rejectedEvidenceIds: [],
    repairs: 0,
    evidenceIds: [],
  };

  const before = { cost: spend.costUsd, calls: spend.calls };
  const response = await call({
    operation: `analysis.${planned.key}`,
    task: args.prompt,
    promptVersion: args.promptVersion,
    scopeKey: args.scopeKey,
    subjectIds: planned.subjectIds,
    contextParts: args.promptContextItems,
    repositoryId: args.repositoryId,
    commitSha: args.commitSha,
    submissionId: args.submissionId,
    pricing: args.pricing,
    actorId: args.input.actorId ?? null,
    sessionId: args.input.sessionId ?? null,
    estimateTokens: Math.ceil(args.prompt.length / 4) + 1200,
    spend,
    provider: args.input.provider ?? null,
  });

  record.inputTokens = Math.max(0, spend.inputTokens);
  record.outputTokens = Math.max(0, spend.outputTokens);
  record.cachedTokens = spend.cachedTokens;
  record.costUsd = Math.max(0, spend.costUsd - before.cost);
  record.status = spend.calls === before.calls ? "cached" : "executed";

  if (!response || !response.parsed) {
    record.status = response ? "failed" : "skipped";
    record.reason = response
      ? "The model did not return valid JSON; the call is recorded as failed."
      : "The call was not made (no key, or the budget for this submission is exhausted).";
    tasks.push(record);
    return { payload: null, items: [], item: null, reason: record.reason };
  }

  let payload = response.parsed;
  let validation = args.validate(payload);
  record.validationErrors = validation.errors;
  record.rejectedEvidenceIds = validation.rejectedEvidenceIds;

  // One repair, only when the shape was the problem.
  if (validation.errors.length) {
    spend.validationFailures += 1;
    const repairTask = V.repairPrompt(args.prompt, validation.errors);
    const repaired = await call({
      operation: `analysis.${planned.key}.repair`,
      task: repairTask,
      promptVersion: `${args.promptVersion}-r1`,
      scopeKey: `${args.scopeKey}:repair`,
      subjectIds: planned.subjectIds,
      contextParts: args.promptContextItems,
      repositoryId: args.repositoryId,
      commitSha: args.commitSha,
      submissionId: args.submissionId,
      pricing: args.pricing,
      actorId: args.input.actorId ?? null,
      sessionId: args.input.sessionId ?? null,
      estimateTokens: Math.ceil(repairTask.length / 4) + 800,
      spend,
      provider: args.input.provider ?? null,
    });
    record.repairs = 1;
    spend.repairs += 1;
    if (repaired?.parsed) {
      payload = repaired.parsed;
      validation = args.validate(payload);
      record.validationErrors = validation.errors;
      record.rejectedEvidenceIds = validation.rejectedEvidenceIds;
    }
  }

  const items = validation.items;
  const item = args.pick ? args.pick(items) : null;
  record.evidenceIds = [...new Set(items.flatMap((entry) => args.evidenceIdsFrom(entry)))].slice(0, 20);
  record.reason = items.length
    ? planned.reason
    : `${planned.reason} No usable conclusion survived validation.`;
  tasks.push(record);

  return { payload, items, item, reason: record.reason };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function claimsFrom(submission: Record<string, unknown>): string[] {
  const claims: string[] = [];
  const description = String(submission.project_description ?? "").trim();
  if (description) claims.push(description.slice(0, 300));
  for (const line of String(submission.key_features ?? "").split("\n")) {
    const cleaned = line.trim().replace(/^[-*•\s]+/, "").trim();
    if (cleaned.length > 8) claims.push(cleaned.slice(0, 200));
  }
  return claims.slice(0, 10);
}

function claimListOf(claims: V.ValidatedClaim[]): string[] {
  return claims.map((claim) => claim.claim);
}

/** What the repository actually shows, for a conflict statement. */
function observationFor(claim: V.ValidatedClaim, evidence: E.EvidenceSet): string[] {
  const out: string[] = [];
  for (const id of claim.evidence_ids) {
    const item = evidence.byId.get(id);
    if (item) out.push(`${item.file ?? "repository"}: ${item.claim.slice(0, 160)}`);
  }
  if (out.length) return out;
  return [
    "no file, symbol or dataset in the analysed repository was found that " +
      "demonstrates this behaviour",
  ];
}

function pushConclusions(
  target: ConclusionRow[],
  items: V.ValidatedConclusion[],
  kind: V.SubjectKind,
  method: string,
  reason: string,
  queries: string[],
) {
  for (const item of items) {
    target.push({
      subject_id: item.subject_id,
      kind,
      status: item.status,
      confidence: item.confidence,
      evidence_ids: item.evidence_ids,
      explanation: item.explanation,
      missing_or_unclear: item.missing_or_unclear,
      method,
      files: item.files,
      retrieval_queries: queries,
      relevant_files: [],
      evidence_count: item.evidence_ids.length,
      ai_used: true,
      ai_reason: reason,
    });
  }
}

function deterministicOrdered(
  requirementMap: RequirementMap,
  deterministicRows: Map<string, ConclusionRow>,
  aiRows: ConclusionRow[],
): ConclusionRow[] {
  const out: ConclusionRow[] = [];
  const used = new Set<string>();
  for (const entry of requirementMap.requirements ?? []) {
    const row = deterministicRows.get(entry.id) ?? aiRows.find((item) => item.subject_id === entry.id);
    if (row) {
      out.push(row);
      used.add(entry.id);
    }
  }
  for (const row of aiRows) {
    if (used.has(row.subject_id)) continue;
    out.push(row);
  }
  return out;
}

function retrieveFor(
  concepts: C.ConceptSet[],
  index: RET.RepoIndex,
): RET.RetrievalResult {
  if (!concepts.length) return emptyRetrieval();
  const results = concepts.map((concept, position) =>
    RET.retrieve({ plan: RET.buildRetrievalPlan(`c${position}`, concept), index }),
  );
  return mergeRetrievals(results);
}

function retrieveForBrief(
  concepts: C.ConceptSet[],
  index: RET.RepoIndex,
): RET.RetrievalResult {
  return retrieveFor(concepts, index);
}

function retrieveForText(question: string, index: RET.RepoIndex): RET.RetrievalResult {
  const concept: C.ConceptSet = {
    text: question.slice(0, 600),
    intent: question.slice(0, 300),
    focus: "general",
    phrases: C.nounPhrases(question).slice(0, 8),
    actions: [],
    subjects: C.termsOf(question).slice(0, 10),
    qualifiers: [],
    terms: C.termsOf(question),
    domainTerms: [],
    facets: [],
    artifacts: [],
  };
  return RET.retrieve({ plan: RET.buildRetrievalPlan("context", concept), index });
}

function conceptFromTask(
  planned: P.PlannedTask,
  requirementConcepts: Map<string, C.ConceptSet>,
  context: HackathonContext,
  index: RET.RepoIndex,
): C.ConceptSet[] {
  void context;
  void index;
  const concepts: C.ConceptSet[] = [];
  for (const id of planned.subjectIds) {
    const concept = requirementConcepts.get(id);
    if (concept) concepts.push(concept);
  }
  return concepts;
}

function mergeRetrievals(results: RET.RetrievalResult[]): RET.RetrievalResult {
  const byPath = new Map<string, RET.FileHit>();
  const evidenceIds: string[] = [];
  const datasetPaths: string[] = [];
  const questions: string[] = [];
  const unmatched: string[] = [];
  let considered = 0;

  for (const result of results) {
    considered = Math.max(considered, result.considered);
    for (const question of result.plan.questions) {
      if (questions.length < 6 && !questions.includes(question)) questions.push(question);
    }
    for (const id of result.evidenceIds) {
      if (evidenceIds.length < 40 && !evidenceIds.includes(id)) evidenceIds.push(id);
    }
    for (const path of result.datasetPaths) {
      if (!datasetPaths.includes(path)) datasetPaths.push(path);
    }
    for (const term of result.unmatchedTerms) {
      if (unmatched.length < 10 && !unmatched.includes(term)) unmatched.push(term);
    }
    for (const hit of result.files) {
      const existing = byPath.get(hit.path);
      if (!existing) {
        byPath.set(hit.path, hit);
        continue;
      }
      existing.score += Math.min(hit.score, 20);
      existing.matchedTerms = [...new Set([...existing.matchedTerms, ...hit.matchedTerms])].slice(0, 8);
    }
  }

  const files = [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  return {
    plan: {
      subjectId: results[0]?.plan.subjectId ?? "",
      focus: results[0]?.plan.focus ?? "general",
      terms: [...new Set(results.flatMap((result) => result.plan.terms))].slice(0, 40),
      phrases: [...new Set(results.flatMap((result) => result.plan.phrases))].slice(0, 12),
      artifacts: results[0]?.plan.artifacts ?? [],
      questions,
    },
    files,
    evidenceIds: evidenceIds.slice(0, 24),
    datasetPaths: datasetPaths.slice(0, 6),
    considered,
    truncated: byPath.size > files.length,
    unmatchedTerms: unmatched,
  };
}

function emptyRetrieval(): RET.RetrievalResult {
  return {
    plan: {
      subjectId: "",
      focus: "general",
      terms: [],
      phrases: [],
      artifacts: [],
      questions: [],
    },
    files: [],
    evidenceIds: [],
    datasetPaths: [],
    considered: 0,
    truncated: false,
    unmatchedTerms: [],
  };
}

function promptContext(
  context: HackathonContext,
  input: AnalysisInput,
  index: RET.RepoIndex,
  evidence: E.EvidenceSet,
  retrieval: RET.RetrievalResult,
  projectMap: Record<string, unknown>,
  datasetProfiles: DatasetProfile[],
  semantics: SemanticsResult[],
  inspectionNote: string,
  concepts: C.ConceptSet[],
): M.PromptContext {
  const paths = new Set(retrieval.files.map((hit) => hit.path));
  // Only the evidence that belongs to the retrieved files travels with the
  // requirement. This is the single biggest token saving in the pipeline.
  const scoped: Evidence[] = [];
  for (const path of paths) {
    for (const item of evidence.byFile.get(path) ?? []) {
      scoped.push(item as unknown as Evidence);
    }
  }
  for (const item of evidenceSetGlobal(evidence)) {
    if (scoped.length < 40) scoped.push(item as unknown as Evidence);
  }
  void input;
  void index;

  return {
    context,
    projectMap,
    evidence: scoped,
    terms: retrieval.plan.terms,
    code: RET.renderPacket(retrieval),
    datasetProfiles: datasetProfiles.filter((profile) =>
      retrieval.datasetPaths.includes(profile.path),
    ),
    semantics: semantics.filter((item) => paths.has(item.path)),
    concepts,
    inspectionNote,
  };
}

function evidenceSetGlobal(evidence: E.EvidenceSet): E.RawEvidence[] {
  const out: E.RawEvidence[] = [];
  for (const item of evidence.byId.values()) {
    if (!item.file) out.push(item);
  }
  return out;
}

function countFacts(
  input: AnalysisInput,
  projectMap: Record<string, unknown>,
  index: RET.RepoIndex,
) {
  const symbols = (projectMap.important_files ?? []) as unknown[];
  void symbols;
  const semantics = input.semantics ?? [];
  const routes = input.routes ?? [];
  const files = input.files ?? [];
  const functionCount = countBy(input.chunks, "symbol_type", [
    "function",
    "method",
  ]);
  const classCount = countBy(input.chunks, "symbol_type", ["class", "type"]);
  const datasets = input.datasetProfiles ?? [];
  const fileCount = files.filter((file) => !file.is_ignored).length;
  const testFileCount = Number(
    ((projectMap.testing as Record<string, unknown>)?.test_file_count ?? 0),
  );

  return {
    fileCount,
    sourceFileCount: files.filter(
      (file) =>
        !file.is_ignored &&
        ["source", "component", "api", "model", "schema", "database"].includes(
          String(file.file_category),
        ),
    ).length,
    datasetCount: datasets.length,
    datasetProfileCount: datasets.length,
    functionCount,
    classCount,
    routeCount: routes.length,
    modelFindingCount: semantics.reduce((sum, item) => sum + item.models.length, 0),
    calculationCount: semantics.reduce((sum, item) => sum + item.calculations.length, 0),
    ruleCount: semantics.reduce((sum, item) => sum + item.rules.length, 0),
    dataAccessCount: semantics.reduce((sum, item) => sum + item.dataAccess.length, 0),
    uiFindingCount: semantics.reduce((sum, item) => sum + item.ui.length, 0),
    testFileCount,
    deploymentFileCount: files.filter((file) => file.file_category === "deployment").length,
    secretCount: Number(
      ((projectMap.security as Record<string, unknown>)?.hardcoded_secrets as unknown[])?.length ?? 0,
    ),
    authDetected: Boolean((projectMap.authentication as Record<string, unknown>)?.detected),
    databaseDetected: Boolean((projectMap.database as Record<string, unknown>)?.technologies),
    hasReadme: Boolean((projectMap.readme as Record<string, unknown>)?.present),
    analysisMode: (projectMap.analysis_mode as "full" | "limited") ?? "full",
    stackSummary: stackSummaryOf(projectMap),
    countables: DET.countablesFrom({
      projectMap,
      functionCount,
      classCount,
      routeCount: routes.length,
      datasetCount: datasets.length,
      modelCount: semantics.reduce((sum, item) => sum + item.models.length, 0),
      fileCount,
      calculationCount: semantics.reduce((sum, item) => sum + item.calculations.length, 0),
      testFileCount,
    }),
    index,
  };
}

function countBy(
  rows: Record<string, unknown>[],
  field: string,
  values: string[],
): number {
  return rows.filter((row) => values.includes(String(row[field]))).length;
}

function stackSummaryOf(projectMap: Record<string, unknown>): string {
  const stack = (projectMap.stack ?? {}) as Record<string, unknown>;
  const frameworks = (stack.frameworks as string[]) ?? [];
  const languages = Object.keys((stack.languages as Record<string, number>) ?? {});
  return [...languages.slice(0, 4), ...frameworks.slice(0, 5)].join(" ");
}

/** The hackathon part of the cacheable context block. */
function contextSnapshot(context: HackathonContext): Record<string, unknown> {
  return {
    name: context.name,
    type: context.type,
    version: context.version,
    problem: context.problem.slice(0, 1200),
    theme: context.theme,
    claims: context.claims,
    custom: context.customInstructions?.slice(0, 400) ?? null,
    notes: context.freeformNotes.slice(0, 3),
  };
}

function slimMap(projectMap: Record<string, unknown>): Record<string, unknown> {
  return {
    analysis_mode: projectMap.analysis_mode,
    stack: projectMap.stack,
    database: projectMap.database,
    authentication: projectMap.authentication,
    testing: projectMap.testing,
    deployment: projectMap.deployment,
    repository_stats: projectMap.repository_stats,
    features: projectMap.features,
    warnings: projectMap.warnings,
  };
}

function alignmentQuestions(context: HackathonContext): string[] {
  const source = [
    context.problem,
    context.theme ?? "",
    context.claims.description,
    context.claims.features,
  ].join(" ");
  return C.nounPhrases(source).slice(0, 18);
}

function dedupeFindings(findings: E.ValidatedFinding[]): E.ValidatedFinding[] {
  const seen = new Set<string>();
  const out: E.ValidatedFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.finding_type}|${finding.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out.slice(0, 30);
}

function statusFor(
  conclusions: ConclusionRow[],
  tasks: TaskOutcome[],
  findings: E.ValidatedFinding[],
): string {
  const executed = tasks.filter((task) => task.status === "executed" || task.status === "cached");
  const failed = tasks.filter((task) => task.status === "failed");
  if (executed.length === 0 && findings.length === 0) return "pending";
  if (failed.length > 0 && executed.length === 0) return "failed";
  if (failed.length > 0) return "partial";
  if (conclusions.length > 0) return "completed";
  return "partial";
}

function buildDefenseTargets(
  conclusions: ConclusionRow[],
  findings: E.ValidatedFinding[],
  claims: string[],
): Record<string, unknown>[] {
  const targets: Record<string, unknown>[] = [];

  // P1: an organiser expectation the evidence does not cover.
  for (const row of conclusions) {
    if (row.kind !== "requirement" && row.kind !== "constraint") continue;
    if (row.status !== "not_evidenced" && row.status !== "partial_evidence") continue;
    targets.push({
      topic: `${row.subject_id}: ${row.explanation.slice(0, 240)}`.slice(0, 300),
      reason:
        row.missing_or_unclear.length
          ? `Not established by the analysed repository: ${row.missing_or_unclear.join("; ").slice(0, 400)}`
          : row.explanation.slice(0, 600),
      priority: row.status === "not_evidenced" ? "P1" : "P2",
      evidence_ids: row.evidence_ids.slice(0, 10),
      question_area: row.kind,
      status: "open",
    });
  }

  // P0: a claim the repository does not currently show. This is about the
  // project's own description, never about a person.
  for (const finding of findings) {
    if (finding.finding_type !== "claim_mismatch") continue;
    targets.push({
      topic: finding.title.slice(0, 300),
      reason: (finding.description || finding.why_it_matters).slice(0, 600),
      priority: "P0",
      evidence_ids: finding.evidence_ids.slice(0, 10),
      question_area: "claim_support",
      status: "open",
    });
  }

  // P5: security.
  for (const finding of findings) {
    if (finding.finding_type !== "security_concern") continue;
    targets.push({
      topic: String(finding.title).slice(0, 300),
      reason: (finding.why_it_matters || finding.description).slice(0, 600),
      priority: "P5",
      evidence_ids: finding.evidence_ids.slice(0, 10),
      question_area: "security",
      status: "open",
    });
  }

  void claims;
  return targets.slice(0, 20);
}

// ── Persistence ────────────────────────────────────────────────────────────

async function upsertReview(args: {
  submissionId: string | null;
  repositoryId: string | null;
  context: HackathonContext;
  plan: P.AnalysisPlan;
  alignment: V.ValidatedAlignment | null;
  allConclusions: ConclusionRow[];
  assessment: V.ValidatedAssessment | null;
  architecture: Record<string, unknown> | null;
  implementation: Record<string, unknown> | null;
  engineering: Record<string, unknown>[];
  testing: E.TestingFacts | null;
  spend: Spend;
  commitSha: string | null;
}): Promise<string | null> {
  if (!args.submissionId || !args.repositoryId) return null;
  const service = db();

  const byKind = (kind: V.SubjectKind) =>
    args.allConclusions.filter((row) => row.kind === kind);

  const payload: Record<string, unknown> = {
    submission_id: args.submissionId,
    repository_id: args.repositoryId,
    status: "completed",
    model: null,
    prompt_version: M.PROMPT_VERSIONS.alignment,
    estimated_cost_usd: args.spend.costUsd,
    total_tokens: args.spend.tokens,
    // New, versioned knowledge (§44, §27). Old columns are kept so the existing
    // admin dashboards and the §80 payload keep working.
    analysis_version: "a3",
    hackathon_version: args.context.version,
    scanner_version: null,
    commit_sha: args.commitSha,
    dimensions: args.plan.dimensions,
    requirement_rows: byKind("requirement"),
    constraint_rows: byKind("constraint"),
    outcome_rows: byKind("outcome"),
    criterion_rows: byKind("criterion"),
    assessment: args.assessment,
    engineering: args.engineering,
    diagnostics_summary: {
      calls_planned: args.plan.tasks.length,
      calls_executed: args.spend.calls,
      cache_hits: args.spend.cacheHits,
    },
  };
  if (args.alignment) payload.problem_alignment = args.alignment;
  if (args.architecture) payload.architecture = args.architecture;
  if (args.implementation) payload.implementation = args.implementation;
  if (args.testing) payload.testing = args.testing;

  try {
    const { data: existing } = await service
      .from("project_reviews")
      .select("id")
      .eq("submission_id", args.submissionId)
      .eq("repository_id", args.repositoryId)
      .limit(1);
    const row = (existing ?? [])[0] as { id: string } | undefined;
    if (row) {
      const { error } = await service.from("project_reviews").update(payload).eq("id", row.id);
      if (error) throw error;
      return row.id;
    }
    const { data, error } = await service
      .from("project_reviews")
      .insert(payload)
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("no row");
    return (data as { id: string }).id;
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist review:", error);
    return null;
  }
}

async function replaceRequirementEvaluations(
  submissionId: string | null,
  conclusions: ConclusionRow[],
): Promise<void> {
  if (!submissionId) return;
  const rows = conclusions.map((row) => ({
    submission_id: submissionId,
    requirement_id: row.subject_id,
    status:
      row.kind === "constraint" || row.kind === "criterion" || row.kind === "outcome"
        ? row.status === "evidence_found"
          ? "supported"
          : row.status
        : row.status,
    evidence_ids: row.evidence_ids,
    confidence: row.confidence,
    explanation: row.explanation.slice(0, 2000),
    source: row.ai_used ? "ai" : "deterministic",
    // New columns; written defensively so an un-migrated database still works.
    kind: row.kind,
    method: row.method,
    missing_or_unclear: row.missing_or_unclear,
    retrieval_queries: row.retrieval_queries,
    relevant_files: row.relevant_files,
    evidence_count: row.evidence_count,
    ai_used: row.ai_used,
    ai_reason: row.ai_reason,
  }));

  if (!rows.length) return;
  try {
    const service = db();
    const { data: existing } = await service
      .from("requirement_evaluations")
      .select("id")
      .eq("submission_id", submissionId);
    if ((existing ?? []).length) {
      await service.from("requirement_evaluations").delete().eq("submission_id", submissionId);
    }
    const { error } = await service
      .from("requirement_evaluations")
      .upsert(rows, { onConflict: "submission_id,requirement_id" });
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist evaluations:", error);
  }
}

async function replaceFindings(
  reviewId: string | null,
  findings: E.ValidatedFinding[],
): Promise<void> {
  if (!reviewId) return;
  const rows = findings.map((finding) => ({
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
  }));

  try {
    const service = db();
    await service.from("project_review_findings").delete().eq("project_review_id", reviewId);
    if (rows.length) {
      const { error } = await service.from("project_review_findings").insert(rows);
      if (error) throw error;
    }
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist findings:", error);
  }
}

async function replaceDefenseTargets(
  submissionId: string | null,
  targets: Record<string, unknown>[],
): Promise<void> {
  if (!submissionId) return;
  try {
    const service = db();
    await service.from("defense_targets").delete().eq("submission_id", submissionId);
    if (targets.length) {
      const { error } = await service
        .from("defense_targets")
        .insert(targets.map((target) => ({ submission_id: submissionId, ...target })));
      if (error) throw error;
    }
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist defence targets:", error);
  }
}

/**
 * §27 / §65 — the knowledge store. A snapshot per run keeps the analysis
 * reproducible: a later brief change cannot rewrite what an old run concluded,
 * and a re-analysis can be diffed against it.
 */
async function saveSnapshot(args: {
  submissionId: string | null;
  repositoryId: string | null;
  commitSha: string | null;
  context: HackathonContext;
  plan: P.AnalysisPlan;
  evidence: number;
  allConclusions: ConclusionRow[];
  spend: Spend;
}): Promise<void> {
  if (!args.submissionId || !args.repositoryId) return;
  try {
    const { error } = await db().from("analysis_snapshots").insert({
      submission_id: args.submissionId,
      repository_id: args.repositoryId,
      commit_sha: args.commitSha,
      hackathon_version: args.context.version,
      analysis_version: "a3",
      scanner_version: null,
      prompt_versions: M.PROMPT_VERSIONS,
      plan: {
        summary: args.plan.summary,
        dimensions: args.plan.dimensions,
        tasks: args.plan.tasks.map((task) => ({ key: task.key, scope: task.scope })),
      },
      hackathon_snapshot: args.context.snapshot,
      conclusions: args.allConclusions,
      evidence_count: args.evidence,
      input_tokens: args.spend.inputTokens,
      output_tokens: args.spend.outputTokens,
      cached_tokens: args.spend.cachedTokens,
      estimated_cost_usd: args.spend.costUsd,
    });
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.analysis] could not save snapshot:", error);
  }
}

async function previousEvaluations(
  submissionId: string | null,
): Promise<{ requirement_id: string; status: string; commit_sha: string | null }[]> {
  if (!submissionId) return [];
  try {
    const { data } = await db()
      .from("requirement_evaluations")
      .select("requirement_id, status")
      .eq("submission_id", submissionId);
    void data;
    const { data: snapshots } = await db()
      .from("analysis_snapshots")
      .select("commit_sha")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1);
    const commit = ((snapshots ?? [])[0] as { commit_sha: string } | undefined)?.commit_sha ?? null;
    return ((data ?? []) as { requirement_id: string; status: string }[]).map((row) => ({
      requirement_id: row.requirement_id,
      status: row.status,
      commit_sha: commit,
    }));
  } catch {
    return [];
  }
}

/** §45 — what changed since the last run, shown rather than overwritten. */
function diffAgainst(
  previous: { requirement_id: string; status: string; commit_sha: string | null }[],
  current: ConclusionRow[],
  commitSha: string | null,
): Record<string, unknown> | null {
  if (!previous.length) return null;
  const before = new Map(previous.map((row) => [row.requirement_id, row.status]));
  const changed: { id: string; from: string; to: string }[] = [];
  const added: string[] = [];
  for (const row of current) {
    const prior = before.get(row.subject_id);
    if (prior === undefined) {
      added.push(row.subject_id);
      continue;
    }
    if (prior !== row.status) {
      changed.push({ id: row.subject_id, from: prior, to: row.status });
    }
  }
  const removed = [...before.keys()].filter(
    (id) => !current.some((row) => row.subject_id === id),
  );
  if (!changed.length && !added.length && !removed.length) return null;
  return {
    previous_commit: previous[0]?.commit_sha ?? null,
    commit: commitSha,
    changed,
    added,
    removed,
  };
}

function buildDiagnostics(args: {
  context: HackathonContext;
  plan: P.AnalysisPlan;
  facts: ReturnType<typeof countFacts>;
  allConclusions: ConclusionRow[];
  tasks: TaskOutcome[];
  spend: Spend;
  inspection: { mode: string; warnings: string[]; filesSeen: number; filesRead: number };
  coverage: boolean;
  datasetProfiles: DatasetProfile[];
  evidenceCount: number;
  diff: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    hackathon: {
      name: args.context.name,
      type: args.context.type,
      version: args.context.version,
      config_version: args.context.configVersion,
      requirements: args.context.requirements.length,
      constraints: args.context.constraints.length,
      outcomes: args.context.expectedOutcomes.length,
      criteria: args.context.evaluationCriteria.length,
      requirements_enabled: args.plan.requirementsEnabled,
      requirements_reason: args.plan.requirementsReason,
    },
    repository: {
      files_seen: args.inspection.filesSeen,
      files_read: args.inspection.filesRead,
      source_files: args.facts.sourceFileCount,
      dataset_files: args.facts.datasetCount,
      dataset_profiles: args.datasetProfiles.length,
      functions: args.facts.functionCount,
      classes: args.facts.classCount,
      routes: args.facts.routeCount,
      models: args.facts.modelFindingCount,
      calculations: args.facts.calculationCount,
      rules: args.facts.ruleCount,
      ui_sites: args.facts.uiFindingCount,
      evidence_count: args.evidenceCount,
      analysis_mode: args.inspection.mode,
      fully_inspected: args.coverage,
      warnings: args.inspection.warnings.slice(0, 8),
    },
    ai: {
      calls_planned: args.plan.tasks.length,
      calls_executed: args.spend.calls,
      calls_avoided: args.tasks.filter((task) => task.status === "avoided").length,
      cache_hits: args.spend.cacheHits,
      cache_misses: Math.max(0, args.spend.calls - args.spend.cacheHits),
      input_tokens: args.spend.inputTokens,
      output_tokens: args.spend.outputTokens,
      cached_tokens: args.spend.cachedTokens,
      cost_usd: Number(args.spend.costUsd.toFixed(6)),
      failures: args.spend.failures,
      validation_failures: args.spend.validationFailures,
      repairs: args.spend.repairs,
      tasks: args.tasks,
    },
    dimensions: args.plan.dimensions,
    conclusions: args.allConclusions.map((row) => ({
      id: row.subject_id,
      kind: row.kind,
      status: row.status,
      confidence: row.confidence,
      method: row.method,
      ai_used: row.ai_used,
      ai_reason: row.ai_reason,
      retrieval_queries: row.retrieval_queries,
      relevant_files: row.relevant_files,
      evidence_count: row.evidence_count,
    })),
    diff: args.diff,
  };
}

function failure(
  context: HackathonContext,
  plan: P.AnalysisPlan,
  base: Partial<AnalysisOutcome>,
): AnalysisOutcome {
  return {
    reviewId: null,
    status: "failed",
    context,
    plan,
    conclusions: [],
    findings: [],
    claims: [],
    assessment: null,
    alignment: null,
    architecture: null,
    implementation: null,
    engineering: [],
    testing: null,
    tasks: [],
    diagnostics: { error: base.error ?? "unknown" },
    diff: null,
    totalCostUsd: 0,
    totalTokens: 0,
    error: base.error,
  };
}
