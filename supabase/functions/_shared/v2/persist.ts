import { db } from "../http.ts";
import type {
  RequirementLinkRow,
} from "./requirement-map.ts";
import type { VerificationCallResult } from "./verifier.ts";
import type {
  V2EngineContext,
  V2EvidenceItem,
  V2FeatureCandidate,
  V2FileRecord,
  V2Relationship,
  V2SymbolRecord,
} from "./types.ts";

const service = () => db();

export async function createAnalysisRun(input: {
  submissionId: string;
  commitSha: string;
  owner: string;
  repoName: string;
  defaultBranch: string;
  normalizedUrl: string;
  repositoryId: string | null;
  scannerVersion: string;
  analysisVersion: string;
  promptVersion: string;
}): Promise<string> {
  const { data, error } = await service()
    .from("analysis_runs")
    .insert({
      submission_id: input.submissionId,
      repository_id: input.repositoryId,
      commit_sha: input.commitSha,
      normalized_repo_url: input.normalizedUrl,
      owner: input.owner,
      repo_name: input.repoName,
      default_branch: input.defaultBranch,
      scanner_version: input.scannerVersion,
      analysis_version: input.analysisVersion,
      prompt_version: input.promptVersion,
      status: "queued",
      progress_stage: "queued",
      progress_percent: 0,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error("Could not create analysis run.");
  const runId = (data as { id: string }).id;
  await service().from("submissions").update({ latest_analysis_run_id: runId }).eq("id", input.submissionId);
  return runId;
}

export async function findCachedRun(
  submissionId: string,
  commitSha: string,
  scannerVersion: string,
  analysisVersion: string,
): Promise<string | null> {
  const { data } = await service()
    .from("analysis_runs")
    .select("id")
    .eq("submission_id", submissionId)
    .eq("commit_sha", commitSha)
    .eq("scanner_version", scannerVersion)
    .eq("analysis_version", analysisVersion)
    .in("status", ["completed", "partial"])
    .limit(1);
  return (data as { id: string }[] | null)?.[0]?.id ?? null;
}

export async function updateRunStatus(
  runId: string,
  status: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await service().from("analysis_runs").update({
    status,
    progress_stage: status,
    updated_at: new Date().toISOString(),
    ...(extra ?? {}),
  }).eq("id", runId);
}

export async function logStage(runId: string, stage: string, message?: string, metrics?: Record<string, unknown>): Promise<void> {
  await service().from("v2_analysis_stage_events").insert({
    analysis_run_id: runId,
    stage,
    message: message ?? null,
    metrics: metrics ?? {},
  });
}

export async function persistSnapshot(
  runId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await service().from("repository_snapshots").upsert({
    analysis_run_id: runId,
    normalized_url: String(meta.normalized_url ?? ""),
    owner: String(meta.owner ?? ""),
    repo_name: String(meta.repo_name ?? ""),
    default_branch: meta.default_branch as string | null,
    commit_sha: String(meta.commit_sha ?? ""),
    is_private: meta.is_private as boolean | null,
    primary_language: meta.primary_language as string | null,
    file_count: Number(meta.file_count ?? 0),
    metadata: meta,
    completed_at: new Date().toISOString(),
  }, { onConflict: "analysis_run_id" });
}

export async function persistEngineArtifacts(
  runId: string,
  ctx: {
    files: V2FileRecord[];
    symbols: V2SymbolRecord[];
    relationships: V2Relationship[];
    evidence: V2EvidenceItem[];
    features: V2FeatureCandidate[];
    chains: { chainKey: string; name: string; orderedEvidenceIds: string[]; featureKey?: string }[];
    requirements: RequirementLinkRow[];
    claims: { claimText: string; status: string; confidence: string; explanation: string; evidenceIds: string[]; chainKeys: string[] }[];
    verificationResults: VerificationCallResult[];
    coverage: Record<string, number>;
    summary: Record<string, unknown>;
    filesSentToAi: number;
  },
): Promise<void> {
  const svc = service();
  await svc.from("v2_repository_files").delete().eq("analysis_run_id", runId);
  await svc.from("v2_evidence_items").delete().eq("analysis_run_id", runId);
  await svc.from("v2_repository_symbols").delete().eq("analysis_run_id", runId);
  await svc.from("v2_code_relationships").delete().eq("analysis_run_id", runId);
  await svc.from("v2_feature_candidates").delete().eq("analysis_run_id", runId);
  await svc.from("v2_evidence_chains").delete().eq("analysis_run_id", runId);
  await svc.from("v2_requirement_links").delete().eq("analysis_run_id", runId);
  await svc.from("v2_claim_verifications").delete().eq("analysis_run_id", runId);

  const fileRows = ctx.files.map((f) => ({
    analysis_run_id: runId,
    path: f.path,
    size_bytes: f.sizeBytes,
    extension: f.extension,
    language: f.language,
    category: f.category,
    importance_score: f.importanceScore,
    importance_reasons: f.reasons,
    ignored: f.ignored,
    generated: f.generated,
    binary: f.binary,
    sensitive: f.sensitive,
    content_hash: f.contentHash,
    structurally_indexed: !f.ignored,
    functionally_inspected: Boolean(f.content) && !f.ignored && f.importanceScore >= 0.35,
    sent_to_ai: false,
  }));
  for (let i = 0; i < fileRows.length; i += 400) {
    await svc.from("v2_repository_files").insert(fileRows.slice(i, i + 400));
  }

  const { data: insertedFiles } = await svc.from("v2_repository_files").select("id, path").eq("analysis_run_id", runId);
  const fileIdByPath = new Map(((insertedFiles ?? []) as { id: string; path: string }[]).map((r) => [r.path, r.id]));

  const symbolRows = ctx.symbols.map((s) => ({
    analysis_run_id: runId,
    file_id: fileIdByPath.get(s.filePath),
    symbol_key: s.symbolKey,
    name: s.name,
    symbol_type: s.symbolType,
    language: s.language,
    start_line: s.startLine,
    end_line: s.endLine,
    signature: s.signature,
    parent_symbol: s.parentSymbol,
    importance: s.importance,
    uncertain: s.uncertain,
  })).filter((r) => r.file_id);
  for (let i = 0; i < symbolRows.length; i += 400) {
    await svc.from("v2_repository_symbols").insert(symbolRows.slice(i, i + 400));
  }

  const relRows = ctx.relationships.map((r) => ({
    analysis_run_id: runId,
    relationship_type: r.relationship,
    confidence: r.confidence,
    source_file: r.sourceFile,
    source_lines: r.sourceLines ?? null,
    source_file_id: fileIdByPath.get(r.sourceFile) ?? null,
    target_file_id: r.targetFile ? fileIdByPath.get(r.targetFile) ?? null : null,
    detail: r.detail ?? {},
  }));
  for (let i = 0; i < relRows.length; i += 400) {
    await svc.from("v2_code_relationships").insert(relRows.slice(i, i + 400));
  }

  const evidenceRows = ctx.evidence.map((e) => ({
    analysis_run_id: runId,
    evidence_id: e.evidenceId,
    level: e.level,
    evidence_type: e.evidenceType,
    claim: e.claim,
    file_path: e.filePath,
    symbol_name: e.symbolName,
    start_line: e.startLine,
    end_line: e.endLine,
    snippet_hash: e.snippetHash,
    snippet_excerpt: e.snippetExcerpt,
    confidence: e.confidence,
    detail: e.detail ?? {},
  }));
  for (let i = 0; i < evidenceRows.length; i += 400) {
    await svc.from("v2_evidence_items").insert(evidenceRows.slice(i, i + 400));
  }

  for (const feature of ctx.features) {
    await svc.from("v2_feature_candidates").insert({
      analysis_run_id: runId,
      feature_key: feature.featureKey,
      name: feature.name,
      workflow: feature.workflow,
      entry_symbol_ids: [],
      symbol_ids: [],
      relationship_ids: [],
      evidence_ids: feature.evidenceIds,
      confidence: feature.confidence,
    });
  }

  for (const chain of ctx.chains) {
    await svc.from("v2_evidence_chains").insert({
      analysis_run_id: runId,
      chain_key: chain.chainKey,
      name: chain.name,
      ordered_evidence_ids: chain.orderedEvidenceIds,
    });
  }

  for (const req of ctx.requirements) {
    await svc.from("v2_requirement_links").insert({
      analysis_run_id: runId,
      requirement_id: req.requirementId,
      kind: req.kind,
      status: req.status,
      confidence: req.confidence,
      explanation: req.explanation,
      uncertainties: req.uncertainties,
      evidence_ids: req.evidenceIds,
      workflow_ids: req.workflowIds,
    });
  }

  for (const claim of ctx.claims) {
    await svc.from("v2_claim_verifications").insert({
      analysis_run_id: runId,
      claim_text: claim.claimText,
      status: claim.status,
      confidence: claim.confidence,
      explanation: claim.explanation,
      evidence_ids: claim.evidenceIds,
      chain_keys: claim.chainKeys,
    });
  }

  for (const vr of ctx.verificationResults) {
    const { data: reqRow } = await svc.from("v2_verification_requests").insert({
      analysis_run_id: runId,
      operation: vr.operation,
      model: "deepseek",
      prompt_version: "verify-v1",
      packet_hash: vr.packet.packetHash,
      evidence_hash: vr.evidenceHash,
      subject_ids: vr.subjectIds,
      verification_round: 1,
      input_tokens: vr.inputTokens,
      output_tokens: vr.outputTokens,
      cached_tokens: vr.cachedTokens,
      total_tokens: vr.inputTokens + vr.outputTokens,
      duration_ms: vr.durationMs,
      cache_hit: vr.cacheHit,
      status: vr.status,
    }).select("id").single();
    if (reqRow && vr.verdict) {
      await svc.from("v2_verification_results").insert({
        request_id: (reqRow as { id: string }).id,
        verdict: vr.verdict.verdict,
        confidence: vr.verdict.confidence,
        verification_level: vr.verdict.verification_level,
        summary: vr.verdict.summary,
        supporting_evidence_ids: vr.verdict.supporting_evidence_ids,
        missing_links: vr.verdict.missing_links,
        contradictions: vr.verdict.contradictions,
        additional_files_needed: vr.verdict.additional_files_needed,
        runtime_verified: vr.verdict.runtime_verified,
        verification_complete: vr.verdict.verification_complete,
        raw_payload: vr.verdict,
      });
    }
  }

  await svc.from("v2_analysis_coverage").upsert({
    analysis_run_id: runId,
    ...ctx.coverage,
    files_sent_to_ai: ctx.filesSentToAi,
  }, { onConflict: "analysis_run_id" });

  await svc.from("v2_analysis_summaries").upsert({
    analysis_run_id: runId,
    headline: String(ctx.summary.headline ?? ""),
    implementation_summary: String(ctx.summary.implementation_summary ?? ""),
    strong_points: ctx.summary.strong_points ?? [],
    uncertainties: ctx.summary.uncertainties ?? [],
    defense_questions: ctx.summary.defense_questions ?? [],
  }, { onConflict: "analysis_run_id" });
}
