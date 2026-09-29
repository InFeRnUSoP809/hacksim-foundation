import { aiConfigured, completeJson } from "../ai.ts";
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
}

async function evidenceHash(ids: string[]): Promise<string> {
  return sha256Hex(ids.sort().join(","));
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
  round: number;
  cacheLookup?: (key: string) => Promise<V2VerificationVerdict | null>;
  cacheStore?: (key: string, verdict: V2VerificationVerdict) => Promise<void>;
}): Promise<VerificationCallResult> {
  const start = Date.now();
  const evHash = await evidenceHash(input.packet.evidenceIds);
  const cacheKey = await packetHash([
    input.runId,
    input.operation,
    input.subjectIds.join(","),
    evHash,
    input.packet.packetHash,
    V2_PROMPT_VERSION,
  ]);

  if (input.cacheLookup) {
    const cached = await input.cacheLookup(cacheKey);
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
      };
    }
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
  try {
    const response = await completeJson({
      systemStable: SYSTEM_PROMPT,
      contextStable: JSON.stringify(userPayload).slice(0, 12000),
      task:
        "Return strict JSON verifying whether supplied evidence supports the subjects. " +
        "Use only evidence IDs provided. Schema: verdict, confidence, verification_level, summary, " +
        "supporting_evidence_ids, missing_links, contradictions, additional_files_needed, " +
        "runtime_verified, verification_complete.",
      promptVersion: V2_PROMPT_VERSION,
      maxOutputTokens: 1800,
    });
    raw = (response.parsed ?? {}) as Record<string, unknown>;
    inputTokens = response.inputTokens;
    outputTokens = response.outputTokens;
    cachedTokens = response.cachedTokens ?? 0;
  } catch (error) {
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
    };
  }

  const validated = validateVerifierOutput(raw, input.evidence, input.filePaths);
  if (!validated.ok || !validated.verdict) {
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
    };
  }

  if (input.cacheStore) await input.cacheStore(cacheKey, validated.verdict);

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
  };
}
