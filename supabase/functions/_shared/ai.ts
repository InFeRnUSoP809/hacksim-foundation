/**
 * DeepSeek client and cost control (§5, §44, §45, §52, §53, §55, §57, §59).
 *
 * The API key never leaves this file. The client:
 *
 *   • asks for structured JSON and validates the shape before returning it,
 *   • retries exactly once on malformed JSON, with a compact correction request,
 *   • returns the provider's own usage numbers untouched — §57 makes the API
 *     response the source of truth, so nothing here estimates,
 *   • is structured for prompt caching: the stable prefix (system instructions,
 *     context) is sent as its own content block, ahead of the volatile task.
 *
 * Pricing lives in `ai_model_configs` so an admin can change it without a
 * deploy. Nothing in this file hardcodes a price.
 *
 * The gate runs *before* every request, in this order (§52):
 *   kill switch → model enabled → budget → estimate → allow or reject
 * A rejection never calls the provider, and it is still recorded in `ai_usage`
 * with status `rejected` so the ledger explains itself (§91).
 */

import { db } from "./http.ts";
import { hasDeepseek, settings, shortHash } from "./config.ts";

// The prefix DeepSeek can cache. Kept byte-identical between runs.
const CACHE_CONTROL = { type: "ephemeral" };

// §53 defaults, used only when no `ai_budgets` row exists.
const DEFAULT_MAX_COST_USD = 0.25;
const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_MAX_INPUT_TOKENS = 100_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 20_000;

// §75 alert thresholds, as a fraction of the budget.
const WARNING_THRESHOLD = 0.5;
const CRITICAL_THRESHOLD = 0.8;
const STOP_THRESHOLD = 1.0;

export class AIError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AIError";
  }
}

export interface AIResponse {
  content: string;
  parsed: Record<string, unknown> | null;
  requestId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  durationMs: number;
  promptVersion: string;
}

export const aiConfigured = hasDeepseek;

// ── Client ─────────────────────────────────────────────────────────────────

function parseJson(content: string): Record<string, unknown> | null {
  if (!content) return null;
  let text = content.trim();

  if (text.startsWith("```")) {
    const parts = text.split("```");
    text = parts.length >= 2 ? parts[1] : text;
    if (text.toLowerCase().startsWith("json")) text = text.slice(4);
    text = text.trim();
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the brace scan
  }

  // Last resort: the outermost braces of the reply.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  cache_miss_tokens: number;
}

/** Read the provider's own counters. Never estimate these (§57). */
function usageFields(usage: Record<string, unknown>): Usage {
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

  // DeepSeek reports cache behaviour on the prompt side.
  const cached = Number(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0);
  const missReported = Number(
    usage.prompt_cache_miss_tokens ?? usage.cache_creation_input_tokens ?? 0,
  );
  // Only the hit count is reported: the remainder is the miss.
  const cacheMiss = missReported ? missReported : Math.max(0, inputTokens - cached);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_tokens: cached,
    cache_miss_tokens: cacheMiss,
  };
}

async function post(input: {
  messages: unknown[];
  maxTokens: number;
  temperature: number;
  promptVersion: string;
}): Promise<AIResponse> {
  const config = settings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.deepseekTimeoutSeconds * 1000);

  let response: Response;
  try {
    response = await fetch(`${config.deepseekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.deepseekApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.deepseekModel,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        // Ask for JSON explicitly; the provider still needs a schema check.
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw aborted
      ? new AIError("The AI provider timed out.", "timeout")
      : new AIError(
          `Could not reach the AI provider: ${(error as Error)?.message ?? error}`,
          "network",
        );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new AIError("The AI provider rate limit was reached.", "rate_limited");
  }
  if (response.status === 401 || response.status === 403) {
    throw new AIError("The AI provider rejected the configured credentials.", "unauthorized");
  }
  if (response.status >= 400) {
    throw new AIError(
      `The AI provider returned an error (HTTP ${response.status}).`,
      "provider_error",
    );
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    throw new AIError("The AI provider returned a malformed response.", "bad_response");
  }

  const choices = (body.choices ?? []) as { message?: { content?: string } }[];
  const content = choices[0]?.message?.content ?? "";

  const usage = usageFields((body.usage ?? {}) as Record<string, unknown>);

  return {
    content,
    parsed: null,
    requestId: (body.id as string) ?? null,
    model: (body.model as string) || settings().deepseekModel,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedTokens: usage.cached_tokens,
    cacheMissTokens: usage.cache_miss_tokens,
    durationMs: 0,
    promptVersion: input.promptVersion,
  };
}

/** Stable-first message layout so repeated calls can hit the cache (§59). */
function messages(systemStable: string, contextStable: string, task: string) {
  return [
    {
      role: "system",
      content: [
        { type: "text", text: systemStable, cache_control: CACHE_CONTROL },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: contextStable, cache_control: CACHE_CONTROL },
        { type: "text", text: task },
      ],
    },
  ];
}

/** One structured call, with a single repair retry (§45). */
export async function completeJson(input: {
  systemStable: string;
  contextStable: string;
  task: string;
  promptVersion: string;
  maxOutputTokens?: number;
  temperature?: number;
}): Promise<AIResponse> {
  if (!aiConfigured()) {
    throw new AIError("AI is not configured on this deployment.", "not_configured");
  }

  const started = Date.now();
  const maxOutputTokens = input.maxOutputTokens ?? 2000;
  const temperature = input.temperature ?? 0.1;

  const response = await post({
    messages: messages(input.systemStable, input.contextStable, input.task),
    maxTokens: maxOutputTokens,
    temperature,
    promptVersion: input.promptVersion,
  });

  let durationMs = Date.now() - started;
  let parsed = parseJson(response.content);

  if (parsed === null) {
    // §45 — exactly one compact correction attempt. A second failure is
    // recorded as a module failure, not retried again.
    const repair = await post({
      messages: messages(
        input.systemStable,
        input.contextStable,
        input.task +
          "\n\nYour previous reply was not valid JSON. Reply with only a JSON " +
          "object matching the requested shape. No prose, no code fence.",
      ),
      maxTokens: maxOutputTokens,
      temperature: 0,
      promptVersion: input.promptVersion,
    });
    durationMs += Date.now() - started;
    parsed = parseJson(repair.content);

    // The repair call's usage is added so the ledger stays truthful.
    response.inputTokens += repair.inputTokens;
    response.outputTokens += repair.outputTokens;
    response.totalTokens += repair.totalTokens;
    response.cachedTokens += repair.cachedTokens;
    response.cacheMissTokens += repair.cacheMissTokens;
  }

  response.promptVersion = input.promptVersion;
  response.durationMs = durationMs;
  response.parsed = parsed;
  return response;
}

// ── Pricing ────────────────────────────────────────────────────────────────

export interface ModelPricing {
  provider: string;
  modelName: string;
  enabled: boolean;
  isDefault: boolean;
  inputPriceCacheHit: number;
  inputPriceCacheMiss: number;
  outputPrice: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  reasoningMode: string;
}

/** The enabled default model, or the enabled model matching the env var. */
export async function loadPricing(): Promise<ModelPricing | null> {
  const service = db();

  const { data } = await service
    .from("ai_model_configs")
    .select("*")
    .eq("enabled", true)
    .eq("is_default", true)
    .limit(1);

  let rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    // No default flagged — fall back to any enabled row.
    const fallback = await service
      .from("ai_model_configs")
      .select("*")
      .eq("enabled", true)
      .order("created_at")
      .limit(1);
    rows = (fallback.data ?? []) as Record<string, unknown>[];
  }
  if (rows.length === 0) return null;

  const row = rows[0];
  const envModel = settings().deepseekModel;
  const modelName = (row.model_name as string) || envModel;

  return {
    provider: (row.provider as string) || "deepseek",
    modelName,
    enabled: row.enabled !== false,
    isDefault: Boolean(row.is_default),
    inputPriceCacheHit: Number(row.input_price_per_million_cache_hit ?? 0),
    inputPriceCacheMiss: Number(row.input_price_per_million_cache_miss ?? 0),
    outputPrice: Number(row.output_price_per_million ?? 0),
    maxInputTokens: Number(row.max_input_tokens ?? 32000),
    maxOutputTokens: Number(row.max_output_tokens ?? 4000),
    reasoningMode: (row.reasoning_mode as string) || "off",
  };
}

/** §57. Per-million prices, applied to the provider's reported usage. */
export function calculateCost(
  pricing: ModelPricing,
  usage: { cachedTokens: number; cacheMissTokens: number; outputTokens: number },
): number {
  const million = 1_000_000;
  return (
    (usage.cachedTokens * pricing.inputPriceCacheHit +
      usage.cacheMissTokens * pricing.inputPriceCacheMiss +
      usage.outputTokens * pricing.outputPrice) /
    million
  );
}

/** A pre-flight estimate. Deliberately pessimistic (§52). */
export function estimateCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheRatio = 0,
): number {
  const cached = Math.floor(inputTokens * cacheRatio);
  const miss = Math.max(0, inputTokens - cached);
  return calculateCost(pricing, { cachedTokens: cached, cacheMissTokens: miss, outputTokens });
}

// ── Budgets ────────────────────────────────────────────────────────────────

export interface BudgetSnapshot {
  maxCostUsd: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxRequests: number | null;
  usedCostUsd: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  usedRequests: number;
  enabled: boolean;
}

export function utilization(budget: BudgetSnapshot): number {
  if (!budget.maxCostUsd) return 0;
  return budget.usedCostUsd / budget.maxCostUsd;
}

/** Which alert band this snapshot is in (§75). */
export function budgetLevel(budget: BudgetSnapshot): string {
  const ratio = utilization(budget);
  if (ratio >= STOP_THRESHOLD) return "stop";
  if (ratio >= CRITICAL_THRESHOLD) return "critical";
  if (ratio >= WARNING_THRESHOLD) return "warning";
  return "normal";
}

function overLimit(budget: BudgetSnapshot): boolean {
  if (budget.maxCostUsd !== null && budget.usedCostUsd >= budget.maxCostUsd) return true;
  if (budget.maxRequests !== null && budget.usedRequests >= budget.maxRequests) return true;
  if (budget.maxInputTokens && budget.usedInputTokens >= budget.maxInputTokens) return true;
  if (budget.maxOutputTokens && budget.usedOutputTokens >= budget.maxOutputTokens) return true;
  return false;
}

export async function loadBudget(submissionId: string | null): Promise<BudgetSnapshot> {
  const { data } = await db().rpc("ai_budget_for_submission", {
    p_submission_id: submissionId,
  });
  const row = ((data ?? []) as Record<string, unknown>[])[0];

  if (!row) {
    return {
      maxCostUsd: DEFAULT_MAX_COST_USD,
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxRequests: DEFAULT_MAX_REQUESTS,
      usedCostUsd: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      usedRequests: 0,
      enabled: true,
    };
  }

  return {
    maxCostUsd:
      row.max_cost_usd === null || row.max_cost_usd === undefined
        ? null
        : Number(row.max_cost_usd),
    maxInputTokens: row.max_input_tokens ? Number(row.max_input_tokens) : null,
    maxOutputTokens: row.max_output_tokens ? Number(row.max_output_tokens) : null,
    maxRequests: row.max_requests ? Number(row.max_requests) : null,
    usedCostUsd: Number(row.used_cost_usd ?? 0),
    usedInputTokens: Number(row.used_input_tokens ?? 0),
    usedOutputTokens: Number(row.used_output_tokens ?? 0),
    usedRequests: Number(row.used_requests ?? 0),
    enabled: row.enabled !== false,
  };
}

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  estimatedCostUsd: number;
  budget: BudgetSnapshot | null;
}

/** The §52 gate. Returns a decision; never throws. */
export async function checkBudget(input: {
  pricing: ModelPricing;
  submissionId: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheRatio?: number;
}): Promise<BudgetDecision> {
  if (!input.pricing.enabled) {
    return { allowed: false, reason: "model_disabled", estimatedCostUsd: 0, budget: null };
  }

  const budget = await loadBudget(input.submissionId);

  if (!budget.enabled) {
    return { allowed: false, reason: "ai_disabled", estimatedCostUsd: 0, budget };
  }

  if (overLimit(budget)) {
    return { allowed: false, reason: `budget_exceeded:${budgetLevel(budget)}`, estimatedCostUsd: 0, budget };
  }

  const estimate = estimateCost(
    input.pricing,
    input.estimatedInputTokens,
    input.estimatedOutputTokens,
    input.cacheRatio ?? 0,
  );

  if (budget.maxCostUsd !== null && budget.usedCostUsd + estimate > budget.maxCostUsd) {
    return { allowed: false, reason: "budget_would_be_exceeded", estimatedCostUsd: estimate, budget };
  }
  if (budget.maxInputTokens && input.estimatedInputTokens > budget.maxInputTokens) {
    return { allowed: false, reason: "input_token_limit", estimatedCostUsd: estimate, budget };
  }
  if (input.estimatedInputTokens > input.pricing.maxInputTokens) {
    return { allowed: false, reason: "model_input_limit", estimatedCostUsd: estimate, budget };
  }

  return { allowed: true, reason: "", estimatedCostUsd: estimate, budget };
}

// ── §58 cache identity ─────────────────────────────────────────────────────

/** Stable hash of the context that shaped a call. */
export function contextHash(parts: unknown[], promptVersion: string, model: string) {
  return shortHash(JSON.stringify([parts, promptVersion, model]));
}

/** A previously successful result for this exact identity, if any. */
export async function findCachedAnalysis(input: {
  repositoryId: string | null;
  analysisType: string;
  promptVersion: string;
  model: string;
  ctxHash: string;
}): Promise<Record<string, unknown> | null> {
  let query = db()
    .from("ai_analyses")
    .select("*")
    .eq("analysis_type", input.analysisType)
    .eq("prompt_version", input.promptVersion)
    .eq("model", input.model)
    .eq("context_hash", input.ctxHash)
    .eq("status", "success")
    .limit(1);

  query = input.repositoryId
    ? query.eq("repository_id", input.repositoryId)
    : query.is("repository_id", null);

  const { data } = await query;
  return ((data ?? []) as Record<string, unknown>[])[0] ?? null;
}

/** Persist a result or a failure. Failures are stored, not discarded (§45). */
export async function saveAnalysis(input: {
  analysisType: string;
  provider: string;
  model: string;
  promptVersion: string;
  ctxHash: string;
  status: string;
  resultPayload: Record<string, unknown> | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  repositoryId?: string | null;
  submissionId?: string | null;
  scopeKey?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  completedAt?: string | null;
}): Promise<string | null> {
  try {
    const { data, error } = await db()
      .from("ai_analyses")
      .insert({
        repository_id: input.repositoryId ?? null,
        submission_id: input.submissionId ?? null,
        analysis_type: input.analysisType,
        scope_key: input.scopeKey ?? null,
        provider: input.provider,
        model: input.model,
        model_version: input.model,
        prompt_version: input.promptVersion,
        context_hash: input.ctxHash,
        input_hash: null,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        total_tokens: input.totalTokens,
        cached_tokens: input.cachedTokens,
        cache_miss_tokens: input.cacheMissTokens,
        estimated_cost_usd: input.costUsd,
        result: input.resultPayload,
        status: input.status,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
        completed_at: input.completedAt ?? null,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.warn("[hacksim.budget] could not persist ai_analyses row:", error?.message);
      return null;
    }
    return (data as { id: string }).id;
  } catch (error) {
    // Accounting must never break a scan.
    console.warn("[hacksim.budget] could not persist ai_analyses row:", error);
    return null;
  }
}

export interface UsageRecord {
  operation: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  costUsd: number;
  requestId: string | null;
  status: "pending" | "success" | "failed" | "rejected";
  durationMs: number;
  userId?: string | null;
  submissionId?: string | null;
  repositoryId?: string | null;
  sessionId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** Write one `ai_usage` row per request — success, failure or rejection. */
export async function recordUsage(row: UsageRecord): Promise<void> {
  try {
    const { error } = await db().rpc("ai_record_usage", {
      p_operation: row.operation,
      p_provider: row.provider,
      p_model: row.model,
      p_prompt_version: row.promptVersion,
      p_input_tokens: row.inputTokens,
      p_output_tokens: row.outputTokens,
      p_cached_tokens: row.cachedTokens,
      p_cost_usd: row.costUsd,
      p_request_id: row.requestId,
      p_status: row.status,
      p_error_code: row.errorCode ?? null,
      p_error_message: row.errorMessage ? row.errorMessage.slice(0, 500) : null,
      p_duration_ms: row.durationMs,
      p_user_id: row.userId ?? null,
      p_submission_id: row.submissionId ?? null,
      p_repository_id: row.repositoryId ?? null,
      p_session_id: row.sessionId ?? null,
    });
    if (error) console.warn("[hacksim.budget] could not record ai_usage:", error.message);
  } catch (error) {
    console.warn("[hacksim.budget] could not record ai_usage:", error);
  }
}
