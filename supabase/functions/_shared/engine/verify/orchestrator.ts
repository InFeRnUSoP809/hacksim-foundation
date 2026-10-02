/**

 * HackSim Analysis Engine v1 — adaptive multi-group verification.

 */



import {

  aiConfigured,

  calculateCost,

  checkBudget,

  completeJson,

  loadPricing,

  recordUsage,

} from "../../ai.ts";

import { buildHackathonContext } from "../../context.ts";

import { buildEvidenceSet, validateFindings } from "../../evidence.ts";

import { getRequirementMap } from "../../requirements.ts";

import { loadMembers } from "../../http.ts";

import { asRawEvidence, repairPrompt } from "../../validate.ts";

import {

  ENGINE_VERIFY_PROMPTS,

  HACKSIM_ENGINE_ID,

  MAX_VERIFICATION_ROUNDS,

  type EngineVerifyTaskKind,

} from "../constants.ts";

import {

  VERIFICATION_SYSTEM_PROMPT,

  buildBriefVerificationPrompt,

  buildClaimsVerificationPrompt,

  buildEngineeringVerificationPrompt,

  buildImplementationVerificationPrompt,

} from "../prompts/verification.ts";

import { loadExistingEngineReview, persistEngineReview } from "../persistence/review.ts";

import { saveEngineSnapshot } from "../persistence/snapshot.ts";

import {

  fingerprintEvidence,

  fingerprintWorkflows,

  loadCachedVerification,

  storeCachedVerification,

  verificationContextHash,

} from "./cache.ts";

import {

  buildSharedVerifyContext,

  buildKnownFileSet,

  packetForTask,

} from "./context.ts";

import {

  buildRepoIndex,

  filterAdditionalFiles,

  mergeSnippet,

  retrieveForVerification,

} from "./retrieval.ts";

import {

  normalizeVerifyTaskName,

  planVerificationTasks,

  type VerificationTaskPlan,

} from "./tasks.ts";

import {

  validateBriefVerification,

  validateEngineeringVerification,

  validateImplementationVerification,

  validateMemberClaimsVerification,

} from "./validation.ts";



export interface EngineVerifyInput {

  submission: Record<string, unknown>;

  hackathon: Record<string, unknown>;

  repository: Record<string, unknown>;

  files: Record<string, unknown>[];

  chunks: Record<string, unknown>[];

  evidence: Record<string, unknown>[];

  projectMap: Record<string, unknown>;

  actorId?: string | null;

  sessionId?: string | null;

  onlyTasks?: EngineVerifyTaskKind[] | null;

}



export interface VerificationTaskRecord {

  kind: EngineVerifyTaskKind;

  status: "executed" | "cached" | "skipped" | "failed";

  prompt_version: string;

  input_tokens: number;

  output_tokens: number;

  cached_tokens: number;

  cost_usd: number;

  verdict: string | null;

  confidence: string | null;

  verification_level: string | null;

  evidence_count: number;

  missing_links: string[];

  validation_errors: string[];

  rounds: number;

}



export interface EngineVerifyOutcome {
  engineId: typeof HACKSIM_ENGINE_ID;
  reviewId: string | null;
  status: string;
  runCostUsd: number;
  runTokens: number;
  cumulativeCostUsd: number;
  cumulativeTokens: number;
  /** This invocation only (alias). */
  totalCostUsd: number;
  totalTokens: number;
  verificationTasks: VerificationTaskRecord[];
}



function teamClaimsFromSubmission(submission: Record<string, unknown>): string[] {

  const out: string[] = [];

  const desc = String(submission.project_description ?? submission.description ?? "").trim();

  if (desc.length > 20) out.push(desc.slice(0, 500));

  const features = submission.features ?? submission.claimed_features;

  if (typeof features === "string" && features.trim()) out.push(features.trim().slice(0, 400));

  if (Array.isArray(features)) {

    for (const f of features.slice(0, 8)) out.push(String(f).slice(0, 200));

  }

  return out.slice(0, 10);

}



async function runTaskAi(input: {

  taskKind: EngineVerifyTaskKind;

  promptVersion: string;

  taskPrompt: string;

  contextStable: string;

  submissionId: string;

  repositoryId: string;

  commitSha: string;

  ctxHash: string;

  pricing: NonNullable<Awaited<ReturnType<typeof loadPricing>>>;

  maxOutputTokens?: number;

}): Promise<{

  parsed: Record<string, unknown>;

  inputTokens: number;

  outputTokens: number;

  cachedTokens: number;

  cacheMissTokens: number;

  costUsd: number;

  model: string;

  fromCache: boolean;

}> {

  const cached = await loadCachedVerification({

    repositoryId: input.repositoryId,

    taskKind: input.taskKind,

    promptVersion: input.promptVersion,

    model: input.pricing.model,

    ctxHash: input.ctxHash,

  });

  if (cached) {

    return {

      parsed: cached,

      inputTokens: 0,

      outputTokens: 0,

      cachedTokens: 0,

      cacheMissTokens: 0,

      costUsd: 0,

      model: input.pricing.model,

      fromCache: true,

    };

  }



  const budget = await checkBudget({

    pricing: input.pricing,

    submissionId: input.submissionId,

    estimatedInputTokens: 7000,

    estimatedOutputTokens: 2200,

  });

  if (!budget.allowed) {

    throw new Error(`AI budget blocked: ${budget.reason}`);

  }



  const response = await completeJson({

    systemStable: VERIFICATION_SYSTEM_PROMPT,

    contextStable: input.contextStable,

    task: input.taskPrompt,

    promptVersion: input.promptVersion,

    maxOutputTokens: Math.min(

      input.pricing.maxOutputTokens,

      input.maxOutputTokens ?? 3500,

    ),

  });



  const costUsd = calculateCost(

    input.pricing,

    response.inputTokens,

    response.outputTokens,

    response.cachedTokens,

  );



  await recordUsage({

    submissionId: input.submissionId,

    userId: null,

    operation: `engine_${input.taskKind}_verification`,

    provider: input.pricing.provider,

    model: response.model,

    promptVersion: input.promptVersion,

    status: "success",

    inputTokens: response.inputTokens,

    outputTokens: response.outputTokens,

    cachedTokens: response.cachedTokens,

    cacheMissTokens: response.cacheMissTokens,

    costUsd,

    requestId: response.requestId,

    durationMs: response.durationMs,

  });



  const parsed = (response.parsed ?? {}) as Record<string, unknown>;

  await storeCachedVerification({

    repositoryId: input.repositoryId,

    submissionId: input.submissionId,

    taskKind: input.taskKind,

    promptVersion: input.promptVersion,

    model: response.model,

    ctxHash: input.ctxHash,

    pricing: input.pricing,

    parsed,

    inputTokens: response.inputTokens,

    outputTokens: response.outputTokens,

    cachedTokens: response.cachedTokens,

    cacheMissTokens: response.cacheMissTokens,

    costUsd,

  });



  return {

    parsed,

    inputTokens: response.inputTokens,

    outputTokens: response.outputTokens,

    cachedTokens: response.cachedTokens,

    cacheMissTokens: response.cacheMissTokens,

    costUsd,

    model: response.model,

    fromCache: false,

  };

}



export async function runEngineVerification(

  input: EngineVerifyInput,

): Promise<EngineVerifyOutcome> {

  if (!aiConfigured()) {

    throw new Error("DeepSeek is not configured.");

  }



  const submissionId = String(input.submission.id ?? "");

  const repositoryId = String(input.repository.id ?? input.repository.repository_id ?? "");

  const commitSha = String(input.repository.analyzed_commit_sha ?? "");



  const requirementMap = await getRequirementMap(String(input.hackathon.id ?? ""), input.hackathon);

  const context = await buildHackathonContext(input.hackathon, requirementMap, input.submission);

  const evidenceSet = buildEvidenceSet(asRawEvidence(input.evidence as never));

  const evidenceIds = [...evidenceSet.byId.keys()];



  const relationships = ((input.projectMap.graph as { relationships?: unknown[] })?.relationships ??

    []) as { from_file: string; to_file: string; relation: string }[];



  const index = buildRepoIndex({

    files: input.files as { path: string; importance?: string; file_category?: string }[],

    chunks: input.chunks as { file_path?: string; path?: string; content?: string }[],

    evidence: input.evidence as { id: string; type: string; claim: string; file?: string }[],

    relationships,

  });

  const knownFiles = buildKnownFileSet(index);



  const workflows = (input.projectMap.implementation_workflows ?? []) as { id: string; files?: string[] }[];

  const workflowFiles = workflows.flatMap((w) => w.files ?? []).slice(0, 12);

  const terms = (requirementMap.requirements ?? []).flatMap((r) => r.text.split(/\s+/)).slice(0, 40);

  let retrieval = retrieveForVerification(index, terms, workflowFiles);



  const hackathonBlock = [

    context.problem,

    context.requirements.map((r) => r.text).join("\n"),

    context.claims.description,

    context.claims.features,

  ]

    .filter(Boolean)

    .join("\n\n");



  let shared = buildSharedVerifyContext({

    hackathonBlock,

    evidenceSet,

    projectMap: input.projectMap,

    codeSnippet: retrieval.snippet,

  });



  const members = await loadMembers(submissionId);

  const hasBriefContext = Boolean(
    context.problem?.trim() ||
      context.claims.description?.trim() ||
      context.claims.features?.trim() ||
      (requirementMap.requirements ?? []).length ||
      (requirementMap.constraints ?? []).length ||
      (requirementMap.expected_outcomes ?? []).length ||
      (requirementMap.evaluation_criteria ?? []).length,
  );

  const partialRetry = Boolean(input.onlyTasks?.length);

  const plan = planVerificationTasks({
    projectMap: input.projectMap,
    requirementCount: (requirementMap.requirements ?? []).length,
    constraintCount: (requirementMap.constraints ?? []).length,
    outcomeCount: (requirementMap.expected_outcomes ?? []).length,
    criterionCount: (requirementMap.evaluation_criteria ?? []).length,
    hasBriefContext,
    memberCount: members.filter((m) => (m.contribution_description ?? "").trim().length > 8).length,
    onlyTasks: input.onlyTasks ?? null,
  });



  const pricing = await loadPricing();

  if (!pricing) throw new Error("AI pricing is not configured.");



  const taskRecords: VerificationTaskRecord[] = [];

  const existing = partialRetry
    ? await loadExistingEngineReview(submissionId, repositoryId)
    : null;

  let briefBundle = existing?.brief ?? validateBriefVerification({}, evidenceSet, {
    requirements: (requirementMap.requirements ?? []).map((r) => r.id),
    constraints: (requirementMap.constraints ?? []).map((r) => r.id),
    outcomes: (requirementMap.expected_outcomes ?? []).map((r) => r.id),
    criteria: (requirementMap.evaluation_criteria ?? []).map((r) => r.id),
  });

  let implementationResult: ReturnType<typeof validateImplementationVerification> | null =
    existing?.implementation ?? null;

  let engineeringResult: ReturnType<typeof validateEngineeringVerification> | null =
    existing?.engineering ?? null;

  let claimsResult: ReturnType<typeof validateMemberClaimsVerification> | null =
    existing?.claims ?? null;

  const priorTasks: VerificationTaskRecord[] = existing?.verificationTasks ?? [];
  const priorFindings: ReturnType<typeof validateFindings> = existing?.findings ?? [];

  const allFindings: ReturnType<typeof validateFindings> = [];
  let runCostUsd = 0;
  let runTokens = 0;



  const reqFingerprint = [

    ...(requirementMap.requirements ?? []).map((r) => r.id),

    ...(requirementMap.constraints ?? []).map((r) => r.id),

  ].join(",");



  for (const planned of plan) {

    if (!planned.useAi && planned.kind !== "brief") {

      taskRecords.push({

        kind: planned.kind,

        status: "skipped",

        prompt_version: ENGINE_VERIFY_PROMPTS[planned.kind],

        input_tokens: 0,

        output_tokens: 0,

        cached_tokens: 0,

        cost_usd: 0,

        verdict: null,

        confidence: null,

        verification_level: null,

        evidence_count: evidenceIds.length,

        missing_links: [],

        validation_errors: [planned.reason],

        rounds: 0,

      });

      continue;

    }



    try {

      const outcome = await executePlannedTask({

        planned,

        input,

        submissionId,

        repositoryId,

        commitSha,

        requirementMap,

        context,

        evidenceSet,

        evidenceIds,

        index,

        knownFiles,

        shared,

        retrieval,

        pricing,

        reqFingerprint,

        workflows,

        members,

        teamClaims: teamClaimsFromSubmission(input.submission),

      });



      runCostUsd += outcome.costUsd;
      runTokens += outcome.inputTokens + outcome.outputTokens;

      taskRecords.push(outcome.record);



      if (outcome.brief) briefBundle = outcome.brief;

      if (outcome.implementation) implementationResult = outcome.implementation;

      if (outcome.engineering) engineeringResult = outcome.engineering;

      if (outcome.claims) claimsResult = outcome.claims;

      if (outcome.findings?.length) allFindings.push(...outcome.findings);

      if (outcome.extraSnippet) {

        retrieval = {

          paths: [...new Set([...retrieval.paths, ...outcome.extraPaths])],

          snippet: outcome.extraSnippet,

        };

        shared = buildSharedVerifyContext({

          hackathonBlock,

          evidenceSet,

          projectMap: input.projectMap,

          codeSnippet: retrieval.snippet,

        });

      }

    } catch (error) {

      taskRecords.push({

        kind: planned.kind,

        status: "failed",

        prompt_version: ENGINE_VERIFY_PROMPTS[planned.kind],

        input_tokens: 0,

        output_tokens: 0,

        cached_tokens: 0,

        cost_usd: 0,

        verdict: null,

        confidence: null,

        verification_level: null,

        evidence_count: evidenceIds.length,

        missing_links: [],

        validation_errors: [(error as Error).message],

        rounds: 0,

      });

    }

  }



  const mergedTasks = [...priorTasks.filter((t) => !taskRecords.some((n) => n.kind === t.kind)), ...taskRecords];

  const cumulativeCostUsd = partialRetry
    ? (existing?.cumulativeCostUsd ?? 0) + runCostUsd
    : runCostUsd;
  const cumulativeTokens = partialRetry
    ? (existing?.cumulativeTokens ?? 0) + runTokens
    : runTokens;

  const reviewId = await persistEngineReview({
    submissionId,
    repositoryId,
    commitSha,
    contextVersion: context.version,
    alignment: briefBundle.alignment,
    requirements: briefBundle.requirements,
    constraints: briefBundle.constraints,
    outcomes: briefBundle.outcomes,
    criteria: briefBundle.criteria,
    findings: allFindings.slice(0, 24),
    findingsMode: partialRetry ? "merge" : "replace_all",
    priorFindings: partialRetry ? priorFindings : [],
    runCostUsd,
    runTokens,
    cumulativeCostUsd,
    cumulativeTokens,
    lastRunMeta: {
      at: new Date().toISOString(),
      tasks: taskRecords.map((t) => t.kind),
      run_cost_usd: runCostUsd,
      run_tokens: runTokens,
    },
    engineId: HACKSIM_ENGINE_ID,
    implementation: implementationResult,
    engineering: engineeringResult,
    claims: claimsResult,
    verificationTasks: mergedTasks,
  });

  await saveEngineSnapshot({
    submissionId,
    repositoryId,
    commitSha,
    contextVersion: context.version,
    plan: plan.map((p) => ({ kind: p.kind, reason: p.reason, useAi: p.useAi })),
    taskRecords: mergedTasks,
    evidenceCount: evidenceIds.length,
    totalCostUsd: runCostUsd,
    totalTokens: runTokens,
  });

  return {
    engineId: HACKSIM_ENGINE_ID,
    reviewId,
    status: "completed",
    runCostUsd,
    runTokens,
    cumulativeCostUsd,
    cumulativeTokens,
    totalCostUsd: runCostUsd,
    totalTokens: runTokens,
    verificationTasks: mergedTasks,
  };

}



async function executePlannedTask(args: {

  planned: VerificationTaskPlan;

  input: EngineVerifyInput;

  submissionId: string;

  repositoryId: string;

  commitSha: string;

  requirementMap: Awaited<ReturnType<typeof getRequirementMap>>;

  context: Awaited<ReturnType<typeof buildHackathonContext>>;

  evidenceSet: ReturnType<typeof buildEvidenceSet>;

  evidenceIds: string[];

  index: ReturnType<typeof buildRepoIndex>;

  knownFiles: Set<string>;

  shared: ReturnType<typeof buildSharedVerifyContext>;

  retrieval: { paths: string[]; snippet: string };

  pricing: NonNullable<Awaited<ReturnType<typeof loadPricing>>>;

  reqFingerprint: string;

  workflows: { id: string }[];

  members: Awaited<ReturnType<typeof loadMembers>>;

  teamClaims: string[];

}): Promise<{

  record: VerificationTaskRecord;

  costUsd: number;

  inputTokens: number;

  outputTokens: number;

  brief?: ReturnType<typeof validateBriefVerification>;

  implementation?: ReturnType<typeof validateImplementationVerification>;

  engineering?: ReturnType<typeof validateEngineeringVerification>;

  claims?: ReturnType<typeof validateMemberClaimsVerification>;

  findings?: ReturnType<typeof validateFindings>;

  extraSnippet?: string;

  extraPaths?: string[];

}> {

  const kind = args.planned.kind;

  const promptVersion = ENGINE_VERIFY_PROMPTS[kind];

  let codeBlock = args.retrieval.snippet;

  let extraPaths: string[] = [];

  let rounds = 0;

  let totalCost = 0;

  let inTok = 0;

  let outTok = 0;

  let cachedTok = 0;

  let parsed: Record<string, unknown> = {};

  let fromCache = false;



  const ctxHash = verificationContextHash({

    commitSha: args.commitSha,

    taskKind: kind,

    promptVersion,

    model: args.pricing.model,

    evidenceFingerprint: fingerprintEvidence(args.evidenceIds),

    workflowFingerprint: fingerprintWorkflows(args.workflows),

    requirementFingerprint: args.reqFingerprint,

    extraPaths: codeBlock.slice(0, 200).split("\n").filter(Boolean).slice(0, 3),

  });



  const contextStable = JSON.stringify({

    engine: HACKSIM_ENGINE_ID,

    commit_sha: args.commitSha,

    task: kind,

    evidence_count: args.evidenceIds.length,

  }).slice(0, 8000);



  let taskPrompt = "";

  if (kind === "brief") {

    taskPrompt = buildBriefVerificationPrompt({

      hackathonBlock: args.shared.hackathonBlock,

      requirements: (args.requirementMap.requirements ?? []).map((r) => ({

        id: r.id,

        text: r.text,

      })),

      constraints: (args.requirementMap.constraints ?? []).map((r) => ({

        id: r.id,

        text: r.text,

      })),

      outcomes: (args.requirementMap.expected_outcomes ?? []).map((r) => ({

        id: r.id,

        text: r.text,

      })),

      criteria: (args.requirementMap.evaluation_criteria ?? []).map((r) => ({

        id: r.id,

        text: r.text,

      })),

      evidenceBlock: args.shared.evidenceBlock,

      codeBlock,

      flowsBlock: args.shared.flowsBlock,

    });

  } else if (kind === "implementation") {

    taskPrompt = buildImplementationVerificationPrompt({

      contextPacket: packetForTask("implementation", args.shared),

      teamClaims: args.teamClaims,

    });

  } else if (kind === "engineering") {

    taskPrompt = buildEngineeringVerificationPrompt({

      contextPacket: packetForTask("engineering", args.shared),

    });

  } else if (kind === "claims") {

    taskPrompt = buildClaimsVerificationPrompt({

      contextPacket: packetForTask("claims", args.shared),

      members: args.members

        .filter((m) => (m.contribution_description ?? "").trim().length > 8)

        .map((m) => ({

          member_id: m.id,

          name: m.full_name ?? m.email ?? "member",

          contribution: String(m.contribution_description ?? ""),

          areas: m.contribution_areas ?? [],

        })),

    });

  }



  for (rounds = 1; rounds <= MAX_VERIFICATION_ROUNDS; rounds++) {

    const ai = await runTaskAi({

      taskKind: kind,

      promptVersion,

      taskPrompt,

      contextStable,

      submissionId: args.submissionId,

      repositoryId: args.repositoryId,

      commitSha: args.commitSha,

      ctxHash: rounds === 1

        ? ctxHash

        : verificationContextHash({

          commitSha: args.commitSha,

          taskKind: kind,

          promptVersion: `${promptVersion}-r${rounds}`,

          model: args.pricing.model,

          evidenceFingerprint: fingerprintEvidence(args.evidenceIds),

          workflowFingerprint: fingerprintWorkflows(args.workflows),

          requirementFingerprint: args.reqFingerprint,

          extraPaths,

        }),

      pricing: args.pricing,

    });

    parsed = ai.parsed;

    totalCost += ai.costUsd;

    inTok += ai.inputTokens;

    outTok += ai.outputTokens;

    cachedTok += ai.cachedTokens;

    fromCache = ai.fromCache;



    const additional = Array.isArray(parsed.additional_files_needed)

      ? (parsed.additional_files_needed as unknown[]).map(String)

      : [];

    const { accepted } = filterAdditionalFiles(additional, args.knownFiles);

    if (rounds < MAX_VERIFICATION_ROUNDS && accepted.length > 0 && !fromCache) {

      extraPaths = accepted;

      codeBlock = mergeSnippet(args.index, accepted, codeBlock);

      taskPrompt = repairPrompt(taskPrompt, [

        `Retrieve and use these additional indexed files: ${accepted.join(", ")}`,

      ]);

      continue;

    }

    break;

  }



  let brief: ReturnType<typeof validateBriefVerification> | undefined;

  let implementation: ReturnType<typeof validateImplementationVerification> | undefined;

  let engineering: ReturnType<typeof validateEngineeringVerification> | undefined;

  let claims: ReturnType<typeof validateMemberClaimsVerification> | undefined;

  let findings: ReturnType<typeof validateFindings> | undefined;

  const validationErrors: string[] = [];



  if (kind === "brief") {

    brief = validateBriefVerification(parsed, args.evidenceSet, {

      requirements: (args.requirementMap.requirements ?? []).map((r) => r.id),

      constraints: (args.requirementMap.constraints ?? []).map((r) => r.id),

      outcomes: (args.requirementMap.expected_outcomes ?? []).map((r) => r.id),

      criteria: (args.requirementMap.evaluation_criteria ?? []).map((r) => r.id),

    });

    findings = validateFindings(parsed.findings ?? null, args.evidenceSet, "hackathon");

    validationErrors.push(...brief.errors);

  } else if (kind === "implementation") {

    implementation = validateImplementationVerification(

      parsed,

      args.evidenceSet,

      args.input.projectMap,

      args.knownFiles,

    );

    findings = implementation.findings;

    validationErrors.push(...implementation.errors);

  } else if (kind === "engineering") {

    engineering = validateEngineeringVerification(parsed, args.evidenceSet, args.knownFiles);

    findings = engineering.findings;

    validationErrors.push(...engineering.errors);

  } else if (kind === "claims") {

    claims = validateMemberClaimsVerification(

      parsed,

      args.evidenceSet,

      args.members.map((m) => m.id),

    );

    validationErrors.push(...claims.errors);

  }



  const record: VerificationTaskRecord = {

    kind,

    status: fromCache ? "cached" : "executed",

    prompt_version: promptVersion,

    input_tokens: inTok,

    output_tokens: outTok,

    cached_tokens: cachedTok,

    cost_usd: totalCost,

    verdict: kind === "implementation"

      ? (implementation?.verdict ?? null)

      : kind === "brief"

      ? (brief?.alignment?.status ?? null)

      : null,

    confidence: kind === "implementation" ? (implementation?.confidence ?? null) : null,

    verification_level: implementation?.verification_level ?? null,

    evidence_count: args.evidenceIds.length,

    missing_links: implementation?.missing_links ?? [],

    validation_errors: validationErrors.slice(0, 8),

    rounds,

  };



  return {

    record,

    costUsd: totalCost,

    inputTokens: inTok,

    outputTokens: outTok,

    brief,

    implementation,

    engineering,

    claims,

    findings,

    extraSnippet: extraPaths.length ? codeBlock : undefined,

    extraPaths: extraPaths.length ? extraPaths : undefined,

  };

}



export { normalizeVerifyTaskName };


