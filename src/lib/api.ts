/**
 * Client for HackSim's Phase 5 + Phase 6 services.
 *
 * Repository analysis and AI review run in Supabase Edge Functions, never in the
 * browser: the GitHub and DeepSeek credentials are edge function secrets, and the
 * AI cache and budget counters are only trustworthy in one place.
 *
 * The frontend calls them with `supabase.functions.invoke`, so the caller's JWT
 * travels in the Authorization header and the platform verifies it before the
 * function runs. There is no API base URL to configure and no CORS setup.
 *
 * Reads that need no model still go straight to the database through RPCs
 * (`submission_analysis`, `admin_repositories`, …), so the analysis pages keep
 * working even if the functions are not deployed.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import type {
  AiBudgetRow,
  AiModelConfig,
  AiOverview,
  AiUsageRow,
  CacheAnalytics,
  CostForecast,
  PreflightReport,
  Repository,
  ReviewRunResult,
  SubmissionAnalysis,
} from "@/types/analysis";
import type { V2AnalysisStatus, V2AnalysisSummary } from "@/types/v2-analysis";

/**
 * Whether the Phase 5/6 services can be called at all.
 *
 * With edge functions there is no separate API to configure: they live in the
 * same Supabase project as the app, reached through the same client. This stays
 * as a named export so the admin pages can keep explaining the state of the
 * system rather than rendering a button that silently fails.
 */
export const isApiConfigured = isSupabaseConfigured;

export class EdgeFunctionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeFunctionError";
  }
}

/**
 * Invoke an edge function and normalise its error into a real message. A missing
 * function returns a bare network error, which would otherwise surface as
 * "Failed to fetch" and tell the user nothing.
 */
async function invoke<T>(
  name: string,
  init: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const query = init.query
    ? `?${new URLSearchParams(
        Object.entries(init.query).filter(([, value]) => value !== ""),
      ).toString()}`
    : "";

  let response: { data: T | null; error: { message: string } | null };
  try {
    response = await supabase.functions.invoke<T>(`${name}${query}`, {
      method: init.method ?? "POST",
      body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    });
  } catch {
    throw new EdgeFunctionError(
      `The "${name}" edge function is not reachable. Deploy it with ` +
        "`supabase functions deploy analysis`.",
    );
  }

  if (response.error) {
    throw new EdgeFunctionError(await edgeErrorMessage(response.error));
  }
  return response.data as T;
}

/**
 * Pull the function's own `detail` out of a failed invoke.
 *
 * Older supabase-js embedded the response body in `error.message`; current
 * versions keep the raw `Response` on `error.context` and reduce the message
 * to a bare "Edge Function returned a non-2xx status code" — which hides
 * everything the function tried to say (a GitHub rate limit, a missing
 * secret, a bad URL). Both shapes are handled here so the pages can show the
 * real reason a scan failed.
 */
async function edgeErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: unknown })?.context as Response | undefined;
  if (context && typeof context.json === "function") {
    try {
      const body = (await context.json()) as { detail?: unknown; message?: unknown };
      const detail =
        typeof body.detail === "string"
          ? body.detail
          : typeof body.message === "string"
            ? body.message
            : "";
      if (detail) return detail;
    } catch {
      // Non-JSON body (a platform error page, an empty body) — fall through.
    }
  }

  const raw = (error as { message?: string })?.message ?? "";
  const match = raw.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return match ? JSON.parse(`"${match[1]}"`) : raw;
}

// ── Analysis (Phase 5 + 6) ────────────────────────────────────────────────

/**
 * The full analysis for a submission, read straight from the database via the
 * `submission_analysis` RPC. This works without the edge functions, because the
 * data is already stored.
 */
export async function getSubmissionAnalysis(
  submissionId: string,
): Promise<SubmissionAnalysis> {
  const { data, error } = await supabase.rpc("submission_analysis", {
    p_submission_id: submissionId,
  });
  if (error) throw new Error(error.message);
  return data as SubmissionAnalysis;
}

/** §13 — run Phase 5. Deterministic, and costs no AI tokens. */
export async function analyzeRepository(submissionId: string): Promise<{
  status: string;
  repository_id?: string;
  file_count?: number;
}> {
  return invoke("analysis", { body: { action: "repository", submission_id: submissionId } });
}

/**
 * Run the analysis.
 *
 * The function plans the work itself: it reads the hackathon, decides which
 * dimensions matter, retrieves the code each requirement actually needs, and
 * calls a model only where the scan could not conclude. `onlyTask` re-runs a
 * single named task, which is what a "retry" button uses.
 */
export async function runReview(
  submissionId: string,
  onlyTask?: string,
): Promise<ReviewRunResult> {
  return invoke("analysis", {
    body: {
      action: "analyze",
      submission_id: submissionId,
      only_task: onlyTask ?? "",
    },
  });
}

/** §89 — force a fresh scan, ignoring the commit cache. */
export async function reanalyzeRepository(submissionId: string): Promise<{ status: string }> {
  return invoke("analysis", { body: { action: "reanalyze", submission_id: submissionId } });
}

/** V2 — enqueue background repository intelligence analysis. */
export async function startV2Analysis(submissionId: string): Promise<{
  run_id: string;
  status: string;
  cached?: boolean;
  message?: string;
}> {
  return invoke("analysis", { body: { action: "start-v2", submission_id: submissionId } });
}

export async function retryV2Analysis(submissionId: string): Promise<{
  run_id: string;
  status: string;
  message?: string;
}> {
  return invoke("analysis", { body: { action: "retry-v2", submission_id: submissionId } });
}

/** Read-only status from PostgreSQL (no edge side effects). */
export async function getV2AnalysisStatusRpc(submissionId: string): Promise<V2AnalysisStatus | null> {
  const { data, error } = await supabase.rpc("analysis_run_status", {
    p_submission_id: submissionId,
  });
  if (error) return null;
  return (data ?? null) as V2AnalysisStatus | null;
}

/** Read-only summary from PostgreSQL (reopen without GitHub/DeepSeek). */
export async function getV2AnalysisSummaryRpc(submissionId: string): Promise<V2AnalysisSummary> {
  const { data, error } = await supabase.rpc("v2_analysis_summary", {
    p_submission_id: submissionId,
  });
  if (error) throw new Error(error.message);
  return (data ?? { ready: false }) as V2AnalysisSummary;
}

export async function getV2EvidencePage(
  runId: string,
  params: {
    limit?: number;
    offset?: number;
    level?: string;
    type?: string;
    file?: string;
    search?: string;
    confidence?: string;
  } = {},
): Promise<{ items: unknown[]; total: number }> {
  const { data, error } = await supabase.rpc("v2_analysis_evidence_page", {
    p_run_id: runId,
    p_limit: params.limit ?? 25,
    p_offset: params.offset ?? 0,
    p_level: params.level ?? null,
    p_type: params.type ?? null,
    p_file: params.file ?? null,
    p_search: params.search ?? null,
    p_confidence: params.confidence ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { items: unknown[]; total: number };
}

export async function getV2RelationshipsPage(
  runId: string,
  params: { limit?: number; offset?: number; type?: string } = {},
): Promise<{ items: unknown[]; total: number }> {
  const { data, error } = await supabase.rpc("v2_analysis_relationships_page", {
    p_run_id: runId,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
    p_type: params.type ?? null,
  });
  if (error) throw new Error(error.message);
  return data as { items: unknown[]; total: number };
}

export async function getV2EvidenceDetail(runId: string, evidenceId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.rpc("v2_evidence_detail", {
    p_run_id: runId,
    p_evidence_id: evidenceId,
  });
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

/** @deprecated Prefer getV2AnalysisStatusRpc for polling. */
export async function getV2AnalysisStatus(submissionId: string): Promise<V2AnalysisStatus> {
  return invoke("analysis", { body: { action: "status-v2", submission_id: submissionId } });
}

/** @deprecated Prefer getV2AnalysisSummaryRpc for completed reports. */
export async function getV2AnalysisSummary(submissionId: string): Promise<V2AnalysisSummary> {
  return invoke("analysis", { body: { action: "summary-v2", submission_id: submissionId } });
}

export async function retryModule(
  submissionId: string,
  task: string,
): Promise<{ status: string }> {
  return invoke("analysis", {
    body: { action: "retry-task", submission_id: submissionId, task },
  });
}

/** §55 — why the analysis concluded what it did. Admin only. */
export async function getAnalysisDiagnostics(
  submissionId: string,
): Promise<Record<string, unknown>> {
  return invoke("analysis", {
    body: { action: "diagnostics", submission_id: submissionId },
  });
}

// ── Admin: repositories and reviews (database-only reads) ─────────────────

export async function getAdminRepositories(): Promise<
  Awaited<ReturnType<typeof supabase.rpc>>["data"]
> {
  const { data, error } = await supabase.rpc("admin_repositories");
  if (error) throw new Error(error.message);
  return data;
}

export async function getAdminProjectReviews() {
  const { data, error } = await supabase.rpc("admin_project_reviews");
  if (error) throw new Error(error.message);
  return data;
}

export async function getAdminAnalysisStats() {
  const { data, error } = await supabase.rpc("admin_analysis_stats");
  if (error) throw new Error(error.message);
  return data;
}

export async function getRepositoryForSubmission(
  submissionId: string,
): Promise<Repository | null> {
  const { data, error } = await supabase
    .from("repositories")
    .select("*")
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (error) {
    if (/no rows/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  return (data as Repository | null) ?? null;
}

// ── AI operations (admin) ─────────────────────────────────────────────────

export async function getAiOverview(days = 30): Promise<AiOverview> {
  return invoke("ai-admin", { method: "GET", query: { view: "overview", days: String(days) } });
}

export async function getAiUsage(
  params: {
    days?: number;
    operation?: string;
    model?: string;
    status?: string;
    submissionId?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ rows: AiUsageRow[]; count: number }> {
  return invoke("ai-admin", {
    method: "GET",
    query: {
      view: "usage",
      days: String(params.days ?? 30),
      operation: params.operation ?? "",
      model: params.model ?? "",
      status: params.status ?? "",
      submission_id: params.submissionId ?? "",
      limit: String(params.limit ?? 100),
      offset: String(params.offset ?? 0),
    },
  });
}

export async function getAiRequest(requestId: string) {
  return invoke<{
    request: Record<string, unknown>;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    pricing: Record<string, number>;
  }>("ai-admin", { method: "GET", query: { view: "request", request_id: requestId } });
}

export async function getAiErrors(days = 30) {
  return invoke<{
    rows: {
      id: string;
      created_at: string;
      operation: string;
      model: string;
      status: string;
      error_code: string | null;
      error_message: string | null;
      duration_ms: number | null;
    }[];
    counts: Record<string, number>;
    total: number;
  }>("ai-admin", { method: "GET", query: { view: "errors", days: String(days) } });
}

export async function getAiBudgets(): Promise<{ budgets: AiBudgetRow[] }> {
  return invoke("ai-admin", { method: "GET", query: { view: "budgets" } });
}

export async function saveAiBudget(payload: Record<string, unknown>) {
  return invoke<{ ok: boolean }>("ai-admin", { body: { view: "budget", payload } });
}

export async function deleteAiBudget(budgetId: string) {
  return invoke<{ ok: boolean }>("ai-admin", { body: { view: "budget-delete", budget_id: budgetId } });
}

export async function getAiSettingsPage(): Promise<{
  models: AiModelConfig[];
  global_budget: Record<string, unknown> | null;
  kill_switch: { ai_enabled: boolean };
}> {
  return invoke("ai-admin", { method: "GET", query: { view: "settings" } });
}

export async function saveAiModel(payload: Record<string, unknown>) {
  return invoke<{ ok: boolean }>("ai-admin", { body: { view: "model", payload } });
}

/** §55 — the kill switch. Off means no new AI calls. */
export async function setAiEnabled(enabled: boolean) {
  return invoke<{ ok: boolean; ai_enabled: boolean }>("ai-admin", {
    body: { view: "kill-switch", enabled },
  });
}

export async function getCostForecast(): Promise<CostForecast> {
  return invoke("ai-admin", { method: "GET", query: { view: "forecast" } });
}

export async function getCacheAnalytics(days = 30): Promise<CacheAnalytics> {
  return invoke("ai-admin", { method: "GET", query: { view: "cache-analytics", days: String(days) } });
}

/**
 * §77 preflight — can the analysis pipeline actually run?
 *
 * This exists because the worst failure mode after a deploy is a silent one: no
 * secret set, no error thrown, no scan ever starts, and a page that just never
 * loads. It pokes the real providers instead of reporting whether a variable is
 * non-empty, so the answer is a fact rather than an assumption.
 */
export async function getPreflight(): Promise<PreflightReport> {
  return invoke("ai-admin", { method: "GET", query: { view: "preflight" } });
}
