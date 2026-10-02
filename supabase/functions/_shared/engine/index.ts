/**
 * HackSim Analysis Engine v1 — production entrypoint.
 *
 * Legacy modules (scanner.ts, review.ts, planner.ts, graph.ts at _shared root)
 * are reference-only and must not be imported from application code.
 */

import { GitHubClient, GitHubError } from "./infra/github.ts";
import { EnginePersistence } from "./persistence/store.ts";
import { runRepositoryScan } from "./scan/run.ts";
import { runEngineVerification, type EngineVerifyInput } from "./verify/orchestrator.ts";
import { HACKSIM_ENGINE_ID, ENGINE_SCAN_VERSION } from "./constants.ts";

export {
  HACKSIM_ENGINE_ID,
  ENGINE_SCAN_VERSION,
  engineRuntimeIdentity,
} from "./constants.ts";

export { EnginePersistence, type LoadedEngineAnalysis } from "./persistence/store.ts";
export { runRepositoryScan } from "./scan/run.ts";
export { runEngineVerification } from "./verify/orchestrator.ts";

export interface AnalyzeSubmissionOutcome {
  status: "completed" | "limited" | "cached" | "failed";
  repository_id?: string;
  commit_sha?: string;
  file_count?: number;
  evidence_count?: number;
  project_map?: unknown;
  error?: string;
  code?: string;
  engine_id: typeof HACKSIM_ENGINE_ID;
}

export async function analyzeSubmission(
  submissionId: string,
  githubUrl: string,
): Promise<AnalyzeSubmissionOutcome> {
  const store = new EnginePersistence();
  const client = new GitHubClient();
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = client.parseRepositoryUrl(githubUrl));
  } catch (error) {
    const message = (error as Error).message;
    const code = error instanceof GitHubError ? error.code : "invalid_url";
    await store.markFailed(submissionId, githubUrl, code, message);
    return { status: "failed", error: message, code, engine_id: HACKSIM_ENGINE_ID };
  }

  await store.markScanning(submissionId, githubUrl, "discovering_repository");

  let result;
  try {
    result = await runRepositoryScan(client, owner, repo);
  } catch (error) {
    const message = (error as Error).message ?? "Repository analysis failed.";
    const code = error instanceof GitHubError ? error.code : "scanner_error";
    await store.markFailed(submissionId, githubUrl, code, message);
    return { status: "failed", error: message, code, engine_id: HACKSIM_ENGINE_ID };
  }

  const cached = await store.cached(submissionId, result.commitSha);
  if (cached) {
    return {
      status: "cached",
      repository_id: cached.id as string,
      project_map: cached.project_map,
      engine_id: HACKSIM_ENGINE_ID,
    };
  }

  const repositoryId = await store.persist(submissionId, result);
  return {
    status: result.analysisMode === "full" ? "completed" : "limited",
    repository_id: repositoryId,
    commit_sha: result.commitSha,
    file_count: result.files.length,
    evidence_count: result.evidence.length,
    engine_id: HACKSIM_ENGINE_ID,
  };
}

export async function runVerification(
  input: EngineVerifyInput,
) {
  return runEngineVerification(input);
}

export type { EngineVerifyTaskKind } from "./constants.ts";
export type { EngineVerifyInput, EngineVerifyOutcome, VerificationTaskRecord } from "./verify/orchestrator.ts";
export { normalizeVerifyTaskName } from "./verify/orchestrator.ts";
