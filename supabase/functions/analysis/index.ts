/**
 * HackSim analysis — repository scan and project analysis.
 *
 * One Supabase function, so the browser needs a single endpoint:
 *
 *   GET  ?submission_id=…                                  read the analysis
 *   POST {action:"repository", submission_id}               scan the repository
 *   POST {action:"reanalyze", submission_id}                force a fresh scan
 *   POST {action:"analyze",   submission_id, only_task?}    run the analysis
 *   POST {action:"retry-task", submission_id, task}         re-run one task
 *   POST {action:"diagnostics", submission_id}               why it concluded that
 *
 * The split between read and act is the whole authorisation story. A valid JWT
 * proves who you are, not what you may touch, so every route re-checks team
 * membership server-side with the service client.
 *
 * The repository scan is deterministic and costs no AI tokens. The analysis asks
 * a model only where the scan could not conclude, and a scan that could not
 * read the whole repository says so instead of reporting a negative.
 */

import {
  db,
  fail,
  getCaller,
  HttpError,
  json,
  loadHackathon,
  loadSubmission,
  requireTeamAccess,
  withErrorHandling,
  type Caller,
} from "../_shared/http.ts";
import {
  analyzeSubmission,
  EnginePersistence,
  ENGINE_SCAN_VERSION,
  HACKSIM_ENGINE_ID,
  normalizeVerifyTaskName,
  runVerification,
  type EngineVerifyTaskKind,
} from "../_shared/engine/index.ts";
import { aiConfigured } from "../_shared/ai.ts";
import { rateLimiter } from "../_shared/security.ts";

/** Proves which engine build handled this HTTP response (server-generated only). */
function runtimeMeta() {
  return {
    handler: "analysis-v1",
    engine_id: HACKSIM_ENGINE_ID,
    analysis_version: ENGINE_SCAN_VERSION,
  };
}

async function requireCaller(req: Request): Promise<Caller> {
  const caller = await getCaller(req);
  if (!caller) throw new HttpError("Invalid or expired session.", 401);
  return caller;
}

async function readAnalysis(req: Request, url: URL): Promise<Response> {
  const submissionId = url.searchParams.get("submission_id");
  if (!submissionId) throw new HttpError("A submission id is required.", 400);

  const caller = await requireCaller(req);
  const submission = await loadSubmission(submissionId);
  await requireTeamAccess(submission, caller);

  // The RPC does its own ownership check too; this is defence in depth, not the
  // only line of defence.
  const { data, error } = await db().rpc("submission_analysis", {
    p_submission_id: submissionId,
  });
  if (error) throw new HttpError("Could not load the analysis.", 500);

  const payload = (data ?? {}) as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown> | null | undefined;
  const projectMap = payload.project_map as Record<string, unknown> | null | undefined;
  return json({
    ...payload,
    ai_available: aiConfigured(),
    runtime: runtimeMeta(),
    runtime_scan_matches: repo?.analysis_version === ENGINE_SCAN_VERSION,
    project_map_engine_id: projectMap?.engine_id ?? null,
  });
}

async function act(req: Request): Promise<Response> {
  const caller = await requireCaller(req);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");
  const submissionId = String(body?.submission_id ?? "");
  if (!submissionId) throw new HttpError("A submission id is required.", 400);

  // §24 — before any expensive work. The limit is per authenticated user, per
  // action; the key is the caller's own id from their JWT, never a client
  // field, so rotating accounts does not dodge it either.
  const limited = rateLimiter.enforce(action, caller.id);
  if (limited) return limited;

  const submission = await loadSubmission(submissionId);
  await requireTeamAccess(submission, caller);

  const githubUrl = (submission.github_url ?? "").trim();

  switch (action) {
    case "repository":
      return json(await runScan(submissionId, githubUrl, false));

    case "reanalyze":
      // Mark the cached row stale so the commit cache does not short-circuit.
      await new EnginePersistence().markStale(submissionId);
      return json(await runScan(submissionId, githubUrl, true));

    case "analyze": {
      const onlyTask = body?.only_task ? [String(body.only_task)] : null;
      return json(
        await runAnalysisFor(
          submission as unknown as Record<string, unknown> & SubmissionKeys,
          onlyTask,
          caller,
        ),
      );
    }

    case "retry-task": {
      const task = String(body?.task ?? "");
      if (!task) throw new HttpError("A task name is required.", 400);
      return json(
        await runAnalysisFor(
          submission as unknown as Record<string, unknown> & SubmissionKeys,
          [task],
          caller,
        ),
      );
    }

    case "diagnostics":
      return json(await diagnosticsFor(submissionId, caller));

    default:
      throw new HttpError("Unknown action.", 400);
  }
}

async function runScan(submissionId: string, githubUrl: string, reanalyze: boolean) {
  if (!githubUrl) {
    throw new HttpError(
      reanalyze
        ? "This submission has no GitHub repository URL."
        : "Add a GitHub repository URL to the submission first.",
      400,
    );
  }

  const outcome = await analyzeSubmission(submissionId, githubUrl);

  if (outcome.status === "failed") {
    // §89 — the submission itself is untouched and the failure is recorded.
    // §57 — a technical failure is named as a technical failure, never turned
    // into a statement about the project.
    throw new HttpError(outcome.error ?? "Repository analysis failed.", 502);
  }
  return {
    ...outcome,
    state: outcome.status,
    runtime: runtimeMeta(),
  };
}

type SubmissionKeys = {
  id: string;
  hackathon_id: string;
  session_id: string;
};

async function runAnalysisFor(
  submission: Record<string, unknown> & SubmissionKeys,
  onlyTasks: string[] | null,
  caller: Caller,
) {
  const store = new EnginePersistence();
  const loaded = await store.loadForReview(submission.id);

  if (!loaded || !["completed", "limited"].includes(loaded.repository.analysis_status as string)) {
    throw new HttpError("Analyse the repository before running the analysis.", 409);
  }

  const scanVersion = String(loaded.repository.analysis_version ?? "");
  if (scanVersion && scanVersion !== ENGINE_SCAN_VERSION) {
    throw new HttpError(
      `Repository scan is ${scanVersion}; re-analyse the repository to run ${ENGINE_SCAN_VERSION} verification.`,
      409,
    );
  }

  if (!aiConfigured()) {
    throw new HttpError(
      "The analysis is not configured on this deployment. Add DEEPSEEK_API_KEY as an " +
        "edge function secret; repository analysis still works without it.",
      503,
    );
  }

  const hackathon = await loadHackathon(submission.hackathon_id);

  let verifyOnly: EngineVerifyTaskKind[] | null = null;
  if (onlyTasks?.length) {
    verifyOnly = [];
    for (const raw of onlyTasks) {
      const normalized = normalizeVerifyTaskName(raw);
      if (!normalized) {
        throw new HttpError(
          `Unknown verification task "${raw}". Use brief, implementation, engineering, or claims.`,
          400,
        );
      }
      verifyOnly.push(normalized);
    }
  }

  const outcome = await runVerification({
    submission: submission as unknown as Record<string, unknown>,
    hackathon,
    repository: loaded.repository,
    files: loaded.files,
    chunks: loaded.chunks,
    evidence: loaded.evidence ?? [],
    projectMap: loaded.projectMap,
    actorId: caller.id,
    sessionId: submission.session_id,
    onlyTasks: verifyOnly,
  });

  return {
    status: outcome.status,
    review_id: outcome.reviewId,
    engine_id: outcome.engineId,
    analysis_version: ENGINE_SCAN_VERSION,
    run_cost_usd: outcome.runCostUsd,
    run_tokens: outcome.runTokens,
    cumulative_cost_usd: outcome.cumulativeCostUsd,
    cumulative_tokens: outcome.cumulativeTokens,
    total_cost_usd: outcome.runCostUsd,
    total_tokens: outcome.runTokens,
    verification_tasks: outcome.verificationTasks,
    runtime: runtimeMeta(),
  };
}

/** §55 — why the analysis concluded what it did, for an admin. */
async function diagnosticsFor(
  submissionId: string,
  caller: Caller,
): Promise<Record<string, unknown>> {
  if (caller.role !== "admin") {
    throw new HttpError("Diagnostics are available to administrators only.", 403);
  }

  const { data, error } = await db()
    .from("analysis_snapshots")
    .select(
      "id, commit_sha, hackathon_version, analysis_version, created_at, " +
        "plan, conclusions, evidence_count, input_tokens, output_tokens, " +
        "cached_tokens, estimated_cost_usd",
    )
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new HttpError("Could not load diagnostics.", 500);

  const { data: usage } = await db()
    .from("ai_usage")
    .select("operation, status, input_tokens, output_tokens, cached_tokens, " +
      "estimated_cost_usd, prompt_version, created_at, error_code")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(100);

  return {
    submission_id: submissionId,
    runs: data ?? [],
    ai_usage: usage ?? [],
    runtime: runtimeMeta(),
  };
}

Deno.serve(
  withErrorHandling((req, url) => {
    if (req.method === "GET") return readAnalysis(req, url);
    if (req.method === "POST") return act(req);
    return fail("Method not allowed.", 405);
  }),
);
