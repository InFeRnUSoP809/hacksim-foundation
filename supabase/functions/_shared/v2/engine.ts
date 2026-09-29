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
  findCachedRun,
  logStage,
  persistEngineArtifacts,
  persistSnapshot,
  updateRunStatus,
} from "./persist.ts";
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
      round: 1,
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
      round: 1,
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
      round: 1,
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

export async function startV2Analysis(submissionId: string, githubUrl: string): Promise<StartV2Outcome> {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submissionId);
  let commitSha = loaded ? String(loaded.repository.analyzed_commit_sha ?? "") : "";

  if (!loaded || !commitSha) {
    const pre = await analyzeSubmission(submissionId, githubUrl);
    if (pre.status === "failed") {
      return { run_id: "", status: "failed", message: pre.error };
    }
    const again = await store.loadForReview(submissionId);
    commitSha = again ? String(again.repository.analyzed_commit_sha ?? "") : "";
  }

  const cachedRun = commitSha
    ? await findCachedRun(submissionId, commitSha, V2_SCANNER_VERSION, V2_ANALYSIS_VERSION)
    : null;
  if (cachedRun) {
    await (await import("../http.ts")).db().from("submissions").update({
      latest_analysis_run_id: cachedRun,
    }).eq("id", submissionId);
    return { run_id: cachedRun, status: "completed", cached: true, message: "Reusing cached V2 analysis for this commit." };
  }

  const repo = (await store.loadForReview(submissionId))?.repository ?? {};
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

  const job = runV2Pipeline(runId, submissionId, githubUrl);
  if (EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job);
  else await job;

  return { run_id: runId, status: EdgeRuntime?.waitUntil ? "queued" : "completed" };
}

export async function getV2Status(submissionId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await (await import("../http.ts")).db().rpc("analysis_run_status", {
    p_submission_id: submissionId,
  });
  if (error) return null;
  return data as Record<string, unknown>;
}
