import { loadHackathon } from "../http.ts";
import { analyzeSubmission, AnalysisStore, SCANNER_VERSION } from "../scanner.ts";
import { getRequirementMap } from "../requirements.ts";
import { attachContent, contentByPath } from "./content.ts";
import { buildFileInventory, entryPointCandidates, scoreImportance } from "./discover.ts";
import { compileEvidence, resetEvidenceCounter } from "./evidence.ts";
import { buildRelationshipGraph } from "./graph.ts";
import { mapClaims, mapRequirements } from "./requirement-map.ts";
import {
  createAnalysisRun,
  findActiveRun,
  findCachedRun,
  logStage,
  persistEngineArtifacts,
  persistSnapshot,
  saveCheckpoint,
  updateRunStatus,
} from "./persist.ts";
import {
  evidenceCountForRun,
  loadPersistedEvidence,
  loadPersistedFeatures,
  loadPersistedRelationships,
  rebuildFilesFromSubmission,
} from "./rehydrate.ts";
import { buildEvidencePacket } from "./retrieval.ts";
import { indexSymbols } from "./symbols.ts";
import { runVerificationGroup } from "./verifier.ts";
import { buildEvidenceChains, discoverFeatureWorkflows } from "./workflows.ts";
import { V2_ANALYSIS_VERSION, V2_PROMPT_VERSION, V2_SCANNER_VERSION, V2_STAGE_PROGRESS } from "./versions.ts";
import { sha256Hex } from "./hash.ts";

declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

export interface StartV2Outcome {
  run_id: string;
  status: string;
  cached?: boolean;
  message?: string;
}

function progressFor(status: string): number {
  return V2_STAGE_PROGRESS[status] ?? 0;
}

async function loadChunksForSubmission(submissionId: string) {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submissionId);
  if (!loaded) return null;
  const pathByFileId = new Map(
    (loaded.files as { id: string; path: string }[]).map((f) => [f.id, f.path]),
  );
  const chunks = (loaded.chunks ?? []).map((c) => ({
    file_path: pathByFileId.get(String(c.file_id)) ?? "",
    start_line: c.start_line as number | null,
    content: String(c.content ?? ""),
  })).filter((c) => c.file_path);
  return { loaded, chunks };
}

export async function runV2Pipeline(runId: string, submissionId: string, githubUrl: string): Promise<void> {
  try {
    await updateRunStatus(runId, "scanning_repository", {
      progress_percent: progressFor("scanning_repository"),
    });
    await logStage(runId, "scanning_repository", "Repository scan");

    const scanOutcome = await analyzeSubmission(submissionId, githubUrl);
    if (scanOutcome.status === "failed") {
      await updateRunStatus(runId, "failed", {
        error_code: scanOutcome.code ?? "scan_failed",
        error_message: scanOutcome.error ?? "Scan failed",
        completed_at: new Date().toISOString(),
        progress_percent: 100,
      });
      return;
    }

    const loadedBundle = await loadChunksForSubmission(submissionId);
    if (!loadedBundle) {
      await updateRunStatus(runId, "failed", {
        error_message: "Could not load scanned repository.",
        completed_at: new Date().toISOString(),
      });
      return;
    }
    const { loaded, chunks } = loadedBundle;
    const repository = loaded.repository;
    const commitSha = String(repository.analyzed_commit_sha ?? repository.latest_commit_sha ?? "");
    const owner = String(repository.owner ?? "");
    const repoName = String(repository.repo_name ?? "");

    await (await import("../http.ts")).db().from("analysis_runs").update({ commit_sha: commitSha }).eq("id", runId);

    await persistSnapshot(runId, {
      normalized_url: githubUrl,
      owner,
      repo_name: repoName,
      default_branch: repository.default_branch,
      commit_sha: commitSha,
      is_private: repository.visibility === "private",
      primary_language: repository.language,
      file_count: loaded.files?.length ?? 0,
    });

    await updateRunStatus(runId, "building_code_graph", {
      progress_percent: progressFor("building_code_graph"),
    });

    resetEvidenceCounter();
    const byPath = contentByPath(chunks);
    const treeEntries = (loaded.files as { path: string; file_size?: number }[]).map((f) => ({
      path: f.path,
      size: f.file_size,
    }));
    treeEntries.push(...[...byPath.keys()].filter((p) => !treeEntries.some((e) => e.path === p)).map((p) => ({
      path: p,
      size: byPath.get(p)?.length ?? 0,
    })));

    let inventory = buildFileInventory(treeEntries, byPath);
    const provisionalFiles = attachContent(inventory, byPath);
    let symbols = indexSymbols(provisionalFiles);
    const { relationships, inDegree, routeFiles } = buildRelationshipGraph(provisionalFiles, symbols);
    const entryFiles = entryPointCandidates(provisionalFiles.map((f) => f.path));
    inventory = scoreImportance(inventory, inDegree, routeFiles, entryFiles);
    const files = attachContent(inventory, byPath);
    symbols = indexSymbols(files);

    for (const file of files) {
      if (file.content) file.contentHash = await sha256Hex(file.content.slice(0, 8000));
    }

    const evidence = await compileEvidence(files, relationships);
    const features = discoverFeatureWorkflows(relationships, evidence);
    const chains = buildEvidenceChains(features);

    await updateRunStatus(runId, "discovering_features", {
      progress_percent: progressFor("discovering_features"),
    });

    const { data: submissionRow } = await (await import("../http.ts")).db()
      .from("submissions")
      .select("hackathon_id, project_description, problem_statement")
      .eq("id", submissionId)
      .single();
    const hackathon = await loadHackathon(String((submissionRow as Record<string, unknown> | null)?.hackathon_id ?? ""));
    const requirementMap = await getRequirementMap(String(hackathon.id ?? submissionId), hackathon);
    const requirements = mapRequirements(requirementMap, evidence, features);
    const claims = [
      String((submissionRow as Record<string, unknown> | null)?.project_description ?? ""),
      String((submissionRow as Record<string, unknown> | null)?.problem_statement ?? ""),
    ];
    const claimRows = mapClaims(claims, evidence, features);

    await updateRunStatus(runId, "verifying", { progress_percent: progressFor("verifying") });

    const filePathSet = new Set(files.map((f) => f.path));
    const hackathonContext = JSON.stringify({
      requirements: (requirementMap.requirements ?? []).slice(0, 12).map((r) => ({ id: r.id, text: r.text })),
    });

    const reqPacket = await buildEvidencePacket({
      subjectIds: requirements.slice(0, 8).map((r) => r.requirementId),
      evidence,
      files,
      relationships,
      seedEvidenceIds: requirements.flatMap((r) => r.evidenceIds).slice(0, 20),
    });

    const archPacket = await buildEvidencePacket({
      subjectIds: features.map((f) => f.featureKey),
      evidence,
      files,
      relationships,
      seedEvidenceIds: features.flatMap((f) => f.evidenceIds).slice(0, 24),
    });

    const techPacket = await buildEvidencePacket({
      subjectIds: ["security", "database", "testing"],
      evidence: evidence.filter((e) =>
        ["reads_database", "route", "behavior"].includes(e.evidenceType) ||
        e.filePath?.includes("test"),
      ),
      files,
      relationships: relationships.filter((r) =>
        ["reads_database", "calls_api", "tests"].includes(r.relationship),
      ),
      seedEvidenceIds: evidence.filter((e) => e.level !== "metadata").slice(0, 16).map((e) => e.evidenceId),
    });

    const verificationResults = [];
    await saveCheckpoint(runId, { stage: "graph_complete", commit_sha: commitSha });
    await persistEngineArtifacts(runId, {
      files,
      symbols,
      relationships,
      evidence,
      features,
      chains,
      requirements,
      claims: claimRows,
      verificationResults: [],
      filesSentToAi: 0,
      coverage: {
        files_discovered: files.length,
        files_structurally_indexed: files.filter((f) => !f.ignored).length,
        files_functionally_inspected: files.filter((f) => f.importanceScore >= 0.35 && f.content).length,
        symbols_indexed: symbols.length,
        relationships_found: relationships.length,
        evidence_items: evidence.length,
        evidence_chains: chains.length,
        source_lines_inspected: files.reduce((n, f) => n + (f.content ? f.content.split("\n").length : 0), 0),
        requirements_analyzed: requirements.length,
        requirements_verified: 0,
        ai_requests: 0,
        ai_input_tokens: 0,
        ai_output_tokens: 0,
        ai_cached_tokens: 0,
        ai_cost_usd: 0,
      },
      summary: {
        headline: `${repoName} — analysis in progress`,
        implementation_summary: "Graph and evidence compiled; verification running.",
        strong_points: [],
        uncertainties: [],
        defense_questions: [],
      },
    });

    const simpleRepo = files.filter((f) => !f.ignored).length <= 3 &&
      evidence.filter((e) => e.level === "implementation").length === 0;

    verificationResults.push(await runVerificationGroup({
      operation: "requirements_alignment",
      subjectIds: reqPacket.subjectIds,
      subjectLabel: "Requirements and functional alignment",
      hackathonContext,
      packet: reqPacket,
      evidence,
      filePaths: filePathSet,
      submissionId,
      runId,
      commitSha,
      scannerVersion: V2_SCANNER_VERSION,
      analysisVersion: V2_ANALYSIS_VERSION,
      round: 1,
      skipAi: simpleRepo,
    }));
    verificationResults.push(await runVerificationGroup({
      operation: "architecture_workflows",
      subjectIds: archPacket.subjectIds,
      subjectLabel: "Architecture and workflows",
      hackathonContext,
      packet: archPacket,
      evidence,
      filePaths: filePathSet,
      submissionId,
      runId,
      commitSha,
      scannerVersion: V2_SCANNER_VERSION,
      analysisVersion: V2_ANALYSIS_VERSION,
      round: 1,
      skipAi: simpleRepo || archPacket.evidenceIds.length === 0,
    }));
    verificationResults.push(await runVerificationGroup({
      operation: "security_data_testing",
      subjectIds: techPacket.subjectIds,
      subjectLabel: "Security, database, and testing",
      hackathonContext,
      packet: techPacket,
      evidence,
      filePaths: filePathSet,
      submissionId,
      runId,
      commitSha,
      scannerVersion: V2_SCANNER_VERSION,
      analysisVersion: V2_ANALYSIS_VERSION,
      round: 1,
      skipAi: simpleRepo || techPacket.evidenceIds.length === 0,
    }));

    // Adaptive second round for first missing link
    const missing = verificationResults.flatMap((v) => v.verdict?.missing_links ?? []).slice(0, 1);
    if (missing.length) {
      const adaptivePacket = await buildEvidencePacket({
        subjectIds: ["adaptive"],
        evidence,
        files,
        relationships,
        seedEvidenceIds: reqPacket.evidenceIds,
        missingLink: missing[0],
      });
      verificationResults.push(await runVerificationGroup({
        operation: "adaptive_missing_link",
        subjectIds: ["adaptive"],
        subjectLabel: `Missing link: ${missing[0]}`,
        hackathonContext,
        packet: adaptivePacket,
        evidence,
        filePaths: filePathSet,
        submissionId,
        runId,
        commitSha,
        scannerVersion: V2_SCANNER_VERSION,
        analysisVersion: V2_ANALYSIS_VERSION,
        round: 2,
      }));
    }

    await updateRunStatus(runId, "validating", { progress_percent: progressFor("validating") });

    const linesInspected = files.reduce((n, f) => n + (f.content ? f.content.split("\n").length : 0), 0);
    const aiTokens = verificationResults.reduce((n, v) => n + v.inputTokens + v.outputTokens, 0);
    const functionalFiles = files.filter((f) => f.importanceScore >= 0.35 && f.content).length;
    const coverageLevel = functionalFiles > 20 ? "high" : functionalFiles > 8 ? "medium" : "low";

    const summary = {
      headline: `${repoName} — repository intelligence summary`,
      implementation_summary: features.length
        ? `Detected ${features.length} workflow candidate(s) from code relationships and implementation evidence.`
        : "Structural inventory completed; no strong workflow chains detected.",
      strong_points: features.filter((f) => f.confidence === "high").map((f) => f.name),
      uncertainties: verificationResults
        .flatMap((v) => v.verdict?.missing_links ?? [])
        .slice(0, 8)
        .map((m) => ({ title: m, detail: "Additional evidence needed to confirm end-to-end behavior." })),
      defense_questions: features.slice(0, 5).map((f) => `Explain how "${f.name}" works across the codebase.`),
    };

    await updateRunStatus(runId, "finalizing", { progress_percent: progressFor("finalizing") });

    await persistEngineArtifacts(runId, {
      files,
      symbols,
      relationships,
      evidence,
      features,
      chains,
      requirements,
      claims: claimRows,
      verificationResults,
      filesSentToAi: new Set([
        ...reqPacket.evidenceIds,
        ...archPacket.evidenceIds,
        ...techPacket.evidenceIds,
      ].map((id) => evidence.find((e) => e.evidenceId === id)?.filePath).filter(Boolean)).size,
      coverage: {
        files_discovered: files.length,
        files_structurally_indexed: files.filter((f) => !f.ignored).length,
        files_functionally_inspected: functionalFiles,
        symbols_indexed: symbols.length,
        relationships_found: relationships.length,
        evidence_items: evidence.length,
        evidence_chains: chains.length,
        source_lines_inspected: linesInspected,
        requirements_analyzed: requirements.length,
        requirements_verified: verificationResults.filter((v) => v.verdict?.verdict === "confirmed").length,
        ai_requests: verificationResults.length,
        ai_input_tokens: verificationResults.reduce((n, v) => n + v.inputTokens, 0),
        ai_output_tokens: verificationResults.reduce((n, v) => n + v.outputTokens, 0),
        ai_cached_tokens: verificationResults.reduce((n, v) => n + v.cachedTokens, 0),
        ai_cost_usd: 0,
      },
      summary,
    });

    const finalStatus = verificationResults.some((v) => v.status === "provider_error") ? "partial" : "completed";
    await updateRunStatus(runId, finalStatus, {
      progress_percent: 100,
      coverage_level: coverageLevel,
      completed_at: new Date().toISOString(),
    });
    await (await import("../http.ts")).db().from("analysis_runs").update({
      repository_id: repository.id as string,
      commit_sha: commitSha,
    }).eq("id", runId);
  } catch (error) {
    await updateRunStatus(runId, "failed", {
      error_message: (error as Error).message?.slice(0, 500) ?? "V2 pipeline failed",
      completed_at: new Date().toISOString(),
      progress_percent: 100,
    });
    await logStage(runId, "failed", (error as Error).message);
  }
}

async function dispatchPipeline(runId: string, submissionId: string, githubUrl: string, mode: "full" | "verify_only") {
  const job = mode === "verify_only"
    ? runVerifyOnlyPhase(runId, submissionId, githubUrl)
    : runV2Pipeline(runId, submissionId, githubUrl);
  if (EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job);
  else await job;
}

export async function startV2Analysis(
  submissionId: string,
  githubUrl: string,
  opts?: { retry?: boolean },
): Promise<StartV2Outcome> {
  const active = await findActiveRun(submissionId);
  if (active) {
    return { run_id: active, status: "queued", message: "Analysis already in progress." };
  }

  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submissionId);
  const commitSha = loaded ? String(loaded.repository.analyzed_commit_sha ?? "") : "";

  if (commitSha) {
    const cachedRun = await findCachedRun(
      submissionId,
      commitSha,
      V2_SCANNER_VERSION,
      V2_ANALYSIS_VERSION,
      V2_PROMPT_VERSION,
    );
    if (cachedRun && !opts?.retry) {
      await (await import("../http.ts")).db().from("submissions").update({
        latest_analysis_run_id: cachedRun,
      }).eq("id", submissionId);
      return {
        run_id: cachedRun,
        status: "completed",
        cached: true,
        message: "Reusing cached V2 analysis for this commit.",
      };
    }
  }

  if (opts?.retry) {
    const { data: lastRuns } = await (await import("../http.ts")).db()
      .from("analysis_runs")
      .select("id, status")
      .eq("submission_id", submissionId)
      .in("status", ["failed", "partial"])
      .order("started_at", { ascending: false })
      .limit(1);
    const last = (lastRuns as { id: string }[] | null)?.[0];
    if (last && (await evidenceCountForRun(last.id)) > 0) {
      await updateRunStatus(last.id, "verifying", { progress_percent: progressFor("verifying") });
      await dispatchPipeline(last.id, submissionId, githubUrl, "verify_only");
      return { run_id: last.id, status: "queued", message: "Retrying verification from persisted evidence." };
    }
  }

  const repo = loaded?.repository ?? {};
  const runId = await createAnalysisRun({
    submissionId,
    commitSha: commitSha || "pending",
    owner: String(repo.owner ?? ""),
    repoName: String(repo.repo_name ?? ""),
    defaultBranch: String(repo.default_branch ?? "main"),
    normalizedUrl: githubUrl,
    repositoryId: (repo.id as string) ?? null,
    scannerVersion: V2_SCANNER_VERSION,
    analysisVersion: V2_ANALYSIS_VERSION,
    promptVersion: V2_PROMPT_VERSION,
  });

  await dispatchPipeline(runId, submissionId, githubUrl, "full");
  return { run_id: runId, status: "queued", message: "V2 analysis queued." };
}

/** Resume verification without rescanning GitHub or rebuilding graph. */
async function runVerifyOnlyPhase(runId: string, submissionId: string, githubUrl: string): Promise<void> {
  try {
    const evidence = await loadPersistedEvidence(runId);
    const relationships = await loadPersistedRelationships(runId);
    const features = await loadPersistedFeatures(runId);
    const files = await rebuildFilesFromSubmission(submissionId);
    if (!evidence.length || !files.length) {
      await runV2Pipeline(runId, submissionId, githubUrl);
      return;
    }

    const { data: submissionRow } = await (await import("../http.ts")).db()
      .from("submissions")
      .select("hackathon_id, project_description, problem_statement")
      .eq("id", submissionId)
      .single();
    const hackathon = await loadHackathon(String((submissionRow as Record<string, unknown> | null)?.hackathon_id ?? ""));
    const requirementMap = await getRequirementMap(String(hackathon.id ?? submissionId), hackathon);
    const requirements = mapRequirements(requirementMap, evidence, features);
    const claims = [
      String((submissionRow as Record<string, unknown> | null)?.project_description ?? ""),
      String((submissionRow as Record<string, unknown> | null)?.problem_statement ?? ""),
    ];
    const claimRows = mapClaims(claims, evidence, features);

    const store = new AnalysisStore();
    const loaded = await store.loadForReview(submissionId);
    const commitSha = String(loaded?.repository.analyzed_commit_sha ?? "unknown");
    const repoName = String(loaded?.repository.repo_name ?? "project");
    const filePathSet = new Set(files.map((f) => f.path));
    const hackathonContext = JSON.stringify({
      requirements: (requirementMap.requirements ?? []).slice(0, 12).map((r) => ({ id: r.id, text: r.text })),
    });

    await updateRunStatus(runId, "verifying", { progress_percent: progressFor("verifying") });

    const reqPacket = await buildEvidencePacket({
      subjectIds: requirements.slice(0, 8).map((r) => r.requirementId),
      evidence,
      files,
      relationships,
      seedEvidenceIds: requirements.flatMap((r) => r.evidenceIds).slice(0, 20),
    });
    const verificationResults = [
      await runVerificationGroup({
        operation: "requirements_alignment",
        subjectIds: reqPacket.subjectIds,
        subjectLabel: "Requirements and functional alignment",
        hackathonContext,
        packet: reqPacket,
        evidence,
        filePaths: filePathSet,
        submissionId,
        runId,
        commitSha,
        scannerVersion: V2_SCANNER_VERSION,
        analysisVersion: V2_ANALYSIS_VERSION,
        round: 1,
      }),
    ];

    await updateRunStatus(runId, "finalizing", { progress_percent: progressFor("finalizing") });
    const summary = {
      headline: `${repoName} — repository intelligence summary`,
      implementation_summary: "Verification retry completed from persisted graph evidence.",
      strong_points: features.filter((f) => f.confidence === "high").map((f) => f.name),
      uncertainties: verificationResults.flatMap((v) => v.verdict?.missing_links ?? []).slice(0, 8)
        .map((m) => ({ title: m, detail: "Additional evidence needed." })),
      defense_questions: features.slice(0, 5).map((f) => `Explain how "${f.name}" works across the codebase.`),
    };

    await persistEngineArtifacts(runId, {
      files,
      symbols: [],
      relationships,
      evidence,
      features,
      chains: buildEvidenceChains(features),
      requirements,
      claims: claimRows,
      verificationResults,
      filesSentToAi: reqPacket.evidenceIds.length,
      coverage: {
        files_discovered: files.length,
        files_structurally_indexed: files.length,
        files_functionally_inspected: files.filter((f) => f.importanceScore >= 0.35).length,
        symbols_indexed: 0,
        relationships_found: relationships.length,
        evidence_items: evidence.length,
        evidence_chains: features.length,
        source_lines_inspected: 0,
        requirements_analyzed: requirements.length,
        requirements_verified: verificationResults.filter((v) => v.verdict?.verdict === "confirmed").length,
        ai_requests: verificationResults.length,
        ai_input_tokens: verificationResults.reduce((n, v) => n + v.inputTokens, 0),
        ai_output_tokens: verificationResults.reduce((n, v) => n + v.outputTokens, 0),
        ai_cached_tokens: verificationResults.reduce((n, v) => n + v.cachedTokens, 0),
        ai_cost_usd: 0,
      },
      summary,
    });

    await updateRunStatus(runId, "completed", {
      progress_percent: 100,
      completed_at: new Date().toISOString(),
      coverage_level: "medium",
    });
  } catch (error) {
    await updateRunStatus(runId, "failed", {
      error_message: (error as Error).message?.slice(0, 500) ?? "Verify retry failed",
      completed_at: new Date().toISOString(),
      progress_percent: 100,
    });
  }
}

export async function getV2Status(submissionId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await (await import("../http.ts")).db().rpc("analysis_run_status", {
    p_submission_id: submissionId,
  });
  if (error) return null;
  return data as Record<string, unknown>;
}
