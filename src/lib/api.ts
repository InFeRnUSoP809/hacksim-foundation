/**
 * Client for the HackSim FastAPI service (Phase 5 + Phase 6).
 *
 * Repository analysis and AI review have to run server-side: the GitHub and
 * DeepSeek credentials must never reach a browser, and the AI cache and budget
 * counters are only trustworthy in one place.
 *
 * The service is optional. Phase 1–4 works entirely through Supabase, so if the
 * API is not deployed, every function here fails with a clear, actionable
 * message instead of a bare network error.
 */

import { supabase } from "@/lib/supabase";
import type {
  AiBudgetRow,
  AiModelConfig,
  AiOverview,
  AiUsageRow,
  CacheAnalytics,
  CostForecast,
  Repository,
  ReviewRunResult,
  SubmissionAnalysis,
} from "@/types/analysis";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiUnavailableError extends Error {
  constructor() {
    super(
      "Repository analysis and AI review run on the HackSim API, which isn't " +
        "reachable. Everything else keeps working — set VITE_API_URL to the " +
        "deployed API to enable it.",
    );
    this.name = "ApiUnavailableError";
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<T> {
  if (!API_BASE) throw new ApiUnavailableError();

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders()),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiUnavailableError();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail =
      (body as { detail?: string } | null)?.detail ??
      `The request failed (HTTP ${response.status}).`;
    throw new Error(detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const isApiConfigured = Boolean(API_BASE);

// ── Analysis (Phase 5 + 6) ────────────────────────────────────────────────

/**
 * The full analysis for a submission, read straight from the database via the
 * `submission_analysis` RPC. This works without the API, because the data is
 * already stored.
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
export async function analyzeRepository(
  submissionId: string,
): Promise<{ status: string; repository_id?: string; file_count?: number }> {
  return request(`/api/analysis/submissions/${submissionId}/repository`, {
    method: "POST",
  });
}

/** §42 — run the AI modules. */
export async function runReview(
  submissionId: string,
  module?: string,
): Promise<ReviewRunResult> {
  const query = module ? `?only_module=${encodeURIComponent(module)}` : "";
  return request(`/api/analysis/submissions/${submissionId}/review${query}`, {
    method: "POST",
  });
}

/** §89 — force a fresh scan, ignoring the commit cache. */
export async function reanalyzeRepository(
  submissionId: string,
): Promise<{ status: string }> {
  return request(`/api/analysis/submissions/${submissionId}/reanalyze`, {
    method: "POST",
  });
}

export async function retryModule(
  submissionId: string,
  module: string,
): Promise<{ status: string }> {
  return request(
    `/api/analysis/submissions/${submissionId}/retry-module?module=${encodeURIComponent(module)}`,
    { method: "POST" },
  );
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

// ── AI operations (admin, API-backed) ────────────────────────────────────

export async function getAiOverview(days = 30): Promise<AiOverview> {
  return request(`/api/ai/overview?days=${days}`);
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
  const query = new URLSearchParams();
  if (params.days) query.set("days", String(params.days));
  if (params.operation) query.set("operation", params.operation);
  if (params.model) query.set("model", params.model);
  if (params.status) query.set("status", params.status);
  if (params.submissionId) query.set("submission_id", params.submissionId);
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));
  return request(`/api/ai/usage?${query.toString()}`);
}

export async function getAiRequest(requestId: string) {
  return request<{
    request: Record<string, unknown>;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    pricing: Record<string, number>;
  }>(`/api/ai/requests/${encodeURIComponent(requestId)}`);
}

export async function getAiErrors(days = 30) {
  return request<{
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
  }>(`/api/ai/errors?days=${days}`);
}

export async function getAiBudgets(): Promise<{ budgets: AiBudgetRow[] }> {
  return request("/api/ai/budgets");
}

export async function saveAiBudget(payload: Record<string, unknown>) {
  return request<{ ok: boolean }>("/api/ai/budgets", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteAiBudget(budgetId: string) {
  return request<{ ok: boolean }>(`/api/ai/budgets/${budgetId}`, {
    method: "DELETE",
  });
}

export async function getAiSettingsPage(): Promise<{
  models: AiModelConfig[];
  global_budget: Record<string, unknown> | null;
  kill_switch: { ai_enabled: boolean };
}> {
  return request("/api/ai/settings");
}

export async function saveAiModel(payload: Record<string, unknown>) {
  return request<{ ok: boolean }>("/api/ai/settings/models", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** §55 — the kill switch. Off means no new AI calls. */
export async function setAiEnabled(enabled: boolean) {
  return request<{ ok: boolean }>(
    `/api/ai/settings/kill-switch?enabled=${enabled}`,
    { method: "POST" },
  );
}

export async function getCostForecast(): Promise<CostForecast> {
  return request("/api/ai/forecast");
}

export async function getCacheAnalytics(days = 30): Promise<CacheAnalytics> {
  return request(`/api/ai/cache-analytics?days=${days}`);
}
