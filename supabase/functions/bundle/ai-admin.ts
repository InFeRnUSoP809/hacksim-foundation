// ─────────────────────────────────────────────────────────────────────
// GENERATED FILE — do not edit.
//
// Built by scripts/bundle-functions.sh from
//   supabase/functions/ai-admin/index.ts
// plus supabase/functions/_shared/*.ts
//
// Edit the sources, then re-run the script. Changes made here are lost.
// 619 lines, self-contained — safe to paste into the Supabase dashboard.
// ─────────────────────────────────────────────────────────────────────

// _shared/http.ts
import { createClient } from "npm:@supabase/supabase-js@2";
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
function fail(message, status = 400, extra) {
  return json({ detail: message, ...extra ? { extra } : {} }, status);
}
function preflight() {
  return new Response("ok", { headers: corsHeaders });
}
function requireEnv(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set on the edge function.`);
  return value;
}
var serviceClient = null;
function db() {
  if (!serviceClient) {
    serviceClient = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return serviceClient;
}
var callerCache = null;
async function getCaller(req) {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  if (callerCache && callerCache.token === token) return callerCache.caller;
  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) return null;
  const user = data.user;
  const { data: profile } = await db().from("profiles").select("id, email, role").eq("id", user.id).maybeSingle();
  const caller = {
    id: user.id,
    email: profile?.email ?? user.email ?? "",
    role: profile?.role === "admin" ? "admin" : "student"
  };
  callerCache = { token, caller };
  return caller;
}
function requireAdmin(caller) {
  if (!caller) throw new HttpError("Invalid or expired session.", 401);
  if (caller.role !== "admin") {
    throw new HttpError("You are not authorized to perform this action.", 403);
  }
  return caller;
}
var HttpError = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
};
function withErrorHandling(handler) {
  return async (req) => {
    if (req.method === "OPTIONS") return preflight();
    try {
      return await handler(req, new URL(req.url));
    } catch (error) {
      if (error instanceof HttpError) return fail(error.message, error.status);
      console.error("[hacksim] unhandled error", error);
      return fail("Something went wrong on the server.", 500);
    }
  };
}

// _shared/ai.ts
function num(name, fallback) {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function str(name, fallback) {
  return Deno.env.get(name) || fallback;
}
var cached = null;
function settings() {
  if (cached) return cached;
  cached = {
    githubToken: str("GITHUB_TOKEN", ""),
    githubApiBase: str("GITHUB_API_BASE", "https://api.github.com"),
    githubTimeoutSeconds: num("GITHUB_TIMEOUT_SECONDS", 20),
    githubMaxRetries: num("GITHUB_MAX_RETRIES", 3),
    deepseekApiKey: str("DEEPSEEK_API_KEY", ""),
    deepseekModel: str("DEEPSEEK_MODEL", "deepseek-flash"),
    deepseekBaseUrl: str("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    deepseekTimeoutSeconds: num("DEEPSEEK_TIMEOUT_SECONDS", 60),
    analysisMaxFiles: num("ANALYSIS_MAX_FILES", 400),
    analysisLargeRepoThreshold: num("ANALYSIS_LARGE_REPO_THRESHOLD", 2e3),
    analysisMaxFileBytes: num("ANALYSIS_MAX_FILE_BYTES", 4e5),
    retrievalMaxFiles: num("RETRIEVAL_MAX_FILES", 6),
    retrievalMaxSnippetLines: num("RETRIEVAL_MAX_SNIPPET_LINES", 120)
  };
  return cached;
}
function hasDeepseek() {
  return Boolean(settings().deepseekApiKey);
}
var DEFAULT_MAX_COST_USD = 0.25;
var DEFAULT_MAX_REQUESTS = 30;
var DEFAULT_MAX_INPUT_TOKENS = 1e5;
var DEFAULT_MAX_OUTPUT_TOKENS = 2e4;
var WARNING_THRESHOLD = 0.5;
var CRITICAL_THRESHOLD = 0.8;
var STOP_THRESHOLD = 1;
function utilization(budget) {
  if (!budget.maxCostUsd) return 0;
  return budget.usedCostUsd / budget.maxCostUsd;
}
function budgetLevel(budget) {
  const ratio = utilization(budget);
  if (ratio >= STOP_THRESHOLD) return "stop";
  if (ratio >= CRITICAL_THRESHOLD) return "critical";
  if (ratio >= WARNING_THRESHOLD) return "warning";
  return "normal";
}
async function loadBudget(submissionId) {
  const { data } = await db().rpc("ai_budget_for_submission", {
    p_submission_id: submissionId
  });
  const row = (data ?? [])[0];
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
      enabled: true
    };
  }
  return {
    maxCostUsd: row.max_cost_usd === null || row.max_cost_usd === void 0 ? null : Number(row.max_cost_usd),
    maxInputTokens: row.max_input_tokens ? Number(row.max_input_tokens) : null,
    maxOutputTokens: row.max_output_tokens ? Number(row.max_output_tokens) : null,
    maxRequests: row.max_requests ? Number(row.max_requests) : null,
    usedCostUsd: Number(row.used_cost_usd ?? 0),
    usedInputTokens: Number(row.used_input_tokens ?? 0),
    usedOutputTokens: Number(row.used_output_tokens ?? 0),
    usedRequests: Number(row.used_requests ?? 0),
    enabled: row.enabled !== false
  };
}

// ai-admin/index.ts
function windowStart(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1e3).toISOString();
}
function intParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
function budgetView(row) {
  if (!row) return null;
  const maxCost = Number(row.max_cost_usd ?? 0);
  const usedCost = Number(row.used_cost_usd ?? 0);
  const ratio = maxCost ? usedCost / maxCost : 0;
  return {
    max_cost_usd: maxCost,
    used_cost_usd: usedCost,
    max_requests: row.max_requests ?? null,
    used_requests: row.used_requests ?? 0,
    max_input_tokens: row.max_input_tokens ?? null,
    used_input_tokens: row.used_input_tokens ?? 0,
    utilization: Number(ratio.toFixed(4)),
    level: ratio >= 1 ? "stop" : ratio >= 0.8 ? "critical" : ratio >= 0.5 ? "warning" : "normal",
    enabled: row.enabled !== false
  };
}
async function usageSummary(days) {
  const { data } = await db().rpc("ai_usage_summary", { p_since: windowStart(days) });
  return data ?? {};
}
async function userEmails(ids) {
  if (ids.length === 0) return /* @__PURE__ */ new Map();
  const { data } = await db().from("profiles").select("id, email").in("id", ids);
  return new Map(
    (data ?? []).map((row) => [row.id, row.email])
  );
}
async function projectNames(ids) {
  if (ids.length === 0) return /* @__PURE__ */ new Map();
  const { data } = await db().from("submissions").select("id, project_name").in("id", ids);
  return new Map(
    (data ?? []).map((row) => [
      row.id,
      row.project_name || null
    ])
  );
}
async function overview(url) {
  const days = intParam(url, "days", 30, 1, 365);
  const summary = await usageSummary(days);
  const inputTokens = Number(summary.input_tokens ?? 0);
  const cachedTokens = Number(summary.cached_tokens ?? 0);
  const totalCost = Number(summary.total_cost ?? 0);
  const requests = Number(summary.requests ?? 0);
  const [{ data: analyses }, { data: spend }, { data: budgets }] = await Promise.all([
    db().from("ai_analyses").select("id").eq("status", "success"),
    db().from("ai_usage").select("submission_id").eq("status", "success").not("submission_id", "is", null),
    db().from("ai_budgets").select("*").eq("scope", "global").limit(1)
  ]);
  const globalBudget = (budgets ?? [])[0];
  const distinctSubmissions = new Set(
    (spend ?? []).map((row) => row.submission_id)
  ).size;
  return {
    window_days: days,
    total_requests: requests,
    successful: Number(summary.success ?? 0),
    failed: Number(summary.failed ?? 0),
    rejected: Number(summary.rejected ?? 0),
    input_tokens: inputTokens,
    output_tokens: Number(summary.output_tokens ?? 0),
    cached_tokens: cachedTokens,
    cache_miss_tokens: Math.max(0, inputTokens - cachedTokens),
    cache_hit_rate: inputTokens ? Number((cachedTokens / inputTokens).toFixed(4)) : 0,
    total_cost_usd: totalCost,
    average_cost_per_submission: distinctSubmissions ? Number((totalCost / distinctSubmissions).toFixed(6)) : 0,
    successful_analyses: (analyses ?? []).length,
    error_codes: summary.error_codes ?? {},
    global_budget: budgetView(globalBudget)
  };
}
async function usage(url) {
  const days = intParam(url, "days", 30, 1, 365);
  const limit = intParam(url, "limit", 100, 1, 500);
  const offset = intParam(url, "offset", 0, 0, 1e6);
  let query = db().from("ai_usage").select(
    "id, created_at, user_id, submission_id, repository_id, operation, provider, model, input_tokens, output_tokens, total_tokens, cached_tokens, estimated_cost_usd, status, error_code, duration_ms, request_id",
    { count: "exact" }
  ).gte("created_at", windowStart(days));
  const operation = url.searchParams.get("operation");
  const model = url.searchParams.get("model");
  const statusFilter = url.searchParams.get("status");
  const submissionId = url.searchParams.get("submission_id");
  if (operation) query = query.eq("operation", operation);
  if (model) query = query.eq("model", model);
  if (statusFilter) query = query.eq("status", statusFilter);
  if (submissionId) query = query.eq("submission_id", submissionId);
  const { data, error, count } = await query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new HttpError(error.message, 400);
  const rows = data ?? [];
  const emails = await userEmails(rows.map((r) => r.user_id).filter(Boolean));
  const names = await projectNames(
    rows.map((r) => r.submission_id).filter(Boolean)
  );
  return {
    rows: rows.map((row) => ({
      ...row,
      user_email: emails.get(row.user_id) ?? null,
      project_name: names.get(row.submission_id) ?? null
    })),
    count: count ?? rows.length,
    limit,
    offset
  };
}
async function requestDetail(requestId) {
  const { data } = await db().from("ai_usage").select("*").eq("request_id", requestId).limit(1);
  const row = (data ?? [])[0];
  if (!row) throw new HttpError("That request was not found.", 404);
  const { data: pricingRows } = await db().from("ai_model_configs").select("*").eq("provider", row.provider ?? "deepseek").eq("model_name", row.model ?? "").limit(1);
  const price = (pricingRows ?? [])[0] ?? {};
  const hit = Number(price.input_price_per_million_cache_hit ?? 0);
  const miss = Number(price.input_price_per_million_cache_miss ?? 0);
  const out = Number(price.output_price_per_million ?? 0);
  const portion = (tokens, pricePerMillion) => Number((tokens * pricePerMillion / 1e6).toFixed(8));
  const cached2 = Number(row.cached_tokens ?? 0);
  const missTokens = Number(row.cache_miss_tokens ?? 0);
  const output = Number(row.output_tokens ?? 0);
  return {
    request: {
      request_id: row.request_id,
      provider: row.provider,
      model: row.model,
      operation: row.operation,
      prompt_version: row.prompt_version,
      status: row.status,
      duration_ms: row.duration_ms,
      created_at: row.created_at,
      error_code: row.error_code,
      error_message: row.error_message
    },
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      total: row.total_tokens,
      cached: cached2,
      cache_miss: missTokens
    },
    cost: {
      cache_hit: portion(cached2, hit),
      cache_miss: portion(missTokens, miss),
      output: portion(output, out),
      total: Number(row.estimated_cost_usd ?? 0)
    },
    pricing: {
      input_price_per_million_cache_hit: hit,
      input_price_per_million_cache_miss: miss,
      output_price_per_million: out
    }
  };
}
async function errors(url) {
  const days = intParam(url, "days", 30, 1, 365);
  const limit = intParam(url, "limit", 100, 1, 500);
  const { data } = await db().from("ai_usage").select(
    "id, created_at, operation, model, status, error_code, error_message, duration_ms"
  ).gte("created_at", windowStart(days)).in("status", ["failed", "rejected"]).order("created_at", { ascending: false }).limit(limit);
  const rows = data ?? [];
  const counts = {};
  for (const row of rows) {
    const code = row.error_code || "unknown";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return { rows, counts, total: rows.length };
}
async function listBudgets() {
  const { data } = await db().from("ai_budgets").select("*").order("scope");
  const rows = data ?? [];
  const names = await projectNames(
    rows.map((r) => r.submission_id).filter(Boolean)
  );
  const emails = await userEmails(rows.map((r) => r.user_id).filter(Boolean));
  return {
    budgets: rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      user_id: row.user_id ?? null,
      submission_id: row.submission_id ?? null,
      project_name: names.get(row.submission_id) ?? null,
      user_email: emails.get(row.user_id) ?? null,
      max_cost_usd: row.max_cost_usd === null ? null : Number(row.max_cost_usd),
      max_input_tokens: row.max_input_tokens ?? null,
      max_output_tokens: row.max_output_tokens ?? null,
      max_requests: row.max_requests ?? null,
      used_cost_usd: Number(row.used_cost_usd ?? 0),
      used_input_tokens: Number(row.used_input_tokens ?? 0),
      used_output_tokens: Number(row.used_output_tokens ?? 0),
      used_requests: Number(row.used_requests ?? 0),
      enabled: row.enabled !== false,
      view: budgetView(row)
    }))
  };
}
async function preflight2() {
  const s = settings();
  const checks = [];
  const started = Date.now();
  let githubOk = false;
  let githubDetail = "";
  const rate = {};
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HackSim-Preflight"
    };
    if (s.githubToken) headers.Authorization = `Bearer ${s.githubToken}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), s.githubTimeoutSeconds * 1e3);
    let response;
    try {
      response = await fetch(`${s.githubApiBase}/rate_limit`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const read = (name) => {
      const raw = response.headers.get(name);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const limit = read("x-ratelimit-limit");
    const remaining = read("x-ratelimit-remaining");
    const reset = read("x-ratelimit-reset");
    if (limit !== null) rate.limit = limit;
    if (remaining !== null) rate.remaining = remaining;
    if (reset !== null) rate.reset_epoch = reset;
    githubOk = response.status === 200;
    if (response.status === 401) {
      githubDetail = "GitHub rejected the token. It is invalid or expired.";
    } else if (response.status === 403) {
      githubDetail = "GitHub refused the request \u2014 usually the token lacks access or the IP is blocked.";
    } else if (!githubOk) {
      githubDetail = `GitHub answered ${response.status}.`;
    } else if (!s.githubToken) {
      githubDetail = "Reachable without a token: only 60 requests/hour, which a real repository exhausts. Add GITHUB_TOKEN.";
    } else {
      githubDetail = "Token accepted.";
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    githubDetail = aborted ? `No answer within ${s.githubTimeoutSeconds}s. Check GITHUB_API_BASE.` : `Could not reach GitHub: ${error?.message ?? error}`;
  }
  checks.push({
    name: "github",
    ok: githubOk,
    detail: githubDetail,
    token_configured: Boolean(s.githubToken),
    latency_ms: Date.now() - started,
    rate_limit: rate
  });
  const { data: modelRows } = await db().from("ai_model_configs").select("provider, model_name, enabled, is_default").eq("is_default", true).limit(1);
  const model = (modelRows ?? [])[0];
  checks.push({
    name: "deepseek",
    // Configured but unpriced is still broken, so both must hold.
    ok: hasDeepseek() && Boolean(model),
    detail: !hasDeepseek() ? "DEEPSEEK_API_KEY is not set. Phase 5 still works; Phase 6 is refused." : !model ? "No default model row. Run supabase/005_model_pricing.sql \u2014 a missing model is a refusal, not a default." : `Key present, default model ${model.provider}/${model.model_name}.`,
    key_configured: hasDeepseek(),
    model_priced: Boolean(model)
  });
  const { data: globalBudgets } = await db().from("ai_budgets").select("enabled, max_cost_usd").eq("scope", "global").limit(1);
  const globalBudget = (globalBudgets ?? [])[0];
  const killSwitchOn = globalBudget ? globalBudget.enabled !== false : true;
  checks.push({
    name: "kill_switch",
    ok: killSwitchOn,
    detail: killSwitchOn ? "AI calls are permitted." : "The kill switch is on: every AI call is rejected."
  });
  const configured = checks.filter((c) => c.ok).length;
  return {
    ok: checks.every((c) => c.ok),
    checks_passed: `${configured}/${checks.length}`,
    checks
  };
}
async function settingsPage() {
  const [{ data: models }, { data: budgets }] = await Promise.all([
    db().from("ai_model_configs").select("*").order("is_default", { ascending: false }),
    db().from("ai_budgets").select("*").eq("scope", "global").limit(1)
  ]);
  const globalBudget = (budgets ?? [])[0];
  return {
    models: models ?? [],
    global_budget: globalBudget ?? null,
    kill_switch: { ai_enabled: globalBudget ? globalBudget.enabled !== false : true }
  };
}
async function forecast() {
  const { data } = await db().rpc("ai_cost_forecast");
  return { ...data ?? {}, basis: "historical_average", is_estimate: true };
}
async function cacheAnalytics(url) {
  const days = intParam(url, "days", 30, 1, 365);
  const summary = await usageSummary(days);
  const inputTokens = Number(summary.input_tokens ?? 0);
  const cached2 = Number(summary.cached_tokens ?? 0);
  const miss = Math.max(0, inputTokens - cached2);
  const { data: pricingRows } = await db().from("ai_model_configs").select("*").eq("is_default", true).limit(1);
  const price = (pricingRows ?? [])[0];
  let savings = 0;
  if (price) {
    const hit = Number(price.input_price_per_million_cache_hit ?? 0);
    const missPrice = Number(price.input_price_per_million_cache_miss ?? 0);
    const saved = miss * (missPrice - hit) / 1e6;
    savings = Number(Math.max(0, saved).toFixed(8));
  }
  return {
    window_days: days,
    cached_tokens: cached2,
    uncached_tokens: miss,
    cache_hit_rate: inputTokens ? Number((cached2 / inputTokens).toFixed(4)) : 0,
    estimated_cache_savings_usd: savings
  };
}
async function saveBudget(payload) {
  const scope = String(payload.scope ?? "");
  if (!["global", "user", "submission"].includes(scope)) {
    throw new HttpError("Unknown budget scope.", 400);
  }
  const fields = {
    scope,
    user_id: payload.user_id ?? null,
    submission_id: payload.submission_id ?? null,
    max_cost_usd: payload.max_cost_usd ?? null,
    max_input_tokens: payload.max_input_tokens ?? null,
    max_output_tokens: payload.max_output_tokens ?? null,
    max_requests: payload.max_requests ?? null,
    enabled: payload.enabled !== false
  };
  if (scope === "user" && !fields.user_id) {
    throw new HttpError("A user budget needs a user id.", 400);
  }
  if (scope === "submission" && !fields.submission_id) {
    throw new HttpError("A submission budget needs a submission id.", 400);
  }
  const id = payload.id ? String(payload.id) : null;
  const { error } = id ? await db().from("ai_budgets").update(fields).eq("id", id) : await db().from("ai_budgets").insert(fields);
  if (error) throw new HttpError("Could not save the budget.", 400);
  return json({ ok: true });
}
async function saveModel(payload) {
  const provider = String(payload.provider ?? "");
  const modelName = String(payload.model_name ?? "");
  if (!provider || !modelName) {
    throw new HttpError("Provider and model are required.", 400);
  }
  const fields = {
    provider,
    model_name: modelName,
    enabled: payload.enabled !== false,
    is_default: Boolean(payload.is_default),
    input_price_per_million_cache_hit: payload.input_price_per_million_cache_hit ?? 0,
    input_price_per_million_cache_miss: payload.input_price_per_million_cache_miss ?? 0,
    output_price_per_million: payload.output_price_per_million ?? 0,
    max_input_tokens: Number(payload.max_input_tokens ?? 32e3),
    max_output_tokens: Number(payload.max_output_tokens ?? 4e3),
    reasoning_mode: payload.reasoning_mode || "off"
  };
  const id = payload.id ? String(payload.id) : null;
  const { error, data } = id ? await db().from("ai_model_configs").update(fields).eq("id", id).select("id").single() : await db().from("ai_model_configs").upsert(fields, { onConflict: "provider,model_name" }).select("id").single();
  if (error) throw new HttpError("Could not save the model settings.", 400);
  if (fields.is_default) {
    const savedId = data?.id;
    let demote = db().from("ai_model_configs").update({ is_default: false }).eq("is_default", true);
    if (savedId) demote = demote.neq("id", savedId);
    const { error: demoteError } = await demote;
    if (demoteError) {
      throw new HttpError(
        "The model was saved but could not be made the only default. Check that no other model is still flagged as default.",
        400
      );
    }
  }
  return json({ ok: true });
}
async function setKillSwitch(enabled) {
  const { data } = await db().from("ai_budgets").select("id").eq("scope", "global").limit(1);
  const existing = (data ?? [])[0];
  const { error } = existing ? await db().from("ai_budgets").update({ enabled }).eq("id", existing.id) : await db().from("ai_budgets").insert({ scope: "global", enabled });
  if (error) throw new HttpError("Could not change the kill switch.", 400);
  return json({ ok: true, ai_enabled: enabled });
}
Deno.serve(
  withErrorHandling(async (req, url) => {
    const caller = requireAdmin(await getCaller(req));
    void caller;
    if (req.method === "GET") {
      const view = url.searchParams.get("view") ?? "overview";
      switch (view) {
        case "overview":
          return json(await overview(url));
        case "usage":
          return json(await usage(url));
        case "errors":
          return json(await errors(url));
        case "budgets":
          return json(await listBudgets());
        case "settings":
          return json(await settingsPage());
        case "preflight":
          return json(await preflight2());
        case "forecast":
          return json(await forecast());
        case "cache-analytics":
          return json(await cacheAnalytics(url));
        case "request": {
          const requestId = url.searchParams.get("request_id");
          if (!requestId) throw new HttpError("A request id is required.", 400);
          return json(await requestDetail(requestId));
        }
        case "budget-state": {
          const snapshot = await loadBudget(url.searchParams.get("submission_id"));
          return json({
            ...snapshot,
            utilization: Number(utilization(snapshot).toFixed(4)),
            level: budgetLevel(snapshot)
          });
        }
        default:
          return fail("Unknown view.", 400);
      }
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      const view = String(body?.view ?? "");
      switch (view) {
        case "budget":
          return saveBudget(body?.payload ?? {});
        case "budget-delete": {
          const { error } = await db().from("ai_budgets").delete().eq("id", String(body?.budget_id ?? ""));
          if (error) throw new HttpError("Could not delete the budget.", 400);
          return json({ ok: true });
        }
        case "model":
          return saveModel(body?.payload ?? {});
        case "kill-switch":
          return setKillSwitch(Boolean(body?.enabled));
        default:
          return fail("Unknown view.", 400);
      }
    }
    return fail("Method not allowed.", 405);
  })
);
