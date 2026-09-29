import { db } from "../http.ts";
import type { V2VerificationVerdict } from "./types.ts";

const svc = () => db();

export async function lookupVerificationCache(
  cacheKey: string,
): Promise<V2VerificationVerdict | null> {
  const { data } = await svc()
    .from("v2_verification_cache")
    .select("validated_result, status")
    .eq("cache_key", cacheKey)
    .eq("status", "success")
    .limit(1);
  const row = (data as { validated_result: V2VerificationVerdict; status: string }[] | null)?.[0];
  if (!row?.validated_result) return null;
  return row.validated_result;
}

export async function storeVerificationCache(input: {
  cacheKey: string;
  commitSha: string;
  analysisVersion: string;
  scannerVersion: string;
  promptVersion: string;
  model: string;
  operation: string;
  subjectHash: string;
  claimHash: string;
  evidenceHash: string;
  packetHash: string;
  verdict: V2VerificationVerdict;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}): Promise<void> {
  await svc().from("v2_verification_cache").upsert({
    cache_key: input.cacheKey,
    commit_sha: input.commitSha,
    analysis_version: input.analysisVersion,
    scanner_version: input.scannerVersion,
    prompt_version: input.promptVersion,
    model: input.model,
    operation: input.operation,
    subject_hash: input.subjectHash,
    claim_hash: input.claimHash,
    evidence_hash: input.evidenceHash,
    packet_hash: input.packetHash,
    validated_result: input.verdict,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cached_tokens: input.cachedTokens,
    estimated_cost_usd: input.costUsd,
    status: "success",
  }, { onConflict: "cache_key" });
}
