// ─────────────────────────────────────────────────────────────────────
// GENERATED FILE — do not edit.
//
// Built by scripts/bundle-functions.sh from
//   supabase/functions/analysis/index.ts
// plus supabase/functions/_shared/*.ts
//
// Edit the sources, then re-run the script. Changes made here are lost.
// 11517 lines, self-contained — safe to paste into the Supabase dashboard.
// ─────────────────────────────────────────────────────────────────────

var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// _shared/security.ts
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function redactSecrets(input) {
  if (!input) return "";
  let out = String(input);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
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
var securityHeaders, MAX_BODY_BYTES, PayloadTooLarge, COSTLY_ACTIONS, DEFAULT_WINDOW_MS, RateLimiter, rateLimiter, SECRET_PATTERNS, safeLog;
var init_security = __esm({
  "_shared/security.ts"() {
    init_http();
    securityHeaders = {
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
    MAX_BODY_BYTES = 256 * 1024;
    PayloadTooLarge = class extends Error {
      constructor(limit) {
        super("Request body is too large.");
        this.limit = limit;
        this.name = "PayloadTooLarge";
      }
      limit;
    };
    COSTLY_ACTIONS = {
      repository: 10,
      // GitHub: a real repository is dozens of API calls
      reanalyze: 10,
      review: 30,
      // DeepSeek: several model calls per run
      "retry-module": 10
    };
    DEFAULT_WINDOW_MS = 6e4;
    RateLimiter = class {
      constructor(now = () => Date.now()) {
        this.now = now;
      }
      now;
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
    rateLimiter = new RateLimiter();
    SECRET_PATTERNS = [
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
    safeLog = {
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
  }
});

// _shared/http.ts
var http_exports = {};
__export(http_exports, {
  HttpError: () => HttpError,
  corsHeaders: () => corsHeaders,
  db: () => db,
  fail: () => fail,
  getCaller: () => getCaller,
  json: () => json,
  loadHackathon: () => loadHackathon,
  loadMembers: () => loadMembers,
  loadSubmission: () => loadSubmission,
  preflight: () => preflight,
  requireAdmin: () => requireAdmin,
  requireTeamAccess: () => requireTeamAccess,
  withErrorHandling: () => withErrorHandling
});
import { createClient } from "npm:@supabase/supabase-js@2";
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
var corsHeaders, serviceClient, callerCache, HttpError;
var init_http = __esm({
  "_shared/http.ts"() {
    init_security();
    corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    };
    serviceClient = null;
    callerCache = null;
    HttpError = class extends Error {
      constructor(message, status = 400) {
        super(message);
        this.status = status;
        this.name = "HttpError";
      }
      status;
    };
  }
});

// analysis/index.ts
init_http();

// _shared/scanner.ts
init_http();

// _shared/ai.ts
init_http();
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
  code;
};
function parseJson(content) {
  if (!content) return null;
  let text2 = content.trim();
  if (text2.startsWith("```")) {
    const parts = text2.split("```");
    text2 = parts.length >= 2 ? parts[1] : text2;
    if (text2.toLowerCase().startsWith("json")) text2 = text2.slice(4);
    text2 = text2.trim();
  }
  try {
    const parsed = JSON.parse(text2);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  const start = text2.indexOf("{");
  const end = text2.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text2.slice(start, end + 1));
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
  const service2 = db();
  const { data } = await service2.from("ai_model_configs").select("*").eq("enabled", true).eq("is_default", true).limit(1);
  let rows = data ?? [];
  if (rows.length === 0) {
    const fallback = await service2.from("ai_model_configs").select("*").eq("enabled", true).order("created_at").limit(1);
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
  ".csv": "dataset",
  ".tsv": "dataset",
  ".tab": "dataset",
  ".jsonl": "dataset",
  ".ndjson": "dataset",
  ".parquet": "dataset",
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
  ".log": "documentation",
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
  if (category === "dataset") return "medium";
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
var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
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
  ".cs",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".swift",
  ".dart",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".csv",
  ".tsv",
  ".sh",
  ".bash",
  ".ps1",
  ".tf",
  ".graphql",
  ".gql",
  ".prisma",
  ".proto",
  ".env",
  ".example",
  ".gitignore"
]);
function looksBinary(content, path) {
  const sample = content.slice(0, 8e3);
  if (sample.length === 0) return false;
  const name = String(path ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot !== -1 && TEXT_EXTENSIONS.has(name.slice(dot))) return false;
  let nulls = 0;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) nulls++;
    if (byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte <= 126 || byte >= 128) {
      printable++;
    }
  }
  if (nulls > 0) return true;
  return printable / sample.length < 0.85;
}
function decodeText(content, path) {
  if (looksBinary(content, path)) return null;
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
  for (const [section, dev] of [["dependencies", false], ["dev-dependencies", true]]) {
    for (const [pkg, spec] of Object.entries(poetry[section] ?? {})) {
      pushTarget(out, pkg, cleanPythonVersion(String(spec)), "pypi", dev);
    }
  }
  return out;
}
function parsePackageJson(content) {
  const out = [];
  const data = parseJson2(content);
  if (!data) return out;
  for (const [section, dev] of [
    ["dependencies", false],
    ["devDependencies", true],
    ["peerDependencies", true]
  ]) {
    const block = data[section] ?? {};
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
  for (const [section, dev] of [["require", false], ["require-dev", true]]) {
    for (const [pkg, spec] of Object.entries(data[section] ?? {})) {
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
    data_sources: (input.datasetProfiles ?? []).slice(0, 25).map((profile) => ({
      ...profile,
      columns: profile.columns.slice(0, 30),
      sample_rows: (profile.sample_rows ?? []).slice(0, 4)
    })),
    business_logic: (input.semantics ?? []).flatMap((file) => [
      ...file.rules.map((item) => ({ ...item, file: file.path, kind: "rule" })),
      ...file.calculations.map((item) => ({ ...item, file: file.path, kind: "calculation" }))
    ]).slice(0, 40),
    calculations: (input.semantics ?? []).flatMap((file) => file.calculations.map((item) => ({ ...item, file: file.path }))).slice(0, 40),
    models: (input.semantics ?? []).flatMap((file) => file.models.map((item) => ({ ...item, file: file.path }))).slice(0, 25),
    data_access: (input.semantics ?? []).flatMap((file) => file.dataAccess.map((item) => ({ ...item, file: file.path }))).slice(0, 30),
    ui_flows: (input.semantics ?? []).flatMap((file) => file.ui.map((item) => ({ ...item, file: file.path }))).slice(0, 30),
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
  code;
  statusCode;
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
      if (response.status === 401) {
        throw new GitHubError(
          "GitHub rejected the GITHUB_TOKEN (HTTP 401). The token is invalid, expired, or was saved with extra characters \u2014 recheck the secret value in Edge Function secrets.",
          "unauthorized",
          401
        );
      }
      if (response.status >= 500) {
        lastError = new GitHubError(
          `GitHub is unavailable (${response.status}).`,
          "provider_error",
          response.status
        );
      } else {
        throw new GitHubError(
          `GitHub rejected the request (HTTP ${response.status}).`,
          "client_error",
          response.status
        );
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

// _shared/concepts.ts
var FOCUS_ORDER = [
  "data",
  "analytics",
  "decision",
  "trust",
  "interface",
  "platform",
  "general"
];
var FOCUS_LABEL = {
  data: "data sources and ingestion",
  analytics: "computation, models and prediction",
  decision: "decision logic, recommendations and risk",
  trust: "confidence, quality and explainability",
  interface: "interface, workflow and usability",
  platform: "platform, APIs and deployment",
  general: "general capability"
};
var CAPABILITIES = [
  {
    group: "data",
    triggers: [
      "ingest",
      "ingestion",
      "import",
      "upload",
      "load",
      "dataset",
      "data set",
      "csv",
      "json",
      "source data",
      "input data",
      "historical data",
      "history",
      "transaction",
      "records",
      "read",
      "parse",
      "extract",
      "etl",
      "schema",
      "preprocess",
      "clean",
      "seed",
      "populate"
    ],
    synonyms: [
      "ingest",
      "ingestion",
      "read_csv",
      "readcsv",
      "load_csv",
      "csv",
      "tsv",
      "jsonl",
      "ndjson",
      "parse",
      "parser",
      "loader",
      "load_data",
      "read_data",
      "import",
      "upload",
      "file",
      "files",
      "dataframe",
      "dataset",
      "raw",
      "source",
      "history",
      "historical",
      "transaction",
      "transactions",
      "record",
      "records",
      "row",
      "rows",
      "column",
      "columns",
      "schema",
      "migration",
      "seed",
      "fixture",
      "sample",
      "snapshot",
      "extract",
      "ingested",
      "preprocess",
      "clean",
      "normalize",
      "scrub",
      "listdir",
      "exists",
      "input",
      "inputs",
      "bulk",
      "batch"
    ],
    weight: 6
  },
  {
    group: "analytics",
    triggers: [
      "forecast",
      "prediction",
      "predict",
      "estimate",
      "projection",
      "project",
      "model",
      "machine learning",
      "ml",
      "ai",
      "inference",
      "trend",
      "time series",
      "timeseries",
      "statistics",
      "statistical",
      "regression",
      "analytics",
      "compute",
      "calculation",
      "calculate",
      "aggregate",
      "score"
    ],
    synonyms: [
      "forecast",
      "forecasting",
      "predict",
      "predicts",
      "prediction",
      "predictions",
      "predicted",
      "estimate",
      "estimated",
      "estimation",
      "projection",
      "projected",
      "project",
      "extrapolate",
      "interpolate",
      "inference",
      "infer",
      "model",
      "models",
      "modeling",
      "regressor",
      "regression",
      "classifier",
      "classification",
      "fit",
      "train",
      "training",
      "trained",
      "predictor",
      "estimator",
      "pipeline",
      "feature",
      "features",
      "transform",
      "aggregate",
      "aggregation",
      "mean",
      "average",
      "moving",
      "trend",
      "trendline",
      "seasonal",
      "seasonality",
      "horizon",
      "window",
      "future",
      "slope",
      "coefficient",
      "weight",
      "weights",
      "score",
      "rmse",
      "mae",
      "mape",
      "accuracy",
      "backtest",
      "holdout",
      "timeseries",
      "series",
      "deviation",
      "expected",
      "residual"
    ],
    weight: 6
  },
  {
    group: "decision",
    triggers: [
      "recommend",
      "recommendation",
      "suggest",
      "suggestion",
      "reorder",
      "replenish",
      "restock",
      "alert",
      "alerts",
      "risk",
      "warning",
      "threshold",
      "prioritise",
      "prioritize",
      "triage",
      "plan",
      "policy",
      "rule",
      "decision",
      "trigger",
      "notify"
    ],
    synonyms: [
      "recommend",
      "recommended",
      "recommendation",
      "recommendations",
      "suggest",
      "suggested",
      "suggestion",
      "reorder",
      "reordering",
      "reorder_quantity",
      "reorder_date",
      "replenish",
      "replenishment",
      "restock",
      "restocking",
      "refill",
      "buy",
      "purchase",
      "order",
      "order_quantity",
      "lead_time",
      "leadtime",
      "safety_stock",
      "stockout",
      "shortage",
      "low_stock",
      "risk",
      "risk_score",
      "risk_level",
      "alert",
      "alerts",
      "alerting",
      "warn",
      "warning",
      "threshold",
      "thresholds",
      "trigger",
      "rule",
      "rules",
      "policy",
      "decide",
      "decision",
      "policy",
      "priority",
      "prioritise",
      "prioritize",
      "triage",
      "action",
      "actionable",
      "plan",
      "planner",
      "inventory",
      "stock",
      "level",
      "levels",
      "balance",
      "onhand",
      "available"
    ],
    weight: 6
  },
  {
    group: "trust",
    triggers: [
      "confidence",
      "uncertainty",
      "reliability",
      "explainable",
      "explainability",
      "transparency",
      "data quality",
      "quality",
      "accuracy",
      "validation",
      "provenance",
      "audit",
      "caveat",
      "assumption",
      "limitations",
      "honest"
    ],
    synonyms: [
      "confidence",
      "confident",
      "uncertainty",
      "uncertain",
      "reliability",
      "reliable",
      "explain",
      "explanation",
      "explainable",
      "explainability",
      "rationale",
      "reason",
      "because",
      "justify",
      "transparent",
      "transparency",
      "data_quality",
      "quality",
      "validate",
      "validation",
      "valid",
      "provenance",
      "audit",
      "caveat",
      "assumption",
      "limitations",
      "missing",
      "null",
      "nan",
      "impute",
      "outlier",
      "completeness",
      "coverage",
      "sample",
      "samples",
      "sample_size",
      "n_obs",
      "interval",
      "band",
      "residual",
      "score",
      "metric",
      "metrics",
      "mae",
      "rmse",
      "r2",
      "holdout",
      "backtest",
      "cross_validation",
      "cv",
      "distribution",
      "std",
      "variance",
      "deviation",
      "accuracy",
      "benchmark",
      "baseline"
    ],
    weight: 6
  },
  {
    group: "interface",
    triggers: [
      "dashboard",
      "interface",
      "ui",
      "screen",
      "page",
      "view",
      "form",
      "table",
      "chart",
      "graph",
      "display",
      "show",
      "visualise",
      "visualize",
      "user can",
      "workflow",
      "click",
      "button",
      "usability",
      "usable",
      "responsive",
      "frontend",
      "presentation"
    ],
    synonyms: [
      "dashboard",
      "dashboards",
      "screen",
      "screens",
      "page",
      "pages",
      "view",
      "views",
      "ui",
      "frontend",
      "front_end",
      "client",
      "app",
      "application",
      "html",
      "template",
      "jinja",
      "blade",
      "render",
      "rendered",
      "display",
      "displayed",
      "show",
      "shown",
      "chart",
      "charts",
      "graph",
      "plot",
      "canvas",
      "svg",
      "table",
      "tables",
      "list",
      "card",
      "cards",
      "modal",
      "form",
      "forms",
      "input",
      "button",
      "buttons",
      "click",
      "onclick",
      "submit",
      "filter",
      "search",
      "sort",
      "column",
      "badge",
      "status",
      "spinner",
      "loading",
      "toast",
      "alert_box",
      "workflow",
      "usability",
      "usable",
      "intuitive",
      "responsive",
      "css",
      "style",
      "layout",
      "dom"
    ],
    weight: 5
  },
  {
    group: "platform",
    triggers: [
      "api",
      "endpoint",
      "service",
      "deploy",
      "deployment",
      "hosting",
      "authentication",
      "authorisation",
      "authorization",
      "login",
      "role",
      "permission",
      "database",
      "storage",
      "integration",
      "webhook",
      "real-time",
      "realtime",
      "responsive time",
      "performance",
      "scalability",
      "scale"
    ],
    synonyms: [
      "api",
      "apis",
      "endpoint",
      "endpoints",
      "route",
      "routes",
      "router",
      "controller",
      "handler",
      "rest",
      "graphql",
      "grpc",
      "webhook",
      "service",
      "server",
      "backend",
      "back_end",
      "fastapi",
      "flask",
      "express",
      "django",
      "deploy",
      "deployment",
      "deployments",
      "hosting",
      "hosted",
      "docker",
      "container",
      "vercel",
      "netlify",
      "fly",
      "render",
      "heroku",
      "railway",
      "auth",
      "authenticate",
      "authentication",
      "authorize",
      "authorization",
      "login",
      "logout",
      "signup",
      "register",
      "session",
      "jwt",
      "token",
      "role",
      "roles",
      "permission",
      "permissions",
      "rbac",
      "middleware",
      "guard",
      "database",
      "db",
      "sql",
      "postgres",
      "postgresql",
      "mysql",
      "sqlite",
      "mongo",
      "mongodb",
      "supabase",
      "firebase",
      "prisma",
      "orm",
      "query",
      "queries",
      "select",
      "insert",
      "update",
      "table",
      "storage",
      "cache",
      "redis",
      "queue",
      "worker",
      "cron",
      "scheduler",
      "integration",
      "webhook",
      "socket",
      "websocket",
      "sse",
      "realtime",
      "real_time"
    ],
    weight: 5
  }
];
var STOPWORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "should",
  "could",
  "must",
  "may",
  "able",
  "each",
  "every",
  "any",
  "all",
  "both",
  "per",
  "via",
  "using",
  "use",
  "used",
  "able",
  "user",
  "users",
  "system",
  "solution",
  "project",
  "application",
  "app",
  "build",
  "provide",
  "provides",
  "allow",
  "allows",
  "allow",
  "support",
  "supports",
  "make",
  "makes",
  "need",
  "needs",
  "want",
  "wants",
  "should",
  "given",
  "based",
  "including",
  "include",
  "includes",
  "such",
  "than",
  "other",
  "others",
  "some",
  "more",
  "most",
  "not",
  "no",
  "also",
  "only",
  "over",
  "under",
  "about",
  "after",
  "before",
  "between",
  "up",
  "down",
  "out",
  "off",
  "again",
  "further",
  "once",
  "here",
  "does",
  "doing",
  "done",
  "how",
  "very",
  "just",
  "now",
  "new",
  "one",
  "two",
  "three",
  "first",
  "second",
  "next",
  "last",
  "same",
  "own",
  "too",
  "s",
  "t",
  "don",
  "doesn",
  "isn",
  "product",
  "option",
  "options",
  "default",
  "default",
  "simple",
  "easily",
  "quickly",
  "small",
  "large",
  "different",
  "sure",
  "etc",
  "eg",
  "ie"
]);
var WEAK_TERMS = /* @__PURE__ */ new Set([
  "data",
  "model",
  "models",
  "system",
  "app",
  "application",
  "file",
  "files",
  "code",
  "page",
  "pages",
  "list",
  "value",
  "values",
  "item",
  "items",
  "user",
  "users",
  "result",
  "results",
  "type",
  "types",
  "name",
  "names",
  "id",
  "ids",
  "service",
  "services",
  "state",
  "info",
  "information",
  "number",
  "count",
  "set",
  "get",
  "run",
  "use",
  "make",
  "add",
  "new",
  "all",
  "test",
  "tests"
]);
function termsOf(text2) {
  if (!text2) return [];
  const out = [];
  const raw = String(text2).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./\\]+/g, " ").toLowerCase();
  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token.length < 2 || token.length > 40) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}
var UNFOLDABLE = /* @__PURE__ */ new Set([
  "ingest",
  "business",
  "series",
  "process",
  "status",
  "analysis",
  "access",
  "address",
  "class",
  "loss",
  "bias",
  "news",
  "press",
  "canvas",
  "basis",
  "hypothesis",
  "synthesis",
  "axis",
  "crisis",
  "thesis",
  "focus",
  "radius",
  "virus",
  "census",
  "bonus",
  "consensus",
  "gas",
  "less",
  "this",
  "was",
  "has",
  "its",
  "us",
  "plus",
  "as",
  "is",
  "up",
  "app",
  "map",
  "gap",
  "map",
  "web",
  "redis",
  "less",
  "across",
  "less",
  "series",
  "always",
  "perhaps",
  "unless",
  "unless",
  "cross",
  "less",
  "styles",
  "styles",
  "caches",
  "boxes",
  "indexes"
]);
function stem(word) {
  if (word.length <= 4 || UNFOLDABLE.has(word)) return word;
  if (word.endsWith("ies") && word.length >= 6) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ing") && word.length >= 7) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length >= 6) return word.slice(0, -2);
  if (word.endsWith("es") && word.length >= 6) return word.slice(0, -2);
  if (word.endsWith("s") && word.length >= 5) return word.slice(0, -1);
  return word;
}
function termVariants(terms) {
  const out = /* @__PURE__ */ new Set();
  for (const term of terms) {
    out.add(term);
    const stemmed = stem(term);
    if (stemmed !== term) out.add(stemmed);
  }
  return [...out];
}
function briefVocabulary(map) {
  const words = /* @__PURE__ */ new Set();
  const phrases = [];
  const source = [
    map.problem_summary ?? "",
    ...(map.requirements ?? []).map((r) => r.text),
    ...(map.constraints ?? []).map((r) => r.text),
    ...(map.expected_outcomes ?? []).map((r) => r.text)
  ].join("\n");
  for (const term of termsOf(source)) {
    words.add(term);
    words.add(stem(term));
  }
  for (const entry of [
    ...map.requirements ?? [],
    ...map.expected_outcomes ?? []
  ]) {
    for (const phrase of nounPhrases(entry.text)) {
      if (phrase.split(" ").length > 1) phrases.push(phrase);
    }
  }
  return { words, phrases: [...new Set(phrases)].slice(0, 120) };
}
function nounPhrases(text2) {
  const tokens = termsOf(text2);
  const phrases = [];
  for (let i = 0; i < tokens.length; i++) {
    phrases.push(tokens[i]);
    if (i + 1 < tokens.length) phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
    if (i + 2 < tokens.length) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }
  return [...new Set(phrases)].filter((p) => p.length > 2);
}
function capabilityFor(word) {
  for (const capability of CAPABILITIES) {
    if (capability.triggers.includes(word)) return capability;
  }
  return null;
}
function artifactHintsFor(group) {
  switch (group) {
    case "data":
      return [
        "dataset",
        "data_loading",
        "file_read",
        "schema",
        "query",
        "ingestion"
      ];
    case "analytics":
      return ["calculation", "model", "function", "route", "dataset"];
    case "decision":
      return ["calculation", "route", "function", "ui"];
    case "trust":
      return ["calculation", "test", "readme", "model", "dataset"];
    case "interface":
      return ["ui", "route", "function", "readme"];
    case "platform":
      return ["route", "configuration", "dependency", "file", "schema"];
    default:
      return ["function", "route", "ui", "dataset", "configuration", "readme"];
  }
}
function analyseRequirement(text2, vocabulary, map) {
  const clean2 = String(text2 ?? "").trim();
  if (!clean2) {
    return {
      text: "",
      intent: "",
      focus: "general",
      phrases: [],
      actions: [],
      subjects: [],
      qualifiers: [],
      terms: [],
      domainTerms: [],
      facets: [],
      artifacts: []
    };
  }
  const own = termsOf(clean2);
  const present = /* @__PURE__ */ new Map();
  for (const word of own) {
    const capability = capabilityFor(word) ?? capabilityFor(stem(word));
    if (!capability) continue;
    const slot = present.get(capability.group);
    if (slot) slot.hits += 1;
    else present.set(capability.group, { capability, hits: 1 });
  }
  const groups = [...present.values()].sort((a, b) => b.hits - a.hits);
  const focus = groups[0]?.capability.group ?? "general";
  const termSet = new Set(termVariants(own));
  const actions = /* @__PURE__ */ new Set();
  const subjects = /* @__PURE__ */ new Set();
  for (const word of own) {
    const capability = capabilityFor(word) ?? capabilityFor(stem(word));
    if (capability) {
      actions.add(word);
      continue;
    }
    if (WEAK_TERMS.has(word)) continue;
    subjects.add(word);
  }
  for (const { capability } of groups) {
    for (const synonym of capability.synonyms) {
      termSet.add(synonym);
      termSet.add(stem(synonym));
    }
  }
  const domainTerms = /* @__PURE__ */ new Set();
  for (const word of subjects) {
    if (vocabulary?.words.has(word) || vocabulary?.words.has(stem(word))) {
      domainTerms.add(word);
    }
  }
  for (const word of actions) {
    if (vocabulary?.words.has(word) || vocabulary?.words.has(stem(word))) {
      domainTerms.add(word);
    }
  }
  const qualifiers = detectQualifiers(clean2);
  const phrases = nounPhrases(clean2).filter((phrase) => {
    const parts = phrase.split(" ");
    return parts.every((part) => !capabilityFor(part));
  });
  const facets = buildFacets(clean2, own, groups.map((g) => g.capability.group));
  return {
    text: clean2,
    intent: intentOf(clean2, map),
    focus,
    phrases: [...new Set(phrases)].slice(0, 24),
    actions: [...actions].slice(0, 12),
    subjects: [...subjects].slice(0, 16),
    qualifiers,
    terms: [...termSet],
    domainTerms: [...domainTerms].slice(0, 40),
    facets,
    artifacts: artifactHintsFor(focus)
  };
}
var QUALIFIER_PATTERNS = [
  /\bconfigurable\b/i,
  /\bcustomi[sz]able\b/i,
  /\badjustable\b/i,
  /\beditable\b/i,
  /\boptional\b/i,
  /\breal[\s-]?time\b/i,
  /\bnear[\s-]?real[\s-]?time\b/i,
  /\blive\b/i,
  /\bper\s+\w+/i,
  /\bfor\s+each\b/i,
  /\bwithin\s+\w+\s+\w+/i,
  /\bwithout\b/i,
  /\bmust\s+not\b/i,
  /\bno\s+\w+\s+services?\b/i,
  /\bfree\b/i,
  /\bpaid\b/i,
  /\boffline\b/i,
  /\bautomatically\b/i,
  /\bmanually\b/i,
  /\bsecure\b/i,
  /\bscalable\b/i,
  /\bfast\b/i,
  /\bquickly\b/i,
  /\bunder\s+\w+\s+\w+/i
];
function detectQualifiers(text2) {
  const found = [];
  for (const pattern of QUALIFIER_PATTERNS) {
    const match = text2.match(pattern);
    if (match) found.push(match[0].toLowerCase().trim());
  }
  return [...new Set(found)].slice(0, 8);
}
function intentOf(text2, map) {
  const first = text2.split(/[.;\n]/)[0]?.trim() ?? text2;
  const goal = first.replace(/^(the|a|an)\s+/i, "").slice(0, 220);
  if (!map) return goal;
  const problem = (map.problem_summary ?? "").split(/[.\n]/)[0]?.trim();
  return problem ? `${goal} (in service of: ${problem.slice(0, 160)})` : goal;
}
function buildFacets(text2, own, groups) {
  const facets = [];
  const seen = /* @__PURE__ */ new Set();
  for (const group of groups) {
    const capability = CAPABILITIES.find((c) => c.group === group);
    if (!capability) continue;
    const matching = own.filter(
      (word) => capability.triggers.includes(word) || capability.triggers.includes(stem(word))
    );
    const label = matching[0] ?? group;
    const key = `${group}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facets.push({
      phrase: matching.join(" ") || group,
      focus: group,
      terms: [label, ...capability.synonyms.slice(0, 24)]
    });
  }
  for (const phrase of nounPhrases(text2)) {
    const parts = phrase.split(" ");
    if (parts.length < 2 || parts.length > 3) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    facets.push({ phrase, focus: "general", terms: [phrase, ...parts] });
  }
  return facets.slice(0, 8);
}
function groupRequirements(map) {
  const vocabulary = briefVocabulary(map);
  const groups = /* @__PURE__ */ new Map();
  if ((map.requirements ?? []).length === 0) return [];
  for (const entry of map.requirements ?? []) {
    const concepts = analyseRequirement(entry.text, vocabulary, map);
    const existing = groups.get(concepts.focus);
    if (existing) {
      existing.entries.push(entry);
      existing.concepts.push(concepts);
    } else {
      groups.set(concepts.focus, {
        focus: concepts.focus,
        label: FOCUS_LABEL[concepts.focus],
        entries: [entry],
        concepts: [concepts]
      });
    }
  }
  return FOCUS_ORDER.filter((focus) => groups.has(focus)).map(
    (focus) => groups.get(focus)
  );
}
function analyseBriefItems(items, map) {
  const vocabulary = briefVocabulary(map);
  return (items ?? []).filter((item) => Boolean(item?.text?.trim())).map((item) => analyseRequirement(item.text, vocabulary, map));
}

// _shared/datasets.ts
var MAX_PROFILE_BYTES = 2e6;
var SAMPLE_LINES = 200;
var MAX_SAMPLE_ROWS = 4;
var MAX_CELL_CHARS = 40;
function rescoreRelevance(profile, concepts) {
  const { level, terms } = relevanceOf(profile.path, profile.column_names, concepts);
  return { ...profile, relevance: level, relevance_terms: terms };
}
var EXTENSION_FORMATS = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".json": "json",
  ".txt": "text",
  ".dat": "text"
};
var MAX_DATASET_BYTES = 20 * 1024 * 1024;
function datasetFormatOf(path) {
  const lower = path.toLowerCase();
  for (const [extension, format] of Object.entries(EXTENSION_FORMATS)) {
    if (lower.endsWith(extension)) return format;
  }
  return null;
}
var ROLE_TERMS = {
  date: [
    "date",
    "day",
    "month",
    "year",
    "week",
    "time",
    "timestamp",
    "datetime",
    "period",
    "expiry",
    "expires",
    "expiration",
    "created",
    "updated",
    "due",
    "issued",
    "received",
    "recorded",
    "birth",
    "start",
    "end",
    "valid_from",
    "valid_to",
    "age",
    "horizon"
  ],
  identifier: [
    "id",
    "uuid",
    "guid",
    "pk",
    "key",
    "code",
    "ref",
    "reference",
    "sku",
    "isbn",
    "serial",
    "number",
    "no",
    "hash",
    "token"
  ],
  entity: [
    "product",
    "item",
    "items",
    "medicine",
    "medicines",
    "drug",
    "drugs",
    "medication",
    "patient",
    "customer",
    "user",
    "account",
    "company",
    "org",
    "organisation",
    "organization",
    "supplier_item",
    "article",
    "article_id",
    "name",
    "title",
    "label",
    "category_name",
    "vehicle",
    "asset",
    "device",
    "sensor",
    "course",
    "student",
    "room",
    "booking",
    "ticket",
    "asset_id"
  ],
  quantity: [
    "quantity",
    "qty",
    "amount",
    "count",
    "units",
    "unit",
    "packs",
    "volume",
    "sold",
    "purchased",
    "ordered",
    "consumed",
    "issued",
    "delivered",
    "dispensed",
    "received",
    "net",
    "gross",
    "total",
    "sum",
    "n"
  ],
  stock: [
    "stock",
    "stocklevel",
    "stock_level",
    "inventory",
    "onhand",
    "on_hand",
    "balance",
    "available",
    "remaining",
    "reserved",
    "in_stock",
    "capacity",
    "min_stock",
    "max_stock",
    "reorder",
    "reorder_level",
    "safety"
  ],
  price: [
    "price",
    "cost",
    "revenue",
    "spend",
    "spent",
    "budget",
    "fee",
    "charge",
    "rate",
    "value",
    "total_price",
    "unit_price",
    "mrp",
    "sell",
    "buying"
  ],
  supplier: [
    "supplier",
    "vendor",
    "distributor",
    "manufacturer",
    "provider",
    "seller",
    "wholesaler",
    "source",
    "agency",
    "pharmacy",
    "store",
    "branch",
    "warehouse"
  ],
  category: [
    "category",
    "type",
    "kind",
    "class",
    "group",
    "segment",
    "status",
    "state",
    "tag",
    "label",
    "level",
    "tier",
    "priority",
    "region",
    "zone",
    "location",
    "city",
    "country",
    "department"
  ],
  numeric: ["value", "score", "rate", "ratio", "index", "metric", "weight"],
  text: [
    "name",
    "description",
    "notes",
    "note",
    "comment",
    "text",
    "title",
    "reason",
    "detail",
    "details",
    "summary",
    "address",
    "email",
    "phone",
    "message",
    "body",
    "content"
  ],
  boolean: [
    "active",
    "enabled",
    "disabled",
    "deleted",
    "archived",
    "flag",
    "valid",
    "verified",
    "available",
    "expired",
    "is_"
  ]
};
var BOOLEAN_VALUES = /* @__PURE__ */ new Set(["true", "false", "yes", "no", "0", "1", "y", "n"]);
var DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
function looksNumeric(value) {
  return /^-?[\d,]*\.?\d+([eE][-+]?\d+)?%?$/.test(value.trim()) && /\d/.test(value);
}
function looksDate(value) {
  const text2 = value.trim();
  if (DATE_RE.test(text2)) return true;
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(text2)) return true;
  if (/^\d{4}-\d{2}$/.test(text2)) return true;
  const monthNames = "jan feb mar apr may jun jul aug sep oct nov dec";
  const lower = text2.toLowerCase();
  return lower.length >= 6 && monthNames.split(" ").some((m) => lower.startsWith(m));
}
function roleFor(name, numeric, date) {
  const tokens = /* @__PURE__ */ new Set();
  for (const token of termsOf(name)) {
    tokens.add(token);
    tokens.add(stem(token));
  }
  const joined = name.toLowerCase();
  if (tokens.has("id") || /(?:^|_)id$/.test(joined) || tokens.has("uuid")) {
    return "identifier";
  }
  if (date) return "date";
  for (const [role, words] of Object.entries(ROLE_TERMS)) {
    if (words.some((word) => tokens.has(word) || tokens.has(stem(word)))) return role;
  }
  if (numeric) return "numeric";
  return "text";
}
function splitDelimited(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}
function sniffDelimiter(sample) {
  const firstLine = sample.split("\n", 1)[0] ?? "";
  const counts = {
    ",": (firstLine.match(/,/g) ?? []).length,
    "	": (firstLine.match(/\t/g) ?? []).length,
    ";": (firstLine.match(/;/g) ?? []).length,
    "|": (firstLine.match(/\|/g) ?? []).length
  };
  let best = ",";
  let bestCount = 0;
  for (const [delimiter, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}
function truncateCell(value) {
  const text2 = String(value ?? "").trim();
  return text2.length > MAX_CELL_CHARS ? `${text2.slice(0, MAX_CELL_CHARS)}\u2026` : text2;
}
function profileDataset(input, concepts = []) {
  const format = datasetFormatOf(input.path);
  if (!format) return null;
  const notes = [];
  if (input.sizeBytes > MAX_DATASET_BYTES) {
    notes.push("File exceeds the dataset size limit and was not profiled.");
    return null;
  }
  const truncatedForProfiling = input.sizeBytes > MAX_PROFILE_BYTES || input.content.length < input.sizeBytes * 0.95;
  const content = truncatedForProfiling ? input.content.slice(0, MAX_PROFILE_BYTES) : input.content;
  let columns = [];
  let sampleRows = [];
  let dataLines = 0;
  let approxRowCount = 0;
  let rowCountExact = false;
  if (format === "csv" || format === "tsv" || format === "text") {
    const delimiter = format === "tsv" ? "	" : sniffDelimiter(content);
    const lines = content.split("\n");
    const nonEmpty = [];
    for (const line of lines) {
      if (line.trim()) nonEmpty.push(line);
    }
    if (nonEmpty.length === 0) return null;
    const header = splitDelimited(nonEmpty[0], delimiter);
    if (header.length === 1 && nonEmpty.length > 1) {
      const retry = sniffDelimiter(nonEmpty.slice(0, 5).join("\n"));
      return retry === delimiter ? null : withDelimiter(input, concepts, retry);
    }
    columns = header.map((name) => buildColumn(name, []));
    const body = nonEmpty.slice(1, 1 + SAMPLE_LINES);
    for (const line of body) {
      const cells = splitDelimited(line, delimiter);
      sampleRows.push(cells);
    }
    columns = columns.map(
      (column, index) => buildColumn(
        column.name,
        sampleRows.map((row) => row[index] ?? "")
      )
    );
    dataLines = Math.max(0, nonEmpty.length - 1);
    if (truncatedForProfiling) {
      const bytesPerLine = content.length / Math.max(1, nonEmpty.length);
      approxRowCount = Math.round(
        input.sizeBytes / Math.max(1, bytesPerLine) - 1
      );
      notes.push(
        `Profiled the first ${Math.round(MAX_PROFILE_BYTES / 1024)} KB of a ${Math.round(input.sizeBytes / 1024)} KB file; the row count is an estimate.`
      );
    } else {
      approxRowCount = dataLines;
      rowCountExact = true;
    }
  } else {
    const parsed = profileJsonLike(content, format);
    if (!parsed) return null;
    columns = parsed.columns;
    sampleRows = parsed.rows;
    approxRowCount = parsed.approxRowCount;
    rowCountExact = parsed.rowCountExact;
  }
  if (columns.length === 0) return null;
  const columnNames = columns.map((column) => column.name);
  const byRole = (role) => columns.filter((column) => column.role === role).map((column) => column.name);
  const { level, terms } = relevanceOf(input.path, columnNames, concepts);
  if (level === "none" && format === "text") return null;
  return {
    path: input.path,
    format,
    size_bytes: input.sizeBytes,
    approx_row_count: approxRowCount,
    row_count_exact: rowCountExact,
    columns,
    column_names: columnNames,
    date_columns: byRole("date"),
    entity_columns: byRole("entity"),
    quantity_columns: byRole("quantity"),
    stock_columns: byRole("stock"),
    price_columns: byRole("price"),
    supplier_columns: byRole("supplier"),
    identifier_columns: byRole("identifier"),
    numeric_columns: columns.filter((column) => column.inferred_type === "number").map((column) => column.name),
    categorical_columns: columns.filter((column) => column.inferred_type === "text").map((column) => column.name).slice(0, 12),
    sample_rows: sampleRows.slice(0, MAX_SAMPLE_ROWS).map(
      (row) => row.map(truncateCell)
    ),
    likely_purpose: purposeOf(input.path, columns),
    relevance: level,
    relevance_terms: terms,
    notes
  };
}
function withDelimiter(input, concepts, delimiter) {
  const lines = input.content.split("\n");
  if (lines.length === 0) return null;
  const header = splitDelimited(lines[0], delimiter);
  if (header.length === 1) return null;
  const sampleRows = lines.slice(1, 1 + SAMPLE_LINES).filter((line) => line.trim()).map((line) => splitDelimited(line, delimiter));
  const columns = header.map(
    (name, index) => buildColumn(name, sampleRows.map((row) => row[index] ?? ""))
  );
  const dataLines = lines.filter((line) => line.trim()).length - 1;
  const columnNames = columns.map((column) => column.name);
  const { level, terms } = relevanceOf(input.path, columnNames, concepts);
  const byRole = (role) => columns.filter((column) => column.role === role).map((column) => column.name);
  return {
    path: input.path,
    format: "csv",
    size_bytes: input.sizeBytes,
    approx_row_count: Math.max(0, dataLines),
    row_count_exact: input.sizeBytes <= MAX_PROFILE_BYTES,
    columns,
    column_names: columnNames,
    date_columns: byRole("date"),
    entity_columns: byRole("entity"),
    quantity_columns: byRole("quantity"),
    stock_columns: byRole("stock"),
    price_columns: byRole("price"),
    supplier_columns: byRole("supplier"),
    identifier_columns: byRole("identifier"),
    numeric_columns: columns.filter((column) => column.inferred_type === "number").map((column) => column.name),
    categorical_columns: columns.filter((column) => column.inferred_type === "text").map((column) => column.name).slice(0, 12),
    sample_rows: sampleRows.slice(0, MAX_SAMPLE_ROWS).map(
      (row) => row.map(truncateCell)
    ),
    likely_purpose: purposeOf(input.path, columns),
    relevance: level,
    relevance_terms: terms,
    notes: [`Delimiter inferred as "${delimiter === "	" ? "\\t" : delimiter}".`]
  };
}
function buildColumn(name, values) {
  const present = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  const nonEmpty = present.length;
  const numericCount = present.filter(looksNumeric).length;
  const dateCount = present.filter(looksDate).length;
  const boolCount = present.filter(
    (value) => BOOLEAN_VALUES.has(value.toLowerCase())
  ).length;
  let inferredType = "text";
  if (nonEmpty > 0) {
    if (dateCount / nonEmpty >= 0.7) inferredType = "date";
    else if (numericCount / nonEmpty >= 0.8) inferredType = "number";
    else if (boolCount / nonEmpty >= 0.9) inferredType = "boolean";
  }
  const distinct = new Set(present.slice(0, SAMPLE_LINES));
  return {
    name: truncateCell(name) || "(unnamed)",
    inferred_type: inferredType,
    role: roleFor(name, inferredType === "number", inferredType === "date"),
    approx_distinct: distinct.size,
    nullable: nonEmpty < values.length,
    sample: [...distinct].slice(0, 3).map(truncateCell)
  };
}
function profileJsonLike(content, format) {
  if (format === "jsonl") {
    const lines = content.split("\n").filter((line) => line.trim());
    if (!lines.length) return null;
    const objects2 = [];
    for (const line of lines.slice(0, SAMPLE_LINES)) {
      try {
        const parsed2 = JSON.parse(line);
        if (parsed2 && typeof parsed2 === "object") {
          objects2.push(parsed2);
        }
      } catch {
      }
    }
    if (!objects2.length) return null;
    const names2 = /* @__PURE__ */ new Set();
    for (const object of objects2) for (const key of Object.keys(object)) names2.add(key);
    const keys2 = [...names2].slice(0, 40);
    const rows = objects2.map((object) => keys2.map((key) => stringify(object[key])));
    return {
      columns: keys2.map(
        (key) => buildColumn(key, objects2.map((object) => stringify(object[key])))
      ),
      rows,
      approxRowCount: lines.length,
      rowCountExact: content.length < MAX_PROFILE_BYTES
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const array = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.data) ? parsed.data : null;
  if (!array) return null;
  const objects = array.slice(0, SAMPLE_LINES).filter(
    (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
  if (!objects.length) return null;
  const names = /* @__PURE__ */ new Set();
  for (const object of objects) for (const key of Object.keys(object)) names.add(key);
  const keys = [...names].slice(0, 40);
  return {
    columns: keys.map(
      (key) => buildColumn(key, objects.map((object) => stringify(object[key])))
    ),
    rows: objects.map((object) => keys.map((key) => stringify(object[key]))),
    approxRowCount: array.length,
    rowCountExact: true
  };
}
function stringify(value) {
  if (value === null || value === void 0) return "";
  if (typeof value === "object") return JSON.stringify(value).slice(0, MAX_CELL_CHARS);
  return String(value);
}
function relevanceOf(path, columnNames, concepts) {
  if (concepts.length === 0) return { level: "low", terms: [] };
  const haystack = /* @__PURE__ */ new Set();
  for (const token of [...termsOf(path), ...columnNames.flatMap(termsOf)]) {
    haystack.add(token);
    haystack.add(stem(token));
  }
  const matched = /* @__PURE__ */ new Set();
  let strong = 0;
  for (const concept of concepts) {
    for (const term of [...concept.domainTerms, ...concept.subjects, ...concept.actions]) {
      if (haystack.has(term) || haystack.has(stem(term))) {
        matched.add(term);
        if (concept.subjects.includes(term) || concept.domainTerms.includes(term)) {
          strong += 1;
        }
      }
    }
  }
  if (matched.size === 0) return { level: "none", terms: [] };
  if (strong >= 2 || matched.size >= 4) return { level: "high", terms: [...matched] };
  if (strong === 1 || matched.size >= 2) return { level: "medium", terms: [...matched] };
  return { level: "low", terms: [...matched] };
}
var PURPOSE_PATTERNS = [
  { re: /sales|transaction|purchase|order|invoice|receipt/i, purpose: "transactional history" },
  { re: /stock|inventory|onhand|balance|warehouse/i, purpose: "stock or inventory state" },
  { re: /forecast|prediction|demand|projection/i, purpose: "precomputed forecast output" },
  { re: /model|weights|result|metric|score|eval/i, purpose: "model artefact or evaluation result" },
  { re: /medicine|product|item|sku|catalog|catalogue|master/i, purpose: "item or entity master data" },
  { re: /supplier|vendor|distributor/i, purpose: "supplier reference data" },
  { re: /customer|patient|user|client|member/i, purpose: "customer or user records" },
  { re: /location|city|region|store|branch|pharmacy/i, purpose: "location reference data" },
  { re: /log|event|audit|trace/i, purpose: "event or audit log" }
];
function purposeOf(path, columns) {
  const haystack = `${path} ${columns.map((column) => column.name).join(" ")}`;
  const parts = [];
  for (const pattern of PURPOSE_PATTERNS) {
    if (pattern.re.test(haystack)) parts.push(pattern.purpose);
    if (parts.length === 2) break;
  }
  const roles = new Set(columns.map((column) => column.role));
  if (roles.has("date")) parts.push("dated over time");
  if (roles.has("entity")) parts.push("keyed by an item");
  if (roles.has("quantity") || roles.has("stock")) parts.push("carrying measured amounts");
  if (roles.has("price")) parts.push("carrying monetary values");
  if (parts.length === 0) return "tabular data of unrecognised shape";
  return [...new Set(parts)].slice(0, 3).join(", ");
}
function compactDatasetProfile(profile) {
  return {
    path: profile.path,
    format: profile.format,
    approx_row_count: profile.approx_row_count,
    row_count_exact: profile.row_count_exact,
    columns: profile.columns.map((column) => ({
      name: column.name,
      type: column.inferred_type,
      role: column.role,
      sample: column.sample.slice(0, 2)
    })),
    likely_purpose: profile.likely_purpose,
    sample_rows: profile.sample_rows.slice(0, 2),
    notes: profile.notes.slice(0, 2)
  };
}

// _shared/semantics.ts
var LANGUAGE_BY_EXT = {
  ".py": "Python",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".swift": "Swift",
  ".dart": "Dart",
  ".html": "HTML",
  ".htm": "HTML",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".sql": "SQL",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".md": "Markdown",
  ".sh": "Shell",
  ".css": "CSS"
};
function languageOfPath(path) {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return LANGUAGE_BY_EXT[lower.slice(dot)] ?? null;
}
var MAX_PER_KIND = 14;
var MAX_EXCERPT = 220;
var CODE_LANGUAGES = /* @__PURE__ */ new Set([
  "Python",
  "TypeScript",
  "JavaScript",
  "Go",
  "Java",
  "Kotlin",
  "Ruby",
  "Rust",
  "PHP",
  "C",
  "C++",
  "C#",
  "Swift",
  "Dart",
  "HTML",
  "Vue",
  "Svelte",
  "SQL",
  "Shell",
  "PowerShell"
]);
function isCodeLanguage(language) {
  return language !== null && CODE_LANGUAGES.has(language);
}
function isCode(line, language) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (language === "Python" && trimmed.startsWith("#")) return false;
  if (language === "SQL" && trimmed.startsWith("--")) return false;
  if (language === "Shell" && trimmed.startsWith("#")) return false;
  if (language && ["JavaScript", "TypeScript", "Java", "Go", "Rust", "C", "C++", "C#", "PHP", "Swift", "Dart", "Kotlin", "CSS", "Vue", "Svelte"].includes(language)) {
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      return false;
    }
  }
  return true;
}
function excerptOf(line) {
  const text2 = line.trim().replace(/\s+/g, " ");
  return text2.length > MAX_EXCERPT ? `${text2.slice(0, MAX_EXCERPT)}\u2026` : text2;
}
function identifiersIn(text2) {
  const found = text2.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const stop = /* @__PURE__ */ new Set([
    "def",
    "class",
    "return",
    "import",
    "from",
    "const",
    "let",
    "var",
    "function",
    "if",
    "else",
    "elif",
    "for",
    "while",
    "try",
    "except",
    "catch",
    "self",
    "this",
    "true",
    "false",
    "None",
    "null",
    "async",
    "await",
    "export",
    "default",
    "new",
    "print",
    "str",
    "int",
    "float",
    "len",
    "range",
    "list",
    "dict",
    "set",
    "type",
    "public",
    "private",
    "static",
    "void",
    "string",
    "number",
    "boolean",
    "value",
    "data",
    "result",
    "results",
    "item",
    "items",
    "self",
    "super"
  ]);
  const unique = /* @__PURE__ */ new Set();
  for (const name of found) {
    if (stop.has(name.toLowerCase())) continue;
    if (name.length < 3) continue;
    unique.add(name);
    if (unique.size >= 6) break;
  }
  return [...unique];
}
function operandList(identifiers) {
  if (identifiers.length === 0) return "computed values";
  if (identifiers.length === 1) return identifiers[0];
  if (identifiers.length === 2) return `${identifiers[0]} and ${identifiers[1]}`;
  return `${identifiers.slice(0, 3).join(", ")} and others`;
}
function enclosingSymbol(symbols, line) {
  let best = null;
  let bestLine = -1;
  for (const symbol of symbols) {
    if (symbol.line <= line && symbol.line > bestLine) {
      best = symbol.name;
      bestLine = symbol.line;
    }
  }
  return best;
}
var CALCULATION_PATTERNS = [
  {
    operation: "aggregation",
    re: /\b(sum|mean|median|avg|average|aggregate|count|total)\s*\(|\.(sum|mean|median|min|max)\s*\(|reduce\s*\(|groupby|group_by|rollup|pivot_table/i,
    describe: (operands, symbol) => `aggregates ${operands} into a single value` + (symbol ? ` inside \`${symbol}\`` : "")
  },
  {
    operation: "statistic",
    re: /\b(std|stddev|variance|percentile|quantile|correlation|covariance|linregress|polyfit|zscore|normaliz|minmaxscaler|standardscaler)\s*\(|\bnp\.(mean|std|percentile|corr|polyfit|interp)|scipy\./i,
    describe: (operands, symbol) => `computes a statistical measure over ${operands}` + (symbol ? ` inside \`${symbol}\`` : "")
  },
  {
    operation: "date_math",
    re: /\b(timedelta|date_add|date_sub|addDays|addMonths|add_years|strftime|strptime|toDate|getTime|getDate|setDate|Date\.now|new Date)\b|\bdate\s*[+\-]|\+\s*timedelta/i,
    describe: (operands, symbol) => `performs date arithmetic on ${operands}` + (symbol ? ` inside \`${symbol}\`` : "")
  },
  {
    operation: "formula",
    re: /[A-Za-z0-9_)\]]\s*[*\/]\s*[A-Za-z0-9_(]|Math\.(round|floor|ceil|min|max|pow|sqrt|abs)|\b(round|floor|ceil|abs|sqrt|pow)\s*\(/,
    describe: (operands, symbol) => `multiplies, divides or scales ${operands}` + (symbol ? ` inside \`${symbol}\`` : "")
  },
  {
    operation: "arithmetic",
    re: /[A-Za-z0-9_)\]]\s*[+\-]\s*[A-Za-z0-9_(]|\b(int|float)\s*\(|\*\s*\d|\+\s*\d/,
    describe: (operands, symbol) => `adds to or subtracts from ${operands}` + (symbol ? ` inside \`${symbol}\`` : "")
  }
];
function extractCalculations(path, content, symbols) {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    for (const pattern of CALCULATION_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      const lineNumber = index + 1;
      const symbol = enclosingSymbol(symbols, lineNumber);
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${symbol ?? lineNumber}:${identifiers[0] ?? ""}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "calculation",
        claim: `\`${path}\` ${pattern.describe(operandList(identifiers), symbol)}.`,
        symbol,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers
      });
      break;
    }
  });
  return out;
}
var RULE_PATTERNS = [
  /\bif\b[^{]*[<>]=?|[<>]=?\s*\d/,
  // if x < 10
  /\bif\b\s*\(?\s*!|not\s+\w+/,
  // if not x
  /\?.*:/,
  // ternary
  /\bswitch\b|\bmatch\s+\w+\s*\{/,
  /\belsif\b|\belif\b/,
  /\bmatch\s*\(/
];
function extractRules(path, content, symbols) {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    if (!RULE_PATTERNS.some((re) => re.test(line))) return;
    if (!/[<>!=]|\bnot\b|\?|true|false/.test(line)) return;
    const lineNumber = index + 1;
    const symbol = enclosingSymbol(symbols, lineNumber);
    const identifiers = identifiersIn(line);
    const hasLiteral = /\d/.test(line);
    const key = `${symbol ?? lineNumber}:${identifiers[0] ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: "rule",
      claim: `\`${path}\` branches on a condition involving ${operandList(identifiers)}` + (hasLiteral ? `, compared against a literal value` : ``) + (symbol ? ` inside \`${symbol}\`` : ``) + `.`,
      symbol,
      line: lineNumber,
      lines: String(lineNumber),
      excerpt: excerptOf(line),
      operation: hasLiteral ? "threshold" : "branch",
      identifiers
    });
  });
  return out;
}
var MODEL_USAGE = [
  {
    re: /\.(fit|train|partial_fit)\s*\(/,
    operation: "training",
    describe: "trains a model in code"
  },
  {
    re: /\.(predict|predict_proba|transform|decision_function|forward|generate)\s*\(/,
    operation: "inference",
    describe: "runs a model or transform to produce a result"
  },
  {
    re: /\b(LinearRegression|LogisticRegression|RandomForest|GradientBoost|DecisionTree|SVC|KMeans|Ridge|Lasso|ARIMA|ETS|ExponentialSmoothing|Prophet|IsolationForest|GradientBoostingRegressor|RandomForestRegressor|torch|nn\.|tf\.|keras|xgboost|lightgbm)\b/,
    operation: "model_type",
    describe: "names a predictive or statistical model"
  },
  {
    re: /\b(joblib|pickle|torch\.load|load_model|np\.load|model\.pt|model\.pkl|onnx|load_weights|from_pretrained)\b/,
    operation: "model_artifact",
    describe: "loads a trained model artefact"
  },
  {
    re: /\b(moving_average|movingaverage|expanding\(|rolling\(|ewm\(|seasonal_decompose|adf\(|auto_arima|trend|forecast)\s*\(|\.forecast\s*\(/,
    operation: "statistical_forecast",
    describe: "computes a moving average, rolling window or time-series forecast"
  },
  {
    re: /\b(StandardScaler|MinMaxScaler|normalize|tokenize|embed|embedding|cosine_similarity|similarity)\b/i,
    operation: "representation",
    describe: "transforms values into a normalised or vector representation"
  }
];
function extractModels(path, content) {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    for (const pattern of MODEL_USAGE) {
      if (!pattern.re.test(line)) continue;
      const lineNumber = index + 1;
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${identifiers[0] ?? lineNumber}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "model",
        claim: `\`${path}\` ${pattern.describe} (line ${lineNumber}${identifiers[0] ? `, near \`${identifiers[0]}\`` : ""}).`,
        symbol: null,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers
      });
      break;
    }
  });
  return out;
}
var DATA_ACCESS = [
  {
    re: /pd\.read_csv|pd\.read_json|pd\.read_excel|pd\.read_sql|csv\.(reader|DictReader|reader)|read_csv|load_csv|open\s*\(\s*['"`][^'"`]*\.(csv|json|jsonl|txt|parquet|xlsx|tsv)/i,
    operation: "file_ingest",
    describe: "reads a data file from disk"
  },
  {
    re: /fetch\s*\(|axios\.|requests\.(get|post|put|patch|delete)|httpx\.|urlopen|XMLHttpRequest|supabase\.|firebase\./,
    operation: "network_call",
    describe: "calls an external service or API"
  },
  {
    re: /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[\s\S]{0,80}\b(FROM|INTO|SET|WHERE)\b/i,
    operation: "sql",
    describe: "executes a database query"
  },
  {
    re: /\.(query|execute|executemany|find|findOne|find_many|insert|update|delete|upsert|save|create)\s*\(|\.collection\s*\(|\.table\s*\(/,
    operation: "orm",
    describe: "reads or writes records through a data-access layer"
  },
  {
    re: /localStorage|sessionStorage|indexedDB|FileReader|readAsText|readAsDataURL|\.read\(\)/,
    operation: "client_state",
    describe: "reads data held in the client or uploaded by the user"
  },
  {
    re: /glob\s*\(|listdir|walk\s*\(|readdir|fs\.|open\s*\(\s*['"`][^'"`]*\.(csv|json|jsonl|parquet)/i,
    operation: "file_scan",
    describe: "scans the filesystem for input data"
  },
  {
    re: /write\s*\(|to_csv|to_json|writerow|json\.dump|FileWriter|createWriteStream/i,
    operation: "file_write",
    describe: "writes data out to a file"
  }
];
function extractDataAccess(path, content, symbols) {
  const language = languageOfPath(path);
  if (!isCodeLanguage(language)) return [];
  const lines = content.split("\n");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    if (!isCode(line, language)) return;
    for (const pattern of DATA_ACCESS) {
      if (!pattern.re.test(line)) continue;
      const lineNumber = index + 1;
      const symbol = enclosingSymbol(symbols, lineNumber);
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${identifiers[0] ?? lineNumber}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "data_access",
        claim: `\`${path}\` ${pattern.describe}` + (symbol ? ` inside \`${symbol}\`` : "") + (identifiers[0] ? `, near \`${identifiers[0]}\`` : "") + `.`,
        symbol,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers
      });
      break;
    }
  });
  return out;
}
var UI_PATTERNS = [
  {
    re: /<form[\s>]|onsubmit|addEventListener\s*\(\s*['"`]submit|onclick\s*=|addEventListener\s*\(\s*['"`]click/,
    operation: "form_submit",
    describe: "captures a user action through a form or click handler"
  },
  {
    re: /<table|<thead|tbody|DataTable|\.map\s*\(\s*\(?\s*\w+\s*\)?\s*=>[\s\S]{0,40}<tr|createElement\s*\(\s*['"`]tr/,
    operation: "data_table",
    describe: "renders rows of data as a table or list"
  },
  {
    re: /<canvas|chart|Chart\s*\(|plotly|d3\.|plot\s*\(|sparkline|svg/i,
    operation: "chart",
    describe: "renders a chart or visual plot of data"
  },
  {
    re: /<input|<select|<textarea|useState|setState|v-model|ng-model/,
    operation: "input_control",
    describe: "provides an input control the user can change"
  },
  {
    re: /<button|type=["']submit["']|onClick|@click|addEventListener/,
    operation: "button",
    describe: "offers a control the user can activate"
  },
  {
    re: /<h1|<h2|<h3|class=["'][^"']*(card|panel|grid|table|stat|kpi|dashboard)|innerHTML|textContent\s*=|dangerouslySetInnerHTML/,
    operation: "display",
    describe: "displays content to the user"
  }
];
function extractUi(path, content, symbols) {
  const language = languageOfPath(path);
  const lines = content.split("\n");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  lines.forEach((line, index) => {
    if (out.length >= MAX_PER_KIND) return;
    for (const pattern of UI_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      if (language !== "HTML" && !isCode(line, language)) continue;
      const lineNumber = index + 1;
      const symbol = enclosingSymbol(symbols, lineNumber);
      const identifiers = identifiersIn(line);
      const key = `${pattern.operation}:${identifiers[0] ?? lineNumber}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        kind: "ui",
        claim: `\`${path}\` ${pattern.describe}` + (identifiers[0] ? ` (near \`${identifiers[0]}\`)` : "") + `.`,
        symbol,
        line: lineNumber,
        lines: String(lineNumber),
        excerpt: excerptOf(line),
        operation: pattern.operation,
        identifiers
      });
      break;
    }
  });
  return out;
}
var IMPORT_PATTERNS = [
  /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^\s*from\s+([\w.]+)\s+import\s+/gm,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  /^\s*use\s+([\w:]+)\s*;/gm,
  /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
  /^\s*import\s+([\w.]+)\s*$/gm
];
function extractImports(content) {
  const found = /* @__PURE__ */ new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1]?.trim();
      if (value) found.add(value);
      if (found.size > 60) break;
    }
  }
  return [...found].slice(0, 60);
}
function analyseSemantics(path, content, symbols) {
  return {
    path,
    language: languageOfPath(path),
    calculations: extractCalculations(path, content, symbols),
    rules: extractRules(path, content, symbols),
    models: extractModels(path, content),
    dataAccess: extractDataAccess(path, content, symbols),
    ui: extractUi(path, content, symbols),
    imports: extractImports(content)
  };
}
function compactSemantics(result, limit = 10) {
  const take = (items) => items.slice(0, limit).map((item) => ({
    claim: item.claim,
    operation: item.operation,
    line: item.line,
    excerpt: item.excerpt
  }));
  return {
    path: result.path,
    language: result.language,
    calculations: take(result.calculations),
    decision_rules: take(result.rules),
    model_usage: take(result.models),
    data_access: take(result.dataAccess),
    interface: take(result.ui)
  };
}

// _shared/scanner.ts
var SCANNER_VERSION = "p5-3";
var READ_CATEGORIES = /* @__PURE__ */ new Set([
  "source",
  "component",
  "api",
  "model",
  "schema",
  "database",
  "config",
  "documentation",
  "test",
  "dataset"
]);
var MAX_DATASETS_READ = 25;
var DATASET_HEAD_BYTES = 512e3;
var MAX_DATASET_BYTES2 = 20 * 1024 * 1024;
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
function looksLikeDataPath(path, fileName) {
  if (!path.toLowerCase().endsWith(".json")) return false;
  const name = fileName.toLowerCase();
  if (name === "package.json" || name === "composer.json" || name === "manifest.json") {
    return false;
  }
  if (name.startsWith("tsconfig") || name.startsWith("jsconfig")) return false;
  if (name.startsWith("babel") || name.startsWith("eslint")) return false;
  if (name.startsWith("prettier") || name.startsWith("stylelint")) return false;
  const parts = path.toLowerCase().split("/");
  return parts.some(
    (part) => ["data", "dataset", "datasets", "dump", "export", "records", "rows", "sample", "samples"].includes(part)
  );
}
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
  const readCandidates = inventory.filter((item) => {
    if (item.record.is_ignored) return false;
    if (item.record.file_category === "dataset") {
      return item.record.file_size <= MAX_DATASET_BYTES2;
    }
    if (looksLikeDataPath(item.record.path, item.record.file_name ?? "")) {
      return item.record.file_size <= MAX_DATASET_BYTES2;
    }
    return READ_CATEGORIES.has(item.record.file_category) && item.record.file_size <= config.analysisMaxFileBytes;
  });
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
  const datasetProfiles = [];
  const semantics = [];
  let datasetsRead = 0;
  let datasetsSkipped = 0;
  const conceptSeeds = () => [];
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
    const binary = looksBinary(blob, path);
    record.is_binary = binary;
    record.file_size = blob.length;
    files.push(record);
    if (binary) {
      record.importance = "ignored";
      continue;
    }
    const isDataFile = category === "dataset" || path.toLowerCase().endsWith(".json") && looksLikeDataPath(path, record.file_name ?? "");
    if (isDataFile) {
      if (datasetsRead >= MAX_DATASETS_READ) {
        datasetsSkipped += 1;
        files.push(record);
        continue;
      }
      datasetsRead += 1;
      const head = blob.length > DATASET_HEAD_BYTES ? blob.slice(0, DATASET_HEAD_BYTES) : blob;
      const headText = decodeText(head, path);
      if (headText !== null) {
        const profile = profileDataset(
          { path, content: headText, sizeBytes: blob.length },
          conceptSeeds()
        );
        if (profile) {
          datasetProfiles.push(profile);
          record.importance = "high";
        }
      }
      files.push(record);
      continue;
    }
    const content = decodeText(blob, path);
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
      } else {
        chunks.push(headChunk(path, record, content, importance));
      }
      routes.push(...extractRoutes(path, content));
      integrations.push(...extractIntegrations(content, path));
      const found = analyseSemantics(
        path,
        content,
        symbols.map((symbol) => ({
          name: symbol.name,
          line: symbol.line,
          symbol_type: symbol.symbol_type
        }))
      );
      if (found.calculations.length || found.rules.length || found.models.length || found.dataAccess.length || found.ui.length) {
        semantics.push(found);
      }
    }
  }
  if (datasetsSkipped) {
    warnings.push(
      `${datasetsSkipped} further data file(s) were not profiled to stay within the limit of ${MAX_DATASETS_READ} datasets per repository.`
    );
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
    analysisMode,
    datasetProfiles,
    semantics
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
    warnings,
    datasetProfiles,
    semantics
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
    datasetProfiles,
    semantics,
    routes,
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
function headChunk(path, record, content, importance) {
  const lines = content.split("\n");
  const end = Math.min(lines.length, 200);
  return {
    file_path: path,
    chunk_index: 0,
    start_line: 1,
    end_line: end,
    content: lines.slice(0, end).join("\n").slice(0, 12e3),
    symbol_name: null,
    symbol_type: "file",
    language: record.language,
    importance
  };
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
  for (const profile of input.datasetProfiles.slice(0, 25)) {
    const shape = [
      profile.date_columns.length ? `dated by ${profile.date_columns.join("/")}` : null,
      profile.entity_columns.length ? `keyed by ${profile.entity_columns.join("/")}` : null,
      profile.quantity_columns.length || profile.stock_columns.length ? `measuring ${[...profile.quantity_columns, ...profile.stock_columns].join("/")}` : null,
      profile.price_columns.length ? `priced by ${profile.price_columns.join("/")}` : null,
      profile.supplier_columns.length ? `with ${profile.supplier_columns.join("/")}` : null
    ].filter(Boolean).join(", ");
    registry.add({
      type: "dataset_profile",
      claim: `Dataset \`${profile.path}\` (${profile.format}, ~${profile.approx_row_count.toLocaleString("en-US")} rows, ${Math.round(profile.size_bytes / 1024)} KB) with columns ${profile.column_names.slice(0, 8).join(", ")}` + (shape ? ` \u2014 ${shape}` : "") + `. Profile: ${profile.likely_purpose}.`,
      file: profile.path,
      confidence: "high",
      detail: {
        columns: profile.column_names.slice(0, 20),
        approx_row_count: profile.approx_row_count,
        format: profile.format,
        purpose: profile.likely_purpose
      }
    });
  }
  for (const file of input.semantics) {
    for (const finding of file.calculations.slice(0, 6)) {
      registry.add({
        type: "calculation",
        claim: finding.claim,
        file: file.path,
        symbol: finding.symbol,
        lines: finding.lines,
        confidence: "high",
        detail: { operation: finding.operation }
      });
    }
    for (const finding of file.rules.slice(0, 4)) {
      registry.add({
        type: "rule",
        claim: finding.claim,
        file: file.path,
        symbol: finding.symbol,
        lines: finding.lines,
        confidence: "high",
        detail: { operation: finding.operation }
      });
    }
    for (const finding of file.models.slice(0, 4)) {
      registry.add({
        type: "model",
        claim: finding.claim,
        file: file.path,
        lines: finding.lines,
        confidence: "high",
        detail: { operation: finding.operation }
      });
    }
    for (const finding of file.dataAccess.slice(0, 4)) {
      registry.add({
        type: "data_access",
        claim: finding.claim,
        file: file.path,
        symbol: finding.symbol,
        lines: finding.lines,
        confidence: "high",
        detail: { operation: finding.operation }
      });
    }
    for (const finding of file.ui.slice(0, 3)) {
      registry.add({
        type: "ui",
        claim: finding.claim,
        file: file.path,
        lines: finding.lines,
        confidence: "medium",
        detail: { operation: finding.operation }
      });
    }
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
function semanticsFrom(projectMap) {
  const empty = [];
  const byFile = /* @__PURE__ */ new Map();
  const add = (kind, rows) => {
    for (const row of rows ?? []) {
      const file = String(row.file ?? "");
      if (!file) continue;
      const entry = byFile.get(file) ?? {
        path: file,
        language: null,
        calculations: [],
        rules: [],
        models: [],
        dataAccess: [],
        ui: [],
        imports: []
      };
      entry[kind].push({
        claim: String(row.claim ?? ""),
        symbol: row.symbol ?? null,
        line: Number(row.line ?? 0),
        lines: String(row.line ?? 0),
        excerpt: "",
        operation: String(row.operation ?? ""),
        identifiers: (row.identifiers ?? []).map(String)
      });
      byFile.set(file, entry);
    }
  };
  add("calculations", projectMap.calculations);
  add("rules", projectMap.business_logic);
  add("models", projectMap.models);
  add("dataAccess", projectMap.data_access);
  add("ui", projectMap.ui_flows);
  return byFile.size ? [...byFile.values()] : empty;
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
    const service2 = this.service;
    await service2.from("repository_files").delete().eq("repository_id", repositoryId);
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
      const { error } = await service2.from("repository_files").upsert(rows.slice(start, start + 500), { onConflict: "repository_id,path" });
      if (error) {
        console.warn("[hacksim.analysis] could not write file rows:", error.message);
        return;
      }
    }
  }
  /** Chunks reference a file id, so they are written after the files. */
  async writeChunks(repositoryId, chunks) {
    const service2 = this.service;
    const { data: fileRows } = await service2.from("repository_files").select("id, path").eq("repository_id", repositoryId);
    const idByPath = new Map(
      (fileRows ?? []).map((row) => [
        row.path,
        row.id
      ])
    );
    await service2.from("code_chunks").delete().eq("repository_id", repositoryId);
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
      const { error } = await service2.from("code_chunks").upsert(rows.slice(start, start + 400), { onConflict: "file_id,chunk_index" });
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
    const { data: files } = await this.service.from("repository_files").select(
      "id, path, file_name, language, file_category, importance, is_ignored, is_binary, line_count"
    ).eq("repository_id", repository.id).eq("is_ignored", false);
    const fileIds = (files ?? []).map((row) => row.id);
    const chunks = [];
    for (let start = 0; start < fileIds.length; start += 200) {
      const { data } = await this.service.from("code_chunks").select(
        "file_id, chunk_index, start_line, end_line, content, symbol_name, symbol_type, language, importance"
      ).in(
        "file_id",
        fileIds.slice(start, start + 200)
      ).in("importance", ["high", "medium"]).order("importance", { ascending: true }).limit(1200);
      chunks.push(...data ?? []);
      if (chunks.length >= 1200) break;
    }
    const pathById = new Map(
      (files ?? []).map((row) => [
        row.id,
        row.path
      ])
    );
    const projectMap = repository.project_map ?? {};
    const restored = chunks.map((chunk) => ({
      ...chunk,
      file_path: pathById.get(chunk.file_id)
    })).filter((chunk) => chunk.file_path);
    return {
      repository,
      files: files ?? [],
      chunks: restored,
      evidence: repository.evidence ?? [],
      projectMap,
      datasetProfiles: projectMap.data_sources ?? [],
      semantics: semanticsFrom(projectMap),
      routes: projectMap.apis ?? [],
      inspection: {
        mode: repository.analysis_mode === "limited" ? "limited" : "full",
        warnings: (projectMap.warnings ?? []).slice(0, 8),
        filesSeen: Number(
          projectMap.repository_stats?.total_files_seen ?? 0
        ),
        filesRead: (files ?? []).filter(
          (row) => !row.is_ignored
        ).length
      }
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

// _shared/review.ts
init_http();

// _shared/evidence.ts
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
  "clarification_needed",
  "dead_feature",
  "placeholder",
  "hardcoding"
];
var SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "informational"
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
var OUTCOME_STATUSES = [
  "supported",
  "partially_supported",
  "not_evidenced",
  "unclear"
];
var CLAIM_STATUSES = [
  "supported",
  "partially_supported",
  "not_evidenced"
];
var CONFIDENCES = ["high", "medium", "low", "none"];
function buildEvidenceSet(evidence) {
  const byId = /* @__PURE__ */ new Map();
  const byFile = /* @__PURE__ */ new Map();
  const ids = /* @__PURE__ */ new Set();
  for (const item of evidence ?? []) {
    if (!item?.id || ids.has(item.id)) continue;
    ids.add(item.id);
    byId.set(item.id, item);
    if (item.file) {
      const list = byFile.get(item.file) ?? [];
      list.push(item);
      byFile.set(item.file, list);
    }
  }
  return { ids, byId, byFile };
}
function filterCitations(raw, evidence, limit = 12) {
  const list = Array.isArray(raw) ? raw : [];
  const accepted = [];
  const rejected = [];
  for (const value of list) {
    const id = String(value ?? "").trim();
    if (!id) continue;
    if (evidence.ids.has(id)) {
      if (!accepted.includes(id) && accepted.length < limit) accepted.push(id);
    } else if (!rejected.includes(id)) {
      rejected.push(id);
    }
  }
  return { accepted, rejected };
}
function compactEvidence(items, limit = 60, terms = [], evidence) {
  const ranked = items.map((item) => {
    const haystack = `${item.claim} ${item.file ?? ""} ${item.symbol ?? ""}`.toLowerCase();
    let score = item.file ? 10 : 0;
    for (const term of terms) {
      if (term.length > 2 && haystack.includes(term)) score += 3;
    }
    if (item.type === "readme" || item.type === "repository") score += 6;
    if (item.type === "analysis_mode") score += 8;
    return { item, score };
  }).sort((a, b) => b.score - a.score);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const { item } of ranked) {
    const key = `${item.type}|${item.file ?? ""}|${item.symbol ?? ""}|${item.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id,
      type: item.type,
      claim: item.claim.slice(0, 220),
      file: item.file ?? null,
      symbol: item.symbol ?? null,
      lines: item.lines ?? null
    });
    if (out.length >= limit) break;
  }
  void evidence;
  return out;
}
var MAX_FINDINGS = 10;
function validateFindings(raw, evidence, expectationSource = "general") {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item;
    const title = String(record.title ?? "").trim();
    if (!title) continue;
    const { accepted } = filterCitations(record.evidence_ids, evidence);
    if (accepted.length === 0 && record.type !== "observation") continue;
    let type = FINDING_TYPES.includes(String(record.type)) ? String(record.type) : "observation";
    const severity = SEVERITIES.includes(String(record.severity)) ? String(record.severity) : "low";
    const confidence = ["high", "medium", "low"].includes(String(record.confidence)) ? String(record.confidence) : "low";
    if (type === "confirmed_issue" && confidence === "low") {
      type = "potential_issue";
    }
    if (type === "claim_mismatch" && accepted.length === 0) continue;
    const files = (record.files ?? []).map(String).filter((file) => Boolean(file)).slice(0, 12);
    out.push({
      finding_type: type,
      severity,
      title: title.slice(0, 200),
      description: String(record.description ?? "").slice(0, 2e3),
      evidence_ids: accepted,
      files,
      symbols: (record.symbols ?? []).map(String).slice(0, 12),
      why_it_matters: String(record.why_it_matters ?? "").slice(0, 1e3),
      suggested_improvement: String(record.suggested_improvement ?? "").slice(0, 1e3),
      confidence,
      expectation_source: expectationSource
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}
function detectConflicts(input, evidence) {
  if (input.status !== "not_evidenced") return [];
  const claim = input.claim.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!claim) return [];
  const observed = input.observed.filter((item) => Boolean(item?.trim())).slice(0, 3).map((item) => item.trim().replace(/\s+/g, " ").slice(0, 240));
  if (observed.length === 0) return [];
  const files = /* @__PURE__ */ new Set();
  for (const id of input.evidenceIds) {
    const item = evidence.byId.get(id);
    if (item?.file) files.add(item.file);
  }
  return [
    {
      finding_type: "claim_mismatch",
      severity: "medium",
      title: `The submission describes "${claim}", which the inspected repository does not currently show`,
      description: `The submission states: "${claim}". The inspected repository evidence at this commit shows: ${observed.join("; ")}. This is a difference between what is described and what is currently visible in the analysed code \u2014 it may be implemented in a form the scan did not reach, described imprecisely, or in another branch.`,
      evidence_ids: input.evidenceIds.filter((id) => evidence.ids.has(id)).slice(0, 8),
      files: [...files].slice(0, 8),
      symbols: [],
      why_it_matters: "A claim that the repository does not support is the first thing a reviewer will test, so it is worth aligning the description, the code, or both.",
      suggested_improvement: "Point the description at the code that implements the claim, or implement the behaviour the description promises.",
      confidence: "medium",
      expectation_source: "claim"
    }
  ];
}
function testingFromEvidence(projectMap) {
  const testing = projectMap?.testing ?? {};
  const count = Number(testing.test_file_count ?? 0);
  const frameworks = (testing.frameworks ?? []).map((name) => String(name));
  let status;
  let finding;
  if (count === 0) {
    status = "not_evidenced";
    finding = "testing_gap";
  } else if (count < 3) {
    status = "partial_evidence";
    finding = null;
  } else {
    status = "evidence_found";
    finding = null;
  }
  return {
    status,
    testFileCount: count,
    frameworks,
    commands: (testing.commands ?? []).map(String),
    finding,
    explanation: count === 0 ? "No test files were detected in the analysed repository." : `${count} test files detected. File count is not a measure of test quality.`
  };
}
function securityFromEvidence(projectMap) {
  const security = projectMap?.security ?? {};
  const secrets = (security.hardcoded_secrets ?? []).filter((item) => item && typeof item.file === "string");
  if (!secrets.length) return null;
  return {
    status: "evidence_found",
    confirmed_issues: secrets.slice(0, 5).map((item) => {
      const words = String(item.type).replace(/_/g, " ");
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

// _shared/modules.ts
var PROMPT_VERSIONS = {
  alignment: "align-v2",
  requirements: "req-v2",
  constraints: "con-v2",
  outcomes: "out-v2",
  criteria: "eval-v2",
  claims: "claim-v2",
  implementation: "impl-v2",
  engineering: "eng-v2",
  properness: "proper-v2",
  requirements_fallback: "reqmap-v1"
};
var SYSTEM_STABLE = `You are a technical reviewer assessing a hackathon submission against its brief.
You are given FACTS extracted deterministically from a GitHub repository, small
targeted code snippets, and dataset profiles. The facts are the source of truth.

How to reason:
1. Read the implementation you are given and describe what it actually does.
   Behaviour lives in code, data, configuration and interface \u2014 judge those.
2. NEVER treat a library as proof. An imported framework does not mean the
   feature exists, and an absent library does not mean the feature is missing.
   Forecasting can be three lines of arithmetic; a project can install a
   machine-learning library and never call it. Both are common.
3. A route, endpoint, component or class existing does NOT prove the behaviour
   behind it is implemented. Open it in the evidence and describe what the code
   in it does.
4. Judge each item against the stated problem and the code in front of you, not
   against a checklist of technologies you expect to find. A different valid
   approach is still a valid approach.
5. Never invent files, functions, endpoints, tables, dependencies, features,
   metrics or vulnerabilities. If something is not in the evidence, say it is
   not evidenced.
6. Every conclusion must cite evidence ids from the list you are given, taken
   exactly from that list. An id that is not in the list is rejected.
7. A positive status with no evidence id is rejected. If you cannot support a
   conclusion from the evidence given, use "not_evidenced" and explain what you
   looked at.
8. "not_evidenced" means this repository, at this commit, did not show sufficient
   evidence. It does NOT mean the feature does not exist.
9. "unable_to_determine" is a statement about the inspection, not the project.
   Use it only when the evidence given could not possibly settle the question.
10. Never claim a real-world impact or benchmark number unless the evidence
    contains a measurement. Describe intent instead.
11. Prefer "potential_issue" over "confirmed_issue". Use "confirmed_issue" only
    when the evidence unambiguously establishes the problem.
12. Do not rank, score, compare or rank teams, and do not declare a winner. No
    numbers that imply a grade. This is a training analysis.
13. Do not penalise an architecture for differing from another architecture. Say
    what it is and whether it fits this problem.
14. Describe what a simple solution does well. Simplicity is not a weakness and
    complexity is not a strength.
15. Reply with a single JSON object matching the requested shape. No prose.`;
var NO_SNIPPETS = "(no code was retrieved for this question)";
function truncateJson(payload, limit) {
  const text2 = JSON.stringify(payload ?? null);
  return text2.length <= limit ? text2 : `${text2.slice(0, limit)} \u2026(truncated)`;
}
function evidenceList(context, limit) {
  const compact = compactEvidence(
    context.evidence,
    limit,
    context.terms
  );
  if (!compact.length) return "(no evidence items matched this question)";
  return compact.map((item) => {
    const where = item.file ? ` ${item.file}${item.lines ? `:${item.lines}` : ""}` : "";
    return `${item.id} [${item.type}]${where} \u2014 ${item.claim}`;
  }).join("\n");
}
function datasetBlock(context) {
  if (!context.datasetProfiles.length) return "";
  const compact = context.datasetProfiles.slice(0, 6).map(compactDatasetProfile);
  return `

DATASET PROFILES (structure and samples, not the full data)
${truncateJson(compact, 3e3)}`;
}
function logicBlock(context) {
  if (!context.semantics.length) return "";
  const compact = context.semantics.slice(0, 6).map((item) => compactSemantics(item, 5));
  return `

WHAT THE CODE DOES (extracted from the code, not from library names)
${truncateJson(compact, 3e3)}`;
}
function briefBlock(context, withClaims = true) {
  const { context: hackathon } = context;
  const parts = [];
  parts.push(`HACKATHON: ${hackathon.name} (type: ${hackathon.type.replace(/_/g, " ")})`);
  if (hackathon.theme) parts.push(`THEME
${hackathon.theme.slice(0, 600)}`);
  if (hackathon.hasProblem) {
    parts.push(`THE PROBLEM THE HACKATHON SET
${hackathon.problem.slice(0, 2e3)}`);
  } else {
    parts.push(
      "THE HACKATHON\nThis is an open-innovation challenge: it sets no problem and no requirements. The participant chose their own problem, and the only correct reference is the problem they describe below."
    );
  }
  for (const note of hackathon.freeformNotes.slice(0, 4)) {
    parts.push(`ORGANISER NOTE
${note.slice(0, 500)}`);
  }
  if (hackathon.customInstructions) {
    parts.push(`ORGANISER INSTRUCTIONS
${hackathon.customInstructions.slice(0, 800)}`);
  }
  if (hackathon.technologyRestrictions) {
    parts.push(`TECHNOLOGY RESTRICTIONS
${hackathon.technologyRestrictions.slice(0, 500)}`);
  }
  if (hackathon.datasetRequirements) {
    parts.push(`DATASET REQUIREMENT
${hackathon.datasetRequirements.slice(0, 500)}`);
  }
  if (hackathon.deploymentRequirements) {
    parts.push(`DEPLOYMENT REQUIREMENT
${hackathon.deploymentRequirements.slice(0, 500)}`);
  }
  if (withClaims) {
    const claims = [
      hackathon.claims.description ? `Description: ${hackathon.claims.description}` : "",
      hackathon.claims.features ? `Claimed features:
${hackathon.claims.features}` : "",
      hackathon.claims.techStack ? `Self-described stack: ${hackathon.claims.techStack}` : ""
    ].filter(Boolean);
    if (claims.length) parts.push(`WHAT THE TEAM SAYS THEY BUILT
${claims.join("\n")}`);
  }
  return parts.join("\n\n");
}
function factsBlock(context, evidenceLimit) {
  const { projectMap } = context;
  const map = projectMap;
  const trimmed = {
    analysis_mode: map.analysis_mode,
    stack: map.stack,
    architecture: map.architecture,
    apis: map.apis,
    database: map.database,
    authentication: map.authentication,
    features: map.features,
    data_sources: map.data_sources,
    business_logic: map.business_logic,
    calculations: map.calculations,
    models: map.models,
    ui_flows: map.ui_flows,
    testing: map.testing,
    deployment: map.deployment,
    repository_stats: map.repository_stats,
    important_files: map.important_files,
    warnings: map.warnings
  };
  return `

EVIDENCE (cite these ids exactly)
${evidenceList(context, evidenceLimit)}` + datasetBlock(context) + logicBlock(context) + `

PROJECT MAP (deterministic facts about the repository)
${truncateJson(trimmed, 4e3)}

RELEVANT CODE
${context.code || NO_SNIPPETS}` + (context.inspectionNote ? `

COVERAGE NOTE
${context.inspectionNote}` : "");
}
var FINDINGS_SCHEMA = `"findings": [
    {
      "type": "strength|observation|potential_issue|confirmed_issue|security_concern|testing_gap|architecture_concern|scalability_concern|claim_mismatch|clarification_needed|dead_feature|placeholder|hardcoding",
      "severity": "critical|high|medium|low|informational",
      "title": "short factual title",
      "description": "what the code does or does not do, citing the evidence",
      "evidence_ids": ["EV-001"],
      "files": ["path/in/repo"],
      "symbols": ["name"],
      "why_it_matters": "consequence for this project",
      "suggested_improvement": "concrete next step, or empty string",
      "confidence": "high|medium|low"
    }
  ]`;
function buildAlignmentTask(context) {
  const { context: hackathon, concepts } = context;
  const vocabulary = concepts.flatMap((concept) => [...concept.phrases, ...concept.subjects, ...concept.actions]).slice(0, 24).join(", ");
  return `Determine whether this submission addresses ${hackathon.hasProblem ? "the problem the hackathon set" : "the problem the team says it chose"}.

Read the evidence and the code, and describe what this project actually does about
that problem. Judge the problem, not the stack: a rule-based solution, a
statistical one and a model-based one are all acceptable if the problem is
genuinely addressed by what the code does.

Words this problem is likely expressed in: ${vocabulary || "(none extracted)"}

Return JSON:
{
  "problem_alignment": {
    "status": "strongly_aligned|partially_aligned|weakly_evidenced|unclear",
    "confidence": "high|medium|low",
    "evidence_ids": ["EV-001"],
    "explanation": "What the implementation does about the stated problem, and how that relates to it.",
    "approach": "One or two sentences naming the actual approach taken, in the code's own terms."
  },
  "approach_notes": [
    "A distinct, separately evidenced observation about the approach."
  ],
  ${FINDINGS_SCHEMA}
}

If the repository genuinely addresses the problem but the evidence given here is
thin, say so in the explanation and use "partially_aligned" with the evidence
you do have. Do not withhold a positive status because a particular library is
absent.

${briefBlock(context)}
${factsBlock(context, 60)}`;
}
function buildRequirementsTask(context, subjects, groupLabel) {
  const listed = subjects.map(
    (subject) => `- ${subject.id} (${subject.importance}) ${subject.text}`
  ).join("\n");
  const focusLines = context.concepts.map(
    (concept) => `- ${concept.intent.slice(0, 200)}
  look for: ${[...concept.phrases, ...concept.actions, ...concept.subjects].slice(0, 10).join(", ") || "(general)"}`
  ).join("\n");
  return `Assess each requirement below against what this repository actually implements.

These requirements are about ${groupLabel}. The code, evidence and dataset
profiles you were given were retrieved using the requirement wording itself, so
they are the most relevant material in the repository for this question. If the
implementation is elsewhere, say so in the explanation and use the most
conservative status the evidence supports.

REQUIREMENTS
${listed}

WHAT WAS RETRIEVED FOR THEM
${focusLines || "(general retrieval)"}

For each requirement decide what the repository shows:
- evidence_found      the implementation required is visible in the evidence
- partial_evidence    part of it is visible; name the missing part
- not_evidenced       the retrieved evidence does not show it
- unable_to_determine only when the evidence given could not settle it

Do not treat the absence of a library, framework or database as evidence about
any requirement. Judge the behaviour.

Return JSON:
{
  "conclusions": [
    {
      "subject_id": "REQ-001",
      "status": "evidence_found|partial_evidence|not_evidenced|unable_to_determine",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What the code does, and how that satisfies or fails this requirement.",
      "missing_or_unclear": ["the specific part that is not evidenced, if any"]
    }
  ],
  ${FINDINGS_SCHEMA}
}

Answer every requirement id exactly once.

${briefBlock(context)}
${factsBlock(context, 50)}`;
}
function buildConstraintsTask(context, subjects) {
  const listed = subjects.map((subject) => `- ${subject.id} ${subject.text}`).join("\n");
  const technology = context.context.technologyRestrictions;
  return `Check each constraint the hackathon set against this repository.

A constraint is about what the project does, not what it is built with. For a
technology restriction, look at the imports, dependencies, configuration,
environment variables and outbound URLs that the evidence shows. For a data
restriction, look at what the code reads, sends and stores.

CONSTRAINTS
${listed}
${technology ? `
TECHNOLOGY RESTRICTIONS (also stated, check them)
${technology.slice(0, 500)}` : ""}

Return JSON:
{
  "conclusions": [
    {
      "subject_id": "CON-001",
      "status": "supported|potential_concern|not_evidenced|unable_to_determine",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What in the repository shows this constraint is respected, or where it looks broken.",
      "missing_or_unclear": ["..."]
    }
  ],
  ${FINDINGS_SCHEMA}
}

Use "not_evidenced" only after actually looking. If the evidence you were given
cannot settle a constraint, say "unable_to_determine" and say why.

${briefBlock(context)}
${factsBlock(context, 40)}`;
}
function buildOutcomesTask(context, subjects) {
  const listed = subjects.map((subject) => `- ${subject.id} ${subject.text}`).join("\n");
  return `Check whether this repository provides evidence of the expected outcome.

The expected outcome describes a result, not a feature list. Trace what the code
actually produces \u2014 what a user would see, what the API returns, what is
written or displayed \u2014 and compare that with the outcome.

EXPECTED OUTCOMES
${listed}

Return JSON:
{
  "conclusions": [
    {
      "subject_id": "OUT-001",
      "status": "supported|partially_supported|not_evidenced|unclear",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What the repository produces, and how that matches the expected outcome.",
      "missing_or_unclear": ["..."]
    }
  ],
  ${FINDINGS_SCHEMA}
}

${briefBlock(context)}
${factsBlock(context, 40)}`;
}
function buildCriteriaTask(context, subjects) {
  const listed = subjects.map((subject) => `- ${subject.id} ${subject.text}`).join("\n");
  return `Describe each evaluation criterion against the evidence.

There is no score here and no comparison with any other team. For each criterion
write a short factual observation about what this repository does, and say what
would need to be demonstrated to evaluate it properly.

EVALUATION CRITERIA
${listed}

Return JSON:
{
  "conclusions": [
    {
      "subject_id": "EVAL-001",
      "status": "supported|partially_supported|not_evidenced|unclear",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What the repository shows for this criterion, descriptively.",
      "missing_or_unclear": ["what could not be assessed and why"]
    }
  ],
  ${FINDINGS_SCHEMA}
}

Never produce a number, a grade, or a rank.

${briefBlock(context)}
${factsBlock(context, 35)}`;
}
function buildClaimsTask(context, claims) {
  const listed = claims.map((claim) => `- ${claim}`).join("\n");
  return `Check each feature the team claims against the repository.

For each claim, trace it: is the behaviour implemented, is data actually passed
into it, is a result produced, and is that result used or shown anywhere? A claim
is only "supported" when that chain is visible in the evidence.

CLAIMS (exactly these, do not add or reword any)
${listed}

Return JSON:
{
  "claims": [
    {
      "claim": "the claim exactly as listed above",
      "status": "supported|partially_supported|not_evidenced",
      "confidence": "high|medium|low|none",
      "evidence_ids": ["EV-001"],
      "explanation": "What the repository shows about this claim. Name the part that is missing if it is partial."
    }
  ],
  ${FINDINGS_SCHEMA}
}

"not_evidenced" means this repository at this commit does not show it. It is not
a statement that the team did not build it.

${briefBlock(context)}
${factsBlock(context, 45)}`;
}
function buildImplementationTask(context) {
  const { projectMap } = context;
  const map = projectMap;
  const stack = map.stack ?? {};
  const declared = stack.dependencies_by_category ?? {};
  const declaredText = Object.entries(declared).map(([category, packages]) => `${category}: ${(packages ?? []).slice(0, 12).join(", ")}`).join("\n");
  return `Describe how this project is built and whether the implementation is
coherent: problem -> implementation -> output.

Describe what exists. Do not judge the architecture against a template: a single
Python file, a Streamlit app, a static site with a CSV, a serverless backend and
a full-stack application are all valid answers to different problems. Report
what the code does, whether the parts connect, and what looks unfinished.

Declared dependencies (descriptive only \u2014 a dependency is not a feature):
${declaredText || "(none declared)"}

Return JSON:
{
  "architecture": {
    "summary": "How the project is structured, as observed.",
    "layers": ["..."],
    "entry_points": ["file or route a user or caller starts from"],
    "evidence_ids": ["EV-001"]
  },
  "technical_decisions": [
    {"decision":"...","rationale":"only if the code shows the reason, else omit","evidence_ids":["EV-001"]}
  ],
  "implementation": {
    "summary": "What is actually implemented end to end.",
    "strengths": ["..."],
    "observations": ["..."],
    "incomplete_or_dead": ["a feature that exists but does nothing, if any"]
  },
  ${FINDINGS_SCHEMA}
}

${briefBlock(context)}
${factsBlock(context, 50)}`;
}
function buildEngineeringTask(context, dimensions) {
  return `Make general engineering observations about this repository.

These are observations, not requirement failures. The hackathon did not ask for
${dimensions.length > 1 ? "these specific characteristics" : "this characteristic"},
so a missing one is a fact about the project, not a mark against it. Only raise a
concern when the evidence shows one.

OBSERVING: ${dimensions.join(", ")}

Return JSON:
{
  "observations": [
    {
      "topic": "security|testing|data_handling|database|api|deployment|usability|maintainability",
      "status": "observed|not_applicable|concern",
      "summary": "What the repository does here, factually.",
      "evidence_ids": ["EV-001"],
      "concern": "the specific problem, only when status is concern",
      "improvement": "concrete next step, or empty string"
    }
  ],
  ${FINDINGS_SCHEMA}
}

"not_applicable" is a correct and welcome answer: a project that needs no
database, no auth and no deployment config should not be told it is missing
them.

${briefBlock(context, false)}
${factsBlock(context, 40)}`;
}
function buildPropernessTask(context, priorConclusions) {
  const prior = priorConclusions.map(
    (item) => `- ${item.label}: ${item.status} \u2014 ${String(item.summary).slice(0, 220)}`
  ).join("\n");
  return `Give the final factual assessment of this project.

You are not scoring it. You are describing what was found, so a participant can
understand what works, what is uncertain and what deserves attention. A project
can be simple, incomplete, or unusual and still be a legitimate implementation \u2014
say which, with evidence.

WHAT THE EARLIER ANALYSIS FOUND
${prior || "(no earlier conclusions)"}

A technical failure elsewhere in the pipeline is not a defect in the project. If
coverage was limited, that belongs under uncertainty, not under gaps.

Return JSON:
{
  "assessment": {
    "headline": "One sentence a participant would understand.",
    "understanding": "What this project is, from the evidence.",
    "problem_relevance": "How it relates to the problem stated or chosen.",
    "solution_coherence": "Whether problem, implementation and output form a working chain.",
    "implementation_evidence": "How much of the claimed functionality is visible in code.",
    "functional_completeness": "What is complete, what is partial, what is absent.",
    "technical_quality": "Only what the code shows: structure, error handling, data flow.",
    "claim_accuracy": "How well the description matches the implementation.",
    "hackathon_alignment": "Against what THIS hackathon asked, and only that.",
    "evidence_ids": ["EV-001"]
  },
  "strengths": ["what is genuinely good about it, evidenced"],
  "gaps": ["what is missing or incomplete, evidenced, or honestly uncertain"],
  "uncertainties": ["what could not be determined and why"],
  "engineering_concerns": ["..."],
  ${FINDINGS_SCHEMA}
}

No score. No grade. No ranking. No claim that the feature does not exist \u2014
only that the evidence does not show it.

${briefBlock(context)}
${factsBlock(context, 30)}`;
}

// _shared/validate.ts
var STATUSES = {
  requirement: REQUIREMENT_STATUSES,
  constraint: CONSTRAINT_STATUSES,
  outcome: OUTCOME_STATUSES,
  criterion: OUTCOME_STATUSES,
  claim: CLAIM_STATUSES
};
var POSITIVE = /* @__PURE__ */ new Set([
  "evidence_found",
  "supported",
  "partially_supported",
  "partial_evidence"
]);
function clampStatus(kind, raw) {
  const allowed = STATUSES[kind];
  const value = String(raw ?? "");
  return allowed.includes(value) ? value : allowed[allowed.length - 1];
}
function clampConfidence(raw) {
  const value = String(raw ?? "");
  return CONFIDENCES.includes(value) ? value : "low";
}
function stringList(raw, limit = 8, itemLimit = 300) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item ?? "").trim().slice(0, itemLimit)).filter((item) => item.length > 2).slice(0, limit);
}
function validateConclusions(payload, options) {
  const { kind, allowedSubjects, evidence } = options;
  const errors = [];
  const rejectedSubjects = [];
  const rejectedEvidenceIds = /* @__PURE__ */ new Set();
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  const record = payload ?? {};
  const raw = Array.isArray(payload) ? payload : Array.isArray(record.conclusions) ? record.conclusions : Array.isArray(record.items) ? record.items : [];
  const list = raw;
  if (!Array.isArray(list)) {
    errors.push("the reply did not contain a list of conclusions");
  }
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      errors.push("a conclusion was not an object");
      continue;
    }
    const record2 = entry;
    const subjectId = String(
      record2.subject_id ?? record2.requirement_id ?? record2.constraint_id ?? record2.outcome_id ?? record2.criterion_id ?? record2.id ?? ""
    ).trim();
    if (!subjectId) {
      errors.push("a conclusion had no subject id");
      continue;
    }
    if (!allowedSubjects.includes(subjectId)) {
      rejectedSubjects.push(subjectId);
      continue;
    }
    if (seen.has(subjectId)) {
      errors.push(`${subjectId} was answered more than once`);
      continue;
    }
    const explanation = String(record2.explanation ?? "").trim().slice(0, 2e3);
    if (explanation.length < 12) {
      errors.push(`${subjectId} had no usable explanation`);
      continue;
    }
    const citations = filterCitations(record2.evidence_ids, evidence);
    for (const id of citations.rejected) rejectedEvidenceIds.add(id);
    let status = clampStatus(kind, record2.status);
    let downgraded = false;
    if (POSITIVE.has(status) && citations.accepted.length === 0) {
      status = kind === "claim" ? "partially_supported" : "partial_evidence";
      downgraded = true;
      errors.push(
        `${subjectId} claimed a positive status with no valid evidence id and was downgraded`
      );
    }
    const files = citations.accepted.map((id) => evidence.byId.get(id)?.file).filter((file) => Boolean(file));
    seen.add(subjectId);
    items.push({
      subject_id: subjectId,
      kind,
      status,
      confidence: clampConfidence(record2.confidence),
      evidence_ids: citations.accepted,
      explanation,
      missing_or_unclear: stringList(record2.missing_or_unclear),
      downgraded,
      files: [...new Set(files)].slice(0, 10)
    });
  }
  const missing = allowedSubjects.filter((id) => !seen.has(id));
  if (missing.length) {
    errors.push(`no conclusion was returned for: ${missing.join(", ")}`);
  }
  return {
    items,
    rejectedSubjects,
    rejectedEvidenceIds: [...rejectedEvidenceIds],
    errors: errors.slice(0, 12)
  };
}
var ALIGNMENT_STATUSES = [
  "strongly_aligned",
  "partially_aligned",
  "weakly_evidenced",
  "unclear"
];
function validateAlignment(payload, evidence) {
  const errors = [];
  const rejectedEvidenceIds = [];
  const record = payload ?? {};
  const raw = record.problem_alignment ?? record;
  const citations = filterCitations(raw.evidence_ids, evidence);
  rejectedEvidenceIds.push(...citations.rejected);
  const explanation = String(raw.explanation ?? "").trim().slice(0, 2e3);
  const approach = String(raw.approach ?? "").trim().slice(0, 1500);
  if (explanation.length < 12) errors.push("the alignment explanation was empty");
  if (approach.length < 8) errors.push("no approach was described");
  const declared = String(raw.status ?? "");
  let status = ALIGNMENT_STATUSES.includes(declared) ? declared : "unclear";
  let downgraded = false;
  if (status === "strongly_aligned" && citations.accepted.length === 0) {
    status = "unclear";
    downgraded = true;
    errors.push("strong alignment was claimed with no valid evidence id");
  }
  return {
    items: [
      {
        status,
        confidence: clampConfidence(raw.confidence),
        evidence_ids: citations.accepted,
        explanation,
        approach,
        approach_notes: stringList(raw.approach_notes),
        downgraded
      }
    ],
    rejectedSubjects: [],
    rejectedEvidenceIds,
    errors
  };
}
function validateAssessment(payload, evidence) {
  const errors = [];
  const record = payload ?? {};
  const raw = record.assessment ?? record;
  const citations = filterCitations(raw.evidence_ids, evidence);
  const text2 = (key) => String(raw[key] ?? "").trim().slice(0, 2e3);
  const headline = text2("headline");
  if (headline.length < 8) errors.push("no headline was produced");
  return {
    items: [
      {
        headline,
        understanding: text2("understanding"),
        problem_relevance: text2("problem_relevance"),
        solution_coherence: text2("solution_coherence"),
        implementation_evidence: text2("implementation_evidence"),
        functional_completeness: text2("functional_completeness"),
        technical_quality: text2("technical_quality"),
        claim_accuracy: text2("claim_accuracy"),
        hackathon_alignment: text2("hackathon_alignment"),
        engineering_concerns: stringList(raw.engineering_concerns),
        uncertainties: stringList(raw.uncertainties, 10),
        gaps: stringList(raw.gaps, 10),
        strengths: stringList(raw.strengths, 10),
        evidence_ids: citations.accepted,
        downgraded: citations.rejected.length > 0
      }
    ],
    rejectedSubjects: [],
    rejectedEvidenceIds: citations.rejected,
    errors
  };
}
function validateClaims(payload, evidence, expectedClaims) {
  const errors = [];
  const rejectedSubjects = [];
  const items = [];
  const list = Array.isArray(payload?.claims) ? payload.claims : [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry;
    const claim = String(record.claim ?? "").trim().slice(0, 300);
    if (!claim) continue;
    if (expectedClaims.length && !expectedClaims.some((item) => item === claim)) {
      rejectedSubjects.push(claim);
      continue;
    }
    const citations = filterCitations(record.evidence_ids, evidence);
    const explanation = String(record.explanation ?? "").trim().slice(0, 1500);
    if (explanation.length < 10) {
      errors.push(`claim "${claim.slice(0, 40)}" had no explanation`);
      continue;
    }
    let status = String(record.status ?? "");
    if (!CLAIM_STATUSES.includes(status)) {
      status = "not_evidenced";
    }
    let downgraded = false;
    if (status !== "not_evidenced" && citations.accepted.length === 0) {
      status = "partially_supported";
      downgraded = true;
      errors.push(`claim "${claim.slice(0, 40)}" asserted support with no citation`);
    }
    items.push({
      claim,
      status,
      confidence: clampConfidence(record.confidence),
      evidence_ids: citations.accepted,
      files: [...new Set(
        citations.accepted.map((id) => evidence.byId.get(id)?.file).filter((file) => Boolean(file))
      )].slice(0, 8),
      explanation,
      downgraded
    });
  }
  return { items, rejectedSubjects, rejectedEvidenceIds: [], errors: errors.slice(0, 10) };
}
function repairPrompt(task, errors) {
  return task + "\n\nYour previous reply could not be accepted:\n" + errors.slice(0, 8).map((error) => `- ${error}`).join("\n") + '\n\nReply again with a single JSON object that fixes exactly these problems. Use only evidence ids that appear in the evidence list you were given. If a conclusion genuinely has no supporting evidence, say so with status "not_evidenced" and cite nothing rather than inventing an id. No prose, no code fence.';
}
function asRawEvidence(items) {
  return items.map((item) => ({
    id: String(item.id),
    type: String(item.type ?? "file"),
    claim: String(item.claim ?? ""),
    file: item.file,
    symbol: item.symbol,
    lines: item.lines,
    confidence: String(item.confidence ?? "medium")
  }));
}

// _shared/planner.ts
var DIMENSION_LABEL = {
  problem_alignment: "Problem alignment",
  theme_alignment: "Theme alignment",
  solution_coherence: "Solution coherence",
  functional_implementation: "Functional implementation",
  feature_evidence: "Feature evidence",
  claim_verification: "Claim verification",
  technical_implementation: "Technical implementation",
  architecture: "Architecture",
  data_handling: "Data handling",
  ml_ai: "ML / AI implementation",
  api_implementation: "API implementation",
  database_usage: "Database usage",
  security: "Security",
  testing: "Testing",
  performance: "Performance",
  scalability: "Scalability",
  deployment: "Deployment",
  usability: "Usability",
  engineering_quality: "Engineering quality",
  evaluation_criteria: "Evaluation criteria",
  constraints: "Constraints",
  expected_outcome: "Expected outcome",
  project_properness: "Project properness"
};
function dimension(key, relevance, reason, method = "ai", expectationSource = "hackathon") {
  return {
    key,
    label: DIMENSION_LABEL[key],
    relevance,
    reason,
    method: relevance === "not_applicable" ? "skipped" : method,
    expectationSource: relevance === "not_applicable" ? "none" : expectationSource
  };
}
function planAnalysis(context, facts, groups, outcomeIds, constraintIds, criteriaIds, conceptQuestions) {
  const dimensions = [];
  const tasks = [];
  let order = 0;
  const next = () => order++;
  if (context.hasProblem) {
    dimensions.push(
      dimension(
        "problem_alignment",
        "required",
        "The hackathon states a problem, so the project is compared against it.",
        "ai",
        "hackathon"
      )
    );
    tasks.push({
      key: "alignment",
      kind: "alignment",
      scope: "problem alignment",
      question: conceptQuestions[0] ?? context.problem.slice(0, 400),
      reason: "Judging whether a solution addresses a problem is interpretation, not counting.",
      subjectIds: [],
      focus: null,
      order: next()
    });
  } else {
    dimensions.push(
      dimension(
        "problem_alignment",
        "not_applicable",
        "The hackathon states no problem; the team's own chosen problem is the reference point."
      )
    );
  }
  if (context.theme) {
    dimensions.push(
      dimension(
        "theme_alignment",
        "required",
        "The hackathon is theme-based, so the theme is the expected frame.",
        "ai",
        "hackathon"
      )
    );
  }
  const requirementsEnabled = context.hasRequirements;
  const requirementsReason = context.hasRequirements ? `The hackathon lists ${context.requirements.length} requirement(s).` : "The hackathon lists no requirements, so none are invented and none are checked. The project is assessed against its own stated problem instead.";
  if (requirementsEnabled) {
    for (const group of groups) {
      dimensions.push(
        dimension(
          dimensionForFocus(group.focus),
          "required",
          `The brief includes requirements about ${group.label}.`,
          "ai",
          "hackathon"
        )
      );
      tasks.push({
        key: `requirements:${group.focus}`,
        kind: "requirements",
        scope: group.label,
        question: group.questions.join(" ") || group.label,
        reason: "Each requirement needs the relevant implementation compared with the requirement text; no deterministic rule can decide that.",
        subjectIds: group.ids,
        focus: group.focus,
        order: next()
      });
    }
  } else {
    for (const key of [
      "functional_implementation",
      "feature_evidence",
      "data_handling",
      "ml_ai",
      "usability"
    ]) {
      dimensions.push(
        dimension(
          key,
          "not_applicable",
          "No requirements are configured, so this is not assessed as a requirement. It is still observed as a general engineering characteristic if the repository shows it.",
          "skipped",
          "none"
        )
      );
    }
  }
  if (context.hasConstraints || context.technologyRestrictions) {
    dimensions.push(
      dimension(
        "constraints",
        "required",
        context.technologyRestrictions ? "The hackathon states technology restrictions." : `The hackathon lists ${context.constraints.length} constraint(s).`,
        "ai",
        "hackathon"
      )
    );
    tasks.push({
      key: "constraints",
      kind: "constraints",
      scope: "constraints",
      question: buildConstraintQuestion(context),
      reason: "Whether a constraint is respected is a judgement over dependencies, configuration and external calls.",
      subjectIds: constraintIds,
      focus: null,
      order: next()
    });
  } else {
    dimensions.push(
      dimension(
        "constraints",
        "not_applicable",
        "The hackathon states no constraints, so none are checked."
      )
    );
  }
  if (context.hasOutcomes) {
    dimensions.push(
      dimension(
        "expected_outcome",
        "required",
        `The hackathon states ${context.expectedOutcomes.length} expected outcome(s).`,
        "ai",
        "hackathon"
      )
    );
    tasks.push({
      key: "outcomes",
      kind: "outcomes",
      scope: "expected outcome",
      question: outcomeIds.map((id) => outcomeText(context, id)).join(" ").slice(0, 800),
      reason: "Whether the delivered result matches the expected outcome requires reading the implementation against the stated outcome.",
      subjectIds: outcomeIds,
      focus: null,
      order: next()
    });
  } else {
    dimensions.push(
      dimension(
        "expected_outcome",
        "not_applicable",
        "The hackathon states no expected outcome."
      )
    );
  }
  if (context.hasCriteria) {
    dimensions.push(
      dimension(
        "evaluation_criteria",
        "required",
        `The hackathon defines ${context.evaluationCriteria.length} evaluation criteria.`,
        "ai",
        "hackathon"
      )
    );
    tasks.push({
      key: "criteria",
      kind: "criteria",
      scope: "evaluation criteria",
      question: context.evaluationCriteria.slice(0, 8).map((criterion) => criterion.text).join(" ").slice(0, 800),
      reason: "Each criterion is described descriptively against evidence; no score is computed and no team is compared to another.",
      subjectIds: criteriaIds,
      focus: null,
      order: next()
    });
  } else {
    dimensions.push(
      dimension(
        "evaluation_criteria",
        "not_applicable",
        "The hackathon defines no evaluation criteria, so none are applied."
      )
    );
  }
  const hasClaims = Boolean(
    context.claims.description || context.claims.features
  );
  if (hasClaims) {
    dimensions.push(
      dimension(
        "claim_verification",
        "required",
        "The team describes what it built, so each claim is checked against evidence.",
        "ai",
        "claim"
      )
    );
    tasks.push({
      key: "claims",
      kind: "claims",
      scope: "claimed features",
      question: [
        context.claims.description,
        context.claims.features,
        context.claims.techStack
      ].join(" ").slice(0, 900),
      reason: "A claim is only supported when the implementation behind it is visible; that is a comparison, not a lookup.",
      subjectIds: [],
      focus: null,
      order: next()
    });
  } else {
    dimensions.push(
      dimension(
        "claim_verification",
        "not_applicable",
        "The submission contains no description or feature list to verify."
      )
    );
  }
  const hasSource = facts.sourceFileCount > 0;
  if (hasSource) {
    dimensions.push(
      dimension(
        "solution_coherence",
        "required",
        "The repository contains source code, so the chain from problem to output can be traced.",
        "ai",
        "general"
      )
    );
    tasks.push({
      key: "implementation",
      kind: "implementation",
      scope: "implementation and solution coherence",
      question: buildImplementationQuestion(context, facts),
      reason: "Coherence between problem, implementation and output is interpretation over the whole call graph the scanner found.",
      subjectIds: [],
      focus: null,
      order: next()
    });
    dimensions.push(
      dimension(
        "technical_implementation",
        "required",
        "Source files are present and carry functions, classes and logic.",
        "ai",
        "general"
      )
    );
    dimensions.push(
      dimension(
        "architecture",
        "required",
        "Source files are present; structure is described as observed, not judged against a template.",
        "ai",
        "general"
      )
    );
  } else {
    for (const key of ["solution_coherence", "technical_implementation", "architecture"]) {
      dimensions.push(
        dimension(
          key,
          "not_applicable",
          "No readable source file was found in the repository, so implementation cannot be described."
        )
      );
    }
  }
  const engineering = planEngineering(facts, context);
  dimensions.push(...engineering.dimensions);
  if (engineering.dimensions.some((item) => item.relevance !== "not_applicable")) {
    tasks.push({
      key: "engineering",
      kind: "engineering",
      scope: "engineering observations",
      question: engineering.question,
      reason: "Observations about security, tests, data handling and deployment are only useful when the repository actually contains those things.",
      subjectIds: [],
      focus: null,
      order: next()
    });
  }
  dimensions.push(
    dimension(
      "project_properness",
      "required",
      "The product's purpose is a contextual judgement on whether this is a legitimate, coherent implementation for this problem.",
      "ai",
      "general"
    )
  );
  tasks.push({
    key: "properness",
    kind: "properness",
    scope: "project properness",
    // Deliberately the cheapest question in the plan: this call reads the
    // conclusions the other calls already produced, not the code again.
    question: "is the project coherent, implemented and consistent with its own claims",
    reason: "The final assessment is a judgement over everything the earlier calls established, and is made once.",
    subjectIds: [],
    focus: null,
    order: next()
  });
  return {
    dimensions,
    tasks: tasks.sort((a, b) => a.order - b.order).map((task, index) => ({ ...task, order: index })),
    requirementsEnabled,
    requirementsReason,
    summary: summarise(context, facts, requirementsEnabled, tasks)
  };
}
function planEngineering(facts, context) {
  const dimensions = [];
  const terms = [];
  const briefText = [
    context.problem,
    context.claims.description,
    context.claims.features,
    ...context.constraints.map((item) => item.text),
    ...context.evaluationCriteria.map((item) => item.text),
    context.customInstructions ?? ""
  ].join(" ");
  const asks = (...needles) => needles.some((needle) => briefText.toLowerCase().includes(needle));
  if (asks("security", "secure", "privacy", "gdpr", "encrypt", "auth")) {
    dimensions.push(
      dimension("security", "required", "The brief asks about security or privacy.", "ai", "hackathon")
    );
    terms.push("authentication authorization security secret credential encryption");
  } else if (facts.secretCount > 0 || facts.authDetected) {
    dimensions.push(
      dimension(
        "security",
        "relevant",
        "The repository contains authentication or credential material, so a security observation is useful even though the brief did not ask for one.",
        "ai",
        "repository"
      )
    );
    terms.push("authentication authorization security secret credential");
  } else {
    dimensions.push(
      dimension(
        "security",
        "not_applicable",
        "The brief does not ask about security and the repository has no credentials or authentication to comment on."
      )
    );
  }
  if (asks("test", "testing", "tested", "coverage", "unit test")) {
    dimensions.push(
      dimension("testing", "required", "The brief asks about testing.", "ai", "hackathon")
    );
    terms.push("test tests testing spec fixture mock assert coverage");
  } else if (facts.testFileCount > 0) {
    dimensions.push(
      dimension(
        "testing",
        "relevant",
        `The repository contains ${facts.testFileCount} test file(s) worth describing.`,
        "deterministic",
        "repository"
      )
    );
  } else {
    dimensions.push(
      dimension(
        "testing",
        "not_applicable",
        "The brief does not ask about testing and the repository has no tests. Absence of tests is not a finding here \u2014 it is recorded as a general observation only.",
        "deterministic",
        "none"
      )
    );
  }
  if (asks("data", "dataset", "ingest", "history", "upload", "csv", "database")) {
    dimensions.push(
      dimension("data_handling", "required", "The brief asks about data.", "ai", "hackathon")
    );
    terms.push("data dataset csv json ingest read load schema");
  } else if (facts.datasetCount > 0 || facts.dataAccessCount > 0) {
    dimensions.push(
      dimension(
        "data_handling",
        "relevant",
        `The repository ships ${facts.datasetCount} dataset file(s) and performs ${facts.dataAccessCount} data access operation(s).`,
        "ai",
        "repository"
      )
    );
    terms.push("data dataset csv json read load schema query");
  } else {
    dimensions.push(
      dimension(
        "data_handling",
        "not_applicable",
        "The brief does not ask about data and the repository contains no datasets or data access operations."
      )
    );
  }
  if (facts.databaseDetected) {
    dimensions.push(
      dimension(
        "database_usage",
        "relevant",
        "The repository contains a database or schema, so its use can be described.",
        "ai",
        "repository"
      )
    );
    terms.push("database schema table query sql migration model repository");
  } else {
    dimensions.push(
      dimension(
        "database_usage",
        "not_applicable",
        "The repository has no database, and the brief did not require one. A project that needs no database is not penalised for it."
      )
    );
  }
  if (facts.routeCount > 0) {
    dimensions.push(
      dimension(
        "api_implementation",
        "relevant",
        `The repository exposes ${facts.routeCount} route(s); what sits behind them is described, but a route's existence alone is not treated as a feature.`,
        "ai",
        "repository"
      )
    );
    terms.push("route endpoint api handler request response");
  } else {
    dimensions.push(
      dimension(
        "api_implementation",
        "not_applicable",
        "The repository exposes no routes and the brief did not require an API."
      )
    );
  }
  if (facts.modelFindingCount > 0) {
    dimensions.push(
      dimension(
        "ml_ai",
        "relevant",
        `The code performs ${facts.modelFindingCount} model or statistical operation(s). What they compute is described from the code, not from the imports.`,
        "ai",
        "repository"
      )
    );
    terms.push("model predict fit train inference forecast statistics");
  } else {
    dimensions.push(
      dimension(
        "ml_ai",
        "not_applicable",
        "The code contains no model training, inference or statistical computation, and the brief did not ask for one. Hand-written rules are a valid answer."
      )
    );
  }
  if (facts.deploymentFileCount > 0) {
    dimensions.push(
      dimension(
        "deployment",
        "relevant",
        "The repository contains deployment configuration.",
        "ai",
        "repository"
      )
    );
    terms.push("docker deploy workflow pipeline hosting build");
  } else {
    dimensions.push(
      dimension(
        "deployment",
        "not_applicable",
        "The repository has no deployment configuration and the brief did not ask for a deployed service."
      )
    );
  }
  if (facts.uiFindingCount > 0) {
    dimensions.push(
      dimension(
        "usability",
        "relevant",
        `The repository contains interface code (${facts.uiFindingCount} interaction or display site(s)).`,
        "ai",
        "repository"
      )
    );
    terms.push("dashboard screen form table button chart display workflow");
  } else {
    dimensions.push(
      dimension(
        "usability",
        "not_applicable",
        "The repository contains no interface code, and the brief did not ask for one."
      )
    );
  }
  dimensions.push(
    dimension(
      "engineering_quality",
      "relevant",
      "Source code exists, so general engineering observations can be made.",
      "ai",
      "general"
    )
  );
  return { dimensions, question: terms.join(" ") || "implementation quality" };
}
function dimensionForFocus(focus) {
  switch (focus) {
    case "data":
      return "data_handling";
    case "analytics":
      return "ml_ai";
    case "decision":
      return "functional_implementation";
    case "trust":
      return "engineering_quality";
    case "interface":
      return "usability";
    case "platform":
      return "api_implementation";
    default:
      return "functional_implementation";
  }
}
function outcomeText(context, id) {
  return context.expectedOutcomes.find((outcome) => outcome.id === id)?.text ?? "";
}
function buildConstraintQuestion(context) {
  const parts = [
    ...context.constraints.map((constraint) => constraint.text),
    context.technologyRestrictions ?? ""
  ].filter(Boolean);
  const concepts = [];
  const lower = parts.join(" ").toLowerCase();
  const probes = {
    paid: ["api", "service", "key", "token", "endpoint", "subscription"],
    data: ["patient", "personal", "data", "privacy", "consent", "pii", "storage"],
    manual: ["form", "input", "manual", "entry", "upload", "csv"],
    hardware: ["sensor", "device", "gpio", "serial", "camera", "arduino", "esp"],
    offline: ["offline", "cache", "local", "service_worker", "indexeddb", "sync"],
    open: ["open", "source", "license", "repository", "public"],
    stack: ["framework", "language", "runtime", "library", "stack"]
  };
  for (const [needle, terms] of Object.entries(probes)) {
    if (lower.includes(needle)) concepts.push(...terms);
  }
  return `${parts.join(" ").slice(0, 600)} ${concepts.join(" ")}`.trim();
}
function buildImplementationQuestion(context, facts) {
  const problem = context.problem.split(/[.\n]/)[0]?.slice(0, 300) ?? "";
  const claim = context.claims.description.split(/[.\n]/)[0]?.slice(0, 300) ?? "";
  return [
    problem,
    claim,
    context.claims.features.split("\n").slice(0, 4).join(" "),
    facts.stackSummary
  ].filter(Boolean).join(" ").slice(0, 900);
}
function summarise(context, facts, requirementsEnabled, tasks) {
  const parts = [
    `${context.name} (${context.type.replace(/_/g, " ")})`,
    requirementsEnabled ? `${context.requirements.length} requirements` : "no requirements configured",
    `${facts.sourceFileCount} source file(s), ${facts.routeCount} route(s), ${facts.datasetCount} dataset(s)`,
    `${tasks.length} reasoning call(s) planned`
  ];
  return parts.join(" \xB7 ");
}
function questionsForGroup(concepts, limit = 6) {
  return concepts.flatMap((concept) => [
    ...concept.phrases.slice(0, 4),
    ...concept.actions.slice(0, 3),
    ...concept.subjects.slice(0, 3)
  ]).filter((term) => term.length > 2).slice(0, limit * 3);
}

// _shared/retrieval.ts
var IMPORTANCE_SCORE = {
  high: 24,
  medium: 12,
  low: 4,
  ignored: 0
};
var MAX_TOKENS_PER_FILE = 400;
var STOP = /* @__PURE__ */ new Set([
  "def",
  "class",
  "return",
  "const",
  "let",
  "var",
  "function",
  "import",
  "from",
  "the",
  "and",
  "for",
  "this",
  "self",
  "true",
  "false",
  "null",
  "none"
]);
function tokenize(text2, limit = MAX_TOKENS_PER_FILE) {
  const out = /* @__PURE__ */ new Set();
  const raw = String(text2 ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./\\]+/g, " ").toLowerCase();
  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token.length < 3 || token.length > 32) continue;
    if (STOP.has(token)) continue;
    out.add(token);
    if (out.size >= limit) break;
  }
  return out;
}
function buildRepoIndex(input) {
  const files = /* @__PURE__ */ new Map();
  const termsByPath = /* @__PURE__ */ new Map();
  const symbolsByPath = /* @__PURE__ */ new Map();
  const chunksByPath = /* @__PURE__ */ new Map();
  const evidenceByPath = /* @__PURE__ */ new Map();
  const bodyTermsByPath = /* @__PURE__ */ new Map();
  const datasetByPath = /* @__PURE__ */ new Map();
  const routesByPath = /* @__PURE__ */ new Map();
  const semanticsByPath = /* @__PURE__ */ new Map();
  const globalEvidence = [];
  const manifestPaths = /* @__PURE__ */ new Set();
  for (const file of input.files) {
    if (!file?.path) continue;
    files.set(file.path, file);
    const terms = tokenize(file.path);
    termsByPath.set(file.path, terms);
    if (/(package\.json|requirements\.txt|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle|composer\.json|pubspec\.yaml)$/i.test(file.path)) {
      manifestPaths.add(file.path);
    }
  }
  for (const chunk of input.chunks) {
    const path = chunk.file_path ?? chunk.path;
    if (!path) continue;
    const list = chunksByPath.get(path) ?? [];
    list.push(chunk);
    chunksByPath.set(path, list);
    const symbol = String(chunk.symbol_name ?? "");
    if (symbol) {
      const symbols = symbolsByPath.get(path) ?? [];
      symbols.push(symbol);
      symbolsByPath.set(path, symbols);
      for (const token of tokenize(symbol, 20)) {
        termsByPath.get(path)?.add(token);
      }
    }
    const body = bodyTermsByPath.get(path) ?? /* @__PURE__ */ new Set();
    for (const token of tokenize(String(chunk.content ?? ""))) body.add(token);
    bodyTermsByPath.set(path, body);
  }
  for (const evidence of input.evidence ?? []) {
    if (!evidence?.id) continue;
    if (evidence.file) {
      const list = evidenceByPath.get(evidence.file) ?? [];
      list.push(evidence);
      evidenceByPath.set(evidence.file, list);
      for (const token of tokenize(`${evidence.claim} ${evidence.symbol ?? ""}`, 30)) {
        termsByPath.get(evidence.file)?.add(token);
      }
    } else {
      globalEvidence.push(evidence);
    }
  }
  for (const route of input.routes ?? []) {
    if (!route?.file) continue;
    const list = routesByPath.get(route.file) ?? [];
    list.push(route);
    routesByPath.set(route.file, list);
    for (const token of tokenize(route.path, 20)) {
      termsByPath.get(route.file)?.add(token);
    }
  }
  for (const profile of input.datasetProfiles ?? []) {
    if (!profile?.path) continue;
    datasetByPath.set(profile.path, profile);
    const terms = termsByPath.get(profile.path) ?? /* @__PURE__ */ new Set();
    for (const name of profile.column_names) {
      for (const token of tokenize(name, 20)) terms.add(token);
    }
    termsByPath.set(profile.path, terms);
  }
  for (const semantics of input.semantics ?? []) {
    if (!semantics?.path) continue;
    semanticsByPath.set(semantics.path, semantics);
  }
  return {
    files,
    termsByPath,
    bodyTermsByPath,
    symbolsByPath,
    chunksByPath,
    evidenceByPath,
    globalEvidence,
    datasetByPath,
    routesByPath,
    semanticsByPath,
    manifestPaths
  };
}
var GENERIC_TERMS = /* @__PURE__ */ new Set([
  "system",
  "application",
  "project",
  "solution",
  "user",
  "users",
  "data",
  "value",
  "values",
  "item",
  "items",
  "result",
  "results",
  "name",
  "names",
  "id",
  "ids",
  "service",
  "code",
  "file",
  "files",
  "page",
  "pages",
  "app",
  "use",
  "using",
  "provide",
  "support",
  "build",
  "make",
  "create",
  "add",
  "must",
  "should",
  "shall",
  "able",
  "ensure",
  "allow",
  "allow",
  "need",
  "require",
  "functionality",
  "feature",
  "features",
  "capability"
]);
function buildRetrievalPlan(subjectId, concept) {
  const ranked = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (term, weight) => {
    const key = term.toLowerCase().trim();
    if (key.length < 3 || GENERIC_TERMS.has(key) || seen.has(key)) return;
    seen.add(key);
    ranked.push({ term: key, weight });
  };
  for (const term of concept.domainTerms) push(term, 10);
  for (const term of concept.actions) push(term, 9);
  for (const term of concept.subjects) push(term, 8);
  for (const term of concept.terms) push(term, 4);
  for (const phrase of concept.phrases) {
    for (const part of phrase.split(" ")) push(part, 5);
  }
  const phrases = concept.phrases.filter((phrase) => phrase.includes(" "));
  const questions = [
    concept.intent.slice(0, 300),
    [...phrases, ...concept.actions, ...concept.subjects].join(" ").slice(0, 300)
  ].filter(Boolean);
  return {
    subjectId,
    focus: concept.focus,
    // Thirty terms is the useful ceiling. A longer list does not add recall, it
    // dilutes the weights so that every file looks equally relevant to every
    // requirement.
    terms: ranked.sort((a, b) => b.weight - a.weight).map((item) => item.term).slice(0, 30),
    phrases,
    artifacts: concept.artifacts,
    questions
  };
}
function retrieve(input) {
  const { plan, index } = input;
  const maxFiles = input.maxFiles ?? 6;
  const maxLines = input.maxSnippetLines ?? 120;
  const maxEvidence = input.maxEvidenceIds ?? 24;
  const hits = [];
  const datasetScores = /* @__PURE__ */ new Map();
  const matchedAnywhere = /* @__PURE__ */ new Set();
  let considered = 0;
  for (const [path, file] of index.files) {
    if (file.is_ignored || file.is_binary) continue;
    considered += 1;
    const pathTerms = index.termsByPath.get(path) ?? /* @__PURE__ */ new Set();
    const bodyTerms = index.bodyTermsByPath.get(path) ?? /* @__PURE__ */ new Set();
    const symbols = index.symbolsByPath.get(path) ?? [];
    const routes = index.routesByPath.get(path) ?? [];
    const dataset = index.datasetByPath.get(path);
    const semantics = index.semanticsByPath.get(path);
    const components = {
      semantic: 0,
      keyword: 0,
      importance: 0,
      symbol: 0,
      route: 0,
      dataset: 0,
      dependency: 0,
      logic: 0,
      artifact: artifactAffinity(plan.artifacts, file)
    };
    const matched = [];
    plan.terms.forEach((term, index_) => {
      const weight = Math.max(1, 10 - Math.floor(index_ / 4));
      if (pathTerms.has(term) || symbols.some((symbol) => symbol.toLowerCase().includes(term))) {
        components.symbol += weight;
        components.semantic += weight;
        matched.push(term);
        matchedAnywhere.add(term);
      }
      if (bodyTerms.has(term)) {
        components.semantic += weight;
        matchedAnywhere.add(term);
      }
    });
    components.semantic = Math.min(40, components.semantic);
    for (const phrase of plan.phrases) {
      const needle = phrase.toLowerCase();
      const inPath = path.toLowerCase().includes(needle);
      const inSymbol = symbols.some((symbol) => symbol.toLowerCase().includes(needle));
      if (inPath || inSymbol) {
        components.keyword += 10;
        matched.push(phrase);
        matchedAnywhere.add(phrase);
      }
    }
    components.keyword = Math.min(30, components.keyword);
    components.importance = IMPORTANCE_SCORE[String(file.importance ?? "low")] ?? 4;
    for (const route of routes) {
      const routeText = `${route.path} ${route.symbol ?? ""}`.toLowerCase();
      if (plan.terms.some((term) => routeText.includes(term))) {
        components.route += 10;
        matchedAnywhere.add(route.path);
      }
    }
    if (dataset) {
      if (dataset.relevance === "high") components.dataset += 14;
      else if (dataset.relevance === "medium") components.dataset += 7;
      const entityHit = [...dataset.entity_columns, ...dataset.identifier_columns].some(
        (column) => plan.terms.some((term) => column.toLowerCase().includes(term))
      );
      if (entityHit) components.dataset += 10;
      if (plan.terms.some(
        (term) => [
          "date",
          "time",
          "history",
          "historical",
          "trend",
          "future",
          "window",
          "horizon",
          "daily",
          "weekly",
          "monthly",
          "forecast",
          "demand",
          "season",
          "overdue",
          "upcoming"
        ].includes(term)
      ) && dataset.date_columns.length) {
        components.dataset += 8;
      }
      if (plan.terms.some(
        (term) => [
          "quantity",
          "qty",
          "amount",
          "stock",
          "level",
          "sales",
          "revenue",
          "price",
          "count",
          "volume",
          "units",
          "balance",
          "available"
        ].includes(term)
      ) && (dataset.quantity_columns.length || dataset.stock_columns.length || dataset.price_columns.length)) {
        components.dataset += 8;
      }
    }
    if (index.manifestPaths.has(path)) {
      const fileTokens = pathTerms;
      if (plan.terms.some((term) => fileTokens.has(term))) components.dependency += 6;
    }
    if (semantics) {
      const groups = [
        semantics.calculations,
        semantics.rules,
        semantics.models,
        semantics.dataAccess
      ];
      for (const group of groups) {
        const hit = group.find(
          (item) => item.identifiers.some(
            (identifier) => plan.terms.some((term) => identifier.toLowerCase().includes(term))
          )
        );
        if (hit) {
          components.logic += 12;
          matched.push(...hit.identifiers.slice(0, 2));
          matchedAnywhere.add(hit.operation);
        }
      }
      if (plan.artifacts.includes("ui") && semantics.ui.length > 0) {
        const hit = semantics.ui.find(
          (item) => item.identifiers.some(
            (identifier) => plan.terms.some((term) => identifier.toLowerCase().includes(term))
          )
        );
        if (hit) components.logic += 6;
      }
    }
    const score = components.semantic + components.keyword + components.importance + components.symbol + components.route + components.dataset + components.dependency + components.logic + components.artifact;
    if (score <= 4) continue;
    if (dataset) datasetScores.set(path, components.dataset + components.semantic);
    const chunk = pickChunk(index, path, plan, maxLines);
    hits.push({
      path,
      score,
      components,
      matchedTerms: [...new Set(matched)].slice(0, 8),
      symbol: chunk?.symbol_name ?? null,
      startLine: Number(chunk?.start_line ?? 1),
      endLine: Number(chunk?.end_line ?? Math.max(1, Number(chunk?.end_line ?? 1))),
      excerpt: chunk ? renderChunk(chunk, maxLines) : ""
    });
  }
  hits.sort((a, b) => b.score - a.score);
  const seenNames = /* @__PURE__ */ new Set();
  const deduped = hits.filter((hit) => {
    const name = hit.path.slice(hit.path.lastIndexOf("/") + 1).toLowerCase();
    if (seenNames.has(name)) return false;
    seenNames.add(name);
    return true;
  });
  const selected = deduped.slice(0, maxFiles);
  const selectedPaths = new Set(selected.map((hit) => hit.path));
  const datasetPaths = [...datasetScores.entries()].filter(([path, score]) => score > 0 && !selectedPaths.has(path)).sort((a, b) => b[1] - a[1]).map(([path]) => path);
  const seenDatasetNames = new Set(
    [...selectedPaths].filter((path) => index.datasetByPath.has(path)).map((path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase())
  );
  const topDatasets = datasetPaths.filter((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    if (seenDatasetNames.has(name)) return false;
    seenDatasetNames.add(name);
    return true;
  }).slice(0, 2);
  const evidenceIds = [];
  for (const path of [...selectedPaths, ...datasetPaths]) {
    for (const evidence of index.evidenceByPath.get(path) ?? []) {
      if (!evidenceIds.includes(evidence.id)) evidenceIds.push(evidence.id);
    }
  }
  for (const evidence of index.globalEvidence) {
    if (evidenceIds.length >= maxEvidence) break;
    if (!evidenceIds.includes(evidence.id)) evidenceIds.push(evidence.id);
  }
  return {
    plan,
    files: selected,
    evidenceIds: evidenceIds.slice(0, maxEvidence),
    datasetPaths: [
      ...[...selectedPaths].filter((path) => index.datasetByPath.has(path)),
      ...topDatasets
    ].slice(0, 3),
    considered,
    truncated: deduped.length > selected.length,
    unmatchedTerms: plan.terms.filter((term) => !matchedAnywhere.has(term)).slice(0, 12)
  };
}
function artifactAffinity(artifacts, file) {
  if (!artifacts.length) return 0;
  const path = String(file.path ?? "").toLowerCase();
  const extension = path.slice(path.lastIndexOf("."));
  const category = String(file.file_category ?? "");
  const wants = (name) => artifacts.includes(name);
  let score = 0;
  if (wants("ui") && (category === "component" || [".html", ".css", ".scss", ".vue", ".svelte", ".jsx", ".tsx"].includes(extension))) {
    score += 14;
  }
  if (wants("route") && (category === "api" || /route|controller|endpoint|view\//.test(path))) {
    score += 10;
  }
  if (wants("calculation") && ["source", "api", "model"].includes(category) && [".py", ".js", ".ts", ".go", ".rb", ".java", ".php", ".cs"].includes(extension)) {
    score += 8;
  }
  if (wants("model") && /(model|ml|train|predict)/.test(path)) score += 10;
  if (wants("ingestion") && (/(data|load|ingest|etl|import|seed)/.test(path) || category === "dataset")) {
    score += 10;
  }
  if (wants("schema") && (category === "schema" || category === "database")) score += 8;
  if (wants("query") && [".sql", ".prisma", ".graphql"].includes(extension)) score += 8;
  if (wants("test") && (category === "test" || /test|spec/.test(path))) score += 8;
  if (wants("configuration") && category === "config") score += 4;
  if (wants("readme") && category === "documentation") score += 6;
  if (wants("data_loading") && /(read|load|ingest|etl|data)/.test(path)) score += 6;
  if (wants("file_read") && category === "dataset") score += 6;
  return Math.min(20, score);
}
function pickChunk(index, path, plan, _maxLines) {
  const chunks = index.chunksByPath.get(path) ?? [];
  if (!chunks.length) return null;
  const scored = chunks.map((chunk) => {
    const symbol = String(chunk.symbol_name ?? "").toLowerCase();
    const content = String(chunk.content ?? "").toLowerCase();
    const termHits = plan.terms.filter(
      (term) => symbol.includes(term) || content.includes(term)
    ).length;
    const highImportance = chunk.importance === "high" ? 1 : 0;
    return { chunk, score: termHits * 3 + highImportance };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.chunk ?? null;
}
function renderChunk(chunk, maxLines) {
  const lines = String(chunk.content ?? "").split("\n");
  const shown = lines.slice(0, maxLines);
  let body = shown.join("\n");
  if (shown.length < lines.length) body += "\n\u2026 (truncated)";
  return body;
}
function renderPacket(result) {
  if (!result.files.length) return "";
  return result.files.map((hit) => {
    const header = `--- ${hit.path}` + (hit.symbol ? ` [${hit.symbol}]` : "") + ` lines ${hit.startLine}-${hit.endLine}` + (hit.matchedTerms.length ? ` (matches: ${hit.matchedTerms.slice(0, 4).join(", ")})` : "") + " ---";
    if (!hit.excerpt) {
      return `${header}
(no chunk was extracted for this file; the file's identifiers and evidence are listed instead)`;
    }
    return `${header}
${hit.excerpt}`;
  }).join("\n\n");
}

// _shared/deterministic.ts
var NO_VERDICT = {
  status: null,
  explanation: "",
  evidenceIds: [],
  method: null
};
function countablesFrom(input) {
  const map = input.projectMap;
  const frontend = map.frontend ?? {};
  const stats = map.repository_stats ?? {};
  const stack = map.stack ?? {};
  const languages = stack.languages ?? {};
  const deps = stack.dependencies_by_category ?? {};
  const depCount = Object.values(deps).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0
  );
  const facts = {
    endpoint: { label: "HTTP endpoint", count: input.routeCount, source: "routes" },
    route: { label: "HTTP endpoint", count: input.routeCount, source: "routes" },
    api: { label: "HTTP endpoint", count: input.routeCount, source: "routes" },
    page: {
      label: "page or screen",
      count: (frontend.pages ?? []).length,
      source: "frontend"
    },
    screen: {
      label: "page or screen",
      count: (frontend.pages ?? []).length,
      source: "frontend"
    },
    test: { label: "test file", count: input.testFileCount, source: "testing" },
    dataset: { label: "dataset", count: input.datasetCount, source: "data" },
    function: { label: "function or method", count: input.functionCount, source: "symbols" },
    class: { label: "class", count: input.classCount, source: "symbols" },
    model: { label: "model or statistical operation", count: input.modelCount, source: "logic" },
    calculation: { label: "calculation", count: input.calculationCount, source: "logic" },
    file: { label: "source file", count: input.fileCount, source: "inventory" },
    language: { label: "language", count: Object.keys(languages).length, source: "stack" },
    dependenc: {
      label: "dependency",
      count: depCount,
      source: "manifests"
    },
    line: { label: "line of code", count: Number(stats.line_count ?? 0), source: "stats" }
  };
  return facts;
}
var COUNT_WORDS = [
  [/\bendpoints?\b/i, "endpoint"],
  [/\broutes?\b/i, "route"],
  [/\bapis?\b/i, "api"],
  [/\bpages?\b/i, "page"],
  [/\bscreens?\b/i, "screen"],
  [/\btests?\b/i, "test"],
  [/\bdatasets?\b/i, "dataset"],
  [/\bdata ?files?\b/i, "dataset"],
  [/\bfunctions?\b/i, "function"],
  [/\bclasses?\b/i, "class"],
  [/\bmodels?\b/i, "model"],
  [/\bcalculations?\b/i, "calculation"],
  [/\b(languages|programming languages)\b/i, "language"],
  [/\b(dependencies|packages|libraries)\b/i, "dependenc"]
];
function deterministicCount(text2, facts) {
  if (!/\b(?:at least|minimum|atleast|minimum of|no fewer than|>=|or more)\b/i.test(text2)) {
    return NO_VERDICT;
  }
  const minimum = text2.match(/\b(\d{1,4})\b/);
  if (!minimum) return NO_VERDICT;
  const required = Number(minimum[1]);
  if (!Number.isFinite(required) || required <= 0) return NO_VERDICT;
  for (const [pattern, key] of COUNT_WORDS) {
    if (!pattern.test(text2)) continue;
    const fact = facts[key];
    if (!fact) continue;
    if (fact.count >= required) {
      return {
        status: "evidence_found",
        explanation: `The scan found ${fact.count} ${fact.label}${fact.count === 1 ? "" : "s"} in the repository; this requirement asks for at least ${required}.`,
        evidenceIds: [],
        method: "deterministic_count"
      };
    }
    return {
      status: "not_evidenced",
      explanation: `The scan found ${fact.count} ${fact.label}${fact.count === 1 ? "" : "s"}; this requirement asks for at least ${required}. This is a count of what the scan read, not a judgement about the approach.`,
      evidenceIds: [],
      method: "deterministic_count"
    };
  }
  return NO_VERDICT;
}
function literalsIn(text2) {
  const out = /* @__PURE__ */ new Set();
  for (const match of text2.matchAll(/`([^`]{3,80})`/g)) out.add(match[1].trim());
  for (const match of text2.matchAll(/"([^"]{3,80})"/g)) out.add(match[1].trim());
  for (const match of text2.matchAll(/'([^']{3,80})'/g)) out.add(match[1].trim());
  for (const match of text2.matchAll(/\b[\w.-]+\/[\w./-]*\.[A-Za-z0-9]{1,6}\b/g)) {
    out.add(match[0]);
  }
  for (const match of text2.matchAll(/\/(?:[A-Za-z0-9_{}<>-]+)(?:\/[A-Za-z0-9_{}<>-]+)+\b/g)) {
    out.add(match[0]);
  }
  return [...out].map((value) => value.trim()).filter((value) => value.length > 2);
}
function deterministicLiteral(text2, index, evidence) {
  if (/\b(?:must not|should not|do not|never|no|without|avoid|exclude)\b/i.test(text2)) {
    return NO_VERDICT;
  }
  const literals = literalsIn(text2);
  if (!literals.length) return NO_VERDICT;
  for (const literal of literals) {
    const needle = literal.toLowerCase();
    for (const [path] of index.files) {
      if (!path.toLowerCase().includes(needle)) continue;
      const evidenceIds = (evidence.byFile.get(path) ?? []).map((item) => item.id).slice(0, 4);
      return {
        status: "evidence_found",
        explanation: `The requirement names \`${literal}\`, and the repository contains that file. The file is present; whether it implements the requirement is judged separately.`,
        evidenceIds,
        method: "deterministic_literal"
      };
    }
    for (const [path, symbols] of index.symbolsByPath) {
      for (const symbol of symbols) {
        if (!symbol.toLowerCase().includes(needle)) continue;
        const evidenceIds = (evidence.byFile.get(path) ?? []).map((item) => item.id).slice(0, 4);
        return {
          status: "evidence_found",
          explanation: `The requirement names \`${literal}\`, and \`${symbol}\` is defined in \`${path}\`. The symbol exists; what it does is judged separately.`,
          evidenceIds,
          method: "deterministic_literal"
        };
      }
    }
    for (const [path, routes] of index.routesByPath) {
      for (const route of routes) {
        if (!String(route.path ?? "").toLowerCase().includes(needle)) continue;
        const evidenceIds = (evidence.byFile.get(path) ?? []).map((item) => item.id).slice(0, 4);
        return {
          status: "partial_evidence",
          explanation: `The requirement names \`${literal}\`, and \`${route.path}\` exists in \`${path}\`. The route is present; what its implementation does is judged separately, because a route alone does not prove the behaviour.`,
          evidenceIds,
          method: "deterministic_literal"
        };
      }
    }
  }
  return NO_VERDICT;
}
function inspectionCovers(inspection) {
  const problems = [];
  if (inspection.mode === "limited") problems.push("the repository was too large to read fully");
  if (inspection.filesRead < inspection.filesSeen) {
    problems.push(
      `${inspection.filesSeen - inspection.filesRead} of ${inspection.filesSeen} files were not read`
    );
  }
  for (const warning of inspection.warnings) {
    if (/rate limit|could not read|truncated/i.test(warning)) problems.push(warning);
  }
  if (!problems.length) return { covered: true, note: "" };
  return {
    covered: false,
    note: "This repository was not fully inspected (" + problems.slice(0, 3).join("; ") + "), so absence of evidence here is not evidence of absence."
  };
}

// _shared/diff.ts
function citedEvidence(conclusions, known) {
  const cited = /* @__PURE__ */ new Set();
  for (const row of conclusions) {
    for (const id of row.evidence_ids ?? []) cited.add(id);
  }
  const out = [];
  for (const item of known) {
    if (cited.has(item.id)) {
      out.push({ id: item.id, claim: item.claim, file: item.file ?? null });
    }
  }
  return out;
}
function diffRuns(previous, current) {
  if (!previous) return null;
  const before = new Map(
    (previous.conclusions ?? []).map((row) => [row.subject_id, row])
  );
  const after = new Map(
    current.conclusions.map((row) => [row.subject_id, row])
  );
  const changed = [];
  const added = [];
  for (const [id, row] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push(id);
      continue;
    }
    if (prior.status !== row.status) {
      changed.push({
        id,
        kind: row.kind ?? prior.kind ?? "requirement",
        from: prior.status,
        to: row.status
      });
    }
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const beforeEvidence = new Map(
    (previous.evidence_index ?? []).map((item) => [item.id, item])
  );
  const afterEvidence = new Map(current.evidence.map((item) => [item.id, item]));
  const evidence_added = current.evidence.filter(
    (item) => !beforeEvidence.has(item.id)
  );
  const evidence_removed = (previous.evidence_index ?? []).filter(
    (item) => !afterEvidence.has(item.id)
  );
  if (!changed.length && !added.length && !removed.length && !evidence_added.length && !evidence_removed.length) {
    return null;
  }
  return {
    previous_commit: previous.commit_sha ?? null,
    commit: current.commit_sha,
    previous_run_at: previous.created_at ?? null,
    changed,
    added,
    removed,
    evidence_added,
    evidence_removed
  };
}

// _shared/context.ts
var HACKATHON_TYPES = [
  "problem_statement",
  "open_innovation",
  "theme_based",
  "ai_ml",
  "web",
  "mobile",
  "iot_hardware",
  "data_science",
  "security",
  "blockchain",
  "custom"
];
function normaliseType(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return "problem_statement";
  return HACKATHON_TYPES.includes(raw) ? raw : raw;
}
function text(value, limit = 2e3) {
  return String(value ?? "").trim().slice(0, limit);
}
async function buildHackathonContext(hackathon, requirementMap, submission) {
  const problem = text(hackathon.problem_statement, 4e3);
  const requirements = requirementMap.requirements ?? [];
  const constraints = requirementMap.constraints ?? [];
  const outcomes = requirementMap.expected_outcomes ?? [];
  const criteria = requirementMap.evaluation_criteria ?? [];
  const known = /* @__PURE__ */ new Set([
    "id",
    "name",
    "problem_statement",
    "requirements",
    "constraints",
    "expected_outcome",
    "evaluation_criteria",
    "hackathon_type",
    "theme",
    "custom_instructions",
    "technology_restrictions",
    "dataset_requirements",
    "deployment_requirements",
    "simulation_duration_minutes",
    "status",
    "practice_enabled",
    "config_version",
    "created_at",
    "updated_at",
    "description",
    "submission_rules",
    "hardware_requirements"
  ]);
  const freeformNotes = [];
  for (const [key, value] of Object.entries(hackathon)) {
    if (known.has(key)) continue;
    const body = text(value, 600);
    if (!body) continue;
    freeformNotes.push(`${key.replace(/_/g, " ")}: ${body}`);
  }
  const snapshot = {
    name: String(hackathon.name ?? ""),
    type: normaliseType(hackathon.hackathon_type),
    problem_statement: problem,
    requirements: String(hackathon.requirements ?? ""),
    constraints: String(hackathon.constraints ?? ""),
    expected_outcome: String(hackathon.expected_outcome ?? ""),
    evaluation_criteria: String(hackathon.evaluation_criteria ?? ""),
    theme: hackathon.theme ?? null,
    custom_instructions: hackathon.custom_instructions ?? null,
    technology_restrictions: hackathon.technology_restrictions ?? null,
    dataset_requirements: hackathon.dataset_requirements ?? null,
    deployment_requirements: hackathon.deployment_requirements ?? null
  };
  return {
    id: String(hackathon.id ?? ""),
    name: String(hackathon.name ?? "Hackathon"),
    type: normaliseType(hackathon.hackathon_type),
    problem,
    hasProblem: problem.length > 0,
    theme: hackathon.theme ? String(hackathon.theme) : null,
    claims: {
      description: text(submission?.project_description, 1200),
      features: text(submission?.key_features, 1200),
      techStack: text(submission?.tech_stack, 600)
    },
    requirements,
    constraints,
    expectedOutcomes: outcomes,
    evaluationCriteria: criteria,
    hasRequirements: requirements.length > 0,
    hasConstraints: constraints.length > 0,
    hasOutcomes: outcomes.length > 0,
    hasCriteria: criteria.length > 0,
    customInstructions: hackathon.custom_instructions ? text(hackathon.custom_instructions, 1500) : null,
    technologyRestrictions: hackathon.technology_restrictions ? text(hackathon.technology_restrictions, 800) : null,
    datasetRequirements: hackathon.dataset_requirements ? text(hackathon.dataset_requirements, 800) : null,
    deploymentRequirements: hackathon.deployment_requirements ? text(hackathon.deployment_requirements, 800) : null,
    freeformNotes: freeformNotes.slice(0, 8),
    version: await shortHash(JSON.stringify(snapshot)),
    configVersion: Number(hackathon.config_version ?? 1) || 1,
    snapshot
  };
}

// _shared/requirements.ts
init_http();
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
function truncate(text2, limit = 300) {
  const collapsed = text2.replace(/\s+/g, " ").trim();
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
function splitItems(text2) {
  if (!text2 || !text2.trim()) return [];
  const lines = text2.split("\n");
  const bullets = [];
  for (const line of lines) {
    if (!BULLET.test(line)) continue;
    const cleaned = clean(line);
    if (cleaned && !NOISE.test(cleaned) && cleaned.length > 2) bullets.push(cleaned);
  }
  if (bullets.length >= 2) {
    return dedupe(bullets.map((bullet) => truncate(bullet)));
  }
  const paragraphs = text2.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    return dedupe(paragraphs.map((p) => truncate(p)));
  }
  const sentences = text2.trim().split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
  if (sentences.length) {
    return dedupe(sentences.map((s) => truncate(s)));
  }
  return [truncate(text2.trim())];
}
function importanceOf2(text2) {
  const lowered = text2.toLowerCase();
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
async function call(input) {
  const { pricing } = input;
  const ctxHash = await contextHash(
    [input.subjectIds, input.contextParts],
    input.promptVersion,
    pricing.modelName
  );
  if (!aiConfigured()) {
    console.info("[hacksim.analysis] AI not configured; skipping", input.operation);
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
    input.spend.cacheHits += 1;
    console.info("[hacksim.analysis] cache hit for", input.scopeKey, input.subjectIds);
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
    cacheRatio: input.scopeKey === "properness" ? 0.5 : 0
  });
  if (!decision.allowed) {
    console.info("[hacksim.analysis] blocked", input.operation, decision.reason);
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
    hackathon: input.contextParts[0],
    project_map: input.contextParts[1]
  }).slice(0, 12e3);
  let response;
  try {
    response = input.provider ? await input.provider({
      task: input.task,
      promptVersion: input.promptVersion,
      maxOutputTokens: Math.min(pricing.maxOutputTokens, 3e3)
    }) : await completeJson({
      systemStable: SYSTEM_STABLE,
      contextStable,
      task: input.task,
      promptVersion: input.promptVersion,
      maxOutputTokens: Math.min(pricing.maxOutputTokens, 3e3)
    });
  } catch (error) {
    const code = error instanceof AIError ? error.code : "unknown";
    const message = error.message;
    console.warn("[hacksim.analysis]", input.operation, "failed:", message);
    input.spend.failures += 1;
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
  input.spend.calls += 1;
  input.spend.costUsd += cost;
  input.spend.tokens += response.inputTokens + response.outputTokens;
  input.spend.inputTokens += response.inputTokens;
  input.spend.outputTokens += response.outputTokens;
  input.spend.cachedTokens += response.cachedTokens;
  if (!valid) input.spend.failures += 1;
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
    status: valid ? "success" : "failed",
    durationMs: response.durationMs,
    userId: input.actorId,
    submissionId: input.submissionId,
    repositoryId: input.repositoryId,
    sessionId: input.sessionId,
    errorCode: valid ? null : "invalid_json",
    errorMessage: valid ? null : "Provider did not return valid JSON."
  });
  await saveAnalysis({
    analysisType: input.scopeKey,
    provider: pricing.provider,
    model: response.model,
    promptVersion: input.promptVersion,
    ctxHash,
    status: valid ? "success" : "failed",
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
    errorCode: valid ? null : "invalid_json",
    errorMessage: valid ? null : "Provider did not return valid JSON.",
    completedAt: valid ? (/* @__PURE__ */ new Date()).toISOString() : null
  });
  return response;
}
async function runAnalysis(input) {
  const submissionId = input.submission.id ?? null;
  const repositoryId = input.repository.repository_id ?? input.repository.id ?? null;
  const commitSha = input.repository.analyzed_commit_sha ?? null;
  await markReviewRunning(submissionId, repositoryId);
  const hackathonId = String(input.hackathon.id ?? "");
  const requirementMap = await getRequirementMap(hackathonId, input.hackathon);
  const context = await buildHackathonContext(
    input.hackathon,
    requirementMap,
    input.submission
  );
  const evidenceSet = buildEvidenceSet(
    asRawEvidence(input.evidence ?? [])
  );
  const datasetProfiles = input.datasetProfiles ?? [];
  const semantics = input.semantics ?? [];
  const projectMap = input.projectMap ?? {};
  const index = buildRepoIndex({
    files: input.files,
    chunks: input.chunks,
    evidence: evidenceSet.byId ? [...evidenceSet.byId.values()] : [],
    routes: input.routes ?? [],
    datasetProfiles,
    semantics
  });
  const vocabulary = briefVocabulary(requirementMap);
  const requirementConcepts = /* @__PURE__ */ new Map();
  for (const entry of requirementMap.requirements ?? []) {
    requirementConcepts.set(
      entry.id,
      analyseRequirement(entry.text, vocabulary, requirementMap)
    );
  }
  const groups = groupRequirements(requirementMap);
  const constraintConcepts = analyseBriefItems(requirementMap.constraints ?? [], requirementMap);
  const outcomeConcepts = analyseBriefItems(requirementMap.expected_outcomes ?? [], requirementMap);
  const criteriaConcepts = analyseBriefItems(requirementMap.evaluation_criteria ?? [], requirementMap);
  const facts = countFacts(input, projectMap, index);
  const inspection = input.inspection ?? {
    mode: projectMap.analysis_mode ?? "full",
    warnings: (projectMap.warnings ?? []).slice(0, 5),
    filesSeen: facts.fileCount,
    filesRead: facts.fileCount
  };
  const coverage = inspectionCovers(inspection);
  const inspectionNote = coverage.covered ? "" : coverage.note + " Prefer 'unable_to_determine' over a negative status for anything not found.";
  const plan = planAnalysis(
    context,
    facts,
    groups.map((group) => ({
      focus: group.focus,
      label: group.label,
      ids: group.entries.map((entry) => entry.id),
      questions: questionsForGroup(group.concepts)
    })),
    (requirementMap.expected_outcomes ?? []).map((entry) => entry.id),
    (requirementMap.constraints ?? []).map((entry) => entry.id),
    (requirementMap.evaluation_criteria ?? []).map((entry) => entry.id),
    alignmentQuestions(context)
  );
  const pricing = await loadPricing();
  const spend = {
    costUsd: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    calls: 0,
    cacheHits: 0,
    failures: 0,
    validationFailures: 0,
    repairs: 0
  };
  const conclusions = [];
  const findings = [];
  const tasks = [];
  let claims = [];
  let alignment = null;
  let architecture = null;
  let implementation = null;
  let engineering = [];
  let assessment = null;
  const wants = (key) => !input.onlyTasks?.length || input.onlyTasks.includes(key);
  if (!pricing) {
    return failure(context, plan, {
      reviewId: null,
      status: "failed",
      conclusions: [],
      findings: [],
      tasks: [],
      diagnostics: {},
      totalCostUsd: 0,
      totalTokens: 0,
      error: "No AI model is configured."
    });
  }
  const deterministicRows = /* @__PURE__ */ new Map();
  for (const entry of requirementMap.requirements ?? []) {
    if (!wants("requirements")) break;
    const concept = requirementConcepts.get(entry.id);
    if (!concept) continue;
    const planForRequirement = buildRetrievalPlan(entry.id, concept);
    const retrieval = retrieve({ plan: planForRequirement, index });
    const counted = deterministicCount(entry.text, facts.countables);
    const literal = deterministicLiteral(entry.text, index, evidenceSet);
    const verdict = counted.status ? counted : literal;
    if (verdict.status) {
      deterministicRows.set(entry.id, {
        subject_id: entry.id,
        kind: "requirement",
        status: verdict.status,
        confidence: verdict.status === "evidence_found" ? "high" : "medium",
        evidence_ids: verdict.evidenceIds,
        explanation: verdict.explanation,
        missing_or_unclear: [],
        method: verdict.method ?? "deterministic_count",
        files: retrieval.files.map((hit) => hit.path).slice(0, 6),
        retrieval_queries: planForRequirement.questions.slice(0, 2),
        relevant_files: retrieval.files.map((hit) => hit.path).slice(0, 6),
        evidence_count: verdict.evidenceIds.length,
        ai_used: false,
        ai_reason: "A count or a named artefact settled this; the deterministic pass is authoritative and no model call was made."
      });
    }
  }
  for (const planned of plan.tasks) {
    if (!wants(planned.key)) continue;
    if (planned.kind === "alignment") {
      const retrieval = retrieveFor(conceptFromTask(planned, requirementConcepts, context, index), index);
      const outcome = await runAi({
        planned,
        prompt: buildAlignmentTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, [])
        ),
        promptVersion: PROMPT_VERSIONS.alignment,
        scopeKey: "alignment",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateAlignment(payload, evidenceSet),
        pick: (items) => items[0],
        evidenceIdsFrom: (item) => item.evidence_ids
      });
      if (outcome.item) {
        alignment = outcome.item;
        findings.push(
          ...validateFindings(outcome.payload?.findations ?? null, evidenceSet, "hackathon")
        );
        if (alignment.downgraded) spend.validationFailures += 1;
      }
      continue;
    }
    if (planned.kind === "requirements") {
      const group = groups.find((item) => item.focus === planned.focus);
      if (!group) continue;
      const pending = [];
      for (const entry of group.entries) {
        if (deterministicRows.has(entry.id)) continue;
        pending.push(entry);
      }
      if (!pending.length) {
        tasks.push({
          key: planned.key,
          kind: planned.kind,
          scope: planned.scope,
          status: "avoided",
          reason: "The deterministic pass settled every requirement in this group.",
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          validationErrors: [],
          rejectedEvidenceIds: [],
          repairs: 0,
          evidenceIds: []
        });
        continue;
      }
      const retrievals = /* @__PURE__ */ new Map();
      for (const entry of pending) {
        const concept = requirementConcepts.get(entry.id);
        if (!concept) continue;
        retrievals.set(entry.id, retrieve({ plan: buildRetrievalPlan(entry.id, concept), index }));
      }
      const merged = mergeRetrievals([...retrievals.values()]);
      const outcome = await runAi({
        planned,
        prompt: buildRequirementsTask(
          promptContext(context, input, index, evidenceSet, merged, projectMap, datasetProfiles, semantics, inspectionNote, group.concepts),
          pending.map((entry) => ({
            id: entry.id,
            text: entry.text,
            importance: entry.importance
          })),
          group.label
        ),
        promptVersion: PROMPT_VERSIONS.requirements,
        scopeKey: "requirements",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateConclusions(payload, {
          kind: "requirement",
          allowedSubjects: pending.map((entry) => entry.id),
          evidence: evidenceSet
        }),
        evidenceIdsFrom: () => []
      });
      for (const item of outcome.items) {
        const retrieval = retrievals.get(item.subject_id);
        const coverageNote = coverage.covered ? "" : " The repository was not fully inspected, so absence of evidence here is inconclusive.";
        const finalStatus = item.status === "not_evidenced" && !coverage.covered ? "unable_to_determine" : item.status;
        conclusions.push({
          subject_id: item.subject_id,
          kind: "requirement",
          status: finalStatus,
          confidence: finalStatus === "unable_to_determine" ? "none" : item.confidence,
          evidence_ids: item.evidence_ids,
          explanation: item.explanation + coverageNote,
          missing_or_unclear: item.missing_or_unclear,
          method: "ai_evidence",
          files: item.files,
          retrieval_queries: (retrieval?.plan.questions ?? []).slice(0, 2),
          relevant_files: (retrieval?.files ?? []).map((hit) => hit.path).slice(0, 6),
          evidence_count: item.evidence_ids.length,
          ai_used: true,
          ai_reason: outcome.reason
        });
      }
      findings.push(
        ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon")
      );
      continue;
    }
    if (planned.kind === "constraints") {
      const subjects = requirementMap.constraints ?? [];
      const retrieval = retrieveForBrief(constraintConcepts, index);
      const outcome = await runAi({
        planned,
        prompt: buildConstraintsTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, constraintConcepts),
          subjects.map((entry) => ({ id: entry.id, text: entry.text, importance: entry.importance }))
        ),
        promptVersion: PROMPT_VERSIONS.constraints,
        scopeKey: "constraints",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateConclusions(payload, {
          kind: "constraint",
          allowedSubjects: subjects.map((entry) => entry.id),
          evidence: evidenceSet
        }),
        evidenceIdsFrom: () => []
      });
      pushConclusions(conclusions, outcome.items, "constraint", "ai_evidence", outcome.reason, []);
      findings.push(
        ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon")
      );
      continue;
    }
    if (planned.kind === "outcomes") {
      const subjects = requirementMap.expected_outcomes ?? [];
      const retrieval = retrieveForBrief(outcomeConcepts, index);
      const outcome = await runAi({
        planned,
        prompt: buildOutcomesTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, outcomeConcepts),
          subjects.map((entry) => ({ id: entry.id, text: entry.text }))
        ),
        promptVersion: PROMPT_VERSIONS.outcomes,
        scopeKey: "outcomes",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateConclusions(payload, {
          kind: "outcome",
          allowedSubjects: subjects.map((entry) => entry.id),
          evidence: evidenceSet
        }),
        evidenceIdsFrom: () => []
      });
      pushConclusions(conclusions, outcome.items, "outcome", "ai_evidence", outcome.reason, []);
      findings.push(
        ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon")
      );
      continue;
    }
    if (planned.kind === "criteria") {
      const subjects = requirementMap.evaluation_criteria ?? [];
      const retrieval = retrieveForBrief(criteriaConcepts, index);
      const outcome = await runAi({
        planned,
        prompt: buildCriteriaTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, criteriaConcepts),
          subjects.map((entry) => ({ id: entry.id, text: entry.text }))
        ),
        promptVersion: PROMPT_VERSIONS.criteria,
        scopeKey: "criteria",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateConclusions(payload, {
          kind: "criterion",
          allowedSubjects: subjects.map((entry) => entry.id),
          evidence: evidenceSet
        }),
        evidenceIdsFrom: () => []
      });
      pushConclusions(conclusions, outcome.items, "criterion", "ai_evidence", outcome.reason, []);
      findings.push(
        ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "hackathon")
      );
      continue;
    }
    if (planned.kind === "claims") {
      const claimList = claimsFrom(input.submission);
      if (!claimList.length) continue;
      const retrieval = retrieveForText(planned.question, index);
      const outcome = await runAi({
        planned,
        prompt: buildClaimsTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, []),
          claimList
        ),
        promptVersion: PROMPT_VERSIONS.claims,
        scopeKey: "claims",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateClaims(payload, evidenceSet, claimList),
        evidenceIdsFrom: () => []
      });
      claims = outcome.items;
      for (const claim of claims) {
        const observed = observationFor(claim, evidenceSet);
        findings.push(...detectConflicts(
          {
            claim: claim.claim,
            status: claim.status,
            evidenceIds: claim.evidence_ids,
            explanation: claim.explanation,
            observed
          },
          evidenceSet
        ));
      }
      findings.push(
        ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "claim")
      );
      continue;
    }
    if (planned.kind === "implementation") {
      const retrieval = retrieveForText(planned.question, index);
      const outcome = await runAi({
        planned,
        prompt: buildImplementationTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, [])
        ),
        promptVersion: PROMPT_VERSIONS.implementation,
        scopeKey: "implementation",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: () => ({ items: [], rejectedSubjects: [], rejectedEvidenceIds: [], errors: [] }),
        pick: () => null,
        evidenceIdsFrom: () => []
      });
      const payload = outcome.payload ?? {};
      architecture = payload.architecture ?? null;
      implementation = payload.implementation ?? null;
      findings.push(
        ...validateFindings(payload.findings ?? null, evidenceSet, "general")
      );
      const dead = implementation?.incomplete_or_dead ?? [];
      for (const item of dead.slice(0, 5)) {
        findings.push({
          finding_type: "dead_feature",
          severity: "low",
          title: `Present but not doing anything: ${item.slice(0, 120)}`,
          description: String(item).slice(0, 600),
          evidence_ids: [],
          files: [],
          symbols: [],
          why_it_matters: "A feature that exists but has no effect is misleading in a write-up and in a demo.",
          suggested_improvement: "Complete it or remove the claim that it is part of the solution.",
          confidence: "low",
          expectation_source: "general"
        });
      }
      continue;
    }
    if (planned.kind === "engineering") {
      const retrieval = retrieveForText(planned.question, index);
      const topics = plan.dimensions.filter((item) => item.relevance !== "not_applicable" && item.method === "ai" && item.key !== "problem_alignment").map((item) => item.label);
      const outcome = await runAi({
        planned,
        prompt: buildEngineeringTask(
          promptContext(context, input, index, evidenceSet, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, []),
          topics.slice(0, 6)
        ),
        promptVersion: PROMPT_VERSIONS.engineering,
        scopeKey: "engineering",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: () => ({ items: [], rejectedSubjects: [], rejectedEvidenceIds: [], errors: [] }),
        pick: () => null,
        evidenceIdsFrom: () => []
      });
      const list = Array.isArray(outcome.payload?.observations) ? outcome.payload.observations : [];
      engineering = list.filter((item) => item && typeof item === "object").slice(0, 8).map((item) => {
        const citations = filterCitations(item.evidence_ids, evidenceSet);
        return {
          topic: String(item.topic ?? "general").slice(0, 60),
          status: ["observed", "not_applicable", "concern"].includes(String(item.status)) ? String(item.status) : "observed",
          summary: String(item.summary ?? "").slice(0, 900),
          evidence_ids: citations.accepted,
          concern: String(item.concern ?? "").slice(0, 600),
          improvement: String(item.improvement ?? "").slice(0, 600),
          expectation_source: "general"
        };
      });
      findings.push(
        ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "general")
      );
      continue;
    }
    if (planned.kind === "properness") {
      const prior = [
        ...alignment ? [{ label: "problem alignment", status: alignment.status, summary: alignment.explanation }] : [],
        ...conclusions.map((row) => ({
          label: row.subject_id,
          status: row.status,
          summary: row.explanation
        })),
        ...claims.map((claim) => ({
          label: `claim: ${claim.claim.slice(0, 60)}`,
          status: claim.status,
          summary: claim.explanation
        }))
      ];
      const outcome = await runAi({
        planned,
        prompt: buildPropernessTask(
          promptContext(context, input, index, evidenceSet, emptyRetrieval(), projectMap, datasetProfiles, semantics, inspectionNote, []),
          prior.slice(0, 24)
        ),
        promptVersion: PROMPT_VERSIONS.properness,
        scopeKey: "properness",
        promptContextItems: [contextSnapshot(context), slimMap(projectMap)],
        repositoryId,
        commitSha,
        submissionId,
        pricing,
        input,
        spend,
        tasks,
        validate: (payload) => validateAssessment(payload, evidenceSet),
        pick: (items) => items[0],
        evidenceIdsFrom: (item) => item.evidence_ids
      });
      if (outcome.item) {
        assessment = outcome.item;
        findings.push(
          ...validateFindings(outcome.payload?.findings ?? null, evidenceSet, "general")
        );
      }
      continue;
    }
  }
  const allConclusions = [
    ...deterministicOrdered(requirementMap, deterministicRows, conclusions)
  ];
  const testing = testingFromEvidence(projectMap);
  const secrets = securityFromEvidence(projectMap);
  if (secrets) {
    for (const issue of secrets.confirmed_issues) {
      findings.push({
        finding_type: "security_concern",
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        evidence_ids: [],
        files: [],
        symbols: [],
        why_it_matters: issue.why_it_matters,
        suggested_improvement: issue.suggested_improvement,
        confidence: "medium",
        expectation_source: "general"
      });
    }
  }
  if (testing.finding === "testing_gap" && testing.testFileCount === 0) {
    const testingRequired = plan.dimensions.some(
      (item) => item.key === "testing" && item.relevance === "required"
    );
    findings.push({
      finding_type: "testing_gap",
      severity: testingRequired ? "medium" : "informational",
      title: "No automated tests were detected",
      description: testing.explanation,
      evidence_ids: [],
      files: [],
      symbols: [],
      why_it_matters: testingRequired ? "This hackathon asks about testing, and no test file was found in the analysed repository." : "Behaviour that is not covered by tests is unverified when it changes. This was not a requirement here.",
      suggested_improvement: "Add a test for the main user path, starting with failure cases.",
      confidence: "medium",
      expectation_source: testingRequired ? "hackathon" : "general"
    });
  }
  const defenseTargets = buildDefenseTargets(allConclusions, findings, claimListOf(claims));
  const previous = await previousRun(submissionId);
  const evidenceRefs = citedEvidence(
    allConclusions,
    [...evidenceSet.byId.values()]
  );
  const reviewId = await upsertReview({
    submissionId,
    repositoryId,
    context,
    plan,
    alignment,
    allConclusions,
    assessment,
    architecture,
    implementation,
    engineering,
    testing,
    spend,
    commitSha
  });
  await replaceRequirementEvaluations(submissionId, allConclusions);
  await replaceFindings(reviewId, findings);
  await replaceDefenseTargets(submissionId, defenseTargets);
  await saveSnapshot({
    submissionId,
    repositoryId,
    commitSha,
    context,
    plan,
    evidence: evidenceSet.byId.size,
    allConclusions,
    evidenceRefs,
    spend
  });
  const diff = diffRuns(previous, {
    commit_sha: commitSha,
    conclusions: allConclusions,
    evidence: evidenceRefs
  });
  const diagnostics = buildDiagnostics({
    context,
    plan,
    facts,
    allConclusions,
    tasks,
    spend,
    inspection,
    coverage: coverage.covered,
    datasetProfiles,
    evidenceCount: evidenceSet.byId.size,
    diff
  });
  return {
    reviewId,
    status: statusFor(allConclusions, tasks, findings),
    context,
    plan,
    conclusions: allConclusions,
    findings: dedupeFindings(findings),
    claims,
    assessment,
    alignment,
    architecture,
    implementation,
    engineering,
    testing,
    tasks,
    diagnostics,
    diff,
    totalCostUsd: spend.costUsd,
    totalTokens: spend.tokens
  };
}
async function runAi(args) {
  const { planned, spend, tasks } = args;
  const record = {
    key: planned.key,
    kind: planned.kind,
    scope: planned.scope,
    status: "executed",
    reason: planned.reason,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    validationErrors: [],
    rejectedEvidenceIds: [],
    repairs: 0,
    evidenceIds: []
  };
  const before = { cost: spend.costUsd, calls: spend.calls };
  const response = await call({
    operation: `analysis.${planned.key}`,
    task: args.prompt,
    promptVersion: args.promptVersion,
    scopeKey: args.scopeKey,
    subjectIds: planned.subjectIds,
    contextParts: args.promptContextItems,
    repositoryId: args.repositoryId,
    commitSha: args.commitSha,
    submissionId: args.submissionId,
    pricing: args.pricing,
    actorId: args.input.actorId ?? null,
    sessionId: args.input.sessionId ?? null,
    estimateTokens: Math.ceil(args.prompt.length / 4) + 1200,
    spend,
    provider: args.input.provider ?? null
  });
  record.inputTokens = Math.max(0, spend.inputTokens);
  record.outputTokens = Math.max(0, spend.outputTokens);
  record.cachedTokens = spend.cachedTokens;
  record.costUsd = Math.max(0, spend.costUsd - before.cost);
  record.status = spend.calls === before.calls ? "cached" : "executed";
  if (!response || !response.parsed) {
    record.status = response ? "failed" : "skipped";
    record.reason = response ? "The model did not return valid JSON; the call is recorded as failed." : "The call was not made (no key, or the budget for this submission is exhausted).";
    tasks.push(record);
    return { payload: null, items: [], item: null, reason: record.reason };
  }
  let payload = response.parsed;
  let validation = args.validate(payload);
  record.validationErrors = validation.errors;
  record.rejectedEvidenceIds = validation.rejectedEvidenceIds;
  if (validation.errors.length) {
    spend.validationFailures += 1;
    const repairTask = repairPrompt(args.prompt, validation.errors);
    const repaired = await call({
      operation: `analysis.${planned.key}.repair`,
      task: repairTask,
      promptVersion: `${args.promptVersion}-r1`,
      scopeKey: `${args.scopeKey}:repair`,
      subjectIds: planned.subjectIds,
      contextParts: args.promptContextItems,
      repositoryId: args.repositoryId,
      commitSha: args.commitSha,
      submissionId: args.submissionId,
      pricing: args.pricing,
      actorId: args.input.actorId ?? null,
      sessionId: args.input.sessionId ?? null,
      estimateTokens: Math.ceil(repairTask.length / 4) + 800,
      spend,
      provider: args.input.provider ?? null
    });
    record.repairs = 1;
    spend.repairs += 1;
    if (repaired?.parsed) {
      payload = repaired.parsed;
      validation = args.validate(payload);
      record.validationErrors = validation.errors;
      record.rejectedEvidenceIds = validation.rejectedEvidenceIds;
    }
  }
  const items = validation.items;
  const item = args.pick ? args.pick(items) : null;
  record.evidenceIds = [...new Set(items.flatMap((entry) => args.evidenceIdsFrom(entry)))].slice(0, 20);
  record.reason = items.length ? planned.reason : `${planned.reason} No usable conclusion survived validation.`;
  tasks.push(record);
  return { payload, items, item, reason: record.reason };
}
function claimsFrom(submission) {
  const claims = [];
  const description = String(submission.project_description ?? "").trim();
  if (description) claims.push(description.slice(0, 300));
  for (const line of String(submission.key_features ?? "").split("\n")) {
    const cleaned = line.trim().replace(/^[-*•\s]+/, "").trim();
    if (cleaned.length > 8) claims.push(cleaned.slice(0, 200));
  }
  return claims.slice(0, 10);
}
function claimListOf(claims) {
  return claims.map((claim) => claim.claim);
}
function observationFor(claim, evidence) {
  const out = [];
  for (const id of claim.evidence_ids) {
    const item = evidence.byId.get(id);
    if (item) out.push(`${item.file ?? "repository"}: ${item.claim.slice(0, 160)}`);
  }
  if (out.length) return out;
  return [
    "no file, symbol or dataset in the analysed repository was found that demonstrates this behaviour"
  ];
}
function pushConclusions(target, items, kind, method, reason, queries) {
  for (const item of items) {
    target.push({
      subject_id: item.subject_id,
      kind,
      status: item.status,
      confidence: item.confidence,
      evidence_ids: item.evidence_ids,
      explanation: item.explanation,
      missing_or_unclear: item.missing_or_unclear,
      method,
      files: item.files,
      retrieval_queries: queries,
      relevant_files: [],
      evidence_count: item.evidence_ids.length,
      ai_used: true,
      ai_reason: reason
    });
  }
}
function deterministicOrdered(requirementMap, deterministicRows, aiRows) {
  const out = [];
  const used = /* @__PURE__ */ new Set();
  for (const entry of requirementMap.requirements ?? []) {
    const row = deterministicRows.get(entry.id) ?? aiRows.find((item) => item.subject_id === entry.id);
    if (row) {
      out.push(row);
      used.add(entry.id);
    }
  }
  for (const row of aiRows) {
    if (used.has(row.subject_id)) continue;
    out.push(row);
  }
  return out;
}
function retrieveFor(concepts, index) {
  if (!concepts.length) return emptyRetrieval();
  const results = concepts.map(
    (concept, position) => retrieve({ plan: buildRetrievalPlan(`c${position}`, concept), index })
  );
  return mergeRetrievals(results);
}
function retrieveForBrief(concepts, index) {
  return retrieveFor(concepts, index);
}
function retrieveForText(question, index) {
  const concept = {
    text: question.slice(0, 600),
    intent: question.slice(0, 300),
    focus: "general",
    phrases: nounPhrases(question).slice(0, 8),
    actions: [],
    subjects: termsOf(question).slice(0, 10),
    qualifiers: [],
    terms: termsOf(question),
    domainTerms: [],
    facets: [],
    artifacts: []
  };
  return retrieve({ plan: buildRetrievalPlan("context", concept), index });
}
function conceptFromTask(planned, requirementConcepts, context, index) {
  void context;
  void index;
  const concepts = [];
  for (const id of planned.subjectIds) {
    const concept = requirementConcepts.get(id);
    if (concept) concepts.push(concept);
  }
  return concepts;
}
function mergeRetrievals(results) {
  const byPath = /* @__PURE__ */ new Map();
  const evidenceIds = [];
  const datasetPaths = [];
  const questions = [];
  const unmatched = [];
  let considered = 0;
  for (const result of results) {
    considered = Math.max(considered, result.considered);
    for (const question of result.plan.questions) {
      if (questions.length < 6 && !questions.includes(question)) questions.push(question);
    }
    for (const id of result.evidenceIds) {
      if (evidenceIds.length < 40 && !evidenceIds.includes(id)) evidenceIds.push(id);
    }
    for (const path of result.datasetPaths) {
      if (!datasetPaths.includes(path)) datasetPaths.push(path);
    }
    for (const term of result.unmatchedTerms) {
      if (unmatched.length < 10 && !unmatched.includes(term)) unmatched.push(term);
    }
    for (const hit of result.files) {
      const existing = byPath.get(hit.path);
      if (!existing) {
        byPath.set(hit.path, hit);
        continue;
      }
      existing.score += Math.min(hit.score, 20);
      existing.matchedTerms = [.../* @__PURE__ */ new Set([...existing.matchedTerms, ...hit.matchedTerms])].slice(0, 8);
    }
  }
  const files = [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  return {
    plan: {
      subjectId: results[0]?.plan.subjectId ?? "",
      focus: results[0]?.plan.focus ?? "general",
      terms: [...new Set(results.flatMap((result) => result.plan.terms))].slice(0, 40),
      phrases: [...new Set(results.flatMap((result) => result.plan.phrases))].slice(0, 12),
      artifacts: results[0]?.plan.artifacts ?? [],
      questions
    },
    files,
    evidenceIds: evidenceIds.slice(0, 24),
    datasetPaths: datasetPaths.slice(0, 6),
    considered,
    truncated: byPath.size > files.length,
    unmatchedTerms: unmatched
  };
}
function emptyRetrieval() {
  return {
    plan: {
      subjectId: "",
      focus: "general",
      terms: [],
      phrases: [],
      artifacts: [],
      questions: []
    },
    files: [],
    evidenceIds: [],
    datasetPaths: [],
    considered: 0,
    truncated: false,
    unmatchedTerms: []
  };
}
function promptContext(context, input, index, evidence, retrieval, projectMap, datasetProfiles, semantics, inspectionNote, concepts) {
  const paths = new Set(retrieval.files.map((hit) => hit.path));
  const scoped = [];
  for (const path of paths) {
    for (const item of evidence.byFile.get(path) ?? []) {
      scoped.push(item);
    }
  }
  for (const item of evidenceSetGlobal(evidence)) {
    if (scoped.length < 40) scoped.push(item);
  }
  void input;
  void index;
  return {
    context,
    projectMap,
    evidence: scoped,
    terms: retrieval.plan.terms,
    code: renderPacket(retrieval),
    datasetProfiles: datasetProfiles.filter(
      (profile) => retrieval.datasetPaths.includes(profile.path)
    ),
    semantics: semantics.filter((item) => paths.has(item.path)),
    concepts,
    inspectionNote
  };
}
function evidenceSetGlobal(evidence) {
  const out = [];
  for (const item of evidence.byId.values()) {
    if (!item.file) out.push(item);
  }
  return out;
}
function countFacts(input, projectMap, index) {
  const symbols = projectMap.important_files ?? [];
  void symbols;
  const semantics = input.semantics ?? [];
  const routes = input.routes ?? [];
  const files = input.files ?? [];
  const functionCount = countBy(input.chunks, "symbol_type", [
    "function",
    "method"
  ]);
  const classCount = countBy(input.chunks, "symbol_type", ["class", "type"]);
  const datasets = input.datasetProfiles ?? [];
  const fileCount = files.filter((file) => !file.is_ignored).length;
  const testFileCount = Number(
    projectMap.testing?.test_file_count ?? 0
  );
  return {
    fileCount,
    sourceFileCount: files.filter(
      (file) => !file.is_ignored && ["source", "component", "api", "model", "schema", "database"].includes(
        String(file.file_category)
      )
    ).length,
    datasetCount: datasets.length,
    datasetProfileCount: datasets.length,
    functionCount,
    classCount,
    routeCount: routes.length,
    modelFindingCount: semantics.reduce((sum, item) => sum + item.models.length, 0),
    calculationCount: semantics.reduce((sum, item) => sum + item.calculations.length, 0),
    ruleCount: semantics.reduce((sum, item) => sum + item.rules.length, 0),
    dataAccessCount: semantics.reduce((sum, item) => sum + item.dataAccess.length, 0),
    uiFindingCount: semantics.reduce((sum, item) => sum + item.ui.length, 0),
    testFileCount,
    deploymentFileCount: files.filter((file) => file.file_category === "deployment").length,
    secretCount: Number(
      projectMap.security?.hardcoded_secrets?.length ?? 0
    ),
    authDetected: Boolean(projectMap.authentication?.detected),
    databaseDetected: Boolean(projectMap.database?.technologies),
    hasReadme: Boolean(projectMap.readme?.present),
    analysisMode: projectMap.analysis_mode ?? "full",
    stackSummary: stackSummaryOf(projectMap),
    countables: countablesFrom({
      projectMap,
      functionCount,
      classCount,
      routeCount: routes.length,
      datasetCount: datasets.length,
      modelCount: semantics.reduce((sum, item) => sum + item.models.length, 0),
      fileCount,
      calculationCount: semantics.reduce((sum, item) => sum + item.calculations.length, 0),
      testFileCount
    }),
    index
  };
}
function countBy(rows, field, values) {
  return rows.filter((row) => values.includes(String(row[field]))).length;
}
function stackSummaryOf(projectMap) {
  const stack = projectMap.stack ?? {};
  const frameworks = stack.frameworks ?? [];
  const languages = Object.keys(stack.languages ?? {});
  return [...languages.slice(0, 4), ...frameworks.slice(0, 5)].join(" ");
}
function contextSnapshot(context) {
  return {
    name: context.name,
    type: context.type,
    version: context.version,
    problem: context.problem.slice(0, 1200),
    theme: context.theme,
    claims: context.claims,
    custom: context.customInstructions?.slice(0, 400) ?? null,
    notes: context.freeformNotes.slice(0, 3)
  };
}
function slimMap(projectMap) {
  return {
    analysis_mode: projectMap.analysis_mode,
    stack: projectMap.stack,
    database: projectMap.database,
    authentication: projectMap.authentication,
    testing: projectMap.testing,
    deployment: projectMap.deployment,
    repository_stats: projectMap.repository_stats,
    features: projectMap.features,
    warnings: projectMap.warnings
  };
}
function alignmentQuestions(context) {
  const source = [
    context.problem,
    context.theme ?? "",
    context.claims.description,
    context.claims.features
  ].join(" ");
  return nounPhrases(source).slice(0, 18);
}
function dedupeFindings(findings) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const finding of findings) {
    const key = `${finding.finding_type}|${finding.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out.slice(0, 30);
}
function statusFor(conclusions, tasks, findings) {
  const executed = tasks.filter((task) => task.status === "executed" || task.status === "cached");
  const failed = tasks.filter((task) => task.status === "failed");
  if (executed.length === 0 && findings.length === 0) return "pending";
  if (failed.length > 0 && executed.length === 0) return "failed";
  if (failed.length > 0) return "partial";
  if (conclusions.length > 0) return "completed";
  return "partial";
}
function buildDefenseTargets(conclusions, findings, claims) {
  const targets = [];
  for (const row of conclusions) {
    if (row.kind !== "requirement" && row.kind !== "constraint") continue;
    if (row.status !== "not_evidenced" && row.status !== "partial_evidence") continue;
    targets.push({
      topic: `${row.subject_id}: ${row.explanation.slice(0, 240)}`.slice(0, 300),
      reason: row.missing_or_unclear.length ? `Not established by the analysed repository: ${row.missing_or_unclear.join("; ").slice(0, 400)}` : row.explanation.slice(0, 600),
      priority: row.status === "not_evidenced" ? "P1" : "P2",
      evidence_ids: row.evidence_ids.slice(0, 10),
      question_area: row.kind,
      status: "open"
    });
  }
  for (const finding of findings) {
    if (finding.finding_type !== "claim_mismatch") continue;
    targets.push({
      topic: finding.title.slice(0, 300),
      reason: (finding.description || finding.why_it_matters).slice(0, 600),
      priority: "P0",
      evidence_ids: finding.evidence_ids.slice(0, 10),
      question_area: "claim_support",
      status: "open"
    });
  }
  for (const finding of findings) {
    if (finding.finding_type !== "security_concern") continue;
    targets.push({
      topic: String(finding.title).slice(0, 300),
      reason: (finding.why_it_matters || finding.description).slice(0, 600),
      priority: "P5",
      evidence_ids: finding.evidence_ids.slice(0, 10),
      question_area: "security",
      status: "open"
    });
  }
  void claims;
  return targets.slice(0, 20);
}
async function markReviewRunning(submissionId, repositoryId) {
  if (!submissionId || !repositoryId) return;
  try {
    await db().from("project_reviews").upsert(
      { submission_id: submissionId, repository_id: repositoryId, status: "running" },
      { onConflict: "submission_id,repository_id" }
    );
  } catch (error) {
    console.warn("[hacksim.analysis] could not mark the review running:", error);
  }
}
async function upsertReview(args) {
  if (!args.submissionId || !args.repositoryId) return null;
  const service2 = db();
  const byKind = (kind) => args.allConclusions.filter((row) => row.kind === kind);
  const payload = {
    submission_id: args.submissionId,
    repository_id: args.repositoryId,
    status: "completed",
    model: null,
    prompt_version: PROMPT_VERSIONS.alignment,
    estimated_cost_usd: args.spend.costUsd,
    total_tokens: args.spend.tokens,
    // New, versioned knowledge (§44, §27). Old columns are kept so the existing
    // admin dashboards and the §80 payload keep working.
    analysis_version: "a3",
    hackathon_version: args.context.version,
    scanner_version: null,
    commit_sha: args.commitSha,
    dimensions: args.plan.dimensions,
    requirement_rows: byKind("requirement"),
    constraint_rows: byKind("constraint"),
    outcome_rows: byKind("outcome"),
    criterion_rows: byKind("criterion"),
    assessment: args.assessment,
    engineering: args.engineering,
    diagnostics_summary: {
      calls_planned: args.plan.tasks.length,
      calls_executed: args.spend.calls,
      cache_hits: args.spend.cacheHits
    }
  };
  if (args.alignment) payload.problem_alignment = args.alignment;
  if (args.architecture) payload.architecture = args.architecture;
  if (args.implementation) payload.implementation = args.implementation;
  if (args.testing) payload.testing = args.testing;
  try {
    const { data: existing } = await service2.from("project_reviews").select("id").eq("submission_id", args.submissionId).eq("repository_id", args.repositoryId).limit(1);
    const row = (existing ?? [])[0];
    if (row) {
      const { error: error2 } = await service2.from("project_reviews").update(payload).eq("id", row.id);
      if (error2) throw error2;
      return row.id;
    }
    const { data, error } = await service2.from("project_reviews").insert(payload).select("id").single();
    if (error || !data) throw error ?? new Error("no row");
    return data.id;
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist review:", error);
    return null;
  }
}
async function replaceRequirementEvaluations(submissionId, conclusions) {
  if (!submissionId) return;
  const rows = conclusions.map((row) => ({
    submission_id: submissionId,
    requirement_id: row.subject_id,
    status: row.kind === "constraint" || row.kind === "criterion" || row.kind === "outcome" ? row.status === "evidence_found" ? "supported" : row.status : row.status,
    evidence_ids: row.evidence_ids,
    confidence: row.confidence,
    explanation: row.explanation.slice(0, 2e3),
    source: row.ai_used ? "ai" : "deterministic",
    // New columns; written defensively so an un-migrated database still works.
    kind: row.kind,
    method: row.method,
    missing_or_unclear: row.missing_or_unclear,
    retrieval_queries: row.retrieval_queries,
    relevant_files: row.relevant_files,
    evidence_count: row.evidence_count,
    ai_used: row.ai_used,
    ai_reason: row.ai_reason
  }));
  if (!rows.length) return;
  try {
    const service2 = db();
    const { data: existing } = await service2.from("requirement_evaluations").select("id").eq("submission_id", submissionId);
    if ((existing ?? []).length) {
      await service2.from("requirement_evaluations").delete().eq("submission_id", submissionId);
    }
    const { error } = await service2.from("requirement_evaluations").upsert(rows, { onConflict: "submission_id,requirement_id" });
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist evaluations:", error);
  }
}
async function replaceFindings(reviewId, findings) {
  if (!reviewId) return;
  const rows = findings.map((finding) => ({
    project_review_id: reviewId,
    finding_type: finding.finding_type,
    severity: finding.severity,
    title: finding.title.slice(0, 200),
    description: finding.description.slice(0, 2e3),
    evidence_ids: finding.evidence_ids.slice(0, 12),
    files: finding.files.slice(0, 12),
    symbols: finding.symbols.slice(0, 12),
    why_it_matters: finding.why_it_matters.slice(0, 1e3),
    suggested_improvement: finding.suggested_improvement.slice(0, 1e3),
    confidence: finding.confidence
  }));
  try {
    const service2 = db();
    await service2.from("project_review_findings").delete().eq("project_review_id", reviewId);
    if (rows.length) {
      const { error } = await service2.from("project_review_findings").insert(rows);
      if (error) throw error;
    }
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist findings:", error);
  }
}
async function replaceDefenseTargets(submissionId, targets) {
  if (!submissionId) return;
  try {
    const service2 = db();
    await service2.from("defense_targets").delete().eq("submission_id", submissionId);
    if (targets.length) {
      const { error } = await service2.from("defense_targets").insert(targets.map((target) => ({ submission_id: submissionId, ...target })));
      if (error) throw error;
    }
  } catch (error) {
    console.warn("[hacksim.analysis] could not persist defence targets:", error);
  }
}
async function saveSnapshot(args) {
  if (!args.submissionId || !args.repositoryId) return;
  try {
    const { error } = await db().from("analysis_snapshots").insert({
      submission_id: args.submissionId,
      repository_id: args.repositoryId,
      commit_sha: args.commitSha,
      hackathon_version: args.context.version,
      analysis_version: "a3",
      scanner_version: null,
      prompt_versions: PROMPT_VERSIONS,
      plan: {
        summary: args.plan.summary,
        dimensions: args.plan.dimensions,
        tasks: args.plan.tasks.map((task) => ({ key: task.key, scope: task.scope }))
      },
      hackathon_snapshot: args.context.snapshot,
      conclusions: args.allConclusions,
      evidence_index: args.evidenceRefs,
      evidence_count: args.evidence,
      input_tokens: args.spend.inputTokens,
      output_tokens: args.spend.outputTokens,
      cached_tokens: args.spend.cachedTokens,
      estimated_cost_usd: args.spend.costUsd
    });
    if (error) throw error;
  } catch (error) {
    console.warn("[hacksim.analysis] could not save snapshot:", error);
  }
}
async function previousRun(submissionId) {
  if (!submissionId) return null;
  try {
    const { data } = await db().from("analysis_snapshots").select("commit_sha, created_at, conclusions, evidence_index").eq("submission_id", submissionId).order("created_at", { ascending: false }).limit(1);
    const row = (data ?? [])[0];
    return row ?? null;
  } catch {
    return null;
  }
}
function buildDiagnostics(args) {
  return {
    hackathon: {
      name: args.context.name,
      type: args.context.type,
      version: args.context.version,
      config_version: args.context.configVersion,
      requirements: args.context.requirements.length,
      constraints: args.context.constraints.length,
      outcomes: args.context.expectedOutcomes.length,
      criteria: args.context.evaluationCriteria.length,
      requirements_enabled: args.plan.requirementsEnabled,
      requirements_reason: args.plan.requirementsReason
    },
    repository: {
      files_seen: args.inspection.filesSeen,
      files_read: args.inspection.filesRead,
      source_files: args.facts.sourceFileCount,
      dataset_files: args.facts.datasetCount,
      dataset_profiles: args.datasetProfiles.length,
      functions: args.facts.functionCount,
      classes: args.facts.classCount,
      routes: args.facts.routeCount,
      models: args.facts.modelFindingCount,
      calculations: args.facts.calculationCount,
      rules: args.facts.ruleCount,
      ui_sites: args.facts.uiFindingCount,
      evidence_count: args.evidenceCount,
      analysis_mode: args.inspection.mode,
      fully_inspected: args.coverage,
      warnings: args.inspection.warnings.slice(0, 8)
    },
    ai: {
      calls_planned: args.plan.tasks.length,
      calls_executed: args.spend.calls,
      calls_avoided: args.tasks.filter((task) => task.status === "avoided").length,
      cache_hits: args.spend.cacheHits,
      cache_misses: Math.max(0, args.spend.calls - args.spend.cacheHits),
      input_tokens: args.spend.inputTokens,
      output_tokens: args.spend.outputTokens,
      cached_tokens: args.spend.cachedTokens,
      cost_usd: Number(args.spend.costUsd.toFixed(6)),
      failures: args.spend.failures,
      validation_failures: args.spend.validationFailures,
      repairs: args.spend.repairs,
      tasks: args.tasks
    },
    dimensions: args.plan.dimensions,
    conclusions: args.allConclusions.map((row) => ({
      id: row.subject_id,
      kind: row.kind,
      status: row.status,
      confidence: row.confidence,
      method: row.method,
      ai_used: row.ai_used,
      ai_reason: row.ai_reason,
      retrieval_queries: row.retrieval_queries,
      relevant_files: row.relevant_files,
      evidence_count: row.evidence_count
    })),
    diff: args.diff
  };
}
function failure(context, plan, base) {
  return {
    reviewId: null,
    status: "failed",
    context,
    plan,
    conclusions: [],
    findings: [],
    claims: [],
    assessment: null,
    alignment: null,
    architecture: null,
    implementation: null,
    engineering: [],
    testing: null,
    tasks: [],
    diagnostics: { error: base.error ?? "unknown" },
    diff: null,
    totalCostUsd: 0,
    totalTokens: 0,
    error: base.error
  };
}

// _shared/v2/engine.ts
init_http();

// _shared/v2/content.ts
function contentByPath(chunks) {
  const grouped = /* @__PURE__ */ new Map();
  for (const chunk of chunks) {
    const path = chunk.file_path;
    const list = grouped.get(path) ?? [];
    list.push({ start: Number(chunk.start_line ?? 0), content: chunk.content });
    grouped.set(path, list);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [path, list] of grouped) {
    list.sort((a, b) => a.start - b.start);
    out.set(path, list.map((row) => row.content).join("\n"));
  }
  return out;
}
function attachContent(files, byPath) {
  return files.map((file) => ({
    ...file,
    content: byPath.get(file.path) ?? ""
  }));
}

// _shared/v2/discover.ts
var GENERATED_HINTS = [
  "/dist/",
  "/build/",
  "/.next/",
  "/coverage/",
  ".min.js",
  ".min.css",
  ".map",
  "/generated/",
  "__generated__"
];
var V2_CATEGORY_MAP = {
  source: "source",
  component: "frontend",
  api: "api",
  model: "model",
  schema: "schema",
  database: "database",
  config: "configuration",
  dependency: "dependency",
  documentation: "documentation",
  test: "test",
  dataset: "dataset",
  asset: "asset",
  unknown: "unknown"
};
function mapCategory(legacy, path) {
  const lower = path.toLowerCase();
  if (lower.includes("supabase/functions") || lower.includes("edge-functions")) {
    return "backend";
  }
  if (lower.includes("migration") || lower.endsWith(".sql") && lower.includes("migrate")) {
    return "migration";
  }
  if (lower.includes("prompt") || lower.endsWith(".prompt.md")) return "prompt";
  if (lower.includes("deploy") || lower === "dockerfile") return "deployment";
  return V2_CATEGORY_MAP[legacy] ?? "unknown";
}
function looksGenerated(path) {
  const lower = path.toLowerCase();
  return GENERATED_HINTS.some((hint) => lower.includes(hint));
}
function buildFileInventory(treeEntries, contentByPath2) {
  return treeEntries.map((entry) => {
    const path = entry.path;
    const ignored = isIgnored(path) || isSensitive(path);
    const binary = [".png", ".jpg", ".pdf", ".zip", ".ico", ".woff"].some(
      (ext) => path.toLowerCase().endsWith(ext)
    );
    const category = mapCategory(categoryOf(path, binary), path);
    const generated = looksGenerated(path);
    return {
      path,
      sizeBytes: Number(entry.size ?? 0),
      extension: extensionOf(path),
      language: languageOf(path),
      category,
      importanceScore: 0,
      reasons: [],
      ignored,
      generated,
      binary,
      sensitive: isSensitive(path),
      contentHash: null
    };
  });
}
function scoreImportance(files, inDegree, routeFiles, entryFiles) {
  return files.map((file) => {
    if (file.ignored || file.generated) {
      return { ...file, importanceScore: 0, reasons: ["ignored_or_generated"] };
    }
    let score = 0.2;
    const reasons = [];
    const indeg = inDegree.get(file.path) ?? 0;
    if (indeg >= 5) {
      score += 0.35;
      reasons.push("high_in_degree");
    } else if (indeg >= 2) {
      score += 0.15;
      reasons.push("imported_by_others");
    }
    if (entryFiles.has(file.path)) {
      score += 0.25;
      reasons.push("entry_point");
    }
    if (routeFiles.has(file.path)) {
      score += 0.2;
      reasons.push("route_handler");
    }
    if (["api", "backend", "database", "model"].includes(file.category)) {
      score += 0.1;
      reasons.push("core_category");
    }
    if (file.category === "test") score += 0.05;
    if (file.category === "documentation") score -= 0.15;
    if (file.category === "dependency") score -= 0.2;
    score = Math.max(0, Math.min(1, score));
    return { ...file, importanceScore: Number(score.toFixed(4)), reasons };
  });
}
function entryPointCandidates(paths) {
  const names = /* @__PURE__ */ new Set([
    "main.py",
    "app.py",
    "index.ts",
    "index.js",
    "main.ts",
    "main.go",
    "server.ts",
    "server.js",
    "manage.py",
    "wsgi.py",
    "asgi.py"
  ]);
  const out = /* @__PURE__ */ new Set();
  for (const path of paths) {
    const base = basenameOf(path).toLowerCase();
    if (names.has(base)) out.add(path);
    if (path.includes("supabase/functions/") && base === "index.ts") out.add(path);
  }
  return out;
}

// _shared/v2/hash.ts
async function sha256Hex2(text2) {
  const data = new TextEncoder().encode(text2);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function snippetHash(excerpt) {
  return sha256Hex2(excerpt.trim().slice(0, 4e3));
}
async function packetHash(parts) {
  return sha256Hex2(parts.join("\n---\n"));
}

// _shared/v2/evidence.ts
var evidenceCounter = 0;
function nextId() {
  evidenceCounter += 1;
  return `EV-${String(evidenceCounter).padStart(3, "0")}`;
}
function resetEvidenceCounter() {
  evidenceCounter = 0;
}
var WEAK_ONLY = /* @__PURE__ */ new Set([
  "dependency_installed",
  "framework_detected",
  "readme_claim",
  "filename_signal",
  "route_exists_only"
]);
async function compileEvidence(files, relationships) {
  const items = [];
  for (const file of files) {
    if (file.ignored || !file.content) continue;
    const { symbols: fileSymbols } = extractSymbols(file.path, file.content);
    const symbolLines = fileSymbols.map((s) => ({
      name: s.name,
      symbol_type: s.symbol_type,
      line: s.line
    }));
    const semantics = analyseSemantics(file.path, file.content, symbolLines);
    const groups = [
      ...semantics.calculations,
      ...semantics.rules,
      ...semantics.models,
      ...semantics.dataAccess,
      ...semantics.ui
    ];
    for (const finding of groups) {
      items.push({
        evidenceId: nextId(),
        level: "implementation",
        evidenceType: "behavior",
        claim: finding.claim,
        filePath: file.path,
        symbolName: finding.symbol,
        startLine: finding.line,
        endLine: Number(finding.lines.split("-").pop()) || finding.line,
        snippetHash: await snippetHash(finding.excerpt),
        snippetExcerpt: finding.excerpt.slice(0, 500),
        confidence: "high"
      });
    }
  }
  for (const rel of relationships) {
    if (rel.relationship === "routes_to") {
      const path = String(rel.detail?.path ?? "");
      items.push({
        evidenceId: nextId(),
        level: "structural",
        evidenceType: "route",
        claim: `HTTP route declared: ${rel.detail?.method ?? "?"} ${path}`,
        filePath: rel.sourceFile,
        symbolName: rel.detail?.handler ?? null,
        startLine: rel.sourceLines ? Number(rel.sourceLines) : null,
        endLine: null,
        snippetHash: null,
        snippetExcerpt: null,
        confidence: rel.confidence,
        detail: { ...rel.detail, not_implementation_proof: true }
      });
    } else if ([
      "calls_api",
      "calls_ai_provider",
      "loads_prompt",
      "parses_response",
      "persists_result",
      "reads_database",
      "calls"
    ].includes(rel.relationship)) {
      items.push({
        evidenceId: nextId(),
        level: rel.relationship === "calls" ? "relationship" : "relationship",
        evidenceType: rel.relationship,
        claim: `${rel.relationship} in ${rel.sourceFile}`,
        filePath: rel.sourceFile,
        symbolName: null,
        startLine: rel.sourceLines ? Number(rel.sourceLines) : null,
        endLine: null,
        snippetHash: null,
        snippetExcerpt: null,
        confidence: rel.confidence,
        detail: rel.detail
      });
    }
  }
  for (const file of files.filter((f) => f.category === "dependency" && !f.ignored)) {
    items.push({
      evidenceId: nextId(),
      level: "metadata",
      evidenceType: "dependency_manifest",
      claim: `Dependency manifest present: ${file.path}`,
      filePath: file.path,
      symbolName: null,
      startLine: null,
      endLine: null,
      snippetHash: null,
      snippetExcerpt: null,
      confidence: "low",
      detail: { weak_signal: true, type: WEAK_ONLY.has("dependency_installed") ? "dependency_installed" : "context" }
    });
  }
  return items;
}
function implementationEvidence(items) {
  return items.filter(
    (e) => e.level === "implementation" || e.level === "relationship" || e.level === "workflow"
  );
}

// _shared/v2/graph.ts
var IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]\s+import)/gm;
var CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
var FETCH_RE = /(?:fetch|axios\.(?:get|post|put|delete|patch)|supabase\.(?:from|rpc|functions\.invoke))\s*\(\s*['"`]([^'"`]+)['"`]/gi;
var DB_RE = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|INTO)\b|\.(?:from|insert|update|delete|upsert|rpc)\s*\(/gi;
var AI_PROVIDER_RE = /\b(?:openai|deepseek|anthropic|cohere|ollama|chat\.completions|completions\.create)\b/i;
var PROMPT_LOAD_RE = /\b(?:prompt|systemPrompt|getPrompt|loadPrompt)\b/i;
var PARSE_JSON_RE = /\b(?:JSON\.parse|parseJson|z\.object|safeParse)\b/;
var PERSIST_RE = /\b(?:insert|upsert|update|save|persist)\b/i;
function resolveImport(fromPath, spec, allPaths) {
  if (spec.startsWith(".")) {
    const baseParts = fromPath.split("/").slice(0, -1);
    const specParts = spec.split("/");
    const merged = [...baseParts];
    for (const part of specParts) {
      if (part === ".") continue;
      if (part === "..") merged.pop();
      else merged.push(part);
    }
    const candidates = [
      merged.join("/"),
      `${merged.join("/")}.ts`,
      `${merged.join("/")}.tsx`,
      `${merged.join("/")}.js`,
      `${merged.join("/")}/index.ts`
    ];
    for (const c of candidates) {
      if (allPaths.has(c)) return c;
    }
    return null;
  }
  return null;
}
function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}
function nearestSymbol(symbols, filePath, line) {
  const inFile = symbols.filter((s) => s.filePath === filePath);
  let best = null;
  for (const sym of inFile) {
    if (sym.startLine <= line && sym.endLine >= line) {
      if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
    }
  }
  return best?.symbolKey;
}
function buildRelationshipGraph(files, symbols) {
  const relationships = [];
  const inDegree = /* @__PURE__ */ new Map();
  const routeFiles = /* @__PURE__ */ new Set();
  const pathSet = new Set(files.map((f) => f.path));
  for (const file of files) {
    if (file.ignored || !file.content) continue;
    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(file.content)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const target = resolveImport(file.path, spec, pathSet);
      if (target) {
        relationships.push({
          relationship: "imports",
          confidence: "high",
          sourceFile: file.path,
          targetFile: target,
          sourceLines: String(lineOf(file.content, match.index))
        });
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }
    const routes = extractRoutes(file.path, file.content);
    for (const route of routes) {
      routeFiles.add(file.path);
      const handlerKey = nearestSymbol(symbols, file.path, route.line);
      relationships.push({
        relationship: "routes_to",
        confidence: route.symbol ? "high" : "medium",
        sourceFile: file.path,
        sourceSymbolKey: handlerKey,
        sourceLines: `${route.line}`,
        detail: {
          method: route.method,
          path: route.path,
          handler: route.symbol ?? null,
          handler_unresolved: !route.symbol
        }
      });
    }
    FETCH_RE.lastIndex = 0;
    while ((match = FETCH_RE.exec(file.content)) !== null) {
      const url = match[1];
      relationships.push({
        relationship: "calls_api",
        confidence: "medium",
        sourceFile: file.path,
        sourceSymbolKey: nearestSymbol(symbols, file.path, lineOf(file.content, match.index)),
        sourceLines: String(lineOf(file.content, match.index)),
        detail: { target: url }
      });
    }
    if (DB_RE.test(file.content)) {
      relationships.push({
        relationship: "reads_database",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1",
        detail: { note: "database access pattern detected in file" }
      });
    }
    if (AI_PROVIDER_RE.test(file.content)) {
      relationships.push({
        relationship: "calls_ai_provider",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1"
      });
    }
    if (PROMPT_LOAD_RE.test(file.content)) {
      relationships.push({
        relationship: "loads_prompt",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1"
      });
    }
    if (PARSE_JSON_RE.test(file.content)) {
      relationships.push({
        relationship: "parses_response",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1"
      });
    }
    if (PERSIST_RE.test(file.content)) {
      relationships.push({
        relationship: "persists_result",
        confidence: "low",
        sourceFile: file.path,
        sourceLines: "1"
      });
    }
    const fileSymbols = symbols.filter((s) => s.filePath === file.path);
    const names = new Map(fileSymbols.map((s) => [s.name, s.symbolKey]));
    CALL_RE.lastIndex = 0;
    while ((match = CALL_RE.exec(file.content)) !== null) {
      const callee = match[1];
      const targetKey = names.get(callee);
      if (!targetKey) continue;
      const callerKey = nearestSymbol(symbols, file.path, lineOf(file.content, match.index));
      if (!callerKey || callerKey === targetKey) continue;
      relationships.push({
        relationship: "calls",
        confidence: "medium",
        sourceSymbolKey: callerKey,
        targetSymbolKey: targetKey,
        sourceFile: file.path,
        sourceLines: String(lineOf(file.content, match.index))
      });
    }
  }
  return { relationships, inDegree, routeFiles };
}

// _shared/v2/requirement-map.ts
function seedTerms(text2) {
  return text2.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3).slice(0, 12);
}
function scoreRequirement(text2, impl, features) {
  const terms = seedTerms(text2);
  const matched = impl.filter((e) => {
    const blob = `${e.claim} ${e.filePath ?? ""} ${e.symbolName ?? ""}`.toLowerCase();
    return terms.some((t) => blob.includes(t));
  });
  const workflows = features.filter(
    (f) => f.name.toLowerCase().split(/\s+/).some((w) => terms.includes(w)) || matched.some((m) => f.evidenceIds.includes(m.evidenceId))
  );
  if (matched.length >= 2 && workflows.length >= 1) {
    return {
      evidenceIds: matched.slice(0, 8).map((m) => m.evidenceId),
      workflowIds: workflows.slice(0, 2).map((w) => w.featureKey),
      status: "partially_confirmed",
      confidence: "medium",
      explanation: "Implementation and workflow evidence connected to requirement keywords; AI verification required for confirmation."
    };
  }
  if (matched.length >= 1) {
    return {
      evidenceIds: matched.slice(0, 6).map((m) => m.evidenceId),
      workflowIds: workflows.slice(0, 1).map((w) => w.featureKey),
      status: "weakly_evidenced",
      confidence: "low",
      explanation: "Some implementation evidence matches requirement themes; insufficient workflow proof without verification."
    };
  }
  return {
    evidenceIds: [],
    workflowIds: [],
    status: "unable_to_determine",
    confidence: "low",
    explanation: "No implementation evidence strongly linked to this requirement from deterministic mapping."
  };
}
function mapRequirements(requirementMap, evidence, features) {
  const impl = implementationEvidence(evidence);
  const rows = [];
  for (const req of requirementMap.requirements ?? []) {
    const scored = scoreRequirement(req.text, impl, features);
    rows.push({
      requirementId: req.id,
      kind: "requirement",
      status: scored.status,
      confidence: scored.status === "partially_confirmed" ? "medium" : "low",
      explanation: scored.explanation,
      uncertainties: scored.status === "unable_to_determine" ? ["Insufficient deterministic linkage; verification may add evidence."] : [],
      evidenceIds: scored.evidenceIds,
      workflowIds: scored.workflowIds
    });
  }
  return rows;
}
function mapClaims(claims, evidence, features) {
  const impl = implementationEvidence(evidence);
  return claims.filter(Boolean).map((claim) => {
    const scored = scoreRequirement(claim, impl, features);
    return {
      claimText: claim,
      status: scored.status,
      confidence: scored.confidence ?? "low",
      explanation: scored.explanation,
      evidenceIds: scored.evidenceIds,
      chainKeys: scored.workflowIds.map((w) => `chain-${w}`)
    };
  });
}

// _shared/v2/persist.ts
init_http();
var service = () => db();
async function createAnalysisRun(input) {
  const { data, error } = await service().from("analysis_runs").insert({
    submission_id: input.submissionId,
    repository_id: input.repositoryId,
    commit_sha: input.commitSha,
    normalized_repo_url: input.normalizedUrl,
    owner: input.owner,
    repo_name: input.repoName,
    default_branch: input.defaultBranch,
    scanner_version: input.scannerVersion,
    analysis_version: input.analysisVersion,
    prompt_version: input.promptVersion,
    status: "queued",
    progress_stage: "queued",
    progress_percent: 0
  }).select("id").single();
  if (error || !data) throw new Error("Could not create analysis run.");
  const runId = data.id;
  await service().from("submissions").update({ latest_analysis_run_id: runId }).eq("id", input.submissionId);
  return runId;
}
async function findCachedRun(submissionId, commitSha, scannerVersion, analysisVersion) {
  const { data } = await service().from("analysis_runs").select("id").eq("submission_id", submissionId).eq("commit_sha", commitSha).eq("scanner_version", scannerVersion).eq("analysis_version", analysisVersion).in("status", ["completed", "partial"]).limit(1);
  return data?.[0]?.id ?? null;
}
async function updateRunStatus(runId, status, extra) {
  await service().from("analysis_runs").update({
    status,
    progress_stage: status,
    updated_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...extra ?? {}
  }).eq("id", runId);
}
async function logStage(runId, stage, message, metrics) {
  await service().from("v2_analysis_stage_events").insert({
    analysis_run_id: runId,
    stage,
    message: message ?? null,
    metrics: metrics ?? {}
  });
}
async function persistSnapshot(runId, meta) {
  await service().from("repository_snapshots").upsert({
    analysis_run_id: runId,
    normalized_url: String(meta.normalized_url ?? ""),
    owner: String(meta.owner ?? ""),
    repo_name: String(meta.repo_name ?? ""),
    default_branch: meta.default_branch,
    commit_sha: String(meta.commit_sha ?? ""),
    is_private: meta.is_private,
    primary_language: meta.primary_language,
    file_count: Number(meta.file_count ?? 0),
    metadata: meta,
    completed_at: (/* @__PURE__ */ new Date()).toISOString()
  }, { onConflict: "analysis_run_id" });
}
async function persistEngineArtifacts(runId, ctx) {
  const svc = service();
  await svc.from("v2_repository_files").delete().eq("analysis_run_id", runId);
  await svc.from("v2_evidence_items").delete().eq("analysis_run_id", runId);
  await svc.from("v2_repository_symbols").delete().eq("analysis_run_id", runId);
  await svc.from("v2_code_relationships").delete().eq("analysis_run_id", runId);
  await svc.from("v2_feature_candidates").delete().eq("analysis_run_id", runId);
  await svc.from("v2_evidence_chains").delete().eq("analysis_run_id", runId);
  await svc.from("v2_requirement_links").delete().eq("analysis_run_id", runId);
  await svc.from("v2_claim_verifications").delete().eq("analysis_run_id", runId);
  const fileRows = ctx.files.map((f) => ({
    analysis_run_id: runId,
    path: f.path,
    size_bytes: f.sizeBytes,
    extension: f.extension,
    language: f.language,
    category: f.category,
    importance_score: f.importanceScore,
    importance_reasons: f.reasons,
    ignored: f.ignored,
    generated: f.generated,
    binary: f.binary,
    sensitive: f.sensitive,
    content_hash: f.contentHash,
    structurally_indexed: !f.ignored,
    functionally_inspected: Boolean(f.content) && !f.ignored && f.importanceScore >= 0.35,
    sent_to_ai: false
  }));
  for (let i = 0; i < fileRows.length; i += 400) {
    await svc.from("v2_repository_files").insert(fileRows.slice(i, i + 400));
  }
  const { data: insertedFiles } = await svc.from("v2_repository_files").select("id, path").eq("analysis_run_id", runId);
  const fileIdByPath = new Map((insertedFiles ?? []).map((r) => [r.path, r.id]));
  const symbolRows = ctx.symbols.map((s) => ({
    analysis_run_id: runId,
    file_id: fileIdByPath.get(s.filePath),
    symbol_key: s.symbolKey,
    name: s.name,
    symbol_type: s.symbolType,
    language: s.language,
    start_line: s.startLine,
    end_line: s.endLine,
    signature: s.signature,
    parent_symbol: s.parentSymbol,
    importance: s.importance,
    uncertain: s.uncertain
  })).filter((r) => r.file_id);
  for (let i = 0; i < symbolRows.length; i += 400) {
    await svc.from("v2_repository_symbols").insert(symbolRows.slice(i, i + 400));
  }
  const relRows = ctx.relationships.map((r) => ({
    analysis_run_id: runId,
    relationship_type: r.relationship,
    confidence: r.confidence,
    source_file: r.sourceFile,
    source_lines: r.sourceLines ?? null,
    source_file_id: fileIdByPath.get(r.sourceFile) ?? null,
    target_file_id: r.targetFile ? fileIdByPath.get(r.targetFile) ?? null : null,
    detail: r.detail ?? {}
  }));
  for (let i = 0; i < relRows.length; i += 400) {
    await svc.from("v2_code_relationships").insert(relRows.slice(i, i + 400));
  }
  const evidenceRows = ctx.evidence.map((e) => ({
    analysis_run_id: runId,
    evidence_id: e.evidenceId,
    level: e.level,
    evidence_type: e.evidenceType,
    claim: e.claim,
    file_path: e.filePath,
    symbol_name: e.symbolName,
    start_line: e.startLine,
    end_line: e.endLine,
    snippet_hash: e.snippetHash,
    snippet_excerpt: e.snippetExcerpt,
    confidence: e.confidence,
    detail: e.detail ?? {}
  }));
  for (let i = 0; i < evidenceRows.length; i += 400) {
    await svc.from("v2_evidence_items").insert(evidenceRows.slice(i, i + 400));
  }
  for (const feature of ctx.features) {
    await svc.from("v2_feature_candidates").insert({
      analysis_run_id: runId,
      feature_key: feature.featureKey,
      name: feature.name,
      workflow: feature.workflow,
      entry_symbol_ids: [],
      symbol_ids: [],
      relationship_ids: [],
      evidence_ids: feature.evidenceIds,
      confidence: feature.confidence
    });
  }
  for (const chain of ctx.chains) {
    await svc.from("v2_evidence_chains").insert({
      analysis_run_id: runId,
      chain_key: chain.chainKey,
      name: chain.name,
      ordered_evidence_ids: chain.orderedEvidenceIds
    });
  }
  for (const req of ctx.requirements) {
    await svc.from("v2_requirement_links").insert({
      analysis_run_id: runId,
      requirement_id: req.requirementId,
      kind: req.kind,
      status: req.status,
      confidence: req.confidence,
      explanation: req.explanation,
      uncertainties: req.uncertainties,
      evidence_ids: req.evidenceIds,
      workflow_ids: req.workflowIds
    });
  }
  for (const claim of ctx.claims) {
    await svc.from("v2_claim_verifications").insert({
      analysis_run_id: runId,
      claim_text: claim.claimText,
      status: claim.status,
      confidence: claim.confidence,
      explanation: claim.explanation,
      evidence_ids: claim.evidenceIds,
      chain_keys: claim.chainKeys
    });
  }
  for (const vr of ctx.verificationResults) {
    const { data: reqRow } = await svc.from("v2_verification_requests").insert({
      analysis_run_id: runId,
      operation: vr.operation,
      model: "deepseek",
      prompt_version: "verify-v1",
      packet_hash: vr.packet.packetHash,
      evidence_hash: vr.evidenceHash,
      subject_ids: vr.subjectIds,
      verification_round: 1,
      input_tokens: vr.inputTokens,
      output_tokens: vr.outputTokens,
      cached_tokens: vr.cachedTokens,
      total_tokens: vr.inputTokens + vr.outputTokens,
      duration_ms: vr.durationMs,
      cache_hit: vr.cacheHit,
      status: vr.status
    }).select("id").single();
    if (reqRow && vr.verdict) {
      await svc.from("v2_verification_results").insert({
        request_id: reqRow.id,
        verdict: vr.verdict.verdict,
        confidence: vr.verdict.confidence,
        verification_level: vr.verdict.verification_level,
        summary: vr.verdict.summary,
        supporting_evidence_ids: vr.verdict.supporting_evidence_ids,
        missing_links: vr.verdict.missing_links,
        contradictions: vr.verdict.contradictions,
        additional_files_needed: vr.verdict.additional_files_needed,
        runtime_verified: vr.verdict.runtime_verified,
        verification_complete: vr.verdict.verification_complete,
        raw_payload: vr.verdict
      });
    }
  }
  await svc.from("v2_analysis_coverage").upsert({
    analysis_run_id: runId,
    ...ctx.coverage,
    files_sent_to_ai: ctx.filesSentToAi
  }, { onConflict: "analysis_run_id" });
  await svc.from("v2_analysis_summaries").upsert({
    analysis_run_id: runId,
    headline: String(ctx.summary.headline ?? ""),
    implementation_summary: String(ctx.summary.implementation_summary ?? ""),
    strong_points: ctx.summary.strong_points ?? [],
    uncertainties: ctx.summary.uncertainties ?? [],
    defense_questions: ctx.summary.defense_questions ?? []
  }, { onConflict: "analysis_run_id" });
}

// _shared/v2/versions.ts
var V2_SCANNER_VERSION = "v2-1";
var V2_ANALYSIS_VERSION = "v2";
var V2_PROMPT_VERSION = "verify-v1";
var V2_DEFAULT_BUDGET = {
  maxInputTokens: 6e3,
  maxSourceBytes: 12e4,
  maxFiles: 24,
  maxSymbols: 40,
  maxRelationships: 80,
  smallVerificationTokens: 2e3
};
var V2_STAGE_PROGRESS = {
  queued: 0,
  discovering_repository: 5,
  scanning_repository: 15,
  building_code_graph: 35,
  discovering_features: 50,
  mapping_requirements: 60,
  verifying: 75,
  validating: 88,
  finalizing: 95,
  completed: 100,
  partial: 100,
  failed: 100
};

// _shared/v2/retrieval.ts
function estimateTokens(text2) {
  return Math.ceil(text2.length / 4);
}
async function buildEvidencePacket(input) {
  const budget = input.budget ?? V2_DEFAULT_BUDGET;
  const byId = new Map(input.evidence.map((e) => [e.evidenceId, e]));
  const selected = new Set(input.seedEvidenceIds);
  for (const rel of input.relationships) {
    if (selected.size >= budget.maxSymbols) break;
    for (const ev of input.evidence) {
      if (ev.filePath === rel.sourceFile) selected.add(ev.evidenceId);
    }
  }
  if (input.missingLink) {
    const needle = input.missingLink.toLowerCase();
    for (const rel of input.relationships) {
      const blob = JSON.stringify(rel.detail ?? {}).toLowerCase();
      if (blob.includes(needle) || rel.sourceFile.toLowerCase().includes(needle)) {
        for (const ev of input.evidence) {
          if (ev.filePath === rel.sourceFile) selected.add(ev.evidenceId);
        }
      }
    }
  }
  const snippets = [];
  let bytes = 0;
  let tokens = 0;
  const fileSet = /* @__PURE__ */ new Set();
  for (const id of selected) {
    const ev = byId.get(id);
    if (!ev) continue;
    const excerpt = ev.snippetExcerpt ?? "";
    const piece = `${ev.claim}
${excerpt}`;
    const nextTokens = tokens + estimateTokens(piece);
    const nextBytes = bytes + piece.length;
    if (nextTokens > budget.maxInputTokens || nextBytes > budget.maxSourceBytes) break;
    if (ev.filePath) fileSet.add(ev.filePath);
    if (fileSet.size > budget.maxFiles) break;
    snippets.push({
      evidenceId: id,
      file: ev.filePath ?? "",
      lines: ev.startLine ? `${ev.startLine}-${ev.endLine ?? ev.startLine}` : "",
      excerpt: excerpt.slice(0, 800)
    });
    tokens = nextTokens;
    bytes = nextBytes;
  }
  const relSlice = input.relationships.filter((r) => r.sourceFile && fileSet.has(r.sourceFile)).slice(0, budget.maxRelationships);
  const graphSummary = relSlice.map((r) => `${r.relationship}: ${r.sourceFile}${r.targetFile ? ` \u2192 ${r.targetFile}` : ""}`).join("\n");
  const hash = await packetHash([
    input.subjectIds.join(","),
    snippets.map((s) => s.evidenceId).join(","),
    graphSummary
  ]);
  return {
    subjectIds: input.subjectIds,
    evidenceIds: snippets.map((s) => s.evidenceId),
    snippets,
    relationships: relSlice,
    graphSummary,
    tokenEstimate: tokens + estimateTokens(graphSummary),
    packetHash: hash
  };
}

// _shared/v2/symbols.ts
function symbolKey(filePath, name, startLine) {
  return `${filePath}::${name}@${startLine}`;
}
function indexSymbols(files) {
  const symbols = [];
  for (const file of files) {
    if (file.ignored || !file.content || file.binary) continue;
    const { symbols: extracted } = extractSymbols(file.path, file.content);
    for (const sym of extracted) {
      symbols.push({
        symbolKey: symbolKey(file.path, sym.name, sym.line),
        filePath: file.path,
        name: sym.name,
        symbolType: sym.symbol_type,
        language: file.language,
        startLine: sym.line,
        endLine: sym.line + 30,
        signature: sym.signature ?? null,
        parentSymbol: null,
        importance: file.importanceScore,
        uncertain: false
      });
    }
    if (file.category === "api" || file.path.includes("functions/")) {
      const serveMatch = file.content.match(/Deno\.serve\s*\(/);
      if (serveMatch) {
        const line = file.content.slice(0, serveMatch.index).split("\n").length;
        symbols.push({
          symbolKey: symbolKey(file.path, "Deno.serve", line),
          filePath: file.path,
          name: "Deno.serve",
          symbolType: "handler",
          language: file.language,
          startLine: line,
          endLine: line + 40,
          signature: "Deno.serve(...)",
          parentSymbol: null,
          importance: Math.max(file.importanceScore, 0.7),
          uncertain: false
        });
      }
    }
  }
  return symbols;
}

// _shared/v2/validate-ai.ts
function validateVerifierOutput(raw, evidence, filePaths) {
  const errors = [];
  const allowedVerdicts = /* @__PURE__ */ new Set([
    "confirmed",
    "partially_confirmed",
    "weakly_evidenced",
    "not_evidenced",
    "unable_to_determine",
    "contradicted"
  ]);
  const verdict = String(raw.verdict ?? "");
  if (!allowedVerdicts.has(verdict)) errors.push("invalid_verdict");
  const supporting = raw.supporting_evidence_ids ?? [];
  const evidenceIds = new Set(evidence.map((e) => e.evidenceId));
  for (const id of supporting) {
    if (!evidenceIds.has(id)) errors.push(`unknown_evidence_id:${id}`);
  }
  const additional = raw.additional_files_needed ?? [];
  for (const path of additional) {
    if (path && !filePaths.has(path)) errors.push(`unknown_file:${path}`);
  }
  if (verdict === "confirmed" && supporting.length === 0) {
    errors.push("confirmed_without_evidence");
  }
  const weakOnly = supporting.every((id) => {
    const ev = evidence.find((e) => e.evidenceId === id);
    return ev?.level === "metadata" || ev?.level === "structural";
  });
  if (verdict === "confirmed" && weakOnly && supporting.length > 0) {
    errors.push("confirmed_on_weak_evidence_only");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    verdict: {
      verdict,
      confidence: String(raw.confidence ?? "medium"),
      verification_level: String(raw.verification_level ?? "source_reviewed"),
      summary: String(raw.summary ?? "").slice(0, 2e3),
      supporting_evidence_ids: supporting,
      missing_links: raw.missing_links ?? [],
      contradictions: raw.contradictions ?? [],
      additional_files_needed: additional,
      runtime_verified: Boolean(raw.runtime_verified),
      verification_complete: raw.verification_complete !== false
    }
  };
}

// _shared/v2/verifier.ts
var SYSTEM_PROMPT = `You are HackSim's repository verification engine.
Use only supplied evidence.
Never invent files, functions, APIs, behavior, architecture, or runtime behavior.
Technology presence is not proof. Dependencies are not proof. Filenames are not proof.
README claims are not proof. A route is not proof of complete implementation.
Static source code does not prove runtime behavior.
Every conclusion must cite evidence IDs.
If evidence is insufficient, return unable_to_determine and identify missing_links.
Return strict JSON with keys: verdict, confidence, verification_level, summary, supporting_evidence_ids, missing_links, contradictions, additional_files_needed, runtime_verified, verification_complete.`;
async function evidenceHash(ids) {
  return sha256Hex2(ids.sort().join(","));
}
async function runVerificationGroup(input) {
  const start = Date.now();
  const evHash = await evidenceHash(input.packet.evidenceIds);
  const cacheKey = await packetHash([
    input.runId,
    input.operation,
    input.subjectIds.join(","),
    evHash,
    input.packet.packetHash,
    V2_PROMPT_VERSION
  ]);
  if (input.cacheLookup) {
    const cached2 = await input.cacheLookup(cacheKey);
    if (cached2) {
      return {
        operation: input.operation,
        subjectIds: input.subjectIds,
        packet: input.packet,
        verdict: cached2,
        validationErrors: [],
        cacheHit: true,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        durationMs: Date.now() - start,
        status: "cache_hit",
        evidenceHash: evHash
      };
    }
  }
  if (!aiConfigured()) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: {
        verdict: "unable_to_determine",
        confidence: "low",
        verification_level: "ai_disabled",
        summary: "AI verification is not configured on this deployment.",
        supporting_evidence_ids: [],
        missing_links: ["ai_verification_unavailable"],
        contradictions: [],
        additional_files_needed: [],
        runtime_verified: false,
        verification_complete: false
      },
      validationErrors: [],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "ai_disabled",
      evidenceHash: evHash
    };
  }
  const userPayload = {
    operation: input.operation,
    subjects: input.subjectIds,
    label: input.subjectLabel,
    hackathon_context: input.hackathonContext.slice(0, 4e3),
    evidence_snippets: input.packet.snippets,
    graph_summary: input.packet.graphSummary,
    uncertainties: []
  };
  let raw;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  try {
    const response = await completeJson({
      systemStable: SYSTEM_PROMPT,
      contextStable: JSON.stringify(userPayload).slice(0, 12e3),
      task: "Return strict JSON verifying whether supplied evidence supports the subjects. Use only evidence IDs provided. Schema: verdict, confidence, verification_level, summary, supporting_evidence_ids, missing_links, contradictions, additional_files_needed, runtime_verified, verification_complete.",
      promptVersion: V2_PROMPT_VERSION,
      maxOutputTokens: 1800
    });
    raw = response.parsed ?? {};
    inputTokens = response.inputTokens;
    outputTokens = response.outputTokens;
    cachedTokens = response.cachedTokens ?? 0;
  } catch (error) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: null,
      validationErrors: [error.message],
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - start,
      status: "provider_error",
      evidenceHash: evHash
    };
  }
  const validated = validateVerifierOutput(raw, input.evidence, input.filePaths);
  if (!validated.ok || !validated.verdict) {
    return {
      operation: input.operation,
      subjectIds: input.subjectIds,
      packet: input.packet,
      verdict: null,
      validationErrors: validated.errors,
      cacheHit: false,
      inputTokens,
      outputTokens,
      cachedTokens,
      durationMs: Date.now() - start,
      status: "verification_failed",
      evidenceHash: evHash
    };
  }
  if (input.cacheStore) await input.cacheStore(cacheKey, validated.verdict);
  return {
    operation: input.operation,
    subjectIds: input.subjectIds,
    packet: input.packet,
    verdict: validated.verdict,
    validationErrors: [],
    cacheHit: false,
    inputTokens,
    outputTokens,
    cachedTokens,
    durationMs: Date.now() - start,
    status: "completed",
    evidenceHash: evHash
  };
}

// _shared/v2/workflows.ts
var FLOW_ORDER = [
  "loads_prompt",
  "calls_ai_provider",
  "parses_response",
  "persists_result",
  "calls_api",
  "routes_to",
  "reads_database",
  "calls"
];
function discoverFeatureWorkflows(relationships, evidence) {
  const features = [];
  const byFile = /* @__PURE__ */ new Map();
  for (const rel of relationships) {
    const list = byFile.get(rel.sourceFile) ?? [];
    list.push(rel);
    byFile.set(rel.sourceFile, list);
  }
  const aiFiles = [...byFile.entries()].filter(
    ([, rels]) => rels.some((r) => r.relationship === "calls_ai_provider")
  );
  if (aiFiles.length) {
    const workflow = [];
    const evidenceIds = [];
    for (const step of FLOW_ORDER) {
      for (const [, rels] of aiFiles) {
        const hit = rels.find((r) => r.relationship === step);
        if (!hit) continue;
        const ev = evidence.find(
          (e) => e.filePath === hit.sourceFile && e.evidenceType === step
        );
        workflow.push({ step, evidenceId: ev?.evidenceId });
        if (ev) evidenceIds.push(ev.evidenceId);
      }
    }
    features.push({
      featureKey: "ai-analysis-pipeline",
      name: "AI analysis pipeline",
      workflow,
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: [...new Set(evidenceIds)],
      confidence: workflow.length >= 3 ? "high" : workflow.length >= 2 ? "medium" : "low"
    });
  }
  const apiCalls = relationships.filter((r) => r.relationship === "calls_api");
  const routes = relationships.filter((r) => r.relationship === "routes_to");
  if (apiCalls.length && routes.length) {
    const workflow = [
      { step: "frontend_api_call", evidenceId: evidence.find((e) => e.evidenceType === "calls_api")?.evidenceId },
      { step: "backend_route", evidenceId: evidence.find((e) => e.evidenceType === "route")?.evidenceId }
    ].filter((w) => w.evidenceId);
    features.push({
      featureKey: "frontend-backend-api",
      name: "Frontend to backend API flow",
      workflow,
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: workflow.map((w) => w.evidenceId).filter(Boolean),
      confidence: workflow.length >= 2 ? "medium" : "low"
    });
  }
  const db2 = relationships.filter(
    (r) => r.relationship === "reads_database" || r.relationship === "writes_database"
  );
  if (db2.length) {
    features.push({
      featureKey: "data-access",
      name: "Data access layer",
      workflow: db2.slice(0, 5).map((r) => ({
        step: r.relationship,
        evidenceId: evidence.find((e) => e.filePath === r.sourceFile)?.evidenceId
      })),
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: evidence.filter((e) => db2.some((d) => d.sourceFile === e.filePath)).map((e) => e.evidenceId),
      confidence: "medium"
    });
  }
  return features;
}
function buildEvidenceChains(features) {
  return features.map((f) => ({
    chainKey: `chain-${f.featureKey}`,
    name: f.name,
    orderedEvidenceIds: f.workflow.map((w) => w.evidenceId).filter((id) => Boolean(id)),
    featureKey: f.featureKey
  }));
}

// _shared/v2/engine.ts
function progressFor(status) {
  return V2_STAGE_PROGRESS[status] ?? 0;
}
async function loadChunksForSubmission(submissionId) {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submissionId);
  if (!loaded) return null;
  const pathByFileId = new Map(
    loaded.files.map((f) => [f.id, f.path])
  );
  const chunks = (loaded.chunks ?? []).map((c) => ({
    file_path: pathByFileId.get(String(c.file_id)) ?? "",
    start_line: c.start_line,
    content: String(c.content ?? "")
  })).filter((c) => c.file_path);
  return { loaded, chunks };
}
async function runV2Pipeline(runId, submissionId, githubUrl) {
  try {
    await updateRunStatus(runId, "scanning_repository", {
      progress_percent: progressFor("scanning_repository")
    });
    await logStage(runId, "scanning_repository", "Repository scan");
    const scanOutcome = await analyzeSubmission(submissionId, githubUrl);
    if (scanOutcome.status === "failed") {
      await updateRunStatus(runId, "failed", {
        error_code: scanOutcome.code ?? "scan_failed",
        error_message: scanOutcome.error ?? "Scan failed",
        completed_at: (/* @__PURE__ */ new Date()).toISOString(),
        progress_percent: 100
      });
      return;
    }
    const loadedBundle = await loadChunksForSubmission(submissionId);
    if (!loadedBundle) {
      await updateRunStatus(runId, "failed", {
        error_message: "Could not load scanned repository.",
        completed_at: (/* @__PURE__ */ new Date()).toISOString()
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
      file_count: loaded.files?.length ?? 0
    });
    await updateRunStatus(runId, "building_code_graph", {
      progress_percent: progressFor("building_code_graph")
    });
    resetEvidenceCounter();
    const byPath = contentByPath(chunks);
    const treeEntries = loaded.files.map((f) => ({
      path: f.path,
      size: f.file_size
    }));
    treeEntries.push(...[...byPath.keys()].filter((p) => !treeEntries.some((e) => e.path === p)).map((p) => ({
      path: p,
      size: byPath.get(p)?.length ?? 0
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
      if (file.content) file.contentHash = await sha256Hex2(file.content.slice(0, 8e3));
    }
    const evidence = await compileEvidence(files, relationships);
    const features = discoverFeatureWorkflows(relationships, evidence);
    const chains = buildEvidenceChains(features);
    await updateRunStatus(runId, "discovering_features", {
      progress_percent: progressFor("discovering_features")
    });
    const { data: submissionRow } = await (await Promise.resolve().then(() => (init_http(), http_exports))).db().from("submissions").select("hackathon_id, project_description, problem_statement").eq("id", submissionId).single();
    const hackathon = await loadHackathon(String(submissionRow?.hackathon_id ?? ""));
    const requirementMap = await getRequirementMap(String(hackathon.id ?? submissionId), hackathon);
    const requirements = mapRequirements(requirementMap, evidence, features);
    const claims = [
      String(submissionRow?.project_description ?? ""),
      String(submissionRow?.problem_statement ?? "")
    ];
    const claimRows = mapClaims(claims, evidence, features);
    await updateRunStatus(runId, "verifying", { progress_percent: progressFor("verifying") });
    const filePathSet = new Set(files.map((f) => f.path));
    const hackathonContext = JSON.stringify({
      requirements: (requirementMap.requirements ?? []).slice(0, 12).map((r) => ({ id: r.id, text: r.text }))
    });
    const reqPacket = await buildEvidencePacket({
      subjectIds: requirements.slice(0, 8).map((r) => r.requirementId),
      evidence,
      files,
      relationships,
      seedEvidenceIds: requirements.flatMap((r) => r.evidenceIds).slice(0, 20)
    });
    const archPacket = await buildEvidencePacket({
      subjectIds: features.map((f) => f.featureKey),
      evidence,
      files,
      relationships,
      seedEvidenceIds: features.flatMap((f) => f.evidenceIds).slice(0, 24)
    });
    const techPacket = await buildEvidencePacket({
      subjectIds: ["security", "database", "testing"],
      evidence: evidence.filter(
        (e) => ["reads_database", "route", "behavior"].includes(e.evidenceType) || e.filePath?.includes("test")
      ),
      files,
      relationships: relationships.filter(
        (r) => ["reads_database", "calls_api", "tests"].includes(r.relationship)
      ),
      seedEvidenceIds: evidence.filter((e) => e.level !== "metadata").slice(0, 16).map((e) => e.evidenceId)
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
      round: 1
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
      round: 1
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
      round: 1
    }));
    const missing = verificationResults.flatMap((v) => v.verdict?.missing_links ?? []).slice(0, 1);
    if (missing.length) {
      const adaptivePacket = await buildEvidencePacket({
        subjectIds: ["adaptive"],
        evidence,
        files,
        relationships,
        seedEvidenceIds: reqPacket.evidenceIds,
        missingLink: missing[0]
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
        round: 2
      }));
    }
    await updateRunStatus(runId, "validating", { progress_percent: progressFor("validating") });
    const linesInspected = files.reduce((n, f) => n + (f.content ? f.content.split("\n").length : 0), 0);
    const aiTokens = verificationResults.reduce((n, v) => n + v.inputTokens + v.outputTokens, 0);
    const functionalFiles = files.filter((f) => f.importanceScore >= 0.35 && f.content).length;
    const coverageLevel = functionalFiles > 20 ? "high" : functionalFiles > 8 ? "medium" : "low";
    const summary = {
      headline: `${repoName} \u2014 repository intelligence summary`,
      implementation_summary: features.length ? `Detected ${features.length} workflow candidate(s) from code relationships and implementation evidence.` : "Structural inventory completed; no strong workflow chains detected.",
      strong_points: features.filter((f) => f.confidence === "high").map((f) => f.name),
      uncertainties: verificationResults.flatMap((v) => v.verdict?.missing_links ?? []).slice(0, 8).map((m) => ({ title: m, detail: "Additional evidence needed to confirm end-to-end behavior." })),
      defense_questions: features.slice(0, 5).map((f) => `Explain how "${f.name}" works across the codebase.`)
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
        ...techPacket.evidenceIds
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
        ai_cost_usd: 0
      },
      summary
    });
    const finalStatus = verificationResults.some((v) => v.status === "provider_error") ? "partial" : "completed";
    await updateRunStatus(runId, finalStatus, {
      progress_percent: 100,
      coverage_level: coverageLevel,
      completed_at: (/* @__PURE__ */ new Date()).toISOString()
    });
    await (await Promise.resolve().then(() => (init_http(), http_exports))).db().from("analysis_runs").update({
      repository_id: repository.id,
      commit_sha: commitSha
    }).eq("id", runId);
  } catch (error) {
    await updateRunStatus(runId, "failed", {
      error_message: error.message?.slice(0, 500) ?? "V2 pipeline failed",
      completed_at: (/* @__PURE__ */ new Date()).toISOString(),
      progress_percent: 100
    });
    await logStage(runId, "failed", error.message);
  }
}
async function startV2Analysis(submissionId, githubUrl) {
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
  const cachedRun = commitSha ? await findCachedRun(submissionId, commitSha, V2_SCANNER_VERSION, V2_ANALYSIS_VERSION) : null;
  if (cachedRun) {
    await (await Promise.resolve().then(() => (init_http(), http_exports))).db().from("submissions").update({
      latest_analysis_run_id: cachedRun
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
    repositoryId: repo.id ?? null,
    scannerVersion: V2_SCANNER_VERSION,
    analysisVersion: V2_ANALYSIS_VERSION,
    promptVersion: V2_PROMPT_VERSION
  });
  const job = runV2Pipeline(runId, submissionId, githubUrl);
  if (EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job);
  else await job;
  return { run_id: runId, status: EdgeRuntime?.waitUntil ? "queued" : "completed" };
}
async function getV2Status(submissionId) {
  const { data, error } = await (await Promise.resolve().then(() => (init_http(), http_exports))).db().rpc("analysis_run_status", {
    p_submission_id: submissionId
  });
  if (error) return null;
  return data;
}

// analysis/index.ts
init_security();
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
    // The browser needs to know whether the analysis can run at all.
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
    case "analyze": {
      const onlyTask = body?.only_task ? [String(body.only_task)] : null;
      return json(
        await runAnalysisFor(
          submission,
          onlyTask,
          caller
        )
      );
    }
    case "retry-task": {
      const task = String(body?.task ?? "");
      if (!task) throw new HttpError("A task name is required.", 400);
      return json(
        await runAnalysisFor(
          submission,
          [task],
          caller
        )
      );
    }
    case "diagnostics":
      return json(await diagnosticsFor(submissionId, caller));
    case "start-v2":
      if (!githubUrl) throw new HttpError("Add a GitHub repository URL first.", 400);
      return json(await startV2Analysis(submissionId, githubUrl), 202);
    case "status-v2":
      return json({ ...await getV2Status(submissionId), ai_available: aiConfigured() });
    case "summary-v2": {
      const { data, error } = await db().rpc("v2_analysis_summary", {
        p_submission_id: submissionId
      });
      if (error) throw new HttpError("Could not load V2 summary.", 500);
      return json(data ?? { ready: false });
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
  return {
    ...outcome,
    state: outcome.status
  };
}
async function runAnalysisFor(submission, onlyTasks, caller) {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submission.id);
  if (!loaded || !["completed", "limited"].includes(loaded.repository.analysis_status)) {
    throw new HttpError("Analyse the repository before running the analysis.", 409);
  }
  if (!aiConfigured()) {
    throw new HttpError(
      "The analysis is not configured on this deployment. Add DEEPSEEK_API_KEY as an edge function secret; repository analysis still works without it.",
      503
    );
  }
  const hackathon = await loadHackathon(submission.hackathon_id);
  const requirementMap = await getRequirementMap(submission.hackathon_id, hackathon);
  const vocabulary = briefVocabulary(requirementMap);
  const concepts = [
    ...(requirementMap.requirements ?? []).map(
      (entry) => analyseRequirement(entry.text, vocabulary, requirementMap)
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
      artifacts: []
    }
  ];
  const datasetProfiles = (loaded.datasetProfiles ?? []).map(
    (profile) => rescoreRelevance(profile, concepts)
  );
  const outcome = await runAnalysis({
    submission,
    hackathon,
    repository: loaded.repository,
    files: loaded.files,
    chunks: loaded.chunks,
    evidence: loaded.evidence ?? [],
    projectMap: loaded.projectMap,
    datasetProfiles,
    semantics: loaded.semantics,
    routes: loaded.routes,
    inspection: loaded.inspection,
    actorId: caller.id,
    sessionId: submission.session_id,
    onlyTasks
  });
  return {
    status: outcome.status,
    review_id: outcome.reviewId,
    plan: outcome.plan.summary,
    requirements_enabled: outcome.plan.requirementsEnabled,
    dimensions: outcome.plan.dimensions.filter((dimension2) => dimension2.relevance !== "not_applicable").map((dimension2) => ({
      key: dimension2.key,
      label: dimension2.label,
      relevance: dimension2.relevance,
      reason: dimension2.reason
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
      repairs: task.repairs
    })),
    conclusions: outcome.conclusions.map((row) => ({
      id: row.subject_id,
      kind: row.kind,
      status: row.status,
      confidence: row.confidence,
      evidence_ids: row.evidence_ids,
      method: row.method
    })),
    diagnostics: outcome.diagnostics,
    diff: outcome.diff,
    error: outcome.error ?? null
  };
}
async function diagnosticsFor(submissionId, caller) {
  if (caller.role !== "admin") {
    throw new HttpError("Diagnostics are available to administrators only.", 403);
  }
  const { data, error } = await db().from("analysis_snapshots").select(
    "id, commit_sha, hackathon_version, analysis_version, created_at, plan, conclusions, evidence_count, input_tokens, output_tokens, cached_tokens, estimated_cost_usd"
  ).eq("submission_id", submissionId).order("created_at", { ascending: false }).limit(5);
  if (error) throw new HttpError("Could not load diagnostics.", 500);
  const { data: usage } = await db().from("ai_usage").select("operation, status, input_tokens, output_tokens, cached_tokens, estimated_cost_usd, prompt_version, created_at, error_code").eq("submission_id", submissionId).order("created_at", { ascending: false }).limit(100);
  return {
    submission_id: submissionId,
    runs: data ?? [],
    ai_usage: usage ?? []
  };
}
Deno.serve(
  withErrorHandling((req, url) => {
    if (req.method === "GET") return readAnalysis(req, url);
    if (req.method === "POST") return act(req);
    return fail("Method not allowed.", 405);
  })
);
