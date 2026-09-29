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
import { analyzeSubmission, AnalysisStore } from "../_shared/scanner.ts";
import { runAnalysis } from "../_shared/review.ts";
import { getV2Status, startV2Analysis } from "../_shared/v2/engine.ts";
import { aiConfigured } from "../_shared/ai.ts";
import { rateLimiter } from "../_shared/security.ts";
import { rescoreRelevance } from "../_shared/datasets.ts";
import { briefVocabulary, analyseRequirement } from "../_shared/concepts.ts";
import { getRequirementMap } from "../_shared/requirements.ts";
import type { Evidence } from "../_shared/github.ts";
import type { ConceptSet } from "../_shared/concepts.ts";

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

  return json({
    ...(data ?? {}),
    // The browser needs to know whether the analysis can run at all.
    ai_available: aiConfigured(),
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
      await new AnalysisStore().markStale(submissionId);
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

    case "start-v2":
      if (!githubUrl) throw new HttpError("Add a GitHub repository URL first.", 400);
      return json(await startV2Analysis(submissionId, githubUrl), 202);

    case "status-v2":
      return json({ ...(await getV2Status(submissionId)), ai_available: aiConfigured() });

    case "summary-v2": {
      const { data, error } = await db().rpc("v2_analysis_summary", {
        p_submission_id: submissionId,
      });
      if (error) throw new HttpError("Could not load V2 summary.", 500);
      return json(data ?? { ready: false });
    }

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
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submission.id);

  if (!loaded || !["completed", "limited"].includes(loaded.repository.analysis_status as string)) {
    throw new HttpError("Analyse the repository before running the analysis.", 409);
  }

  if (!aiConfigured()) {
    throw new HttpError(
      "The analysis is not configured on this deployment. Add DEEPSEEK_API_KEY as an " +
        "edge function secret; repository analysis still works without it.",
      503,
    );
  }

  const hackathon = await loadHackathon(submission.hackathon_id);
  const requirementMap = await getRequirementMap(submission.hackathon_id, hackathon);

  // Dataset relevance is a question about *this* challenge, so it is answered
  // here rather than during the repository scan.
  const vocabulary = briefVocabulary(requirementMap);
  const concepts: ConceptSet[] = [
    ...(requirementMap.requirements ?? []).map((entry) =>
      analyseRequirement(entry.text, vocabulary, requirementMap),
    ),
    {
      text: String(submission.project_description ?? ""),
      intent: String(submission.project_description ?? "").slice(0, 300),
      focus: "general",
      phrases: [],
      actions: [],
      subjects: [],
      qualifiers: [],
      terms: [],
      domainTerms: [],
      facets: [],
      artifacts: [],
    } as ConceptSet,
  ];
  const datasetProfiles = (loaded.datasetProfiles ?? []).map((profile) =>
    rescoreRelevance(profile, concepts),
  );

  const outcome = await runAnalysis({
    submission: submission as unknown as Record<string, unknown>,
    hackathon,
    repository: loaded.repository,
    files: loaded.files,
    chunks: loaded.chunks,
    evidence: (loaded.evidence ?? []) as unknown as Evidence[],
    projectMap: loaded.projectMap,
    datasetProfiles,
    semantics: loaded.semantics,
    routes: loaded.routes,
    inspection: loaded.inspection,
    actorId: caller.id,
    sessionId: submission.session_id,
    onlyTasks,
  });

  return {
    status: outcome.status,
    review_id: outcome.reviewId,
    plan: outcome.plan.summary,
    requirements_enabled: outcome.plan.requirementsEnabled,
    dimensions: outcome.plan.dimensions
      .filter((dimension) => dimension.relevance !== "not_applicable")
      .map((dimension) => ({
        key: dimension.key,
        label: dimension.label,
        relevance: dimension.relevance,
        reason: dimension.reason,
      })),
    tasks: outcome.tasks.map((task) => ({
      key: task.key,
      kind: task.kind,
      scope: task.scope,
      status: task.status,
      reason: task.reason,
      input_tokens: task.inputTokens,
      output_tokens: task.outputTokens,
      cost_usd: Number(task.costUsd.toFixed(6)),
      validation_errors: task.validationErrors,
      rejected_evidence_ids: task.rejectedEvidenceIds,
      repairs: task.repairs,
    })),
    conclusions: outcome.conclusions.map((row) => ({
      id: row.subject_id,
      kind: row.kind,
      status: row.status,
      confidence: row.confidence,
      evidence_ids: row.evidence_ids,
      method: row.method,
    })),
    diagnostics: outcome.diagnostics,
    diff: outcome.diff,
    error: outcome.error ?? null,
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
  };
}

Deno.serve(
  withErrorHandling((req, url) => {
    if (req.method === "GET") return readAnalysis(req, url);
    if (req.method === "POST") return act(req);
    return fail("Method not allowed.", 405);
  }),
);
