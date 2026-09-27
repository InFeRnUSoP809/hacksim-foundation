// ─────────────────────────────────────────────────────────────────────
// GENERATED FILE — do not edit.
//
// Built by scripts/bundle-functions.sh from
//   supabase/functions/analysis/index.ts
// plus supabase/functions/_shared/*.ts
//
// Edit the sources, then re-run the script. Changes made here are lost.
// 4987 lines, self-contained — safe to paste into the Supabase dashboard.
// ─────────────────────────────────────────────────────────────────────

// _shared/http.ts
import { createClient } from "npm:@supabase/supabase-js@2";

// _shared/security.ts
var securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  // `connect-src` allows the Supabase project the app talks to and nothing else,
  // so a compromised dependency cannot exfiltrate a session to a third origin.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Tailwind injects a stylesheet at runtime
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ")
};
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
var MAX_BODY_BYTES = 256 * 1024;
var PayloadTooLarge = class extends Error {
  constructor(limit) {
    super("Request body is too large.");
    this.limit = limit;
    this.name = "PayloadTooLarge";
  }
};
var COSTLY_ACTIONS = {
  repository: 10,
  // GitHub: a real repository is dozens of API calls
  reanalyze: 10,
  review: 30,
  // DeepSeek: several model calls per run
  "retry-module": 10
};
var DEFAULT_WINDOW_MS = 6e4;
var RateLimiter = class {
  constructor(now = () => Date.now()) {
    this.now = now;
  }
  buckets = /* @__PURE__ */ new Map();
  /**
   * @param action    the expensive operation, e.g. "repository"
   * @param callerId  the authenticated user id — never a client-supplied value
   * @param limit     permits per window
   */
  check(action, callerId, limit) {
    const windowMs = DEFAULT_WINDOW_MS;
    const key = `${action}:${callerId}`;
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      this.buckets.set(key, { count: 1, resetAt: at + windowMs });
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0, limit };
    }
    if (bucket.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - at) / 1e3)),
        limit
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      // Clamped: a limit of 0 means "not rate limited", and `0 - 1` reporting a
      // negative allowance would be nonsense to anything reading the header.
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSeconds: 0,
      limit
    };
  }
  /** Reject a request that would exceed a limit, naming the wait. */
  enforce(action, callerId) {
    const limit = COSTLY_ACTIONS[action] ?? 0;
    if (limit === 0) return null;
    const result = this.check(action, callerId, limit);
    if (result.allowed) return null;
    return fail(
      `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
      429,
      { retry_after: result.retryAfterSeconds, limit: result.limit }
    );
  }
  /** Drop expired buckets so a long-lived instance does not accumulate them. */
  sweep() {
    const at = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }
};
var rateLimiter = new RateLimiter();
var SECRET_PATTERNS = [
  // Authorization headers, in any casing, with the scheme preserved for context.
  [/\b(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/-]{12,}=*/gi, "$1$2[REDACTED]"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1[REDACTED]"],
  // Provider key shapes, before the generic rule so the label is preserved.
  [/\b(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "[REDACTED]"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, "[REDACTED]"],
  [/\b(AIza[A-Za-z0-9_-]{20,})/g, "[REDACTED]"],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]"],
  [/\b([sr]k_(?:live|test)_[A-Za-z0-9]{12,})/g, "[REDACTED]"],
  // A URL carrying its own credentials. This one has no label to key off, so
  // it needs a rule of its own: `postgres://admin:s3cr3t@db/app` appears bare in
  // a stack trace or an error string and the labelled pattern below would miss
  // it entirely. The userinfo half goes; the host is kept, because "which host"
  // is diagnostic and "the password" is not.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s:@]+)@/gi, "$1$2:[REDACTED]@"],
  // PEM blocks: a private key is a multi-line secret that a single-line regex
  // would otherwise leak a line of.
  [/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, "[REDACTED]"],
  // Labelled assignments — the last line of defence, so `password = "hunter2"`
  // is caught even when the value does not match a provider's shape.
  [
    /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|connection[_-]?string)\s*[:=]\s*)(['"]?)[^\s'",;}]{8,}\2/gi,
    "$1[REDACTED]"
  ]
];
function redactSecrets(input) {
  if (!input) return "";
  let out = String(input);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
var safeLog = {
  info(scope, message, detail) {
    console.log(`[${scope}] ${redactSecrets(message)}`, detail ? safeDetail(detail) : "");
  },
  warn(scope, message, detail) {
    console.warn(`[${scope}] ${redactSecrets(message)}`, detail ? safeDetail(detail) : "");
  },
  error(scope, message, detail) {
    console.error(`[${scope}] ${redactSecrets(message)}`, detail ? safeDetail(detail) : "");
  }
};
function safeDetail(detail) {
  if (detail instanceof Error) {
    return redactSecrets(`${detail.name}: ${detail.message} ${detail.stack ?? ""}`);
  }
  try {
    return redactSecrets(JSON.stringify(detail));
  } catch {
    return "[unserialisable]";
  }
}

// _shared/http.ts
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
var HttpError = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
};
async function loadSubmission(submissionId) {
  const { data, error } = await db().from("submissions").select(
    "id, session_id, hackathon_id, team_id, project_name, project_description, github_url, live_demo_url, tech_stack, key_features, status"
  ).eq("id", submissionId).maybeSingle();
  if (error) throw new HttpError("Could not read the submission.", 500);
  if (!data) throw new HttpError("That submission was not found.", 404);
  return data;
}
async function requireTeamAccess(submission, caller) {
  if (caller.role === "admin") return;
  const { data: session } = await db().from("build_sessions").select("team_id").eq("id", submission.session_id).maybeSingle();
  if (!session) throw new HttpError("That simulation was not found.", 404);
  const { data: membership } = await db().from("team_members").select("id").eq("team_id", session.team_id).eq("user_id", caller.id).maybeSingle();
  if (!membership) {
    throw new HttpError("You are not authorized to perform this action.", 403);
  }
}
async function loadHackathon(hackathonId) {
  const { data, error } = await db().from("hackathons").select("*").eq("id", hackathonId).maybeSingle();
  if (error) throw new HttpError("Could not read the hackathon.", 500);
  if (!data) throw new HttpError("That hackathon was not found.", 404);
  return data;
}
async function loadMembers(submissionId) {
  const { data: raw } = await db().from("submission_members").select(
    "id, user_id, contribution_description, contribution_areas, planned_responsibilities, ai_tools_used, ai_usage_description"
  ).eq("submission_id", submissionId).order("created_at");
  const members = raw ?? [];
  if (members.length === 0) return [];
  const { data: rawProfiles } = await db().from("profiles").select("id, full_name, email").in(
    "id",
    members.map((m) => m.user_id).filter((id) => Boolean(id))
  );
  const profiles = rawProfiles ?? [];
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return members.map((member) => {
    const profile = byId.get(member.user_id);
    return {
      ...member,
      full_name: profile?.full_name ?? null,
      email: profile?.email ?? null
    };
  });
}
function withErrorHandling(handler) {
  return async (req) => {
    if (req.method === "OPTIONS") return withSecurityHeaders(preflight());
    try {
      return withSecurityHeaders(await handler(req, new URL(req.url)));
    } catch (error) {
      if (error instanceof HttpError) return withSecurityHeaders(fail(error.message, error.status));
      if (error instanceof PayloadTooLarge) {
        return withSecurityHeaders(
          fail(`Request body is too large. The limit is ${error.limit} bytes.`, 413)
        );
      }
      if (error instanceof SyntaxError) {
        return withSecurityHeaders(fail("Request body must be valid JSON.", 400));
      }
      safeLog.error("hacksim", "unhandled error", error);
      return withSecurityHeaders(fail("Something went wrong on the server.", 500));
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
var aiConfigured = hasDeepseek;
async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function shortHash(input) {
  return (await sha256Hex(input)).slice(0, 32);
}
var CACHE_CONTROL = { type: "ephemeral" };
var DEFAULT_MAX_COST_USD = 0.25;
var DEFAULT_MAX_REQUESTS = 30;
var DEFAULT_MAX_INPUT_TOKENS = 1e5;
var DEFAULT_MAX_OUTPUT_TOKENS = 2e4;
var WARNING_THRESHOLD = 0.5;
var CRITICAL_THRESHOLD = 0.8;
var STOP_THRESHOLD = 1;
var AIError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "AIError";
  }
};
function parseJson(content) {
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
      return parsed;
    }
  } catch {
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
function usageFields(usage) {
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
  const cached2 = Number(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0);
  const missReported = Number(
    usage.prompt_cache_miss_tokens ?? usage.cache_creation_input_tokens ?? 0
  );
  const cacheMiss = missReported ? missReported : Math.max(0, inputTokens - cached2);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_tokens: cached2,
    cache_miss_tokens: cacheMiss
  };
}
async function post(input) {
  const config = settings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.deepseekTimeoutSeconds * 1e3);
  let response;
  try {
    response = await fetch(`${config.deepseekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        // The one and only place the key is used.
        Authorization: `Bearer ${config.deepseekApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.deepseekModel,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        // Ask for JSON explicitly; the provider still needs a schema check.
        response_format: { type: "json_object" },
        stream: false
      }),
      signal: controller.signal
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw aborted ? new AIError("The AI provider timed out.", "timeout") : new AIError(
      `Could not reach the AI provider: ${error?.message ?? error}`,
      "network"
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
      "provider_error"
    );
  }
  const body = await response.json().catch(() => null);
  if (!body) {
    throw new AIError("The AI provider returned a malformed response.", "bad_response");
  }
  const choices = body.choices ?? [];
  const content = choices[0]?.message?.content ?? "";
  const usage = usageFields(body.usage ?? {});
  return {
    content,
    parsed: null,
    requestId: body.id ?? null,
    model: body.model || settings().deepseekModel,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedTokens: usage.cached_tokens,
    cacheMissTokens: usage.cache_miss_tokens,
    durationMs: 0,
    promptVersion: input.promptVersion
  };
}
function messages(systemStable, contextStable, task) {
  return [
    {
      role: "system",
      content: [
        { type: "text", text: systemStable, cache_control: CACHE_CONTROL }
      ]
    },
    {
      role: "user",
      content: [
        { type: "text", text: contextStable, cache_control: CACHE_CONTROL },
        { type: "text", text: task }
      ]
    }
  ];
}
async function completeJson(input) {
  if (!aiConfigured()) {
    throw new AIError("AI is not configured on this deployment.", "not_configured");
  }
  const started = Date.now();
  const maxOutputTokens = input.maxOutputTokens ?? 2e3;
  const temperature = input.temperature ?? 0.1;
  const response = await post({
    messages: messages(input.systemStable, input.contextStable, input.task),
    maxTokens: maxOutputTokens,
    temperature,
    promptVersion: input.promptVersion
  });
  let durationMs = Date.now() - started;
  let parsed = parseJson(response.content);
  if (parsed === null) {
    const repair = await post({
      messages: messages(
        input.systemStable,
        input.contextStable,
        input.task + "\n\nYour previous reply was not valid JSON. Reply with only a JSON object matching the requested shape. No prose, no code fence."
      ),
      maxTokens: maxOutputTokens,
      temperature: 0,
      promptVersion: input.promptVersion
    });
    durationMs += Date.now() - started;
    parsed = parseJson(repair.content);
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
async function loadPricing() {
  const service = db();
  const { data } = await service.from("ai_model_configs").select("*").eq("enabled", true).eq("is_default", true).limit(1);
  let rows = data ?? [];
  if (rows.length === 0) {
    const fallback = await service.from("ai_model_configs").select("*").eq("enabled", true).order("created_at").limit(1);
    rows = fallback.data ?? [];
  }
  if (rows.length === 0) return null;
  const row = rows[0];
  const envModel = settings().deepseekModel;
  const modelName = row.model_name || envModel;
  return {
    provider: row.provider || "deepseek",
    modelName,
    enabled: row.enabled !== false,
    isDefault: Boolean(row.is_default),
    inputPriceCacheHit: Number(row.input_price_per_million_cache_hit ?? 0),
    inputPriceCacheMiss: Number(row.input_price_per_million_cache_miss ?? 0),
    outputPrice: Number(row.output_price_per_million ?? 0),
    maxInputTokens: Number(row.max_input_tokens ?? 32e3),
    maxOutputTokens: Number(row.max_output_tokens ?? 4e3),
    reasoningMode: row.reasoning_mode || "off"
  };
}
function calculateCost(pricing, usage) {
  const million = 1e6;
  return (usage.cachedTokens * pricing.inputPriceCacheHit + usage.cacheMissTokens * pricing.inputPriceCacheMiss + usage.outputTokens * pricing.outputPrice) / million;
}
function estimateCost(pricing, inputTokens, outputTokens, cacheRatio = 0) {
  const cached2 = Math.floor(inputTokens * cacheRatio);
  const miss = Math.max(0, inputTokens - cached2);
  return calculateCost(pricing, { cachedTokens: cached2, cacheMissTokens: miss, outputTokens });
}
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
function overLimit(budget) {
  if (budget.maxCostUsd !== null && budget.usedCostUsd >= budget.maxCostUsd) return true;
  if (budget.maxRequests !== null && budget.usedRequests >= budget.maxRequests) return true;
  if (budget.maxInputTokens && budget.usedInputTokens >= budget.maxInputTokens) return true;
  if (budget.maxOutputTokens && budget.usedOutputTokens >= budget.maxOutputTokens) return true;
  return false;
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
async function checkBudget(input) {
  if (!input.pricing.enabled) {
    return { allowed: false, reason: "model_disabled", estimatedCostUsd: 0, budget: null };
  }
  const budget = await loadBudget(input.submissionId);
  if (!budget.enabled) {
    return { allowed: false, reason: "ai_disabled", estimatedCostUsd: 0, budget };
  }
  if (overLimit(budget)) {
    return {
      allowed: false,
      reason: `budget_exceeded:${budgetLevel(budget)}`,
      estimatedCostUsd: 0,
      budget
    };
  }
  const estimate = estimateCost(
    input.pricing,
    input.estimatedInputTokens,
    input.estimatedOutputTokens,
    input.cacheRatio ?? 0
  );
  if (budget.maxCostUsd !== null && budget.usedCostUsd + estimate > budget.maxCostUsd) {
    return {
      allowed: false,
      reason: "budget_would_be_exceeded",
      estimatedCostUsd: estimate,
      budget
    };
  }
  if (budget.maxInputTokens && input.estimatedInputTokens > budget.maxInputTokens) {
    return { allowed: false, reason: "input_token_limit", estimatedCostUsd: estimate, budget };
  }
  if (input.estimatedInputTokens > input.pricing.maxInputTokens) {
    return { allowed: false, reason: "model_input_limit", estimatedCostUsd: estimate, budget };
  }
  return { allowed: true, reason: "", estimatedCostUsd: estimate, budget };
}
function contextHash(parts, promptVersion, model) {
  return shortHash(JSON.stringify([parts, promptVersion, model]));
}
async function findCachedAnalysis(input) {
  let query = db().from("ai_analyses").select("*").eq("analysis_type", input.analysisType).eq("prompt_version", input.promptVersion).eq("model", input.model).eq("context_hash", input.ctxHash).eq("status", "success").limit(1);
  query = input.repositoryId ? query.eq("repository_id", input.repositoryId) : query.is("repository_id", null);
  const { data } = await query;
  return (data ?? [])[0] ?? null;
}
async function saveAnalysis(input) {
  try {
    const { data, error } = await db().from("ai_analyses").insert({
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
      completed_at: input.completedAt ?? null
    }).select("id").single();
    if (error || !data) {
      console.warn("[hacksim.budget] could not persist ai_analyses row:", error?.message);
      return null;
    }
    return data.id;
  } catch (error) {
    console.warn("[hacksim.budget] could not persist ai_analyses row:", error);
    return null;
  }
}
async function recordUsage(row) {
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
      p_session_id: row.sessionId ?? null
    });
    if (error) console.warn("[hacksim.budget] could not record ai_usage:", error.message);
  } catch (error) {
    console.warn("[hacksim.budget] could not record ai_usage:", error);
  }
}

// _shared/github.ts
var IGNORED_DIRECTORIES = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  "dist",
  "build",
  "out",
  "coverage",
  ".coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
  "bower_components",
  ".gradle",
  ".idea",
  ".vscode",
  "site-packages",
  ".terraform",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  "htmlcov"
]);
var IGNORED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".class",
  ".jar",
  ".war",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".aac",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svgz",
  ".webp",
  ".psd",
  ".ai",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".dump",
  ".bak",
  ".pack",
  ".idx",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".map"
];
var IGNORED_FILENAMES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "mix.lock",
  "packages.lock.json"
]);
var SENSITIVE_FILENAMES = /* @__PURE__ */ new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".netrc",
  ".pgpass"
]);
var MANIFEST_FILENAMES = {
  "package.json": "dependency",
  "requirements.txt": "dependency",
  "pyproject.toml": "dependency",
  "pipfile": "dependency",
  "poetry.lock": "dependency",
  "pom.xml": "dependency",
  "build.gradle": "dependency",
  "go.mod": "dependency",
  "cargo.toml": "dependency",
  "composer.json": "dependency",
  "gemfile": "dependency",
  "pubspec.yaml": "dependency",
  "deno.json": "dependency"
};
var DEPLOYMENT_FILENAMES = /* @__PURE__ */ new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "render.yaml",
  "railway.json",
  "heroku.yml",
  "procfile",
  "makefile",
  "justfile",
  "serverless.yml",
  "k8s.yaml",
  "helmfile.yaml",
  "app.yaml"
]);
var CONFIG_FILENAMES = /* @__PURE__ */ new Set([
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "nuxt.config.ts",
  "angular.json",
  "svelte.config.js",
  "astro.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "tsconfig.json",
  "jsconfig.json",
  "eslint.config.js",
  ".eslintrc.js",
  ".eslintrc.json",
  ".prettierrc",
  "babel.config.js",
  "jest.config.js",
  "vitest.config.ts",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "ruff.toml",
  "mypy.ini",
  "alembic.ini",
  "manage.py",
  "wsgi.py",
  "asgi.py"
]);
var HIGH_IMPORTANCE = /* @__PURE__ */ new Set([
  "readme.md",
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "supabase/schema.sql"
]);
var MEDIUM_IMPORTANCE_HINTS = [
  "schema",
  "migration",
  "model",
  "auth",
  "route",
  "router",
  "controller",
  "api",
  "service",
  "middleware",
  "config",
  "settings",
  "requirements",
  "prisma",
  "supabase"
];
var CATEGORY_BY_EXTENSION = {
  ".py": "source",
  ".ts": "source",
  ".tsx": "component",
  ".jsx": "component",
  ".js": "source",
  ".mjs": "source",
  ".cjs": "source",
  ".go": "source",
  ".rs": "source",
  ".rb": "source",
  ".java": "source",
  ".kt": "source",
  ".swift": "source",
  ".dart": "source",
  ".c": "source",
  ".h": "source",
  ".cpp": "source",
  ".hpp": "source",
  ".cs": "source",
  ".php": "source",
  ".vue": "component",
  ".svelte": "component",
  ".sql": "database",
  ".prisma": "schema",
  ".graphql": "schema",
  ".gql": "schema",
  ".proto": "schema",
  ".json": "config",
  ".yaml": "config",
  ".yml": "config",
  ".toml": "config",
  ".ini": "config",
  ".cfg": "config",
  ".conf": "config",
  ".properties": "config",
  ".env": "config",
  ".md": "documentation",
  ".mdx": "documentation",
  ".rst": "documentation",
  ".txt": "documentation",
  ".adoc": "documentation",
  ".html": "component",
  ".css": "component",
  ".scss": "component",
  ".sass": "component",
  ".less": "component",
  ".sh": "deployment",
  ".bash": "deployment",
  ".zsh": "deployment",
  ".ps1": "deployment",
  ".tf": "deployment",
  ".dockerfile": "deployment",
  ".gradle": "dependency",
  ".kts": "dependency",
  ".bat": "deployment"
};
var LANGUAGE_BY_EXTENSION = {
  ".py": "Python",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".dart": "Dart",
  ".php": "PHP",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".hpp": "C++",
  ".cs": "C#",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Shell",
  ".ps1": "PowerShell",
  ".html": "HTML",
  ".css": "CSS",
  ".scss": "SCSS",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".md": "Markdown",
  ".graphql": "GraphQL",
  ".prisma": "Prisma",
  ".tf": "Terraform",
  ".ipynb": "Jupyter Notebook"
};
var SUPPORTED_EXTENSIONS = /* @__PURE__ */ new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".rs",
  ".php",
  ".cs"
]);
function normalize(path) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  return normalized.replace(/\/$/, "");
}
function basenameOf(path) {
  const parts = normalize(path).split("/");
  return parts[parts.length - 1] ?? "";
}
function extensionOf(path) {
  const name = basenameOf(path).toLowerCase();
  if (name in MANIFEST_FILENAMES || name.startsWith("dockerfile")) return "";
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}
function isSensitive(path) {
  const name = basenameOf(path).toLowerCase();
  return SENSITIVE_FILENAMES.has(name) || name.startsWith(".env");
}
function isIgnored(path) {
  const parts = normalize(path).split("/");
  const directories = parts.slice(0, -1);
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  for (const directory of directories) {
    if (IGNORED_DIRECTORIES.has(directory) || directory.endsWith(".egg-info")) {
      return true;
    }
  }
  if (SENSITIVE_FILENAMES.has(name) || name.startsWith(".env.")) return true;
  if (IGNORED_FILENAMES.has(name) || IGNORED_DIRECTORIES.has(name)) return true;
  const lower = name.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
function languageOf(path) {
  const name = basenameOf(path).toLowerCase();
  if (name.startsWith("dockerfile")) return "Dockerfile";
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}
function categoryOf(path, isBinary) {
  if (isBinary) return "asset";
  const normalized = normalize(path);
  const name = basenameOf(normalized).toLowerCase();
  const dirs = normalized.split("/").slice(0, -1).map((p) => p.toLowerCase());
  if (SENSITIVE_FILENAMES.has(name) || name.startsWith(".env")) return "config";
  if (name in MANIFEST_FILENAMES || name.endsWith(".lock")) return "dependency";
  if (name.startsWith("dockerfile") || DEPLOYMENT_FILENAMES.has(name)) {
    return "deployment";
  }
  const testDir = dirs.some(
    (d) => ["test", "tests", "spec", "__tests__"].includes(d)
  );
  if (testDir || /^(test|spec)/.test(name)) return "test";
  if (name.includes("jest.config") || name.includes("vitest.config") || name.includes("playwright.config") || name.includes("cypress")) {
    return "test";
  }
  if (CONFIG_FILENAMES.has(name)) return "config";
  if (/\.(md|mdx|rst)$/.test(name)) return "documentation";
  const byExtension = CATEGORY_BY_EXTENSION[extensionOf(normalized)];
  if (byExtension) return byExtension;
  if (dirs.some((d) => ["routes", "routers", "api", "controllers", "endpoints"].includes(d))) {
    return "api";
  }
  if (dirs.some((d) => ["models", "entities", "db", "database"].includes(d))) {
    return "model";
  }
  if (dirs.some((d) => ["pages", "views", "components", "app"].includes(d))) {
    return "component";
  }
  return "unknown";
}
function importanceOf(path, category) {
  if (isIgnored(path)) return "ignored";
  if (category === "asset") return "ignored";
  const name = basenameOf(path).toLowerCase();
  if (HIGH_IMPORTANCE.has(name)) return "high";
  if (category === "schema" || category === "database" || category === "deployment") {
    return "high";
  }
  if (MEDIUM_IMPORTANCE_HINTS.some((hint) => name.includes(hint))) return "high";
  if (["api", "model", "component", "config", "source", "test"].includes(category)) {
    return "medium";
  }
  return "low";
}
function isSourceLike(category) {
  return ["source", "component", "api", "model", "schema", "database"].includes(
    category
  );
}
var InvalidRepositoryUrl = class extends Error {
};
var ALLOWED = /^[A-Za-z0-9._-]+$/;
function parseRepositoryUrl(url) {
  const raw = (url ?? "").trim();
  if (!raw) throw new InvalidRepositoryUrl("No repository URL was provided.");
  let candidate = raw;
  if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.split(":")[1] ?? "";
  } else {
    const withoutScheme = candidate.replace(/^[a-z]+:\/\//i, "");
    const [host, ...rest] = withoutScheme.split("/");
    if (!host || !["github.com", "www.github.com"].includes(host.toLowerCase())) {
      throw new InvalidRepositoryUrl("Only GitHub repository URLs are supported.");
    }
    candidate = rest.join("/");
  }
  candidate = candidate.split("?")[0].split("#")[0].replace(/^\/+|\/+$/g, "");
  if (candidate.toLowerCase().endsWith(".git")) {
    candidate = candidate.slice(0, -4);
  }
  const parts = candidate.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new InvalidRepositoryUrl(
      "Enter a GitHub repository URL, like https://github.com/user/repo"
    );
  }
  const [owner, repo] = parts;
  if (!ALLOWED.test(owner) || !ALLOWED.test(repo)) {
    throw new InvalidRepositoryUrl(
      "Enter a GitHub repository URL, like https://github.com/user/repo"
    );
  }
  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`
  };
}
var SECRET_PATTERNS2 = [
  { type: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { type: "service_role_key", regex: /\bey[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { type: "aws_access_key_id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { type: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { type: "openai_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { type: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { type: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { type: "stripe_key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { type: "credential_url", regex: /\b[a-z][a-z0-9+.\-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i },
  { type: "connection_string", regex: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i },
  {
    type: "api_key_assignment",
    regex: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i
  }
];
var PLACEHOLDER_TOKENS = [
  "your_",
  "your-",
  "example",
  "changeme",
  "change-me",
  "placeholder",
  "xxxxx",
  "dummy",
  "fake",
  "todo",
  "insert_",
  "replace_"
];
var SAFE_ASSIGNMENT = /(?:process\.env\.|Deno\.env\.|import\.meta\.env\.|os\.environ|getenv\(|env\[)/;
var LOCAL_HOST = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)\b/;
function redact(secretType) {
  return `${secretType.replace(/_/g, " ")}: [redacted]`;
}
function scanFileForSecrets(path, content) {
  const findings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { type, regex } of SECRET_PATTERNS2) {
    if (seen.has(type)) continue;
    const match = regex.exec(content);
    if (!match) continue;
    const matched = match[0];
    const lowered = matched.toLowerCase();
    if (SAFE_ASSIGNMENT.test(matched)) continue;
    if (PLACEHOLDER_TOKENS.some((token) => lowered.includes(token))) continue;
    if ((type === "connection_string" || type === "credential_url") && LOCAL_HOST.test(matched)) {
      continue;
    }
    const line = content.slice(0, match.index).split("\n").length;
    seen.add(type);
    findings.push({ secret_type: type, file: path, line, redacted: redact(type) });
  }
  return findings;
}
function looksBinary(content) {
  const sample = content.slice(0, 8e3);
  if (sample.length === 0) return false;
  let nulls = 0;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) nulls++;
    if (byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte <= 126) {
      printable++;
    }
  }
  if (nulls > 0) return true;
  return printable / sample.length < 0.98;
}
function decodeText(content) {
  if (looksBinary(content)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(content);
  } catch {
    return null;
  }
}
function countLines(content) {
  if (!content) return 0;
  const breaks = (content.match(/\n/g) ?? []).length;
  return content.endsWith("\n") ? breaks : breaks + 1;
}
var CATEGORY_RULES = [
  ["frontend", [
    "react",
    "react-dom",
    "next",
    "vue",
    "nuxt",
    "svelte",
    "@angular/core",
    "preact",
    "solid-js",
    "astro",
    "@remix-run/react",
    "redux",
    "@reduxjs/toolkit",
    "zustand",
    "tailwindcss",
    "bootstrap",
    "@mui/material",
    "antd",
    "@chakra-ui/react",
    "framer-motion",
    "vite",
    "webpack",
    "esbuild"
  ]],
  ["backend", [
    "express",
    "fastapi",
    "flask",
    "django",
    "@nestjs/core",
    "spring-boot",
    "laravel/framework",
    "gin-gonic/gin",
    "actix-web",
    "axum",
    "rails",
    "sinatra"
  ]],
  ["database", [
    "pg",
    "psycopg",
    "psycopg2",
    "asyncpg",
    "mysql2",
    "pymysql",
    "sqlalchemy",
    "prisma",
    "@prisma/client",
    "mongoose",
    "mongodb",
    "redis",
    "ioredis",
    "typeorm",
    "sequelize",
    "drizzle-orm",
    "knex",
    "sqlite3",
    "better-sqlite3",
    "@supabase/supabase-js"
  ]],
  ["ai_ml", [
    "openai",
    "anthropic",
    "langchain",
    "transformers",
    "torch",
    "tensorflow",
    "keras",
    "scikit-learn",
    "xgboost",
    "lightgbm",
    "prophet",
    "sentence-transformers",
    "deepseek"
  ]],
  ["testing", [
    "pytest",
    "jest",
    "vitest",
    "mocha",
    "chai",
    "cypress",
    "playwright",
    "@testing-library/react",
    "supertest",
    "hypothesis",
    "msw"
  ]],
  ["authentication", [
    "passport",
    "jsonwebtoken",
    "pyjwt",
    "python-jose",
    "auth0",
    "next-auth",
    "@auth/core",
    "@clerk/nextjs",
    "bcrypt",
    "argon2",
    "passlib",
    "lucia",
    "better-auth"
  ]],
  ["deployment", [
    "vercel",
    "netlify",
    "docker",
    "kubernetes",
    "serverless",
    "pm2",
    "terraform",
    "pulumi",
    "firebase",
    "firebase-admin",
    "cloudflare-workers"
  ]]
];
function categorisePackage(pkg) {
  const lowered = pkg.toLowerCase();
  for (const [category, needles] of CATEGORY_RULES) {
    if (needles.some((n) => n.toLowerCase() === lowered)) return category;
  }
  for (const [category, needles] of CATEGORY_RULES) {
    const ordered = [...needles].sort((a, b) => b.length - a.length);
    if (ordered.some((n) => lowered.includes(n.toLowerCase()))) return category;
  }
  return "utility";
}
function cleanPythonVersion(spec) {
  const match = /(\d+(?:\.\d+)*)/.exec(spec.replace(/^[<>=!~\[\s]+/, ""));
  return match ? match[1] : null;
}
function parseJson2(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function pushTarget(out, pkg, version, ecosystem, dev = false) {
  const package_ = pkg.split("[")[0].split(";")[0].trim();
  if (!package_) return;
  out.push({
    package: package_,
    version,
    category: categorisePackage(package_),
    ecosystem,
    dev
  });
}
function parseRequirementsTxt(content) {
  const out = [];
  for (const raw of content.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line || line.startsWith("-")) continue;
    if (line.includes("git+") || line.includes("http")) {
      const name = /([A-Za-z0-9_.-]+)/.exec(line.split("@")[0] ?? "");
      if (name) pushTarget(out, name[1], null, "pypi");
      continue;
    }
    const specMatch = /^(.*?)(==|>=|~=|>|<)(.*)$/.exec(line);
    if (specMatch) {
      pushTarget(out, specMatch[1], cleanPythonVersion(specMatch[3]), "pypi");
      continue;
    }
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?$/.test(line)) {
      pushTarget(out, line, null, "pypi");
    }
  }
  return out;
}
function parsePyproject(content) {
  const out = [];
  const data = parseJson2(content);
  if (!data) return out;
  const project = data.project ?? {};
  for (const spec of project.dependencies ?? []) {
    const [name, version] = String(spec).split(">=");
    pushTarget(out, name ?? "", version ? cleanPythonVersion(version) : null, "pypi");
  }
  const optional = project["optional-dependencies"] ?? {};
  for (const [group, specs] of Object.entries(optional)) {
    for (const spec of specs ?? []) {
      const [name, version] = String(spec).split(">=");
      pushTarget(
        out,
        name ?? "",
        version ? cleanPythonVersion(version) : null,
        "pypi",
        ["dev", "test", "tests"].includes(group)
      );
    }
  }
  const poetry = data.tool?.poetry ?? {};
  for (const [section2, dev] of [["dependencies", false], ["dev-dependencies", true]]) {
    for (const [pkg, spec] of Object.entries(poetry[section2] ?? {})) {
      pushTarget(out, pkg, cleanPythonVersion(String(spec)), "pypi", dev);
    }
  }
  return out;
}
function parsePackageJson(content) {
  const out = [];
  const data = parseJson2(content);
  if (!data) return out;
  for (const [section2, dev] of [
    ["dependencies", false],
    ["devDependencies", true],
    ["peerDependencies", true]
  ]) {
    const block = data[section2] ?? {};
    for (const [pkg, spec] of Object.entries(block)) {
      pushTarget(out, pkg, spec ? String(spec).replace(/^[\^~>=<\s]+/, "") : null, "npm", dev);
    }
  }
  return out;
}
function parseGoMod(content) {
  const out = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || /^(module|go\s|\/\/)/.test(line)) continue;
    const match = /^(?:require\s+)?([\w./-]+)\s+(v[\w.+-]+)/.exec(line);
    if (match) pushTarget(out, match[1], match[2].replace(/^v/, ""), "go");
  }
  return out;
}
function parseCargo(content) {
  const out = [];
  let inDeps = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[dependencies]")) {
      inDeps = true;
      continue;
    }
    if (line.startsWith("[") && inDeps) {
      inDeps = false;
      continue;
    }
    if (!inDeps || !line.includes("=")) continue;
    const [pkg, spec] = line.split("=");
    const version = /version\s*=\s*"([^"]+)"/.exec(spec ?? "");
    pushTarget(out, (pkg ?? "").trim().replace(/^"|"$/g, ""), version?.[1] ?? null, "cargo");
  }
  return out;
}
function parseMaven(content) {
  const out = [];
  const regex = /<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    pushTarget(out, `${match[1]}:${match[2]}`, match[3] ?? null, "maven");
  }
  return out;
}
function parseGradle(content) {
  const out = [];
  const regex = /(implementation|api|testImplementation|compileOnly)\s*[('"]+([\w.-]+):([\w.-]+):?([\w.-]*)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    pushTarget(
      out,
      `${match[2]}:${match[3]}`,
      match[4] || null,
      "maven",
      match[1] === "testImplementation"
    );
  }
  return out;
}
function parseComposer(content) {
  const out = [];
  const data = parseJson2(content);
  if (!data) return out;
  for (const [section2, dev] of [["require", false], ["require-dev", true]]) {
    for (const [pkg, spec] of Object.entries(data[section2] ?? {})) {
      if (pkg === "php" || pkg.startsWith("ext-")) continue;
      pushTarget(out, pkg, String(spec).replace(/^[\^~>=<\s]+/, ""), "composer", dev);
    }
  }
  return out;
}
function parsePubspec(content) {
  const out = [];
  let inBlock = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "dependencies:") {
      inBlock = true;
      continue;
    }
    if (line.endsWith(":") && !line.startsWith(" ") && !line.startsWith("	")) {
      inBlock = false;
      continue;
    }
    if (!inBlock || !line.startsWith(" ") || !line.includes(":")) continue;
    const [name, spec] = line.split(":");
    if (name && name.trim()) pushTarget(out, name, spec?.trim() || null, "pub");
  }
  return out;
}
var MANIFEST_PARSERS = {
  "package.json": parsePackageJson,
  "requirements.txt": parseRequirementsTxt,
  "pyproject.toml": parsePyproject,
  pipfile: parseRequirementsTxt,
  "pom.xml": parseMaven,
  "build.gradle": parseGradle,
  "go.mod": parseGoMod,
  "cargo.toml": parseCargo,
  "composer.json": parseComposer,
  "pubspec.yaml": parsePubspec
};
function extractDependencies(path, content) {
  const parser = MANIFEST_PARSERS[basenameOf(path).toLowerCase()];
  if (!parser) return [];
  try {
    return parser(content);
  } catch {
    return [];
  }
}
var SYMBOL_RULES = {
  ".py": [
    [/^\s*async\s+def\s+(\w+)\s*\(/, 1, "function"],
    [/^\s*def\s+(\w+)\s*\(/, 1, "function"],
    [/^\s*class\s+(\w+)\s*[\(:]/, 1, "class"]
  ],
  ts: [
    [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/, 1, "function"],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, 1, "class"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)/, 1, "function"],
    [/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/, 1, "type"],
    // A class method. Without this, a TypeScript class reports as a bare name
    // and its whole API is invisible to the review — which is most of what a
    // hackathon submission actually contains.
    [
      /^\s*(?:(?:public|private|protected|readonly|static|override|abstract|async|declare)\s+)*\*?\s*(?:get\s+|set\s+)?(\w+)\s*(?:<[^>()]*>)?\s*\([^;]*\)\s*(?::[^{;]+)?\s*\{/,
      1,
      "method"
    ]
  ],
  ".go": [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, 1, "function"],
    [/^type\s+(\w+)\s+struct/, 1, "type"]
  ],
  ".java": [
    [/^\s*(?:public|private|protected)?[\w\s<>[\],]*\s(\w+)\s*\([^;]*\)\s*\{/, 1, "method"],
    [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/, 1, "class"]
  ],
  ".kt": [
    [/^\s*(?:suspend\s+)?fun\s+(\w+)\s*\(/, 1, "function"],
    [/^\s*(?:data\s+)?class\s+(\w+)/, 1, "class"]
  ],
  ".rb": [
    [/^\s*def\s+([\w?!.]+)/, 1, "method"],
    [/^\s*class\s+(\w+)/, 1, "class"],
    [/^\s*module\s+(\w+)/, 1, "module"]
  ],
  ".rs": [
    [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 1, "function"],
    [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, 1, "type"]
  ],
  ".php": [
    [/^\s*(?:public|private|protected)?\s*function\s+(\w+)\s*\(/, 1, "method"],
    [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 1, "class"]
  ],
  ".cs": [
    [/^\s*(?:public|private|protected|internal)[\w\s<>[\],]*\s(\w+)\s*\([^;]*\)\s*\{/, 1, "method"],
    [/^\s*(?:public\s+)?(?:class|record|struct|interface)\s+(\w+)/, 1, "class"]
  ]
};
var RESERVED = /* @__PURE__ */ new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "class"
]);
function rulesFor(extension) {
  if (extension === ".ts" || extension === ".tsx") return SYMBOL_RULES.ts;
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    return SYMBOL_RULES.ts;
  }
  return SYMBOL_RULES[extension] ?? [];
}
function extractSymbols(path, content) {
  const extension = extensionOf(path);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return { symbols: [], parserStatus: "unsupported" };
  }
  const rules = rulesFor(extension);
  const symbols = [];
  const seen = /* @__PURE__ */ new Set();
  const classIndents = [];
  content.split("\n").forEach((line, index) => {
    const trimmed = line.trimEnd();
    if (!trimmed.trim() || /^\s*(#|\/\/|\*|\/\*)/.test(trimmed)) return;
    const indent = trimmed.length - trimmed.trimStart().length;
    while (classIndents.length && indent <= classIndents[classIndents.length - 1]) {
      classIndents.pop();
    }
    for (const [regex, group, type] of rules) {
      const match = regex.exec(trimmed);
      if (!match) continue;
      const name = match[group];
      if (!name || RESERVED.has(name)) continue;
      let symbolType = type;
      if (type === "class") classIndents.push(indent);
      else if (type === "function" && classIndents.length > 0) {
        symbolType = "method";
      }
      const key = `${name}:${symbolType}`;
      if (seen.has(key)) return;
      seen.add(key);
      symbols.push({
        name,
        symbol_type: symbolType,
        line: index + 1,
        signature: trimmed.trim().slice(0, 200)
      });
      return;
    }
  });
  return { symbols, parserStatus: "ok" };
}
var FILE_BASED_ROUTE = /^(app|pages|src\/app|src\/pages)\/(.*)\.(tsx|jsx|ts|js)$/;
function extractRoutes(path, content) {
  const routes = [];
  const seen = /* @__PURE__ */ new Set();
  const extension = extensionOf(path);
  let classPrefix = "";
  const add = (method, routePath, line, symbol, framework) => {
    const key = `${method.toUpperCase()} ${routePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({
      method: method.toUpperCase(),
      path: routePath,
      file: path,
      line,
      symbol,
      framework
    });
  };
  content.split("\n").forEach((line, index) => {
    const number = index + 1;
    let m = /^\s*@(app|router|api)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/i.exec(line);
    if (m) {
      add(m[2], m[3], number, null, "FastAPI");
      return;
    }
    m = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']?(\/?[\w{}\/-]*)/.exec(line);
    if (m) {
      const rest = content.split("\n").slice(index, index + 4).join("\n");
      if (/\bclass\s+\w+/.test(rest)) {
        classPrefix = m[1] || "";
        return;
      }
    }
    m = /@(\w+)\.route\s*\(\s*["']([^"']+)["']([^)]*)\)/.exec(line);
    if (m) {
      const methods = [...(m[3] ?? "").matchAll(/get|post|put|patch|delete/gi)];
      for (const method of methods.length ? methods : ["GET"]) {
        add(method[0], m[2], number, m[1], "Flask");
      }
      return;
    }
    m = /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']?(\/?[\w{}\/-]*)/.exec(line);
    if (m) {
      const own = m[2] || "";
      const joined = classPrefix && !own.startsWith(classPrefix) ? `${classPrefix}${own === "/" ? "" : own}` : own || "/";
      add(m[1] === "Request" ? "GET" : m[1], joined, number, null, "Spring");
      return;
    }
    m = /\b(\w+)\.(Get|Post|Put|Patch|Delete)\s*\(\s*["`]([^"`]+)["`]/.exec(line);
    if (m) {
      add(m[2], m[3], number, m[1], "Go");
      return;
    }
    m = /Route::(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/.exec(line);
    if (m) {
      add(m[1], m[2], number, null, "Laravel");
      return;
    }
    m = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/.exec(line);
    if (m) {
      add(m[1], m[2], number, null, "Rails");
      return;
    }
    m = /^\s*(?:path|re_path|url)\s*\(\s*r?["']([^"']+)["']/.exec(line);
    if (m) {
      add("ANY", m[1], number, null, "Django");
      return;
    }
    if (extension === ".py") return;
    m = /\b(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(line);
    if (m) {
      add(m[1], m[2], number, null, "Express");
      return;
    }
    m = /<Route[^>]*\bpath\s*=\s*["']([^"']+)["']/i.exec(line);
    if (m) {
      add("GET", m[1], number, null, "React Router");
      return;
    }
  });
  const fileRoute = FILE_BASED_ROUTE.exec(path);
  if (fileRoute) {
    const segments = (fileRoute[2] ?? "").split("/").filter((s) => s && s !== "index");
    add("GET", `/${segments.join("/")}`, 1, null, "File-based routing");
  }
  return routes;
}
var EXTERNAL_CALL = /\b(?:fetch|axios(?:\.\w+)?)\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g;
var REQUESTS_CALL = /\brequests\.(get|post|put|patch|delete)\s*\(\s*f?["'](https?:\/\/[^"']+)["']/g;
function extractIntegrations(content, file) {
  const found = /* @__PURE__ */ new Map();
  for (const match of content.matchAll(EXTERNAL_CALL)) {
    found.set(match[1], {
      url: match[1],
      file,
      line: content.slice(0, match.index).split("\n").length,
      method: null
    });
  }
  for (const match of content.matchAll(REQUESTS_CALL)) {
    if (!found.has(match[2])) {
      found.set(match[2], {
        url: match[2],
        file,
        line: content.slice(0, match.index).split("\n").length,
        method: match[1].toUpperCase()
      });
    }
  }
  return [...found.values()];
}
var TEST_FILE_PATTERNS = [
  /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/,
  /(^|\/)(tests?\/.*\.(py|ts|tsx|js|jsx))$/,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  /(__tests__\/.*\.(ts|tsx|js|jsx))$/
];
function isTestFile(path) {
  return TEST_FILE_PATTERNS.some((regex) => regex.test(path));
}
var TEST_FRAMEWORKS = [
  ["Jest", ["jest.config"]],
  ["Vitest", ["vitest.config"]],
  ["Pytest", ["pytest.ini", "conftest.py"]],
  ["Playwright", ["playwright.config"]],
  ["Cypress", ["cypress.config", "cypress.json"]],
  ["Mocha", [".mocharc"]],
  ["Testing Library", ["setupTests", "jest.setup"]],
  ["Django test runner", ["manage.py"]]
];
function detectTestFrameworks(filenames, paths) {
  const haystack = [...filenames, ...paths].map((p) => p.toLowerCase());
  const found = [];
  for (const [name, needles] of TEST_FRAMEWORKS) {
    for (const needle of needles) {
      if (haystack.some((p) => p.includes(needle))) {
        found.push({ name, evidence: `\`${needle}\` present` });
        break;
      }
    }
  }
  if (found.length === 0 && paths.some(isTestFile)) {
    found.push({
      name: "Unidentified",
      evidence: "test files present but no known test configuration found"
    });
  }
  return found;
}
var TEST_COMMANDS = [
  ["npm test", /"test"\s*:\s*"[^"]+"/],
  ["pytest", /\bpytest\b/],
  ["go test", /\bgo test\b/],
  ["cargo test", /\bcargo test\b/]
];
function detectTestCommands(contents) {
  const found = /* @__PURE__ */ new Set();
  for (const content of contents) {
    for (const [command, regex] of TEST_COMMANDS) {
      if (regex.test(content)) found.add(command);
    }
  }
  return [...found].sort();
}
var FRAMEWORK_SIGNALS = {
  React: ["react", "react-dom", "preact"],
  "Next.js": ["next"],
  Vue: ["vue"],
  Nuxt: ["nuxt"],
  Angular: ["@angular/core"],
  Svelte: ["svelte"],
  SvelteKit: ["@sveltejs/kit"],
  Astro: ["astro"],
  Remix: ["@remix-run/react", "@remix-run/node"],
  Vite: ["vite"],
  FastAPI: ["fastapi"],
  Flask: ["flask", "flask-cors", "flask-sqlalchemy"],
  Django: ["django", "djangorestframework"],
  Express: ["express"],
  NestJS: ["@nestjs/core", "@nestjs/common"],
  Spring: ["spring-boot", "spring-boot-starter", "spring-web"],
  Laravel: ["laravel/framework", "laravel/sanctum"],
  Rails: ["rails", "railties"],
  Gin: ["gin-gonic/gin"],
  Fiber: ["gofiber/fiber"],
  Actix: ["actix-web"],
  Axum: ["axum"],
  Sinatra: ["sinatra"],
  Flutter: ["flutter"],
  "React Native": ["react-native", "expo"]
};
var FRAMEWORK_CONFIG_SIGNALS = {
  "next.config.js": "Next.js",
  "next.config.mjs": "Next.js",
  "next.config.ts": "Next.js",
  "nuxt.config.ts": "Nuxt",
  "nuxt.config.js": "Nuxt",
  "svelte.config.js": "Svelte",
  "angular.json": "Angular",
  "astro.config.mjs": "Astro",
  "vite.config.ts": "Vite",
  "vite.config.js": "Vite",
  "manage.py": "Django",
  "vercel.json": "Vercel",
  "netlify.toml": "Netlify",
  "serverless.yml": "Serverless",
  "fly.toml": "Fly.io"
};
var DATABASE_SIGNALS = {
  PostgreSQL: ["pg", "psycopg", "psycopg2", "asyncpg", "postgres", "@supabase/supabase-js"],
  MySQL: ["mysql2", "pymysql", "mysql-connector"],
  MongoDB: ["mongoose", "mongodb", "pymongo"],
  SQLite: ["sqlite3", "better-sqlite3"],
  Redis: ["redis", "ioredis"],
  SQLAlchemy: ["sqlalchemy"],
  Prisma: ["prisma", "@prisma/client"],
  TypeORM: ["typeorm"],
  Sequelize: ["sequelize"],
  Drizzle: ["drizzle-orm"],
  "Django ORM": ["django"],
  Mongoose: ["mongoose"]
};
var ORM_KEYWORDS = {
  SQLAlchemy: ["from sqlalchemy", "import sqlalchemy", "sqlalchemy.orm"],
  Prisma: ["@prisma/client", "prisma."],
  TypeORM: ["typeorm", "@Entity("],
  Sequelize: ["sequelize"],
  Drizzle: ["drizzle-orm"],
  "Django ORM": ["from django.db", "models.Model"],
  Mongoose: ["new mongoose.Schema", "mongoose.model"],
  Supabase: ["createClient", "supabase.from"]
};
var AUTH_SIGNALS = {
  "Supabase Auth": ["@supabase/supabase-js", "@supabase/auth-js"],
  JWT: ["jsonwebtoken", "pyjwt", "python-jose", "jose"],
  OAuth: ["passport", "oauthlib", "auth0", "next-auth", "@auth/core", "@clerk/nextjs"],
  Passport: ["passport"],
  NextAuth: ["next-auth"],
  Clerk: ["@clerk/nextjs"],
  Auth0: ["auth0", "@auth0/auth0-react"],
  bcrypt: ["bcrypt", "argon2", "passlib"],
  "Laravel Sanctum": ["laravel/sanctum"],
  "Better Auth": ["better-auth"]
};
var AUTH_CODE_SIGNALS = {
  "Supabase Auth": ["supabase.auth.signIn", "supabase.auth.signUp", "getSession("],
  "JWT verification": ["jwt.decode", "jwt.verify", "verify(", "getUser("],
  "Session cookies": ["setCookie", "document.cookie", "res.cookie"],
  "Authorization middleware": [
    "requireAuth",
    "authenticate",
    "get_current_user",
    "verifyToken",
    "requireLogin"
  ],
  "Authorization checks": ["is_admin", "isAdmin", "role ===", "hasRole", "require_role"]
};
function matchByDependencies(dependencies, signals, category) {
  const byPackage = new Map(dependencies.map((d) => [d.package.toLowerCase(), d]));
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const mentions = (pkg, needle) => {
    const n = needle.toLowerCase();
    let at = pkg.indexOf(n);
    while (at !== -1) {
      const before = at === 0 ? "" : pkg[at - 1];
      const after = pkg[at + n.length] ?? "";
      const bounded = (c) => c === "" || "-_./".includes(c);
      if (bounded(before) && bounded(after)) return true;
      at = pkg.indexOf(n, at + 1);
    }
    return false;
  };
  for (const [technology, needles] of Object.entries(signals)) {
    for (const needle of needles) {
      for (const [pkg, dependency] of byPackage) {
        if (!mentions(pkg, needle)) continue;
        if (seen.has(technology)) break;
        seen.add(technology);
        found.push({
          name: technology,
          category,
          evidence: `dependency \`${dependency.package}\``,
          symbol: dependency.package
        });
        break;
      }
    }
  }
  return found;
}
function detectFrameworks(dependencies, filenames) {
  const found = matchByDependencies(dependencies, FRAMEWORK_SIGNALS, "framework");
  const present = new Set(found.map((f) => f.name));
  for (const filename of filenames) {
    const technology = FRAMEWORK_CONFIG_SIGNALS[filename.toLowerCase()];
    if (technology && !present.has(technology)) {
      present.add(technology);
      found.push({
        name: technology,
        category: "framework",
        evidence: `configuration file \`${filename}\``,
        file: filename
      });
    }
  }
  return found;
}
function detectDatabases(dependencies, paths) {
  const found = matchByDependencies(dependencies, DATABASE_SIGNALS, "database");
  if (paths.some((p) => p.endsWith(".sql")) && !found.some((d) => d.name === "SQLAlchemy")) {
    found.push({
      name: "SQL",
      category: "database",
      evidence: "SQL files in the repository"
    });
  }
  if (paths.some((p) => p.endsWith("schema.prisma"))) {
    found.push({
      name: "Prisma",
      category: "database",
      evidence: "`schema.prisma` present",
      file: "schema.prisma"
    });
  }
  return found;
}
function detectAuth(dependencies) {
  return matchByDependencies(dependencies, AUTH_SIGNALS, "authentication");
}
function detectInCode(sources, signals, category) {
  const found = /* @__PURE__ */ new Map();
  for (const [technology, needles] of Object.entries(signals)) {
    for (const source of sources) {
      for (const needle of needles) {
        const index = source.content.indexOf(needle);
        if (index === -1) continue;
        const line = source.content.slice(0, index).split("\n").length;
        if (!found.has(technology)) {
          found.set(technology, {
            name: technology,
            category,
            evidence: `\`${needle}\` used in source`,
            file: source.path,
            lines: `${line}-${line}`
          });
        }
        break;
      }
    }
  }
  return [...found.values()];
}
function detectAuthInCode(sources) {
  return detectInCode(sources, AUTH_CODE_SIGNALS, "authentication");
}
function detectDatabaseInCode(sources) {
  return detectInCode(sources, ORM_KEYWORDS, "database");
}
var README_MAX_BYTES = 6e4;
var SECTION_ALIASES = {
  description: ["description", "about", "overview", "introduction", "what is", "summary"],
  setup: ["installation", "getting started", "setup", "quick start", "how to run"],
  features: ["features", "functionality", "capabilities", "key features", "what it does"],
  technologies: ["tech stack", "technologies", "built with", "stack", "tools"],
  usage: ["usage", "how to use", "examples", "example"]
};
var TECH_HINTS = [
  "react",
  "next.js",
  "nextjs",
  "vue",
  "nuxt",
  "angular",
  "svelte",
  "vite",
  "typescript",
  "javascript",
  "python",
  "django",
  "flask",
  "fastapi",
  "express",
  "nestjs",
  "spring",
  "laravel",
  "rails",
  "flutter",
  "supabase",
  "postgres",
  "postgresql",
  "mysql",
  "mongodb",
  "redis",
  "prisma",
  "tailwind",
  "openai",
  "tensorflow",
  "pytorch",
  "scikit-learn",
  "docker",
  "vercel",
  "aws",
  "node.js",
  "php",
  "java"
];
function parseReadme(path, raw) {
  const content = raw.length > README_MAX_BYTES ? raw.slice(0, README_MAX_BYTES) : raw;
  const headingRegex = /^(#{1,4})\s+(.+?)\s*$/gm;
  const sections = /* @__PURE__ */ new Map();
  const preambles = [];
  let lastIndex = 0;
  let lastTitle = "";
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const body = content.slice(lastIndex, match.index);
    if (lastTitle) sections.set(lastTitle, body);
    else preambles.push(body);
    lastTitle = match[2].trim().toLowerCase();
    lastIndex = headingRegex.lastIndex;
  }
  if (lastTitle) sections.set(lastTitle, content.slice(lastIndex));
  const bodyFor = (key) => {
    for (const [title, body] of sections) {
      if (SECTION_ALIASES[key].some((alias) => title.includes(alias))) return body;
    }
    return "";
  };
  const firstParagraph = (body) => {
    for (const block of body.split(/\n\s*\n/)) {
      const cleaned = block.trim();
      if (!cleaned || /^[#!<\[*|>-]/.test(cleaned) || cleaned.startsWith("```")) continue;
      return cleaned.slice(0, 1200);
    }
    return "";
  };
  const bullets = (body) => {
    const items = [...body.matchAll(/^\s*[-*+]\s+(?:\[[ xX]?\]\s*)?(.+)$/gm)].map((m) => m[1].trim());
    const numbered = items.length ? items : [...body.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => m[1].trim());
    return numbered.filter((item) => item.length > 2 && item.length < 200).slice(0, 25);
  };
  const firstCodeBlock = (body) => {
    const match2 = /```[^\n]*\n([\s\S]*?)```/.exec(body);
    return match2 ? match2[1].trim().slice(0, 800) : "";
  };
  const preamble = preambles.join("\n").trim();
  const description = preamble || bodyFor("description");
  const stackSection = bodyFor("technologies");
  const haystack = `${stackSection}
${content}`.toLowerCase();
  return {
    path,
    present: content.trim().length > 0,
    description: firstParagraph(description),
    features: bullets(bodyFor("features")).length ? bullets(bodyFor("features")).slice(0, 20) : bullets(description).slice(0, 20),
    technologies: TECH_HINTS.filter((hint) => haystack.includes(hint)).slice(0, 20),
    setup: firstCodeBlock(bodyFor("setup")),
    usage: firstCodeBlock(bodyFor("usage")),
    sections: [...sections.keys()].slice(0, 30)
  };
}
var EvidenceRegistry = class {
  items = [];
  byFingerprint = /* @__PURE__ */ new Map();
  add(input) {
    const source = [input.type, input.claim, input.file ?? "", input.symbol ?? "", input.lines ?? ""].join("|");
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      hash = hash * 31 + source.charCodeAt(i) >>> 0;
    }
    const fingerprint = hash.toString(16);
    const existing = this.byFingerprint.get(fingerprint);
    if (existing) return existing;
    const evidence = {
      id: `EV-${String(this.items.length + 1).padStart(3, "0")}`,
      type: input.type,
      claim: input.claim,
      confidence: input.confidence ?? "medium",
      ...input.file ? { file: input.file } : {},
      ...input.symbol ? { symbol: input.symbol } : {},
      ...input.lines ? { lines: input.lines } : {},
      ...input.detail && Object.keys(input.detail).length ? { detail: input.detail } : {}
    };
    this.items.push(evidence);
    this.byFingerprint.set(fingerprint, evidence);
    return evidence;
  }
  toList() {
    return this.items;
  }
};
function compactEvidence(items, limit) {
  const compact = items.map((item) => ({
    id: item.id,
    type: item.type,
    claim: item.claim.slice(0, 220),
    file: item.file ?? null,
    lines: item.lines ?? null
  }));
  const filtered = compact.filter(
    (item) => item.file || ["repository", "readme", "framework", "dependency", "test_framework", "analysis_mode"].includes(item.type)
  );
  return limit ? filtered.slice(0, limit) : filtered;
}
var MAX_ROUTES = 40;
var MAX_DEPENDENCIES = 45;
var MAX_IMPORTANT_FILES = 25;
var MAX_WARNINGS = 12;
var MAX_INTEGRATIONS = 12;
var MAX_FEATURES = 15;
var IMPORTANCE_RANK = {
  high: 0,
  medium: 1,
  low: 2,
  ignored: 3
};
var STATE_PACKAGES = {
  redux: "Redux",
  "@reduxjs/toolkit": "Redux Toolkit",
  zustand: "Zustand",
  jotai: "Jotai",
  recoil: "Recoil",
  mobx: "MobX",
  pinia: "Pinia",
  vuex: "Vuex",
  "@tanstack/react-query": "TanStack Query",
  swr: "SWR",
  "react-hook-form": "React Hook Form"
};
function buildProjectMap(input) {
  const warnings = [...input.warnings];
  const { files, dependencies, routes, analysisMode } = input;
  const hiddenRoutes = Math.max(0, routes.length - MAX_ROUTES);
  const hiddenDeps = Math.max(0, dependencies.length - MAX_DEPENDENCIES);
  const hiddenIntegrations = Math.max(0, input.integrations.length - MAX_INTEGRATIONS);
  const hiddenAuth = Math.max(0, input.auth.length - 12);
  const hiddenFrameworks = Math.max(0, input.frameworks.length - 15);
  if (hiddenRoutes) {
    warnings.push(`${hiddenRoutes} further endpoints exist and were not listed here.`);
  }
  if (hiddenDeps) {
    warnings.push(`${hiddenDeps} further dependencies were not listed here.`);
  }
  if (analysisMode === "limited") {
    warnings.push("Large repository detected. Analysis was limited to relevant files.");
  }
  const shownFiles = [...files].sort((a, b) => (IMPORTANCE_RANK[a.importance] ?? 4) - (IMPORTANCE_RANK[b.importance] ?? 4)).slice(0, MAX_IMPORTANT_FILES);
  const hiddenFiles = Math.max(0, files.length - MAX_IMPORTANT_FILES);
  if (hiddenFiles) {
    warnings.push(`${hiddenFiles} further files exist and were not listed here.`);
  }
  const languageCounts = {};
  for (const file of files) {
    const language = file.language;
    if (!language || ["JSON", "YAML", "TOML", "Markdown"].includes(language)) continue;
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
  }
  const languages = Object.entries(languageCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const byCategory = {};
  for (const dependency of dependencies.slice(0, MAX_DEPENDENCIES)) {
    const category = byCategory[dependency.category] ?? [];
    category.push(dependency.package);
    byCategory[dependency.category] = category;
  }
  const packageNames = new Set(dependencies.map((d) => d.package.toLowerCase()));
  const stateManagement = Object.entries(STATE_PACKAGES).filter(([key]) => packageNames.has(key)).map(([, label]) => label);
  const styling = [];
  for (const [pkg, label] of [
    ["tailwindcss", "Tailwind CSS"],
    ["@mui/material", "Material UI"],
    ["antd", "Ant Design"],
    ["@chakra-ui/react", "Chakra UI"],
    ["bootstrap", "Bootstrap"],
    ["styled-components", "styled-components"],
    ["sass", "Sass"]
  ]) {
    if (packageNames.has(pkg)) styling.push(label);
  }
  if (files.some((f) => /\.(css|scss)$/.test(f.path))) styling.push("plain CSS");
  const backendLanguages = [
    ...new Set(
      files.filter((f) => ["Python", "Go", "Java", "Ruby", "PHP", "Rust", "C#", "Kotlin"].includes(f.language)).map((f) => f.language)
    )
  ];
  return {
    analysis_mode: analysisMode,
    identity: {
      owner: input.repository.owner,
      repo: input.repository.repo_name,
      default_branch: input.repository.default_branch,
      commit: String(input.repository.analyzed_commit_sha ?? "").slice(0, 12),
      visibility: input.repository.visibility,
      stars: input.repository.stars,
      forks: input.repository.forks
    },
    stack: {
      primary_language: input.repository.language,
      languages: Object.fromEntries(languages),
      frameworks: input.frameworks.slice(0, 15).map((f) => f.name),
      dependencies_by_category: Object.fromEntries(
        Object.entries(byCategory).map(([k, v]) => [k, v.slice(0, 20)])
      ),
      package_managers: [
        ...new Set(files.filter((f) => f.file_category === "dependency").map((f) => f.file_name))
      ]
    },
    architecture: {
      layers: [
        ...new Set(
          files.filter((f) => ["source", "component", "api", "model", "schema", "database"].includes(f.file_category)).map((f) => f.file_category)
        )
      ],
      has_frontend: files.some((f) => f.file_category === "component" || f.file_name === "package.json"),
      has_backend: files.some((f) => ["api", "source", "database"].includes(f.file_category)) && backendLanguages.length > 0,
      monorepo: files.some(
        (f) => String(f.path).split("/").slice(0, -1).some(
          (part) => ["apps", "packages", "services", "libs", "backend", "frontend"].includes(part)
        )
      )
    },
    frontend: {
      components: files.filter((f) => f.file_category === "component").length,
      pages: files.filter((f) => /^(app|pages|src\/pages|src\/app)\//.test(f.path) && /\.(tsx|jsx|vue|svelte|ts)$/.test(f.path)).map((f) => f.path).slice(0, MAX_IMPORTANT_FILES),
      state_management: stateManagement,
      styling
    },
    backend: {
      languages: backendLanguages,
      endpoint_count: routes.length,
      entrypoints: files.filter(
        (f) => ["main.py", "app.py", "server.js", "index.js", "main.go", "manage.py"].includes(f.file_name)
      ).map((f) => f.path).slice(0, MAX_IMPORTANT_FILES)
    },
    database: {
      technologies: input.databases.map((d) => d.name),
      schema_files: files.filter((f) => ["schema", "database"].includes(f.file_category)).map((f) => f.path).slice(0, MAX_IMPORTANT_FILES),
      orm_evidence: input.databases.slice(0, 10).map((d) => d.evidence)
    },
    authentication: {
      detected: input.auth.slice(0, 12).map((a) => a.name),
      evidence: input.auth.slice(0, 10).map((a) => a.evidence),
      authorization_checks: input.auth.some((a) => a.name.includes("Authorization"))
    },
    apis: routes.slice(0, MAX_ROUTES),
    external_integrations: input.integrations.slice(0, MAX_INTEGRATIONS),
    features: (input.readme?.features ?? []).slice(0, MAX_FEATURES),
    testing: {
      test_file_count: input.tests.file_count,
      frameworks: input.tests.frameworks.map((f) => f.name),
      commands: input.tests.commands,
      has_tests: input.tests.file_count > 0
    },
    deployment: {
      files: files.filter((f) => f.file_category === "deployment").map((f) => f.path).slice(0, MAX_IMPORTANT_FILES),
      ci: files.filter((f) => f.path.startsWith(".github/workflows") || f.path === ".gitlab-ci.yml").map((f) => f.path).slice(0, 10)
    },
    repository_stats: {
      file_count: files.length,
      total_files_seen: Number(input.repository.total_files ?? files.length),
      line_count: files.reduce((total, f) => total + (f.line_count ?? 0), 0),
      symbol_count: input.symbols.length,
      secret_findings: input.secrets.length
    },
    readme: {
      present: Boolean(input.readme?.present),
      description: (input.readme?.description ?? "").slice(0, 600),
      technologies: (input.readme?.technologies ?? []).slice(0, MAX_FEATURES)
    },
    security: {
      hardcoded_secrets: input.secrets.slice(0, MAX_WARNINGS).map((s) => ({
        type: s.secret_type,
        file: s.file,
        line: s.line
      })),
      secret_file_present: files.some((f) => String(f.file_name ?? "").startsWith(".env"))
    },
    important_files: shownFiles.map((f) => ({
      path: f.path,
      category: f.file_category,
      importance: f.importance,
      lines: f.line_count
    })),
    warnings: warnings.slice(0, MAX_WARNINGS),
    truncated: {
      routes: hiddenRoutes,
      dependencies: hiddenDeps,
      files: hiddenFiles,
      integrations: hiddenIntegrations,
      auth: hiddenAuth,
      frameworks: hiddenFrameworks
    }
  };
}

// _shared/github-api.ts
var GitHubError = class extends Error {
  constructor(message, code, statusCode = 0) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "GitHubError";
  }
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var GitHubClient = class {
  cache = /* @__PURE__ */ new Map();
  rateLimit = {
    limit: 0,
    remaining: -1,
    resetEpoch: 0,
    cooldownUntil: 0
  };
  get exhausted() {
    return this.rateLimit.remaining === 0 || Date.now() / 1e3 < this.rateLimit.cooldownUntil;
  }
  /** GET a GitHub path, returning decoded JSON. */
  async get(path, cacheable = true) {
    if (cacheable && this.cache.has(path)) {
      return this.cache.get(path);
    }
    if (this.exhausted) {
      throw new GitHubError(
        "GitHub rate limit reached; analysis cannot continue right now.",
        "rate_limited",
        429
      );
    }
    const { githubMaxRetries, githubTimeoutSeconds } = settings();
    let lastError = null;
    for (let attempt = 0; attempt < githubMaxRetries; attempt++) {
      const response = await this.request(path, githubTimeoutSeconds);
      if (response.status === 200) {
        const body = await response.json();
        if (cacheable) this.cache.set(path, body);
        return body;
      }
      if (response.status === 404) {
        throw new GitHubError(
          "That repository, branch or file was not found on GitHub.",
          "not_found",
          404
        );
      }
      if (response.status === 403 || response.status === 429) {
        this.rateLimit.cooldownUntil = Date.now() / 1e3 + Math.min(60, 2 * (attempt + 1));
        this.rateLimit.remaining = 0;
        throw new GitHubError(
          "GitHub rate limit reached; analysis cannot continue right now.",
          "rate_limited",
          response.status
        );
      }
      if (response.status >= 500) {
        lastError = new GitHubError(
          `GitHub is unavailable (${response.status}).`,
          "provider_error",
          response.status
        );
      } else {
        throw new GitHubError("GitHub rejected the request.", "client_error", response.status);
      }
      if (attempt < githubMaxRetries - 1) {
        await sleep(Math.min(8e3, 750 * 2 ** attempt));
      }
    }
    throw lastError ?? new GitHubError("GitHub request failed.", "network");
  }
  /** One HTTP attempt, with the rate-limit headers read on every response. */
  async request(path, timeoutSeconds) {
    const { githubApiBase, githubToken } = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1e3);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HackSim-Scanner"
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    try {
      const response = await fetch(`${githubApiBase}${path}`, {
        headers,
        signal: controller.signal
      });
      this.readRateLimitHeaders(response);
      return response;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw aborted ? new GitHubError("GitHub timed out.", "timeout") : new GitHubError(
        `GitHub request failed: ${error?.message ?? error}`,
        "network"
      );
    } finally {
      clearTimeout(timer);
    }
  }
  readRateLimitHeaders(response) {
    const read = (name) => {
      const raw = response.headers.get(name);
      if (raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const limit = read("x-ratelimit-limit");
    const remaining = read("x-ratelimit-remaining");
    const reset = read("x-ratelimit-reset");
    if (limit !== null) this.rateLimit.limit = limit;
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (reset !== null) this.rateLimit.resetEpoch = reset;
  }
  // ── §10 URL validation + parsing ─────────────────────────────────────────
  parseRepositoryUrl(url) {
    try {
      const ref = parseRepositoryUrl(url);
      return { owner: ref.owner, repo: ref.repo };
    } catch (error) {
      if (error instanceof InvalidRepositoryUrl) {
        throw new GitHubError(error.message, "invalid_url");
      }
      throw error;
    }
  }
  // ── §11 endpoints the scanner uses ───────────────────────────────────────
  repository(owner, repo) {
    return this.get(`/repos/${owner}/${repo}`);
  }
  latestCommit(owner, repo, branch) {
    return this.get(`/repos/${owner}/${repo}/commits/${branch}`);
  }
  gitTree(owner, repo, commitSha) {
    return this.get(`/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`);
  }
  /**
   * Raw file bytes, cached.
   *
   * Uses the blob API rather than /contents so a file is fetched in one request
   * regardless of size, and we never base64-decode a payload we would then
   * throw away.
   */
  async blob(owner, repo, blobSha) {
    if (this.cache.has(blobSha)) {
      return this.cache.get(blobSha);
    }
    if (this.exhausted) {
      throw new GitHubError(
        "GitHub rate limit reached; analysis cannot continue right now.",
        "rate_limited",
        429
      );
    }
    const { githubApiBase, githubToken, githubTimeoutSeconds, analysisMaxFileBytes } = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), githubTimeoutSeconds * 1e3);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HackSim-Scanner"
    };
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
    try {
      const response = await fetch(
        `${githubApiBase}/repos/${owner}/${repo}/git/blobs/${blobSha}`,
        { headers, signal: controller.signal }
      );
      this.readRateLimitHeaders(response);
      if (response.status === 200) {
        const payload = await response.json();
        const binary = atob((payload.content ?? "").replace(/\n/g, ""));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        if (bytes.length <= analysisMaxFileBytes) this.cache.set(blobSha, bytes);
        return bytes;
      }
      if (response.status === 403 || response.status === 429) {
        this.rateLimit.cooldownUntil = Date.now() / 1e3 + 5;
        this.rateLimit.remaining = 0;
        throw new GitHubError(
          "GitHub rate limit reached; analysis cannot continue right now.",
          "rate_limited",
          response.status
        );
      }
      throw new GitHubError(
        `Could not read a file from the repository (HTTP ${response.status}).`,
        "blob_error",
        response.status
      );
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw aborted ? new GitHubError("GitHub timed out.", "timeout") : new GitHubError(
        `Could not read a file from the repository: ${error?.message ?? error}`,
        "blob_error"
      );
    } finally {
      clearTimeout(timer);
    }
  }
};

// _shared/scanner.ts
var SCANNER_VERSION = "p5-1";
var READ_CATEGORIES = /* @__PURE__ */ new Set([
  "source",
  "component",
  "api",
  "model",
  "schema",
  "database",
  "config",
  "documentation",
  "test"
]);
var ALWAYS_READ_NAMES = /* @__PURE__ */ new Set([
  "readme.md",
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "composer.json",
  "pubspec.yaml",
  "alembic.ini",
  "manage.py",
  "schema.prisma"
]);
async function scanRepository(client, owner, repo) {
  const config = settings();
  const metadata = await client.repository(owner, repo);
  const branch = metadata.default_branch || "main";
  const commit = await client.latestCommit(owner, repo, branch);
  const commitSha = commit.sha;
  if (!commitSha) {
    throw new GitHubError("Could not determine the latest commit.", "no_commit");
  }
  const tree = await client.gitTree(owner, repo, commitSha);
  const entries2 = (tree.tree ?? []).filter((entry) => entry.type === "blob");
  const truncatedTree = Boolean(tree.truncated);
  const analysisMode = truncatedTree || entries2.length > config.analysisLargeRepoThreshold ? "limited" : "full";
  const warnings = [];
  if (truncatedTree) {
    warnings.push(
      "GitHub returned a truncated file tree; some paths are not listed by the API."
    );
  }
  if (entries2.length > config.analysisLargeRepoThreshold) {
    warnings.push(
      `Repository has ${entries2.length} files. Analysis was limited to relevant files.`
    );
  }
  const registry = new EvidenceRegistry();
  const inventory = [];
  for (const entry of entries2) {
    const path = entry.path ?? "";
    if (!path) continue;
    const size = Number(entry.size ?? 0);
    if (isIgnored(path) || isSensitive(path)) {
      const category2 = categoryOf(path, false);
      inventory.push({
        record: {
          path,
          file_name: basenameOf(path),
          extension: extensionOf(path),
          language: languageOf(path),
          file_size: size,
          line_count: null,
          is_binary: false,
          is_ignored: true,
          file_category: category2,
          importance: "ignored",
          sha: entry.sha ?? null
        },
        category: category2,
        importance: "ignored"
      });
      continue;
    }
    const extension = extensionOf(path);
    const provisionalBinary = [".png", ".jpg", ".pdf", ".zip", ".ico"].includes(extension);
    const category = categoryOf(path, provisionalBinary);
    inventory.push({
      record: {
        path,
        file_name: basenameOf(path),
        extension,
        language: languageOf(path),
        file_size: size,
        line_count: null,
        is_binary: provisionalBinary,
        is_ignored: false,
        file_category: category,
        importance: importanceOf(path, category),
        sha: entry.sha ?? null
      },
      category,
      importance: importanceOf(path, category)
    });
  }
  const readCandidates = inventory.filter(
    (item) => !item.record.is_ignored && READ_CATEGORIES.has(item.record.file_category) && item.record.file_size <= config.analysisMaxFileBytes
  );
  const priority = (item) => {
    const name = (item.record.file_name ?? "").toLowerCase();
    if (ALWAYS_READ_NAMES.has(name)) return 0;
    if (item.record.importance === "high") return 1;
    if (item.record.importance === "medium") return 2;
    return 3;
  };
  readCandidates.sort(
    (a, b) => priority(a) - priority(b) || a.record.file_size - b.record.file_size
  );
  const maxReads = analysisMode === "full" ? config.analysisMaxFiles : Math.max(40, Math.floor(config.analysisMaxFiles / 2));
  const selected = readCandidates.slice(0, maxReads);
  if (readCandidates.length > selected.length) {
    warnings.push(
      `${readCandidates.length - selected.length} candidate files were not read to stay within the analysis budget.`
    );
  }
  const files = [];
  const chunks = [];
  const dependencies = [];
  const allSymbols = [];
  const routes = [];
  const integrations = [];
  const secrets = [];
  const testPaths = [];
  const sourcesForCodeScan = [];
  const configFilenames = inventory.map((item) => item.record.file_name).filter((name) => Boolean(name));
  const testCommandContents = [];
  let readme = null;
  let blobBudgetExhausted = false;
  for (const item of inventory) {
    const { record, category } = item;
    if (record.is_ignored) {
      files.push(record);
      continue;
    }
    if (category === "asset") {
      record.is_binary = true;
      record.importance = "ignored";
      files.push(record);
      continue;
    }
    if (isTestFile(record.path)) testPaths.push(record.path);
  }
  for (const item of selected) {
    const { record, category, importance } = item;
    const path = record.path;
    let blob;
    try {
      blob = await client.blob(owner, repo, record.sha ?? "");
    } catch (error) {
      if (error instanceof GitHubError && error.code === "rate_limited") {
        blobBudgetExhausted = true;
        warnings.push(
          "GitHub rate limit reached partway through; later files were not read."
        );
        break;
      }
      warnings.push(`Could not read \`${path}\`.`);
      continue;
    }
    const binary = looksBinary(blob);
    record.is_binary = binary;
    record.file_size = blob.length;
    files.push(record);
    if (binary) {
      record.importance = "ignored";
      continue;
    }
    const content = decodeText(blob);
    if (content === null) {
      record.is_binary = true;
      continue;
    }
    record.line_count = countLines(content);
    sourcesForCodeScan.push({ path, content });
    for (const finding of scanFileForSecrets(path, content)) {
      secrets.push(finding);
      registry.add({
        type: "secret",
        claim: `Possible hard-coded ${finding.secret_type.replace(/_/g, " ")}`,
        file: path,
        lines: String(finding.line),
        confidence: "medium",
        detail: { secret_type: finding.secret_type }
      });
    }
    const name = (record.file_name ?? "").toLowerCase();
    if (ALWAYS_READ_NAMES.has(name) || category === "dependency") {
      dependencies.push(...extractDependencies(path, content));
    }
    if (name.startsWith("readme") && readme === null) {
      readme = parseReadme(path, content);
      if (readme.description) {
        registry.add({
          type: "readme",
          claim: `README describes the project: ${readme.description.slice(0, 160)}`,
          file: path,
          confidence: "high"
        });
      }
    }
    if (["package.json", "makefile", "pyproject.toml"].includes(name)) {
      testCommandContents.push(content);
    }
    if (isSourceLike(category)) {
      const { symbols, parserStatus } = extractSymbols(path, content);
      if (parserStatus === "ok") {
        allSymbols.push(...symbols);
        chunks.push(...chunksFor(path, record, symbols, content, importance));
      }
      routes.push(...extractRoutes(path, content));
      integrations.push(...extractIntegrations(content, path));
    }
  }
  const frameworks = detectFrameworks(dependencies, configFilenames);
  const databases = [
    ...detectDatabases(dependencies, files.map((f) => f.path)),
    ...detectDatabaseInCode(sourcesForCodeScan)
  ];
  const auth = [...detectAuth(dependencies), ...detectAuthInCode(sourcesForCodeScan)];
  const tests = {
    file_count: testPaths.length,
    frameworks: detectTestFrameworks(configFilenames, files.map((f) => f.path)),
    commands: detectTestCommands(testCommandContents)
  };
  recordStructuralEvidence(registry, {
    metadata,
    owner,
    repo,
    branch,
    commitSha,
    frameworks,
    dependencies,
    databases,
    auth,
    routes,
    tests,
    secrets,
    files,
    analysisMode
  });
  const projectMap = buildProjectMap({
    repository: {
      owner,
      repo_name: repo,
      default_branch: branch,
      analyzed_commit_sha: commitSha,
      visibility: metadata.visibility ?? null,
      language: metadata.language ?? null,
      stars: metadata.stargazers_count ?? null,
      forks: metadata.forks_count ?? null,
      total_files: entries2.length
    },
    files,
    dependencies,
    frameworks,
    databases,
    auth,
    routes,
    symbols: allSymbols,
    integrations,
    tests,
    readme,
    secrets,
    analysisMode,
    warnings
  });
  if (blobBudgetExhausted && !projectMap.apis.length) {
    throw new GitHubError(
      "GitHub rate limit reached before any endpoint could be detected.",
      "rate_limited",
      429
    );
  }
  return {
    owner,
    repoName: repo,
    defaultBranch: branch,
    commitSha,
    visibility: metadata.visibility ?? null,
    language: metadata.language ?? null,
    stars: metadata.stargazers_count ?? null,
    forks: metadata.forks_count ?? null,
    analysisMode,
    files,
    chunks,
    evidence: registry.toList(),
    projectMap,
    secretCount: secrets.length,
    scannerVersion: SCANNER_VERSION
  };
}
function chunksFor(path, record, symbols, content, importance) {
  const lines = content.split("\n");
  const chunks = [];
  if (symbols.length === 0) {
    if (importance === "high" && lines.length <= 200) {
      chunks.push({
        file_path: path,
        chunk_index: 0,
        start_line: 1,
        end_line: lines.length,
        content: content.slice(0, 2e4),
        symbol_name: null,
        symbol_type: "file",
        language: record.language,
        importance
      });
    }
    return chunks;
  }
  symbols.slice(0, 20).forEach((symbol, index) => {
    const start = Math.max(1, symbol.line);
    const end = Math.min(lines.length, start + 160);
    const body = lines.slice(start - 1, end).join("\n");
    if (!body.trim()) return;
    chunks.push({
      file_path: path,
      chunk_index: index,
      start_line: start,
      end_line: end,
      content: body.slice(0, 2e4),
      symbol_name: symbol.name,
      symbol_type: symbol.symbol_type,
      language: record.language,
      importance
    });
  });
  return chunks;
}
function recordStructuralEvidence(registry, input) {
  registry.add({
    type: "repository",
    claim: `Repository ${input.owner}/${input.repo} analysed at commit ${input.commitSha.slice(0, 12)} on branch ${input.branch}`,
    confidence: "high",
    detail: {
      visibility: input.metadata.visibility ?? null,
      language: input.metadata.language ?? null,
      stars: input.metadata.stargazers_count ?? null
    }
  });
  registry.add({
    type: "analysis_mode",
    claim: input.analysisMode === "limited" ? "Analysis mode limited to relevant files." : "Full repository analysis.",
    confidence: "high"
  });
  for (const item of input.frameworks) {
    registry.add({
      type: "framework",
      claim: `${item.name} is in use (${item.evidence})`,
      file: item.file ?? null,
      symbol: item.symbol ?? null,
      lines: item.lines ?? null,
      confidence: item.file ? "high" : "medium"
    });
  }
  for (const dependency of input.dependencies) {
    if (["utility", "testing"].includes(dependency.category)) continue;
    registry.add({
      type: "dependency",
      claim: `Dependency \`${dependency.package}\` (${dependency.category})`,
      symbol: dependency.package,
      confidence: "high",
      detail: { category: dependency.category, version: dependency.version }
    });
  }
  for (const item of input.databases) {
    registry.add({
      type: "database",
      claim: `${item.name} detected (${item.evidence})`,
      file: item.file ?? null,
      lines: item.lines ?? null,
      confidence: "high"
    });
  }
  for (const item of input.auth) {
    registry.add({
      type: "authentication",
      claim: `${item.name} detected (${item.evidence})`,
      file: item.file ?? null,
      lines: item.lines ?? null,
      confidence: item.file ? "high" : "medium"
    });
  }
  for (const route of input.routes.slice(0, 120)) {
    registry.add({
      type: "route",
      claim: `${route.method} ${route.path} exists`,
      file: route.file,
      symbol: route.symbol,
      lines: `${route.line}-${route.line}`,
      confidence: "high",
      detail: { method: route.method, framework: route.framework }
    });
  }
  for (const framework of input.tests.frameworks) {
    registry.add({
      type: "test_framework",
      claim: `Test framework ${framework.name} detected (${framework.evidence})`,
      confidence: "medium"
    });
  }
  if (input.tests.file_count) {
    registry.add({
      type: "testing",
      claim: `${input.tests.file_count} test files present`,
      confidence: "medium"
    });
  }
  for (const secret of input.secrets) {
    registry.add({
      type: "secret",
      claim: `Possible hard-coded ${secret.secret_type.replace(/_/g, " ")} at ${secret.file}:${secret.line}`,
      file: secret.file,
      lines: String(secret.line),
      confidence: "medium"
    });
  }
  for (const record of input.files.filter((f) => ["schema", "database"].includes(f.file_category)).slice(0, 20)) {
    registry.add({
      type: "database_schema",
      claim: `Schema or migration file present: ${record.path}`,
      file: record.path,
      confidence: "high"
    });
  }
  for (const record of input.files.filter((f) => f.file_category === "config" && f.importance === "high").slice(0, 15)) {
    registry.add({
      type: "config",
      claim: `Configuration file present: ${record.path}`,
      file: record.path,
      confidence: "medium"
    });
  }
}
var AnalysisStore = class {
  service = db();
  /** One scan per (submission, commit, scanner version). */
  async cached(submissionId, commitSha) {
    const { data } = await this.service.from("repositories").select(
      "id, analysis_status, project_map, evidence, analyzed_commit_sha, analysis_version"
    ).eq("submission_id", submissionId).eq("analyzed_commit_sha", commitSha).eq("analysis_version", SCANNER_VERSION).in("analysis_status", ["completed", "limited"]).limit(1);
    return data?.[0] ?? null;
  }
  async markScanning(submissionId, githubUrl) {
    await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: githubUrl,
        analysis_status: "scanning",
        analysis_version: SCANNER_VERSION,
        error_code: null,
        error_message: null
      },
      { onConflict: "submission_id" }
    );
  }
  async markFailed(submissionId, githubUrl, code, message) {
    await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: githubUrl,
        analysis_status: "failed",
        analysis_version: SCANNER_VERSION,
        error_code: code,
        error_message: message.slice(0, 500)
      },
      { onConflict: "submission_id" }
    );
  }
  /** Mark the cached row stale so a forced re-analysis does not short-circuit. */
  async markStale(submissionId) {
    await this.service.from("repositories").update({ analysis_status: "stale" }).eq("submission_id", submissionId);
  }
  async persist(submissionId, result) {
    const { data, error } = await this.service.from("repositories").upsert(
      {
        submission_id: submissionId,
        github_url: `https://github.com/${result.owner}/${result.repoName}`,
        owner: result.owner,
        repo_name: result.repoName,
        default_branch: result.defaultBranch,
        latest_commit_sha: result.commitSha,
        analyzed_commit_sha: result.commitSha,
        visibility: result.visibility,
        language: result.language,
        stars: result.stars,
        forks: result.forks,
        // `completed` for a full scan, `limited` when we tightened the read set.
        analysis_status: result.analysisMode === "full" ? "completed" : "limited",
        analysis_version: result.scannerVersion,
        analysis_mode: result.analysisMode,
        project_map: result.projectMap,
        evidence: result.evidence,
        file_count: result.files.length,
        chunk_count: result.chunks.length,
        secret_count: result.secretCount,
        error_code: null,
        error_message: null,
        last_analyzed_at: (/* @__PURE__ */ new Date()).toISOString()
      },
      { onConflict: "submission_id" }
    ).select("id").single();
    if (error || !data) {
      throw new HttpError("Could not persist the repository row.", 500);
    }
    const repositoryId = data.id;
    await this.writeFiles(repositoryId, result.files);
    await this.writeChunks(repositoryId, result.chunks);
    return repositoryId;
  }
  /** Inventory rows are rewritten wholesale; a re-scan supersedes them. */
  async writeFiles(repositoryId, files) {
    const service = this.service;
    await service.from("repository_files").delete().eq("repository_id", repositoryId);
    const rows = files.map((record) => ({
      repository_id: repositoryId,
      path: record.path,
      file_name: record.file_name,
      extension: record.extension || null,
      language: record.language,
      file_size: record.file_size,
      line_count: record.line_count,
      is_binary: record.is_binary,
      is_ignored: record.is_ignored,
      file_category: record.file_category,
      importance: record.importance,
      sha: record.sha
    }));
    for (let start = 0; start < rows.length; start += 500) {
      const { error } = await service.from("repository_files").upsert(rows.slice(start, start + 500), { onConflict: "repository_id,path" });
      if (error) {
        console.warn("[hacksim.analysis] could not write file rows:", error.message);
        return;
      }
    }
  }
  /** Chunks reference a file id, so they are written after the files. */
  async writeChunks(repositoryId, chunks) {
    const service = this.service;
    const { data: fileRows } = await service.from("repository_files").select("id, path").eq("repository_id", repositoryId);
    const idByPath = new Map(
      (fileRows ?? []).map((row) => [
        row.path,
        row.id
      ])
    );
    await service.from("code_chunks").delete().eq("repository_id", repositoryId);
    const rows = chunks.map((chunk) => {
      const fileId = idByPath.get(chunk.file_path);
      if (!fileId) return null;
      return {
        repository_id: repositoryId,
        file_id: fileId,
        chunk_index: chunk.chunk_index ?? 0,
        start_line: chunk.start_line ?? null,
        end_line: chunk.end_line ?? null,
        content: String(chunk.content ?? "").slice(0, 2e4),
        symbol_name: chunk.symbol_name ?? null,
        symbol_type: chunk.symbol_type ?? null,
        language: chunk.language ?? null,
        importance: chunk.importance ?? null
      };
    }).filter((row) => row !== null);
    for (let start = 0; start < rows.length; start += 400) {
      const { error } = await service.from("code_chunks").upsert(rows.slice(start, start + 400), { onConflict: "file_id,chunk_index" });
      if (error) {
        console.warn("[hacksim.analysis] could not write chunk rows:", error.message);
        return;
      }
    }
  }
  /** Everything the Phase 6 reviewer needs, in one read. */
  async loadForReview(submissionId) {
    const { data: repositories } = await this.service.from("repositories").select("*").eq("submission_id", submissionId).limit(1);
    const repository = repositories?.[0];
    if (!repository) return null;
    const [{ data: files }, { data: chunks }] = await Promise.all([
      this.service.from("repository_files").select(
        "id, path, file_name, language, file_category, importance, is_ignored, is_binary, line_count"
      ).eq("repository_id", repository.id).eq("is_ignored", false),
      this.service.from("code_chunks").select(
        "file_id, chunk_index, start_line, end_line, content, symbol_name, symbol_type, language, importance"
      ).eq("repository_id", repository.id).eq("importance", "high").limit(600)
    ]);
    const pathById = new Map(
      (files ?? []).map((row) => [
        row.id,
        row.path
      ])
    );
    return {
      repository,
      files: files ?? [],
      chunks: (chunks ?? []).map((chunk) => ({
        ...chunk,
        file_path: pathById.get(chunk.file_id)
      })).filter((chunk) => chunk.file_path),
      evidence: repository.evidence ?? [],
      projectMap: repository.project_map ?? {}
    };
  }
};
async function analyzeSubmission(submissionId, githubUrl) {
  const store = new AnalysisStore();
  const client = new GitHubClient();
  let owner;
  let repo;
  try {
    ({ owner, repo } = client.parseRepositoryUrl(githubUrl));
  } catch (error) {
    const message = error.message;
    const code = error instanceof GitHubError ? error.code : "invalid_url";
    await store.markFailed(submissionId, githubUrl, code, message);
    return { status: "failed", error: message, code };
  }
  await store.markScanning(submissionId, githubUrl);
  let result;
  try {
    result = await scanRepository(client, owner, repo);
  } catch (error) {
    const message = error.message ?? "Repository analysis failed.";
    const code = error instanceof GitHubError ? error.code : "scanner_error";
    await store.markFailed(submissionId, githubUrl, code, message);
    return { status: "failed", error: message, code };
  }
  const cached2 = await store.cached(submissionId, result.commitSha);
  if (cached2) {
    return {
      status: "cached",
      repository_id: cached2.id,
      project_map: cached2.project_map
    };
  }
  const repositoryId = await store.persist(submissionId, result);
  return {
    // A full scan reports "completed"; a tightened one reports "limited".
    status: result.analysisMode === "full" ? "completed" : "limited",
    repository_id: repositoryId,
    commit_sha: result.commitSha,
    file_count: result.files.length,
    evidence_count: result.evidence.length
  };
}

// _shared/modules.ts
var PROMPT_VERSIONS = {
  alignment: "align-v1",
  architecture: "arch-v1",
  quality: "quality-v1",
  contribution: "contrib-v1",
  claims: "claims-v1",
  requirements_fallback: "reqmap-v1"
};
var MODULE_A = "alignment";
var MODULE_B = "architecture";
var MODULE_C = "quality";
var MODULE_D = "contribution";
var SYSTEM_STABLE = `You are a technical reviewer assessing a hackathon submission against its
brief. You are given FACTS extracted deterministically from a GitHub repository,
and small targeted code snippets. The facts are the source of truth.

Rules you must follow:
1. Never invent files, functions, endpoints, tables, dependencies, features,
metrics or vulnerabilities. If something is not in the evidence, say it is not
evidenced.
2. Every conclusion must cite evidence ids from the list you are given.
3. "not_evidenced" means the analysed repository did not show sufficient evidence.
It does NOT mean the feature does not exist.
4. Never claim a real-world impact or benchmark number unless the evidence
contains a measurement. Describe intent instead.
5. Prefer "potential_issue" over "confirmed_issue". Use "confirmed_issue" only
when the evidence unambiguously establishes the problem.
6. Do not rank, score, or compare teams. This is a training analysis.
7. Reply with a single JSON object matching the requested shape. No prose.`;
function moduleResult(module, status, source, data, reason = "") {
  return { module, status, source, data, reason };
}
var REQUIREMENT_SIGNALS = {
  auth: ["Supabase Auth", "JWT", "Passport", "NextAuth", "Clerk", "Auth0"],
  predict: ["TensorFlow", "PyTorch", "scikit-learn", "XGBoost", "OpenAI"],
  database: ["PostgreSQL", "Supabase", "SQLAlchemy", "Prisma", "MongoDB", "SQL"]
};
function signalsFor(text) {
  const found = [];
  for (const [keyword, names] of Object.entries(REQUIREMENT_SIGNALS)) {
    if (text.includes(keyword)) found.push(...names);
  }
  return found;
}
function alignmentFromEvidence(requirementMap, projectMap) {
  const requirements = requirementMap.requirements ?? [];
  if (requirements.length === 0) return null;
  const stats = projectMap.repository_stats ?? {};
  const endpoints = (projectMap.apis ?? []).length;
  const files = stats.file_count ?? 0;
  const dependencies = Object.values(
    projectMap.stack?.dependencies_by_category ?? {}
  ).reduce((sum, list) => sum + list.length, 0);
  if (endpoints < 2 && files < 15 && dependencies < 5) return null;
  const detected = new Set(
    projectMap.authentication?.detected ?? []
  );
  const hasDatabase = Boolean(
    projectMap.database?.technologies?.length
  );
  const critical = requirements.filter((r) => r.importance === "critical");
  const checkable = critical.length ? critical : requirements;
  const addressed = [];
  for (const requirement of checkable) {
    const signals = signalsFor(requirement.text.toLowerCase());
    if (signals.length && signals.some((signal) => detected.has(signal))) {
      addressed.push(requirement.id);
    }
  }
  const ratio = checkable.length ? addressed.length / checkable.length : 0;
  let status;
  let explanation;
  if (hasDatabase && checkable.some((r) => r.category === "ai_ml")) {
    status = "partially_aligned";
    explanation = "The repository contains a data layer and a machine-learning dependency, but no direct evidence links a model to the feature.";
  } else if (ratio >= 0.6) {
    status = "strongly_aligned";
    explanation = `${addressed.length} of ${checkable.length} core requirements have a matching detected technology in the repository.`;
  } else if (ratio >= 0.25) {
    status = "partially_aligned";
    explanation = `${addressed.length} of ${checkable.length} core requirements have a matching detected technology. The remainder are not evidenced by detection alone.`;
  } else {
    status = "weakly_evidenced";
    explanation = "Detected technologies do not clearly correspond to the stated core requirements. Code inspection is needed to determine coverage.";
  }
  return { status, confidence: "medium", addressed_requirement_ids: addressed, explanation };
}
function testingFromEvidence(projectMap) {
  const testing = projectMap.testing ?? {};
  const count = Number(testing.test_file_count ?? 0);
  const frameworks = (testing.frameworks ?? []).map((name) => name);
  let status;
  let finding;
  if (count === 0) {
    status = "not_evidenced";
    finding = "testing_gap";
  } else if (count < 3) {
    status = "partial_evidence";
    finding = "testing_gap";
  } else {
    status = "evidence_found";
    finding = null;
  }
  return {
    status,
    testFileCount: count,
    frameworks,
    commands: testing.commands ?? [],
    finding,
    explanation: count === 0 ? "No test files were detected in the analysed repository." : `${count} test files detected. File count is not a measure of test quality.`
  };
}
function securityFromEvidence(projectMap) {
  const secrets = projectMap.security?.hardcoded_secrets ?? [];
  if (secrets.length === 0) return null;
  return {
    status: "evidence_found",
    confirmed_issues: secrets.slice(0, 5).map((item) => {
      const words = item.type.replace(/_/g, " ");
      return {
        type: "security_concern",
        severity: "high",
        title: `Hard-coded ${words} in ${item.file}`,
        description: `A value matching a ${words} pattern was found at ${item.file} line ${item.line}. The value itself is redacted and was not transmitted.`,
        why_it_matters: "A committed credential should be rotated, not just removed.",
        suggested_improvement: "Rotate the credential and load it from the environment.",
        confidence: "medium"
      };
    })
  };
}
function formatItems(items) {
  if (!items || items.length === 0) return "(none provided)";
  return items.slice(0, 30).map((item) => `- [${item.id}] (${item.category}, ${item.importance}) ${item.text}`).join("\n");
}
function truncateJson(payload, limit) {
  const text = JSON.stringify(payload ?? null);
  return text.length <= limit ? text : `${text.slice(0, limit)} \u2026(truncated)`;
}
var NO_SNIPPETS = "(no relevant code could be retrieved)";
function buildAlignmentTask(input) {
  const facts = compactEvidence(input.evidence, 120);
  const submission = input.submission;
  return `Assess whether this submission addresses THIS specific hackathon.

Return JSON:
{
  "problem_alignment": {
    "status": "strongly_aligned|partially_aligned|weakly_evidenced|unclear",
    "confidence": "high|medium|low",
    "evidence_ids": ["EV-001"],
    "explanation": "How the implementation relates to the stated problem."
  },
  "requirements": [
    {
      "requirement_id": "REQ-001",
      "status": "evidence_found|partial_evidence|not_evidenced|unable_to_determine",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What in the repository shows this, or why it is not evidenced."
    }
  ],
  "summary": {
    "headline": "One sentence.",
    "strengths": ["..."],
    "areas_to_clarify": ["..."]
  }
}

Only include a requirement entry for the requirement ids listed below.

PROJECT PROBLEM
${(input.requirementMap.problem_summary || "").slice(0, 1500)}

REQUIREMENTS
${formatItems(input.requirementMap.requirements)}

CONSTRAINTS
${formatItems(input.requirementMap.constraints)}

EXPECTED OUTCOME
${formatItems(input.requirementMap.expected_outcomes)}

EVALUATION CRITERIA
${formatItems(input.requirementMap.evaluation_criteria)}

WHAT THE STUDENT CLAIMED
Project: ${submission.project_name || "(none)"}
Description: ${String(submission.project_description ?? "").slice(0, 900)}
Key features: ${String(submission.key_features ?? "").slice(0, 900)}
Tech stack claimed: ${String(submission.tech_stack ?? "").slice(0, 400)}

PROJECT MAP (deterministic facts)
${truncateJson(input.projectMap, 6e3)}

REPOSITORY FACTS
${truncateJson(facts, 6e3)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}
function buildArchitectureTask(input) {
  const facts = compactEvidence(input.evidence, 80);
  return `Assess the technical architecture and implementation of this project.

Return JSON:
{
  "architecture": {
    "summary": "How the project is structured.",
    "layers": ["..."],
    "entry_points": ["..."],
    "evidence_ids": ["EV-001"]
  },
  "technical_decisions": [
    {"decision":"...","rationale":"... (only if the evidence supports it)","evidence_ids":["EV-001"]}
  ],
  "implementation": {
    "summary": "...",
    "strengths": ["..."],
    "observations": ["..."]
  },
  "findings": [
    {
      "type": "strength|observation|potential_issue|architecture_concern|scalability_concern",
      "severity": "critical|high|medium|low|informational",
      "title": "...",
      "description": "...",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "why_it_matters": "...",
      "suggested_improvement": "...",
      "confidence": "high|medium|low"
    }
  ]
}

Do not invent a technical decision rationale the repository does not show. If the
reason for a choice is not in the evidence, omit the rationale.

PROJECT MAP
${truncateJson(input.projectMap, 5e3)}

REPOSITORY FACTS
${truncateJson(facts, 5e3)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}
function buildQualityTask(input) {
  const facts = compactEvidence(input.evidence, 80);
  return `Assess security, data handling, testing and scalability of this project.

Return JSON:
{
  "security": {
    "summary": "...",
    "authentication_present": true,
    "authorization_checks_present": true,
    "concerns": ["..."],
    "evidence_ids": ["EV-001"]
  },
  "database": {
    "summary": "...",
    "technologies": ["..."],
    "schema_present": true,
    "evidence_ids": ["EV-001"]
  },
  "testing": {
    "summary": "...",
    "evidence_ids": ["EV-001"]
  },
  "scalability": {
    "summary": "...",
    "concerns": ["..."],
    "evidence_ids": ["EV-001"]
  },
  "findings": [
    {
      "type": "security_concern|testing_gap|scalability_concern|potential_issue|observation",
      "severity": "critical|high|medium|low|informational",
      "title": "...",
      "description": "...",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "why_it_matters": "...",
      "suggested_improvement": "...",
      "confidence": "high|medium|low"
    }
  ]
}

Report only what the evidence supports. A concern you cannot evidence must be
omitted, not softened.

PROJECT MAP
${truncateJson(input.projectMap, 5e3)}

REPOSITORY FACTS
${truncateJson(facts, 5e3)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}
function buildContributionTask(input) {
  const facts = compactEvidence(input.evidence, 60);
  const member = input.member;
  return `Assess one team member's claimed contribution against the repository.

Return JSON:
{
  "status": "supported_by_repository|partially_supported|not_yet_verified",
  "confidence": "high|medium|low",
  "evidence_ids": ["EV-001"],
  "matched_files": ["path"],
  "matched_symbols": ["name"],
  "explanation": "What the repository shows about this contribution, or why it cannot be determined."
}

Absence of evidence is not evidence of absence. If the claim is broad or the
repository cannot speak to it, use "not_yet_verified" and say so plainly.

CLAIMED CONTRIBUTION (${member.full_name || member.email || "member"})
Description: ${String(member.contribution_description ?? "(none)").slice(0, 700)}
Areas: ${(member.contribution_areas ?? []).join(", ") || "(none)"}
Planned responsibilities: ${String(member.planned_responsibilities ?? "(none)").slice(0, 500)}
AI tools disclosed: ${String(member.ai_tools_used ?? "(none)").slice(0, 300)}

OTHER TEAM MEMBERS (so you do not attribute their work to this person)
${input.otherMembers.join(", ") || "(none)"}

PROJECT MAP
${truncateJson(input.projectMap, 3500)}

REPOSITORY FACTS
${truncateJson(facts, 3500)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}
function buildClaimsTask(input) {
  const facts = compactEvidence(input.evidence, 80);
  return `Check each feature the student claimed against the repository.

Return JSON:
{
  "claims": [
    {
      "claim": "...",
      "status": "supported|partially_supported|not_evidenced",
      "evidence_ids": ["EV-001"],
      "files": ["path"],
      "symbols": ["name"],
      "explanation": "..."
    }
  ]
}

"not_evidenced" means the analysed repository did not show evidence. It is not a
statement that the claim is false.

CLAIMS
${input.claims.map((claim) => `- ${claim}`).join("\n")}

PROJECT MAP
${truncateJson(input.projectMap, 4e3)}

REPOSITORY FACTS
${truncateJson(facts, 4e3)}

TARGETED CODE
${input.snippets || NO_SNIPPETS}`;
}
var ALIGNMENT_STATUSES = [
  "strongly_aligned",
  "partially_aligned",
  "weakly_evidenced",
  "unclear"
];
var REQUIREMENT_STATUSES = [
  "evidence_found",
  "partial_evidence",
  "not_evidenced",
  "unable_to_determine"
];
var CONSTRAINT_STATUSES = [
  "supported",
  "potential_concern",
  "not_evidenced",
  "unable_to_determine"
];
var OUTCOME_STATUSES = ["supported", "partially_supported", "not_evidenced", "unclear"];
var CONTRIBUTION_STATUSES = [
  "supported_by_repository",
  "partially_supported",
  "not_yet_verified"
];
var CONFIDENCES = ["high", "medium", "low", "none"];
var FINDING_TYPES = [
  "strength",
  "observation",
  "potential_issue",
  "confirmed_issue",
  "security_concern",
  "testing_gap",
  "architecture_concern",
  "scalability_concern",
  "claim_mismatch",
  "clarification_needed"
];
var SEVERITIES = ["critical", "high", "medium", "low", "informational"];
var MAX_FINDINGS_PER_MODULE = 8;
function validateFindings(raw, evidenceIds) {
  if (!Array.isArray(raw)) return [];
  const findings = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item;
    if (!record.title) continue;
    const cited = (record.evidence_ids ?? []).filter((id) => evidenceIds.has(id));
    if (cited.length === 0 && record.type !== "observation") continue;
    let findingType = FINDING_TYPES.includes(record.type) ? record.type : "observation";
    const severity = SEVERITIES.includes(record.severity) ? record.severity : "low";
    const confidence = ["high", "medium", "low"].includes(record.confidence) ? record.confidence : "low";
    if (findingType === "confirmed_issue" && confidence === "low") {
      findingType = "potential_issue";
    }
    findings.push({
      finding_type: findingType,
      severity,
      title: String(record.title).slice(0, 200),
      description: String(record.description ?? "").slice(0, 2e3),
      evidence_ids: cited.slice(0, 12),
      files: (record.files ?? []).map(String).slice(0, 12),
      symbols: (record.symbols ?? []).map(String).slice(0, 12),
      why_it_matters: String(record.why_it_matters ?? "").slice(0, 1e3),
      suggested_improvement: String(record.suggested_improvement ?? "").slice(0, 1e3),
      confidence
    });
    if (findings.length >= MAX_FINDINGS_PER_MODULE) break;
  }
  return findings;
}

// _shared/retrieval.ts
var QUESTION_SIGNALS = {
  security: [
    "auth",
    "login",
    "password",
    "token",
    "jwt",
    "session",
    "cookie",
    "permission",
    "role",
    "secret",
    "key",
    "credential",
    "encrypt",
    "hash"
  ],
  database: [
    "database",
    "db",
    "schema",
    "migration",
    "table",
    "query",
    "sql",
    "model",
    "orm",
    "index",
    "postgres",
    "supabase",
    "storage",
    "data"
  ],
  api: [
    "api",
    "endpoint",
    "route",
    "request",
    "response",
    "controller",
    "handler",
    "rest",
    "graphql",
    "webhook",
    "fetch",
    "http"
  ],
  frontend: [
    "ui",
    "component",
    "page",
    "screen",
    "form",
    "render",
    "view",
    "react",
    "vue",
    "dashboard",
    "interface",
    "click",
    "button"
  ],
  testing: ["test", "spec", "coverage", "assert", "mock", "fixture"],
  prediction: [
    "predict",
    "forecast",
    "model",
    "train",
    "inference",
    "ml",
    "machine learning",
    "algorithm",
    "score",
    "accuracy",
    "dataset"
  ],
  deployment: ["deploy", "docker", "build", "ci", "pipeline", "hosting", "vercel"],
  configuration: ["config", "setting", "environment", "env", "variable", "option"]
};
var PATH_SIGNALS = {
  security: ["auth", "login", "session", "permission", "middleware", "guard", "acl"],
  database: ["schema", "migration", "model", "db", "database", "sql", "prisma", "repository"],
  api: ["route", "router", "controller", "api", "endpoint", "handler", "view"],
  frontend: ["component", "page", "view", "screen", "ui", "app/", "layout"],
  testing: ["test", "spec", "__tests__", "fixtures"],
  deployment: ["docker", "workflow", "deploy", "ci", "vercel", "netlify"],
  configuration: ["config", "settings", ".env", "settings.py", "constants"]
};
var CATEGORY_PREFERENCE = {
  security: ["source", "api", "config", "model"],
  database: ["database", "schema", "model", "source"],
  api: ["api", "source", "component"],
  frontend: ["component", "source"],
  testing: ["test"],
  deployment: ["deployment", "config"],
  configuration: ["config", "deployment", "source"]
};
var ContextPacket = class {
  constructor(question, category) {
    this.question = question;
    this.category = category;
  }
  snippets = [];
  filesConsidered = 0;
  truncated = false;
  get isEmpty() {
    return this.snippets.length === 0;
  }
  /** A deliberately crude estimate — good enough to gate a budget. */
  estimateTokens() {
    return Math.floor(this.snippets.reduce((sum, s) => sum + s.content.length, 0) / 4);
  }
  render(maxSnippetLines = settings().retrievalMaxSnippetLines) {
    if (this.snippets.length === 0) return "";
    const blocks = this.snippets.map((snippet) => {
      const all = snippet.content.split("\n");
      const shown = all.slice(0, maxSnippetLines);
      let body = shown.join("\n");
      if (shown.length < all.length) body += "\n\u2026 (truncated)";
      return `--- ${snippet.path} [${snippet.symbol ?? "file"}] lines ${snippet.startLine}-${snippet.endLine} ---
${body}`;
    });
    return blocks.join("\n\n");
  }
};
function classifyQuestion(question, categories) {
  const lowered = (question ?? "").toLowerCase();
  const wanted = categories ?? Object.keys(QUESTION_SIGNALS);
  let bestCategory = "general";
  let bestScore = 0;
  for (const category of wanted) {
    const score = (QUESTION_SIGNALS[category] ?? []).filter((term) => lowered.includes(term)).length;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  return bestCategory;
}
function buildPacket(input) {
  const config = settings();
  const limitFiles = input.maxFiles ?? config.retrievalMaxFiles;
  const limitLines = input.maxLines ?? config.retrievalMaxSnippetLines;
  const category = input.category ?? classifyQuestion(input.question);
  const packet = new ContextPacket(input.question, category);
  packet.filesConsidered = input.files.length;
  if (input.files.length === 0) return packet;
  const questionTerms = (input.question ?? "").toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  const pathTerms = PATH_SIGNALS[category] ?? [];
  const preferredCategories = CATEGORY_PREFERENCE[category] ?? [];
  const importanceWeight = {
    high: 30,
    medium: 15,
    low: 5,
    ignored: 0
  };
  const chunksByFile = /* @__PURE__ */ new Map();
  for (const chunk of input.chunks) {
    const path = chunk.file_path ?? chunk.path;
    if (!path) continue;
    const list = chunksByFile.get(path) ?? [];
    list.push(chunk);
    chunksByFile.set(path, list);
  }
  const ranked = [];
  for (const record of input.files) {
    const path = record.path ?? "";
    if (!path || record.is_ignored || record.is_binary) continue;
    if (record.importance === "ignored") continue;
    const lowered = path.toLowerCase();
    let score = importanceWeight[record.importance ?? "low"] ?? 5;
    if (pathTerms.some((fragment) => lowered.includes(fragment))) score += 40;
    if (preferredCategories.includes(record.file_category)) score += 20;
    score += questionTerms.filter((term) => lowered.includes(term)).length * 6;
    const candidateChunks = chunksByFile.get(path) ?? [];
    if (candidateChunks.some((chunk) => {
      const symbol = String(chunk.symbol_name ?? "").toLowerCase();
      return Boolean(symbol) && questionTerms.some((term) => symbol.includes(term));
    })) {
      score += 18;
    }
    if (score <= 5) continue;
    ranked.push({ score, path, language: record.language ?? null, chunks: candidateChunks });
  }
  ranked.sort((a, b) => b.score - a.score);
  const selected = ranked.slice(0, limitFiles);
  if (ranked.length > selected.length) packet.truncated = true;
  for (const item of selected) {
    if (item.chunks.length) {
      const chosen = [...item.chunks].sort((a, b) => {
        const highA = a.importance === "high" ? 1 : 0;
        const highB = b.importance === "high" ? 1 : 0;
        if (highA !== highB) return highB - highA;
        const termsA = questionTerms.filter(
          (term) => String(a.symbol_name ?? "").toLowerCase().includes(term)
        ).length;
        const termsB = questionTerms.filter(
          (term) => String(b.symbol_name ?? "").toLowerCase().includes(term)
        ).length;
        return termsB - termsA;
      })[0];
      const start = Number(chosen.start_line ?? 1);
      const end = Math.min(
        start + limitLines - 1,
        Number(chosen.end_line ?? start + limitLines)
      );
      packet.snippets.push({
        path: item.path,
        symbol: chosen.symbol_name ?? null,
        startLine: start,
        endLine: end,
        content: chosen.content ?? "",
        language: item.language,
        score: item.score
      });
    } else {
      packet.snippets.push({
        path: item.path,
        symbol: null,
        startLine: 1,
        endLine: limitLines,
        content: "",
        language: item.language,
        score: item.score
      });
    }
  }
  return packet;
}

// _shared/requirements.ts
var IMPORTANCE_KEYWORDS = [
  ["critical", ["must", "required", "requirement", "core", "essential", "need to", "has to"]],
  ["important", ["should", "provide", "expose", "surface", "support"]],
  ["optional", ["optional", "if you have the time", "nice to have", "bonus", "ideally"]]
];
var HEADING = /^#{1,6}\s+/;
var BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
var TASK = /^\s*-\s*\[\s*[ xX]?\s*\]\s*/;
var NOISE = /^(?:[-*+]\s*)?(?:usage|contents|table of contents)\s*:?\s*$/i;
function clean(line) {
  return line.replace(HEADING, "").replace(BULLET, "").replace(TASK, "").trim().replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
}
function truncate(text, limit = 300) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}\u2026`;
}
function dedupe(items) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.slice(0, 40);
}
function splitItems(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split("\n");
  const bullets = [];
  for (const line of lines) {
    if (!BULLET.test(line)) continue;
    const cleaned = clean(line);
    if (cleaned && !NOISE.test(cleaned) && cleaned.length > 2) bullets.push(cleaned);
  }
  if (bullets.length >= 2) {
    return dedupe(bullets.map((bullet) => truncate(bullet)));
  }
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    return dedupe(paragraphs.map((p) => truncate(p)));
  }
  const sentences = text.trim().split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
  if (sentences.length) {
    return dedupe(sentences.map((s) => truncate(s)));
  }
  return [truncate(text.trim())];
}
function importanceOf2(text) {
  const lowered = text.toLowerCase();
  for (const [level, keywords] of IMPORTANCE_KEYWORDS) {
    if (keywords.some((keyword) => lowered.includes(keyword))) return level;
  }
  return "important";
}
function entries(prefix, items, category) {
  return items.map((item, index) => ({
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    text: item,
    category,
    importance: importanceOf2(item)
  }));
}
function buildRequirementMap(hackathon) {
  return {
    requirements: entries(
      "REQ",
      splitItems(hackathon.requirements),
      "core_functionality"
    ),
    constraints: entries(
      "CON",
      splitItems(hackathon.constraints),
      "constraint"
    ),
    expected_outcomes: entries(
      "OUT",
      splitItems(hackathon.expected_outcome),
      "outcome"
    ),
    evaluation_criteria: entries(
      "EVAL",
      splitItems(hackathon.evaluation_criteria),
      "evaluation"
    ),
    problem_summary: truncate(hackathon.problem_statement || "", 1500)
  };
}
function requirementMapHash(hackathon) {
  const payload = [
    "problem_statement",
    "requirements",
    "constraints",
    "expected_outcome",
    "evaluation_criteria"
  ].map((field) => String(hackathon[field] ?? "")).join("|");
  return shortHash(payload);
}
async function getRequirementMap(hackathonId, hackathon) {
  const wantedHash = await requirementMapHash(hackathon);
  const { data } = await db().from("hackathon_requirement_maps").select("*").eq("hackathon_id", hackathonId).order("version", { ascending: false }).limit(1);
  const rows = data ?? [];
  const row = rows[0];
  if (row && row.input_hash === wantedHash) {
    return {
      version: row.version ?? 1,
      input_hash: wantedHash,
      problem_summary: row.problem_summary ?? "",
      requirements: row.requirements ?? [],
      constraints: row.constraints ?? [],
      expected_outcomes: row.expected_outcomes ?? [],
      evaluation_criteria: row.evaluation_criteria ?? []
    };
  }
  const fresh = buildRequirementMap(hackathon);
  const version = row ? (row.version ?? 1) + 1 : 1;
  const { error } = await db().from("hackathon_requirement_maps").insert({
    hackathon_id: hackathonId,
    version,
    problem_summary: fresh.problem_summary,
    requirements: fresh.requirements,
    constraints: fresh.constraints,
    expected_outcomes: fresh.expected_outcomes,
    evaluation_criteria: fresh.evaluation_criteria,
    input_hash: wantedHash
  });
  if (error) console.warn("[hacksim.requirements] could not cache map:", error.message);
  return { version, input_hash: wantedHash, ...fresh };
}

// _shared/review.ts
var MAX_MEMBER_MODULES = 6;
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
function section(payload, evidenceIds) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { summary: "No result returned.", source: "skipped" };
  }
  const record = payload;
  const result = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== "evidence_ids") result[key] = value;
  }
  const cited = (record.evidence_ids ?? []).filter((id) => evidenceIds.has(id));
  if (cited.length) result.evidence_ids = cited.slice(0, 12);
  return result;
}
function requirementsFromDeterministic(requirements, alignment) {
  const addressed = new Set(alignment.addressed_requirement_ids ?? []);
  return requirements.map(
    (requirement) => addressed.has(requirement.id) ? {
      requirement_id: requirement.id,
      status: "partial_evidence",
      confidence: "low",
      evidence_ids: [],
      explanation: "A matching technology was detected, but the specific implementation was not inspected for this requirement."
    } : {
      requirement_id: requirement.id,
      status: "unable_to_determine",
      confidence: "none",
      evidence_ids: [],
      explanation: "No matching technology was detected. This does not mean the feature is absent; the repository was not inspected at code level."
    }
  );
}
function validateRequirementRows(raw, requirements, evidenceIds) {
  if (!Array.isArray(raw)) return [];
  const known = new Set(requirements.map((r) => r.id));
  const rows = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry;
    const id = String(record.requirement_id ?? "");
    if (!known.has(id)) continue;
    rows.push({
      requirement_id: id,
      status: oneOf(record.status, REQUIREMENT_STATUSES, "unable_to_determine"),
      confidence: oneOf(record.confidence, CONFIDENCES, "low"),
      evidence_ids: (record.evidence_ids ?? []).filter((e) => evidenceIds.has(e)).slice(0, 12),
      explanation: String(record.explanation ?? "").slice(0, 1500)
    });
  }
  return rows;
}
function claimsFrom(submission) {
  const claims = [];
  for (const line of String(submission.key_features ?? "").split("\n")) {
    const cleaned = line.trim().replace(/^[-*•\s]+/, "").trim();
    if (cleaned.length > 8) claims.push(cleaned.slice(0, 200));
  }
  const description = String(submission.project_description ?? "").trim();
  if (description) claims.unshift(description.slice(0, 300));
  return claims.slice(0, 10);
}
function deterministicClaims(claims) {
  return {
    claims: claims.map((claim) => ({
      claim,
      status: "not_evidenced",
      evidence_ids: [],
      explanation: "AI review unavailable; no deterministic evidence matched."
    }))
  };
}
function overallStatus(modules) {
  if (modules.length === 0) return "pending";
  if (modules.every((m) => m.status === "failed")) return "failed";
  if (modules.some((m) => ["completed", "cached"].includes(m.status))) {
    return modules.some((m) => m.status === "failed") ? "partial" : "completed";
  }
  return modules.some((m) => m.status === "skipped") ? "partial" : "pending";
}
async function call(input) {
  const { pricing } = input;
  const ctxHash = await contextHash(input.contextParts, input.promptVersion, pricing.modelName);
  if (!aiConfigured()) {
    console.info("[hacksim.review] AI not configured; skipping", input.operation);
    return null;
  }
  const cached2 = await findCachedAnalysis({
    repositoryId: input.repositoryId,
    analysisType: input.scopeKey,
    promptVersion: input.promptVersion,
    model: pricing.modelName,
    ctxHash
  });
  if (cached2?.result) {
    console.info("[hacksim.review] cache hit for", input.scopeKey);
    return {
      content: JSON.stringify(cached2.result),
      parsed: cached2.result,
      requestId: null,
      model: pricing.modelName,
      inputTokens: Number(cached2.input_tokens ?? 0),
      outputTokens: Number(cached2.output_tokens ?? 0),
      totalTokens: Number(cached2.total_tokens ?? 0),
      cachedTokens: Number(cached2.cached_tokens ?? 0),
      cacheMissTokens: Number(cached2.cache_miss_tokens ?? 0),
      durationMs: 0,
      promptVersion: input.promptVersion
    };
  }
  const decision = await checkBudget({
    pricing,
    submissionId: input.submissionId,
    estimatedInputTokens: input.estimateTokens,
    estimatedOutputTokens: pricing.maxOutputTokens,
    cacheRatio: ["alignment", "quality"].includes(input.scopeKey) ? 0.5 : 0
  });
  if (!decision.allowed) {
    console.info("[hacksim.review] blocked", input.operation, decision.reason);
    await recordUsage({
      operation: input.operation,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: input.promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requestId: null,
      status: "rejected",
      durationMs: 0,
      userId: input.actorId,
      submissionId: input.submissionId,
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
      errorCode: decision.reason || "blocked"
    });
    return null;
  }
  const contextStable = JSON.stringify({
    context_hash: ctxHash,
    modules: input.contextParts
  }).slice(0, 12e3);
  let response;
  try {
    response = await completeJson({
      systemStable: SYSTEM_STABLE,
      contextStable,
      task: input.task,
      promptVersion: input.promptVersion,
      maxOutputTokens: Math.min(pricing.maxOutputTokens, 2500)
    });
  } catch (error) {
    const code = error instanceof AIError ? error.code : "unknown";
    const message = error.message;
    console.warn("[hacksim.review]", input.operation, "failed:", message);
    await recordUsage({
      operation: input.operation,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: input.promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      requestId: null,
      status: "failed",
      durationMs: 0,
      userId: input.actorId,
      submissionId: input.submissionId,
      repositoryId: input.repositoryId,
      sessionId: input.sessionId,
      errorCode: code,
      errorMessage: message
    });
    await saveAnalysis({
      analysisType: input.scopeKey,
      provider: pricing.provider,
      model: pricing.modelName,
      promptVersion: input.promptVersion,
      ctxHash,
      status: "failed",
      resultPayload: null,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 0,
      costUsd: 0,
      repositoryId: input.repositoryId,
      submissionId: input.submissionId,
      scopeKey: input.scopeKey,
      errorCode: code,
      errorMessage: message
    });
    return null;
  }
  const cost = calculateCost(pricing, {
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    outputTokens: response.outputTokens
  });
  const valid = response.parsed !== null;
  const status = valid ? "success" : "failed";
  const errorCode = valid ? null : "invalid_json";
  const errorMessage = valid ? null : "Provider did not return valid JSON.";
  input.spend.costUsd += cost;
  input.spend.tokens += response.inputTokens + response.outputTokens;
  await recordUsage({
    operation: input.operation,
    provider: pricing.provider,
    model: response.model,
    promptVersion: input.promptVersion,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    costUsd: cost,
    requestId: response.requestId,
    status,
    durationMs: response.durationMs,
    userId: input.actorId,
    submissionId: input.submissionId,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    errorCode,
    errorMessage
  });
  await saveAnalysis({
    analysisType: input.scopeKey,
    provider: pricing.provider,
    model: response.model,
    promptVersion: input.promptVersion,
    ctxHash,
    status,
    resultPayload: response.parsed,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    totalTokens: response.totalTokens,
    cachedTokens: response.cachedTokens,
    cacheMissTokens: response.cacheMissTokens,
    costUsd: cost,
    repositoryId: input.repositoryId,
    submissionId: input.submissionId,
    scopeKey: input.scopeKey,
    errorCode,
    errorMessage,
    completedAt: valid ? (/* @__PURE__ */ new Date()).toISOString() : null
  });
  return response;
}
async function runReview(input) {
  const repositoryId = input.repository.repository_id ?? input.repository.id;
  const repositoryIdValue = repositoryId ?? null;
  const submissionId = input.submission.id ?? null;
  const evidenceIds = new Set(
    input.evidence.map((item) => item.id).filter((id) => Boolean(id))
  );
  const outcome = {
    reviewId: null,
    status: "pending",
    modules: [],
    totalCostUsd: 0,
    totalTokens: 0
  };
  const review = await loadReview(submissionId, repositoryIdValue);
  const requirementMap = await getRequirementMap(
    String(input.hackathon.id),
    input.hackathon
  );
  const pricing = await loadPricing();
  if (!pricing) {
    outcome.status = "failed";
    outcome.error = "No AI model is configured.";
    await upsertReview(submissionId, repositoryIdValue, {}, outcome, null);
    return outcome;
  }
  const results = { ...review?.data ?? {} };
  const spend = { costUsd: 0, tokens: 0 };
  const wants = (module) => !input.onlyModules || input.onlyModules.includes(module);
  if (wants(MODULE_A)) {
    try {
      const result = await moduleAlignment({
        input,
        requirementMap,
        evidenceIds,
        submissionId,
        repositoryIdValue,
        pricing,
        spend
      });
      outcome.modules.push(result);
      Object.assign(results, result.data);
    } catch (error) {
      console.error("[hacksim.review] module A failed", error);
      outcome.modules.push({
        ...moduleResult(MODULE_A, "failed", "ai", {}),
        errorMessage: error.message
      });
    }
  }
  if (wants(MODULE_B)) {
    try {
      const result = await moduleGeneric({
        module: MODULE_B,
        promptVersion: PROMPT_VERSIONS.architecture,
        taskBuilder: (snippets) => buildArchitectureTask({
          projectMap: input.projectMap,
          evidence: input.evidence,
          snippets
        }),
        question: "How is this project architected, and what technical decisions does it make?",
        input,
        evidenceIds,
        submissionId,
        repositoryIdValue,
        pricing,
        spend,
        scope: "architecture"
      });
      outcome.modules.push(result);
      if (result.data.architecture) results.architecture = result.data.architecture;
      if (result.data.technical_decisions) results.technical_decisions = result.data.technical_decisions;
      if (result.data.implementation) results.implementation = result.data.implementation;
    } catch (error) {
      console.error("[hacksim.review] module B failed", error);
      outcome.modules.push({
        ...moduleResult(MODULE_B, "failed", "ai", {}),
        errorMessage: error.message
      });
    }
  }
  if (wants(MODULE_C)) {
    try {
      const result = await moduleQuality({
        input,
        evidenceIds,
        submissionId,
        repositoryIdValue,
        pricing,
        spend
      });
      outcome.modules.push(result);
      if (result.data.security) results.security = result.data.security;
      if (result.data.database) results.database_review = result.data.database;
      if (result.data.testing) results.testing = result.data.testing;
      if (result.data.scalability) results.scalability = result.data.scalability;
    } catch (error) {
      console.error("[hacksim.review] module C failed", error);
      outcome.modules.push({
        ...moduleResult(MODULE_C, "failed", "ai", {}),
        errorMessage: error.message
      });
    }
  }
  if (wants(MODULE_D)) {
    try {
      const contributionResults = await moduleContributions({
        input,
        evidenceIds,
        submissionId,
        repositoryIdValue,
        pricing,
        spend
      });
      outcome.modules.push(...contributionResults);
      if (contributionResults.length) {
        results.contributions = Object.fromEntries(
          contributionResults.filter((item) => item.data.user_id).map((item) => [item.data.user_id, item.data])
        );
      }
    } catch (error) {
      console.error("[hacksim.review] module D failed", error);
      outcome.modules.push({
        ...moduleResult(MODULE_D, "failed", "ai", {}),
        errorMessage: error.message
      });
    }
  }
  outcome.status = overallStatus(outcome.modules);
  outcome.totalCostUsd = spend.costUsd;
  outcome.totalTokens = spend.tokens;
  outcome.reviewId = await upsertReview(submissionId, repositoryIdValue, results, outcome, pricing);
  await replaceRequirementEvaluations(submissionId, outcome.modules, evidenceIds);
  await replaceFindings(outcome.reviewId, outcome.modules, evidenceIds);
  await replaceDefenseTargets(submissionId, input.members, outcome.modules, requirementMap, evidenceIds);
  return outcome;
}
async function moduleAlignment(args) {
  const { input, requirementMap, evidenceIds, submissionId, repositoryIdValue, pricing, spend } = args;
  const requirements = requirementMap.requirements ?? [];
  const out = {};
  const deterministic = alignmentFromEvidence(requirementMap, input.projectMap);
  if (deterministic) {
    out.problem_alignment = deterministic;
    out.requirements = requirementsFromDeterministic(requirements, deterministic);
    const addressed = new Set(deterministic.addressed_requirement_ids ?? []);
    out.summary = {
      headline: deterministic.explanation,
      strengths: [],
      areas_to_clarify: requirements.filter((r) => !addressed.has(r.id)).map((r) => `${r.id} has no matching detected technology`).slice(0, 6),
      source: "deterministic"
    };
  } else {
    const packet = buildPacket({
      question: "Does this repository implement the hackathon requirements?",
      files: input.files,
      chunks: input.chunks,
      category: "api"
    });
    const response = await call({
      operation: `${MODULE_A}.alignment`,
      task: buildAlignmentTask({
        requirementMap,
        projectMap: input.projectMap,
        evidence: input.evidence,
        snippets: packet.render(),
        submission: input.submission
      }),
      promptVersion: PROMPT_VERSIONS.alignment,
      contextParts: [requirementMap, input.projectMap],
      scopeKey: "alignment",
      repositoryId: repositoryIdValue,
      submissionId,
      pricing,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      estimateTokens: packet.estimateTokens() + 3500,
      spend
    });
    if (response === null) {
      return moduleResult(MODULE_A, "skipped", "deterministic", {}, "no_call");
    }
    const payload = response.parsed ?? {};
    const alignment = payload.problem_alignment ?? {};
    out.problem_alignment = {
      status: oneOf(alignment.status, ALIGNMENT_STATUSES, "unclear"),
      confidence: oneOf(alignment.confidence, ["high", "medium", "low"], "low"),
      evidence_ids: (alignment.evidence_ids ?? []).filter((id) => evidenceIds.has(id)).slice(0, 12),
      explanation: String(alignment.explanation ?? "").slice(0, 1500),
      source: "ai"
    };
    out.requirements = validateRequirementRows(payload.requirements, requirements, evidenceIds);
    const summary = payload.summary ?? {};
    out.summary = {
      headline: String(summary.headline ?? "").slice(0, 300),
      strengths: (summary.strengths ?? []).map((s) => String(s).slice(0, 200)).slice(0, 6),
      areas_to_clarify: (summary.areas_to_clarify ?? []).map((s) => String(s).slice(0, 200)).slice(0, 6),
      source: "ai"
    };
  }
  const claims = claimsFrom(input.submission);
  if (claims.length) {
    const claimResult = await moduleGeneric({
      module: "claims",
      promptVersion: PROMPT_VERSIONS.claims,
      taskBuilder: (snippets) => buildClaimsTask({
        claims,
        projectMap: input.projectMap,
        evidence: input.evidence,
        snippets
      }),
      question: "Which claimed features are supported by the code?",
      input,
      evidenceIds,
      submissionId,
      repositoryIdValue,
      pricing,
      spend,
      scope: "claims",
      preComputed: deterministicClaims(claims)
    });
    if (claimResult.data.claims) out.claims = claimResult.data.claims;
    const mismatches = (claimResult.data.findings ?? []).filter(
      (finding) => finding.finding_type === "claim_mismatch"
    );
    if (mismatches.length) {
      out.findings = [...out.findings ?? [], ...mismatches];
    }
  }
  return moduleResult(
    MODULE_A,
    "completed",
    deterministic ? "deterministic" : "ai",
    out
  );
}
async function moduleQuality(args) {
  const { input, evidenceIds, submissionId, repositoryIdValue, pricing, spend } = args;
  const securityFacts = securityFromEvidence(input.projectMap);
  const testingFacts = testingFromEvidence(input.projectMap);
  const packet = buildPacket({
    question: "authentication authorization middleware database schema and tests",
    files: input.files,
    chunks: input.chunks,
    category: "security"
  });
  const response = await call({
    operation: `${MODULE_C}.quality`,
    task: buildQualityTask({
      projectMap: input.projectMap,
      evidence: input.evidence,
      snippets: packet.render()
    }),
    promptVersion: PROMPT_VERSIONS.quality,
    contextParts: [input.projectMap, testingFacts, securityFacts],
    scopeKey: "quality",
    repositoryId: repositoryIdValue,
    submissionId,
    pricing,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    estimateTokens: packet.estimateTokens() + 3500,
    spend
  });
  const out = {};
  const findings = [];
  if (response?.parsed) {
    const payload = response.parsed;
    out.security = section(payload.security, evidenceIds);
    out.database = section(payload.database, evidenceIds);
    out.scalability = section(payload.scalability, evidenceIds);
    out.testing = { ...testingFacts, source: "deterministic" };
    findings.push(
      ...validateFindings(payload.findings, evidenceIds)
    );
  } else {
    out.security = securityFacts ?? { summary: "AI review unavailable.", source: "skipped" };
    out.database = { summary: "AI review unavailable.", source: "skipped" };
    out.scalability = { summary: "AI review unavailable.", source: "skipped" };
    out.testing = { ...testingFacts, source: "deterministic" };
  }
  if (securityFacts) {
    findings.push(
      ...securityFacts.confirmed_issues
    );
  }
  if (testingFacts.finding && testingFacts.testFileCount === 0) {
    findings.push({
      finding_type: "testing_gap",
      severity: "medium",
      title: "No automated tests detected",
      description: testingFacts.explanation,
      evidence_ids: [],
      files: [],
      symbols: [],
      why_it_matters: "Behaviour that is not covered by tests is unverified when it changes.",
      suggested_improvement: "Add tests for the main user path, starting with failure cases.",
      confidence: "medium"
    });
  }
  if (findings.length) out.findings = findings;
  return moduleResult(MODULE_C, "completed", "ai", out);
}
async function moduleGeneric(args) {
  const { input, evidenceIds, submissionId, repositoryIdValue, pricing, spend, scope } = args;
  const packet = buildPacket({
    question: args.question,
    files: input.files,
    chunks: input.chunks
  });
  const response = await call({
    operation: `${args.module}.${scope}`,
    task: args.taskBuilder(packet.render()),
    promptVersion: args.promptVersion,
    contextParts: [input.projectMap],
    scopeKey: scope,
    repositoryId: repositoryIdValue,
    submissionId,
    pricing,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    estimateTokens: packet.estimateTokens() + 3e3,
    spend
  });
  if (response === null || !response.parsed) {
    return moduleResult(
      args.module,
      "skipped",
      "deterministic",
      {
        ...args.preComputed ?? {},
        status: "skipped",
        reason: "AI unavailable or budget exhausted; deterministic facts only."
      }
    );
  }
  const data = { ...response.parsed };
  data.findings = validateFindings(response.parsed.findings, evidenceIds);
  return moduleResult(args.module, "completed", "ai", data);
}
async function moduleContributions(args) {
  const { input, evidenceIds, submissionId, repositoryIdValue, pricing, spend } = args;
  const checkable = input.members.filter((member) => (member.contribution_description ?? "").trim()).slice(0, MAX_MEMBER_MODULES);
  const results = [];
  const otherNames = input.members.map(
    (member) => member.full_name || member.email || "member"
  );
  for (const member of checkable) {
    const question = (member.contribution_description ?? "").slice(0, 400);
    const packet = buildPacket({
      question,
      files: input.files,
      chunks: input.chunks,
      maxFiles: 4
    });
    const response = await call({
      operation: `${MODULE_D}.contribution`,
      task: buildContributionTask({
        member,
        projectMap: input.projectMap,
        evidence: input.evidence,
        snippets: packet.render(),
        otherMembers: otherNames
      }),
      promptVersion: PROMPT_VERSIONS.contribution,
      contextParts: [input.projectMap, member.id],
      scopeKey: `contribution:${member.id}`,
      repositoryId: repositoryIdValue,
      submissionId,
      pricing,
      actorId: input.actorId ?? null,
      sessionId: input.sessionId ?? null,
      estimateTokens: packet.estimateTokens() + 2e3,
      spend
    });
    if (response === null || !response.parsed) {
      results.push(
        moduleResult(MODULE_D, "skipped", "deterministic", {
          user_id: member.user_id,
          member_id: member.id,
          status: "not_yet_verified",
          confidence: "none",
          explanation: "Contribution analysis was unavailable."
        })
      );
      continue;
    }
    const payload = response.parsed;
    results.push(
      moduleResult(MODULE_D, "completed", "ai", {
        user_id: member.user_id,
        member_id: member.id,
        status: oneOf(payload.status, CONTRIBUTION_STATUSES, "not_yet_verified"),
        confidence: oneOf(payload.confidence, ["high", "medium", "low"], "low"),
        evidence_ids: (payload.evidence_ids ?? []).filter((id) => evidenceIds.has(id)).slice(0, 10),
        matched_files: (payload.matched_files ?? []).map((f) => String(f).slice(0, 200)).slice(0, 10),
        matched_symbols: (payload.matched_symbols ?? []).map((s) => String(s).slice(0, 120)).slice(0, 10),
        explanation: String(payload.explanation ?? "").slice(0, 1200)
      })
    );
  }
  return results;
}
async function loadReview(submissionId, repositoryId) {
  if (!submissionId || !repositoryId) return null;
  const { data } = await db().from("project_reviews").select("*").eq("submission_id", submissionId).eq("repository_id", repositoryId).limit(1);
  return (data ?? [])[0] ?? null;
}
async function upsertReview(submissionId, repositoryId, results, outcome, pricing) {
  if (!submissionId || !repositoryId) return null;
  const service = db();
  const existing = await loadReview(submissionId, repositoryId);
  const payload = {
    submission_id: submissionId,
    repository_id: repositoryId,
    status: outcome.status,
    model: pricing?.modelName ?? null,
    prompt_version: PROMPT_VERSIONS.alignment,
    estimated_cost_usd: outcome.totalCostUsd,
    total_tokens: outcome.totalTokens
  };
  for (const key of [
    "summary",
    "problem_alignment",
    "requirements",
    "constraints",
    "expected_outcomes",
    "evaluation_criteria",
    "architecture",
    "implementation",
    "security",
    "database_review",
    "testing",
    "scalability",
    "technical_decisions",
    "contributions"
  ]) {
    if (results[key] !== void 0 && results[key] !== null) payload[key] = results[key];
  }
  try {
    if (existing?.id) {
      const { error: error2 } = await service.from("project_reviews").update(payload).eq("id", existing.id);
      if (error2) throw error2;
      return existing.id;
    }
    const { data, error } = await service.from("project_reviews").insert(payload).select("id").single();
    if (error || !data) throw error ?? new Error("no row");
    return data.id;
  } catch (error) {
    console.warn("[hacksim.review] could not persist review:", error);
    return null;
  }
}
function rowsFromModule(module, evidenceIds) {
  const rows = [];
  const cite = (value) => (value ?? []).filter((id) => evidenceIds.has(id)).slice(0, 12);
  for (const entry of module.data.requirements ?? []) {
    if (!entry?.requirement_id) continue;
    rows.push({
      requirement_id: String(entry.requirement_id).slice(0, 32),
      status: oneOf(entry.status, REQUIREMENT_STATUSES, "unable_to_determine"),
      evidence_ids: cite(entry.evidence_ids),
      confidence: oneOf(entry.confidence, CONFIDENCES, "low"),
      explanation: String(entry.explanation ?? "").slice(0, 1500),
      source: module.source === "deterministic" ? "deterministic" : "ai"
    });
  }
  for (const entry of module.data.constraints ?? []) {
    if (!entry?.constraint_id) continue;
    rows.push({
      requirement_id: String(entry.constraint_id).slice(0, 32),
      status: oneOf(entry.status, CONSTRAINT_STATUSES, "unable_to_determine"),
      evidence_ids: cite(entry.evidence_ids),
      confidence: oneOf(entry.confidence, CONFIDENCES, "low"),
      explanation: String(entry.explanation ?? "").slice(0, 1500),
      source: "ai"
    });
  }
  for (const entry of module.data.expected_outcomes ?? []) {
    if (!entry?.outcome_id) continue;
    rows.push({
      requirement_id: String(entry.outcome_id).slice(0, 32),
      status: oneOf(entry.status, OUTCOME_STATUSES, "unclear"),
      evidence_ids: cite(entry.evidence_ids),
      confidence: oneOf(entry.confidence, CONFIDENCES, "low"),
      explanation: String(entry.explanation ?? "").slice(0, 1500),
      source: "ai"
    });
  }
  return rows;
}
async function replaceRequirementEvaluations(submissionId, modules, evidenceIds) {
  if (!submissionId) return;
  const rows = modules.flatMap((module) => rowsFromModule(module, evidenceIds));
  if (rows.length === 0) return;
  try {
    const { data: existing } = await db().from("requirement_evaluations").select("id").eq("submission_id", submissionId);
    if ((existing ?? []).length) {
      await db().from("requirement_evaluations").delete().eq("submission_id", submissionId);
    }
    const { error } = await db().from("requirement_evaluations").upsert(
      rows.map((row) => ({ submission_id: submissionId, ...row })),
      { onConflict: "submission_id,requirement_id" }
    );
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.review] could not persist requirement evaluations:", error);
  }
}
async function replaceFindings(reviewId, modules, evidenceIds) {
  if (!reviewId) return;
  const rows = modules.flatMap((module) => module.data.findings ?? []).map((finding) => ({
    project_review_id: reviewId,
    finding_type: finding.finding_type ?? "observation",
    severity: finding.severity ?? "low",
    title: String(finding.title ?? "Untitled finding").slice(0, 200),
    description: String(finding.description ?? "").slice(0, 2e3),
    evidence_ids: (finding.evidence_ids ?? []).filter((id) => evidenceIds.has(id)).slice(0, 12),
    files: (finding.files ?? []).slice(0, 12),
    symbols: (finding.symbols ?? []).slice(0, 12),
    why_it_matters: String(finding.why_it_matters ?? "").slice(0, 1e3),
    suggested_improvement: String(finding.suggested_improvement ?? "").slice(0, 1e3),
    confidence: finding.confidence ?? "low"
  })).filter((row) => row.evidence_ids.length > 0);
  try {
    await db().from("project_review_findings").delete().eq("project_review_id", reviewId);
    if (rows.length) {
      const { error } = await db().from("project_review_findings").insert(rows);
      if (error) throw error;
    }
  } catch (error) {
    console.warn("[hacksim.review] could not persist findings:", error);
  }
}
async function replaceDefenseTargets(submissionId, members, modules, requirementMap, evidenceIds) {
  if (!submissionId) return;
  const targets = [];
  const requirementTexts = new Map(
    requirementMap.requirements.map((r) => [r.id, r.text])
  );
  for (const module of modules) {
    for (const entry of module.data.requirements ?? []) {
      const status = entry.status;
      if (status !== "not_evidenced" && status !== "partial_evidence") continue;
      const id = String(entry.requirement_id ?? "");
      targets.push({
        submission_id: submissionId,
        topic: (requirementTexts.get(id) ?? id).slice(0, 300),
        reason: String(entry.explanation ?? "").slice(0, 600) || "The analysed repository did not provide sufficient evidence for this requirement.",
        priority: status === "not_evidenced" ? "P1" : "P2",
        evidence_ids: (entry.evidence_ids ?? []).filter((e) => evidenceIds.has(e)).slice(0, 10),
        question_area: "requirement_coverage",
        status: "open"
      });
    }
  }
  for (const module of modules.filter((m) => m.module === MODULE_D)) {
    const data = module.data;
    if (data.status !== "not_yet_verified" && data.status !== "partially_supported") continue;
    const member = members.find((m) => m.id === data.member_id);
    if (!member) continue;
    targets.push({
      submission_id: submissionId,
      user_id: member.user_id,
      topic: (member.contribution_description || "Your contribution").slice(0, 300),
      reason: String(data.explanation ?? "").slice(0, 600),
      priority: "P0",
      evidence_ids: (data.evidence_ids ?? []).slice(0, 10),
      question_area: "personal_contribution",
      status: "open"
    });
  }
  for (const module of modules) {
    for (const finding of module.data.findings ?? []) {
      if (finding.finding_type !== "security_concern") continue;
      targets.push({
        submission_id: submissionId,
        topic: String(finding.title ?? "Security concern").slice(0, 300),
        reason: String(finding.why_it_matters ?? finding.description ?? "").slice(0, 600),
        priority: "P5",
        evidence_ids: finding.evidence_ids ?? [],
        question_area: "security",
        status: "open"
      });
    }
  }
  if (targets.length === 0) return;
  try {
    await db().from("defense_targets").delete().eq("submission_id", submissionId);
    const { error } = await db().from("defense_targets").insert(targets.slice(0, 20));
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.review] could not persist defense targets:", error);
  }
}

// analysis/index.ts
async function requireCaller(req) {
  const caller = await getCaller(req);
  if (!caller) throw new HttpError("Invalid or expired session.", 401);
  return caller;
}
async function readAnalysis(req, url) {
  const submissionId = url.searchParams.get("submission_id");
  if (!submissionId) throw new HttpError("A submission id is required.", 400);
  const caller = await requireCaller(req);
  const submission = await loadSubmission(submissionId);
  await requireTeamAccess(submission, caller);
  const { data, error } = await db().rpc("submission_analysis", {
    p_submission_id: submissionId
  });
  if (error) throw new HttpError("Could not load the analysis.", 500);
  return json({
    ...data ?? {},
    // The browser needs to know whether Phase 6 can run at all.
    ai_available: aiConfigured()
  });
}
async function act(req) {
  const caller = await requireCaller(req);
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const submissionId = String(body?.submission_id ?? "");
  if (!submissionId) throw new HttpError("A submission id is required.", 400);
  const limited = rateLimiter.enforce(action, caller.id);
  if (limited) return limited;
  const submission = await loadSubmission(submissionId);
  await requireTeamAccess(submission, caller);
  const githubUrl = (submission.github_url ?? "").trim();
  switch (action) {
    case "repository":
      return json(await runScan(submissionId, githubUrl, false));
    case "reanalyze":
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
async function runScan(submissionId, githubUrl, reanalyze) {
  if (!githubUrl) {
    throw new HttpError(
      reanalyze ? "This submission has no GitHub repository URL." : "Add a GitHub repository URL to the submission first.",
      400
    );
  }
  const outcome = await analyzeSubmission(submissionId, githubUrl);
  if (outcome.status === "failed") {
    throw new HttpError(outcome.error ?? "Repository analysis failed.", 502);
  }
  return outcome;
}
async function runReviewFor(submission, onlyModules, caller) {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submission.id);
  if (!loaded || !["completed", "limited"].includes(loaded.repository.analysis_status)) {
    throw new HttpError("Analyse the repository before running an AI review.", 409);
  }
  if (!aiConfigured()) {
    throw new HttpError(
      "AI review is not configured on this deployment. Add DEEPSEEK_API_KEY as an edge function secret; repository analysis still works without it.",
      503
    );
  }
  const outcome = await runReview({
    submission,
    hackathon: await loadHackathon(submission.hackathon_id),
    repository: loaded.repository,
    files: loaded.files,
    chunks: loaded.chunks,
    evidence: loaded.evidence ?? [],
    projectMap: loaded.projectMap ?? {},
    members: await loadMembers(submission.id),
    actorId: caller.id,
    sessionId: submission.session_id,
    onlyModules
  });
  return {
    status: outcome.status,
    review_id: outcome.reviewId,
    modules: outcome.modules.map((module) => ({
      module: module.module,
      status: module.status,
      source: module.source,
      reason: module.reason ?? ""
    })),
    error: outcome.error ?? null
  };
}
Deno.serve(
  withErrorHandling((req, url) => {
    if (req.method === "GET") return readAnalysis(req, url);
    if (req.method === "POST") return act(req);
    return fail("Method not allowed.", 405);
  })
);
