import {
  aiConfigured,
  checkBudget,
  completeJson,
  loadPricing,
  recordUsage,
  settings,
} from "../ai.ts";
import { lookupVerificationCache, storeVerificationCache } from "./cache.ts";
import { V2_PROMPT_VERSION } from "./versions.ts";
import type { EvidencePacket } from "./retrieval.ts";
import type { V2EvidenceItem, V2VerificationVerdict } from "./types.ts";
import { validateVerifierOutput } from "./validate-ai.ts";
import { packetHash, sha256Hex } from "./hash.ts";

const SYSTEM_PROMPT = `You are HackSim's repository verification engine.
Use only supplied evidence.
Never invent files, functions, APIs, behavior, architecture, or runtime behavior.
Technology presence is not proof. Dependencies are not proof. Filenames are not proof.
README claims are not proof. A route is not proof of complete implementation.
Static source code does not prove runtime behavior.
Every conclusion must cite evidence IDs.
If evidence is insufficient, return unable_to_determine and identify missing_links.
Return strict JSON with keys: verdict, confidence, verification_level, summary, supporting_evidence_ids, missing_links, contradictions, additional_files_needed, runtime_verified, verification_complete.`;

export interface VerificationCallResult {
  operation: string;
  subjectIds: string[];
  packet: EvidencePacket;
  verdict: V2VerificationVerdict | null;
  validationErrors: string[];
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  durationMs: number;
  status: string;
  evidenceHash: string;
  cacheKey: string;
}

async function evidenceHash(ids: string[]): Promise<string> {
  return sha256Hex(ids.sort().join(","));
}

export async function buildCacheKey(input: {
  commitSha: string;
  analysisVersion: string;
  operation: string;
  subjectIds: string[];
  evidenceHash: string;
  packetHash: string;
  promptVersion: string;
  model: string;
}): Promise<string> {
  const subjectHash = await sha256Hex(input.subjectIds.join(","));
  return packetHash([
    input.commitSha,
    input.analysisVersion,
    input.operation,
    subjectHash,
    input.evidenceHash,
    input.packetHash,
    input.promptVersion,
    input.model,
  ]);
}

export async function runVerificationGroup(input: {
  operation: string;
  subjectIds: string[];
  subjectLabel: string;
  hackathonContext: string;
  packet: EvidencePacket;
  evidence: V2EvidenceItem[];
  filePaths: Set<string>;
  submissionId: string;
  runId: string;
  commitSha: string;
  scannerVersion: string;
  analysisVersion: string;
  round: number;
  skipAi?: boolean;
}): Promise<VerificationCallResult> {
  const start = Date.now();
  const evHash = await evidenceHash(input.packet.evidenceIds);
  const model = settings().deepseekModel;
  const cacheKey = await buildCacheKey({
    commitSha: input.commitSha,
    analysisVersion: input.analysisVersion,
    operation: input.operation,
    subjectIds: input.subjectIds,
    evidenceHash: evHash,
    packetHash: input.packet.packetHash,
    promptVersion: V2_PROMPT_VERSION,
    model,
  });

  const cached = await lookupVerificationCache(cacheKey);
  if (cached) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: cached,
      validationErrors: [],
      cacheHit: true,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "cache_hit",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  if (input.skipAi || input.packet.evidenceIds.length === 0) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: {
        verdict: "unable_to_determine",
        confidence: "low",
        verification_level: "deterministic_only",
        summary: "Insufficient evidence in packet; AI verification skipped or not required.",
        supporting_evidence_ids: [],
        missing_links: input.packet.evidenceIds.length ? [] : ["implementation_evidence"],
        contradictions: [],
        additional_files_needed: [],
        runtime_verified: false,
        verification_complete: true,
      },
      validationErrors: [],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "skipped",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  if (!aiConfigured()) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: {
        verdict: "unable_to_determine",
        confidence: "low",
        verification_level: "ai_disabled",
        summary: "AI verification is not configured on this deployment.",
        supporting_evidence_ids: [],
        missing_links: ["ai_verification_unavailable"],
        contradictions: [],
        additional_files_needed: [],
        runtime_verified: false,
        verification_complete: false,
      },
      validationErrors: [],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "ai_disabled",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  const pricing = await loadPricing();
  if (!pricing) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: null,
      validationErrors: ["pricing_unavailable"],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "budget_blocked",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  const estimatedInput = input.packet.tokenEstimate;
  const budget = await checkBudget({
    pricing,
    submissionId: input.submissionId,
    estimatedInputTokens: estimatedInput,
    estimatedOutputTokens: 1200,
    cacheRatio: 0.2,
  });
  if (!budget.allowed) {
    await recordUsage({
      operation: `v2_${input.operation}`,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: V2_PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requestId: null,
      status: "rejected",
      durationMs: Date.now() - start,
      submissionId: input.submissionId,
      errorCode: budget.reason,
      errorMessage: budget.reason,
    });
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: {
        verdict: "unable_to_determine",
        confidence: "low",
        verification_level: "budget_exceeded",
        summary: "AI verification was not run because the budget gate rejected the request.",
        supporting_evidence_ids: [],
        missing_links: [budget.reason],
        contradictions: [],
        additional_files_needed: [],
        runtime_verified: false,
        verification_complete: false,
      },
      validationErrors: [],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "budget_exceeded",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  const userPayload = {
    operation: input.operation,
    subjects: input.subjectIds,
    label: input.subjectLabel,
    hackathon_context: input.hackathonContext.slice(0, 4000),
    evidence_snippets: input.packet.snippets,
    graph_summary: input.packet.graphSummary,
    uncertainties: [],
  };

  let raw: Record<string, unknown>;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let requestId: string | null = null;
  try {
    const response = await completeJson({
      systemStable: SYSTEM_PROMPT,
      contextStable: JSON.stringify(userPayload).slice(0, 12000),
      task:
        "Return strict JSON verifying whether supplied evidence supports the subjects. " +
        "Use only evidence IDs provided.",
      promptVersion: V2_PROMPT_VERSION,
      maxOutputTokens: 1800,
    });
    raw = (response.parsed ?? {}) as Record<string, unknown>;
    inputTokens = response.inputTokens;
    outputTokens = response.outputTokens;
    cachedTokens = response.cachedTokens ?? 0;
    requestId = response.requestId;
  } catch (error) {
    await recordUsage({
      operation: `v2_${input.operation}`,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: V2_PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requestId: null,
      status: "failed",
      durationMs: Date.now() - start,
      submissionId: input.submissionId,
      errorCode: "provider_error",
      errorMessage: (error as Error).message,
    });
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: null,
      validationErrors: [(error as Error).message],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "provider_error",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  const validated = validateVerifierOutput(raw, input.evidence, input.filePaths);
  if (!validated.ok || !validated.verdict) {
    await recordUsage({
      operation: `v2_${input.operation}`,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: V2_PROMPT_VERSION,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheMissTokens: Math.max(0, inputTokens - cachedTokens),
      costUsd: budget.estimatedCostUsd,
      requestId,
      status: "failed",
      durationMs: Date.now() - start,
      submissionId: input.submissionId,
      errorCode: "verification_failed",
      errorMessage: validated.errors.join(","),
    });
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: null,
      validationErrors: validated.errors,
      cacheHit: false,
      inputTokens,
      outputTokens,
      cachedTokens,
      durationMs: Date.now() - start,
      status: "verification_failed",
      evidenceHash: evHash,
      cacheKey,
    };
  }

  await storeVerificationCache({
    cacheKey,
    commitSha: input.commitSha,
    analysisVersion: input.analysisVersion,
    scannerVersion: input.scannerVersion,
    promptVersion: V2_PROMPT_VERSION,
    model: pricing.modelName,
    operation: input.operation,
    subjectHash: await sha256Hex(input.subjectIds.join(",")),
    claimHash: "",
    evidenceHash: evHash,
    packetHash: input.packet.packetHash,
    verdict: validated.verdict,
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd: budget.estimatedCostUsd,
  });

  await recordUsage({
    operation: `v2_${input.operation}`,
    provider: pricing.provider,
    model: pricing.modelName,
    promptVersion: V2_PROMPT_VERSION,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheMissTokens: Math.max(0, inputTokens - cachedTokens),
    costUsd: budget.estimatedCostUsd,
    requestId,
    status: "success",
    durationMs: Date.now() - start,
    submissionId: input.submissionId,
  });

  return {
    operation: input.operation,
    subjectIds: input.subjectIds,
    packet: input.packet,
    verdict: validated.verdict,
    validationErrors: [],
    cacheHit: false,
    inputTokens,
    outputTokens,
    cachedTokens,
    durationMs: Date.now() - start,
    status: "completed",
    evidenceHash: evHash,
    cacheKey,
  };
}
