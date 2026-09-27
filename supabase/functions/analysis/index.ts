/**
 * HackSim analysis — Phase 5 (repository scan) and Phase 6 (AI review).
 *
 * Routes (one Supabase function, so the browser needs a single endpoint):
 *
 *   GET  ?submission_id=…                              read the analysis
 *   POST {action:"repository", submission_id}          run Phase 5
 *   POST {action:"review",     submission_id, only_module?}  run Phase 6
 *   POST {action:"reanalyze",  submission_id}          force a fresh scan
 *   POST {action:"retry-module", submission_id, module} retry one module
 *
 * The split between read and act is the whole authorisation story. A valid JWT
 * proves who you are, not what you may touch, so every route re-checks team
 * membership server-side with the service client.
 *
 * Phase 5 is deterministic and costs no AI tokens. Phase 6 calls a model only
 * where the deterministic pass could not conclude.
 */

import {
  db,
  fail,
  getCaller,
  HttpError,
  json,
  loadHackathon,
  loadMembers,
  loadSubmission,
  requireTeamAccess,
  withErrorHandling,
  type Caller,
} from "../_shared/http.ts";
import { analyzeSubmission, AnalysisStore } from "../_shared/scanner.ts";
import { runReview } from "../_shared/review.ts";
import { aiConfigured } from "../_shared/ai.ts";
import { rateLimiter } from "../_shared/security.ts";
import type { Evidence, ProjectMap } from "../_shared/github.ts";

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
    // The browser needs to know whether Phase 6 can run at all.
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

    case "review": {
      const onlyModule = body?.only_module ? [String(body.only_module)] : null;
      return json(await runReviewFor(submission, onlyModule, caller));
    }

    case "retry-module": {
      const module = String(body?.module ?? "");
      if (!module) throw new HttpError("A module name is required.", 400);
      return json(await runReviewFor(submission, [module], caller));
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
    throw new HttpError(outcome.error ?? "Repository analysis failed.", 502);
  }
  return outcome;
}

async function runReviewFor(
  submission: { id: string; hackathon_id: string; session_id: string },
  onlyModules: string[] | null,
  caller: Caller,
) {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submission.id);

  if (!loaded || !["completed", "limited"].includes(loaded.repository.analysis_status as string)) {
    throw new HttpError("Analyse the repository before running an AI review.", 409);
  }

  if (!aiConfigured()) {
    throw new HttpError(
      "AI review is not configured on this deployment. Add DEEPSEEK_API_KEY as an " +
        "edge function secret; repository analysis still works without it.",
      503,
    );
  }

  const outcome = await runReview({
    submission: submission as unknown as Record<string, unknown>,
    hackathon: await loadHackathon(submission.hackathon_id),
    repository: loaded.repository,
    files: loaded.files,
    chunks: loaded.chunks,
    evidence: (loaded.evidence ?? []) as unknown as Evidence[],
    projectMap: (loaded.projectMap ?? {}) as unknown as ProjectMap,
    members: await loadMembers(submission.id),
    actorId: caller.id,
    sessionId: submission.session_id,
    onlyModules,
  });

  return {
    status: outcome.status,
    review_id: outcome.reviewId,
    modules: outcome.modules.map((module) => ({
      module: module.module,
      status: module.status,
      source: module.source,
      reason: module.reason ?? "",
    })),
    error: outcome.error ?? null,
  };
}

Deno.serve(
  withErrorHandling((req, url) => {
    if (req.method === "GET") return readAnalysis(req, url);
    if (req.method === "POST") return act(req);
    return fail("Method not allowed.", 405);
  }),
);
