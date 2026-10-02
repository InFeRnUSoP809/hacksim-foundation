/**
 * Verification result cache (ai_analyses).
 */

import {
  contextHash,
  findCachedAnalysis,
  saveAnalysis,
} from "../../ai.ts";
import {
  ENGINE_SCAN_VERSION,
  HACKSIM_ENGINE_ID,
  type EngineVerifyTaskKind,
} from "../constants.ts";

export function verificationContextHash(input: {
  commitSha: string;
  taskKind: EngineVerifyTaskKind;
  promptVersion: string;
  model: string;
  evidenceFingerprint: string;
  workflowFingerprint: string;
  requirementFingerprint: string;
  extraPaths: string[];
}): string {
  return contextHash(
    [
      HACKSIM_ENGINE_ID,
      ENGINE_SCAN_VERSION,
      input.commitSha,
      input.taskKind,
      input.evidenceFingerprint,
      input.workflowFingerprint,
      input.requirementFingerprint,
      input.extraPaths.sort().join("|"),
    ],
    input.promptVersion,
    input.model,
  );
}

export function fingerprintEvidence(ids: string[]): string {
  return ids.sort().slice(0, 80).join(",");
}

export function fingerprintWorkflows(workflows: { id: string }[]): string {
  return workflows.map((w) => w.id).sort().join(",");
}

export async function loadCachedVerification(input: {
  repositoryId: string;
  taskKind: EngineVerifyTaskKind;
  promptVersion: string;
  model: string;
  ctxHash: string;
}): Promise<Record<string, unknown> | null> {
  const row = await findCachedAnalysis({
    repositoryId: input.repositoryId,
    analysisType: `engine_verify_${input.taskKind}`,
    promptVersion: input.promptVersion,
    model: input.model,
    ctxHash: input.ctxHash,
  });
  const result = row?.result;
  return result && typeof result === "object" ? (result as Record<string, unknown>) : null;
}

export async function storeCachedVerification(input: {
  repositoryId: string;
  submissionId: string;
  taskKind: EngineVerifyTaskKind;
  promptVersion: string;
  model: string;
  ctxHash: string;
  pricing: { provider: string };
  parsed: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  costUsd: number;
}): Promise<void> {
  await saveAnalysis({
    repositoryId: input.repositoryId,
    submissionId: input.submissionId,
    analysisType: `engine_verify_${input.taskKind}`,
    scopeKey: input.taskKind,
    provider: input.pricing.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    ctxHash: input.ctxHash,
    status: "success",
    resultPayload: input.parsed,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.inputTokens + input.outputTokens,
    cachedTokens: input.cachedTokens,
    cacheMissTokens: input.cacheMissTokens,
    costUsd: input.costUsd,
    completedAt: new Date().toISOString(),
  });
}
