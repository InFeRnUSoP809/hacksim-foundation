/**
 * HackSim AI operations — admin only (§68–§77).
 *
 * Routes:
 *
 *   GET  ?view=overview | usage | errors | budgets | settings | forecast
 *       | cache-analytics | preflight
 *   GET  ?view=request&request_id=…      one request with its cost breakdown
 *   POST {view:"budget", payload}         create or update a budget
 *   POST {view:"budget-delete", budget_id}  delete a budget
 *   POST {view:"model", payload}          create or update a model config
 *   POST {view:"kill-switch", enabled}    §55 — stop/start new AI calls
 *
 * Everything reads and writes with the service client, because these are the
 * tables RLS deliberately closes to students (§90). No response in this module
 * ever contains an API key or a provider credential — the key is a Supabase
 * secret, not a database row, and there is nothing here that could reveal it.
 */

import {
  db,
  fail,
  getCaller,
  HttpError,
  json,
  requireAdmin,
  withErrorHandling,
} from "../_shared/http.ts";
import { budgetLevel, hasDeepseek, loadBudget, settings, utilization } from "../_shared/ai.ts";

function windowStart(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function budgetView(row: Record<string, unknown> | null | undefined) {
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
    level:
      ratio >= 1 ? "stop" : ratio >= 0.8 ? "critical" : ratio >= 0.5 ? "warning" : "normal",
    enabled: row.enabled !== false,
  };
}

async function usageSummary(days: number): Promise<Record<string, unknown>> {
  const { data } = await db().rpc("ai_usage_summary", { p_since: windowStart(days) });
  return (data ?? {}) as Record<string, unknown>;
}

async function userEmails(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await db().from("profiles").select("id, email").in("id", ids);
  return new Map(
    ((data ?? []) as { id: string; email: string }[]).map((row) => [row.id, row.email]),
  );
}

async function projectNames(ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const { data } = await db().from("submissions").select("id, project_name").in("id", ids);
  return new Map(
    ((data ?? []) as { id: string; project_name: string | null }[]).map((row) => [
      row.id,
      row.project_name || null,
    ]),
  );
}

// ── Views ──────────────────────────────────────────────────────────────────

async function overview(url: URL) {
  const days = intParam(url, "days", 30, 1, 365);
  const summary = await usageSummary(days);

  const inputTokens = Number(summary.input_tokens ?? 0);
  const cachedTokens = Number(summary.cached_tokens ?? 0);
  const totalCost = Number(summary.total_cost ?? 0);
  const requests = Number(summary.requests ?? 0);

  const [{ data: analyses }, { data: spend }, { data: budgets }] = await Promise.all([
    db().from("ai_analyses").select("id").eq("status", "success"),
    db().from("ai_usage").select("submission_id").eq("status", "success").not("submission_id", "is", null),
    db().from("ai_budgets").select("*").eq("scope", "global").limit(1),
  ]);

  const globalBudget = ((budgets ?? []) as Record<string, unknown>[])[0];
  const distinctSubmissions = new Set(
    ((spend ?? []) as { submission_id: string }[]).map((row) => row.submission_id),
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
    average_cost_per_submission: distinctSubmissions
      ? Number((totalCost / distinctSubmissions).toFixed(6))
      : 0,
    successful_analyses: (analyses ?? []).length,
    error_codes: summary.error_codes ?? {},
    global_budget: budgetView(globalBudget),
  };
}

async function usage(url: URL) {
  const days = intParam(url, "days", 30, 1, 365);
  const limit = intParam(url, "limit", 100, 1, 500);
  const offset = intParam(url, "offset", 0, 0, 1_000_000);

  let query = db()
    .from("ai_usage")
    .select(
      "id, created_at, user_id, submission_id, repository_id, operation, provider, " +
        "model, input_tokens, output_tokens, total_tokens, cached_tokens, " +
        "estimated_cost_usd, status, error_code, duration_ms, request_id",
      { count: "exact" },
    )
    .gte("created_at", windowStart(days));

  const operation = url.searchParams.get("operation");
  const model = url.searchParams.get("model");
  const statusFilter = url.searchParams.get("status");
  const submissionId = url.searchParams.get("submission_id");
  if (operation) query = query.eq("operation", operation);
  if (model) query = query.eq("model", model);
  if (statusFilter) query = query.eq("status", statusFilter);
  if (submissionId) query = query.eq("submission_id", submissionId);

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new HttpError(error.message, 400);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  const emails = await userEmails(rows.map((r) => r.user_id as string).filter(Boolean));
  const names = await projectNames(
    rows.map((r) => r.submission_id as string).filter(Boolean),
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      user_email: emails.get(row.user_id as string) ?? null,
      project_name: names.get(row.submission_id as string) ?? null,
    })),
    count: count ?? rows.length,
    limit,
    offset,
  };
}

async function requestDetail(requestId: string) {
  const { data } = await db()
    .from("ai_usage")
    .select("*")
    .eq("request_id", requestId)
    .limit(1);
  const row = ((data ?? []) as Record<string, unknown>[])[0];
  if (!row) throw new HttpError("That request was not found.", 404);

  const { data: pricingRows } = await db()
    .from("ai_model_configs")
    .select("*")
    .eq("provider", (row.provider as string) ?? "deepseek")
    .eq("model_name", (row.model as string) ?? "")
    .limit(1);
  const price = ((pricingRows ?? []) as Record<string, unknown>[])[0] ?? {};

  const hit = Number(price.input_price_per_million_cache_hit ?? 0);
  const miss = Number(price.input_price_per_million_cache_miss ?? 0);
  const out = Number(price.output_price_per_million ?? 0);
  const portion = (tokens: number, pricePerMillion: number) =>
    Number(((tokens * pricePerMillion) / 1_000_000).toFixed(8));

  const cached = Number(row.cached_tokens ?? 0);
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
      error_message: row.error_message,
    },
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      total: row.total_tokens,
      cached,
      cache_miss: missTokens,
    },
    cost: {
      cache_hit: portion(cached, hit),
      cache_miss: portion(missTokens, miss),
      output: portion(output, out),
      total: Number(row.estimated_cost_usd ?? 0),
    },
    pricing: {
      input_price_per_million_cache_hit: hit,
      input_price_per_million_cache_miss: miss,
      output_price_per_million: out,
    },
  };
}

async function errors(url: URL) {
  const days = intParam(url, "days", 30, 1, 365);
  const limit = intParam(url, "limit", 100, 1, 500);

  const { data } = await db()
    .from("ai_usage")
    .select(
      "id, created_at, operation, model, status, error_code, error_message, duration_ms",
    )
    .gte("created_at", windowStart(days))
    .in("status", ["failed", "rejected"])
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const code = (row.error_code as string) || "unknown";
    counts[code] = (counts[code] ?? 0) + 1;
  }

  return { rows, counts, total: rows.length };
}

async function listBudgets() {
  const { data } = await db().from("ai_budgets").select("*").order("scope");
  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  const names = await projectNames(
    rows.map((r) => r.submission_id as string).filter(Boolean),
  );
  const emails = await userEmails(rows.map((r) => r.user_id as string).filter(Boolean));

  return {
    budgets: rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      user_id: row.user_id ?? null,
      submission_id: row.submission_id ?? null,
      project_name: names.get(row.submission_id as string) ?? null,
      user_email: emails.get(row.user_id as string) ?? null,
      max_cost_usd: row.max_cost_usd === null ? null : Number(row.max_cost_usd),
      max_input_tokens: row.max_input_tokens ?? null,
      max_output_tokens: row.max_output_tokens ?? null,
      max_requests: row.max_requests ?? null,
      used_cost_usd: Number(row.used_cost_usd ?? 0),
      used_input_tokens: Number(row.used_input_tokens ?? 0),
      used_output_tokens: Number(row.used_output_tokens ?? 0),
      used_requests: Number(row.used_requests ?? 0),
      enabled: row.enabled !== false,
      view: budgetView(row),
    })),
  };
}

/**
 * §77 preflight — is the analysis pipeline actually able to run?
 *
 * The failure this exists to catch is the quiet one: a function deployed
 * without its secrets. Nothing throws, no scan ever starts, and the only
 * symptom is a page that never loads. So this pokes the real providers rather
 * than reporting whether a variable is non-empty — "the key is set" and "the
 * key works" are different claims, and only the second one is worth anything.
 *
 * GitHub is checked with a real authenticated request, because an invalid or
 * expired token still *is* a set string. DeepSeek is checked by confirming a
 * price row exists, because that is the failure a deploy cannot fix: a missing
 * model is a refusal, not a free tier. The key itself is never sent, never
 * echoed and never timed — an admin learns whether it works, nothing more.
 */
async function preflight() {
  const s = settings();
  const checks: Record<string, unknown>[] = [];

  // ── GitHub: one authenticated request, rate-limit headers are the payload ──
  const started = Date.now();
  let githubOk = false;
  let githubDetail = "";
  const rate: Record<string, number> = {};

  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HackSim-Preflight",
    };
    if (s.githubToken) headers.Authorization = `Bearer ${s.githubToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), s.githubTimeoutSeconds * 1000);
    let response: Response;
    try {
      response = await fetch(`${s.githubApiBase}/rate_limit`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const read = (name: string) => {
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
      githubDetail = "GitHub refused the request — usually the token lacks access or the IP is blocked.";
    } else if (!githubOk) {
      githubDetail = `GitHub answered ${response.status}.`;
    } else if (!s.githubToken) {
      githubDetail =
        "Reachable without a token: only 60 requests/hour, which a real repository exhausts. Add GITHUB_TOKEN.";
    } else {
      githubDetail = "Token accepted.";
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    githubDetail = aborted
      ? `No answer within ${s.githubTimeoutSeconds}s. Check GITHUB_API_BASE.`
      : `Could not reach GitHub: ${(error as Error)?.message ?? error}`;
  }

  checks.push({
    name: "github",
    ok: githubOk,
    detail: githubDetail,
    token_configured: Boolean(s.githubToken),
    latency_ms: Date.now() - started,
    rate_limit: rate,
  });

  // ── DeepSeek: configuration and pricing, without spending a token ─────────
  const { data: modelRows } = await db()
    .from("ai_model_configs")
    .select("provider, model_name, enabled, is_default")
    .eq("is_default", true)
    .limit(1);
  const model = ((modelRows ?? []) as Record<string, unknown>[])[0];

  checks.push({
    name: "deepseek",
    // Configured but unpriced is still broken, so both must hold.
    ok: hasDeepseek() && Boolean(model),
    detail: !hasDeepseek()
      ? "DEEPSEEK_API_KEY is not set. Phase 5 still works; Phase 6 is refused."
      : !model
      ? "No default model row. Run supabase/005_model_pricing.sql — a missing model is a refusal, not a default."
      : `Key present, default model ${model.provider}/${model.model_name}.`,
    key_configured: hasDeepseek(),
    model_priced: Boolean(model),
  });

  const { data: globalBudgets } = await db()
    .from("ai_budgets")
    .select("enabled, max_cost_usd")
    .eq("scope", "global")
    .limit(1);
  const globalBudget = ((globalBudgets ?? []) as Record<string, unknown>[])[0];
  const killSwitchOn = globalBudget ? globalBudget.enabled !== false : true;

  checks.push({
    name: "kill_switch",
    ok: killSwitchOn,
    detail: killSwitchOn ? "AI calls are permitted." : "The kill switch is on: every AI call is rejected.",
  });

  const configured = checks.filter((c) => c.ok).length;
  return {
    ok: checks.every((c) => c.ok),
    checks_passed: `${configured}/${checks.length}`,
    checks,
  };
}

async function settingsPage() {
  const [{ data: models }, { data: budgets }] = await Promise.all([
    db().from("ai_model_configs").select("*").order("is_default", { ascending: false }),
    db().from("ai_budgets").select("*").eq("scope", "global").limit(1),
  ]);

  const globalBudget = ((budgets ?? []) as Record<string, unknown>[])[0];
  return {
    models: models ?? [],
    global_budget: globalBudget ?? null,
    kill_switch: { ai_enabled: globalBudget ? globalBudget.enabled !== false : true },
  };
}

async function forecast() {
  const { data } = await db().rpc("ai_cost_forecast");
  return { ...((data ?? {}) as Record<string, unknown>), basis: "historical_average", is_estimate: true };
}

async function cacheAnalytics(url: URL) {
  const days = intParam(url, "days", 30, 1, 365);
  const summary = await usageSummary(days);
  const inputTokens = Number(summary.input_tokens ?? 0);
  const cached = Number(summary.cached_tokens ?? 0);
  const miss = Math.max(0, inputTokens - cached);

  const { data: pricingRows } = await db()
    .from("ai_model_configs")
    .select("*")
    .eq("is_default", true)
    .limit(1);
  const price = ((pricingRows ?? []) as Record<string, unknown>[])[0];

  let savings = 0;
  if (price) {
    const hit = Number(price.input_price_per_million_cache_hit ?? 0);
    const missPrice = Number(price.input_price_per_million_cache_miss ?? 0);
    const saved = (miss * (missPrice - hit)) / 1_000_000;
    savings = Number(Math.max(0, saved).toFixed(8));
  }

  return {
    window_days: days,
    cached_tokens: cached,
    uncached_tokens: miss,
    cache_hit_rate: inputTokens ? Number((cached / inputTokens).toFixed(4)) : 0,
    estimated_cache_savings_usd: savings,
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────

async function saveBudget(payload: Record<string, unknown>) {
  const scope = String(payload.scope ?? "");
  if (!["global", "user", "submission"].includes(scope)) {
    throw new HttpError("Unknown budget scope.", 400);
  }

  const fields: Record<string, unknown> = {
    scope,
    user_id: payload.user_id ?? null,
    submission_id: payload.submission_id ?? null,
    max_cost_usd: payload.max_cost_usd ?? null,
    max_input_tokens: payload.max_input_tokens ?? null,
    max_output_tokens: payload.max_output_tokens ?? null,
    max_requests: payload.max_requests ?? null,
    enabled: payload.enabled !== false,
  };

  // A budget without a target would silently never apply.
  if (scope === "user" && !fields.user_id) {
    throw new HttpError("A user budget needs a user id.", 400);
  }
  if (scope === "submission" && !fields.submission_id) {
    throw new HttpError("A submission budget needs a submission id.", 400);
  }

  const id = payload.id ? String(payload.id) : null;
  const { error } = id
    ? await db().from("ai_budgets").update(fields).eq("id", id)
    : await db().from("ai_budgets").insert(fields);
  if (error) throw new HttpError("Could not save the budget.", 400);

  return json({ ok: true });
}

async function saveModel(payload: Record<string, unknown>) {
  const provider = String(payload.provider ?? "");
  const modelName = String(payload.model_name ?? "");
  if (!provider || !modelName) {
    throw new HttpError("Provider and model are required.", 400);
  }

  const fields: Record<string, unknown> = {
    provider,
    model_name: modelName,
    enabled: payload.enabled !== false,
    is_default: Boolean(payload.is_default),
    input_price_per_million_cache_hit: payload.input_price_per_million_cache_hit ?? 0,
    input_price_per_million_cache_miss: payload.input_price_per_million_cache_miss ?? 0,
    output_price_per_million: payload.output_price_per_million ?? 0,
    max_input_tokens: Number(payload.max_input_tokens ?? 32000),
    max_output_tokens: Number(payload.max_output_tokens ?? 4000),
    reasoning_mode: payload.reasoning_mode || "off",
  };

  // Write the row first, then demote the others. Clearing first and writing
  // second is not atomic: if the write fails, the project is left with no
  // default model at all, and a missing default is a refusal of every AI call
  // — a single failed save would silently switch the whole system off.
  const id = payload.id ? String(payload.id) : null;
  const { error, data } = id
    ? await db().from("ai_model_configs").update(fields).eq("id", id).select("id").single()
    : await db()
        .from("ai_model_configs")
        .upsert(fields, { onConflict: "provider,model_name" })
        .select("id")
        .single();
  if (error) throw new HttpError("Could not save the model settings.", 400);

  if (fields.is_default) {
    const savedId = (data as { id?: string } | null)?.id;
    // Only one default at a time. Scoped to the row just written, so a
    // concurrent admin editing a different model is not reverted wholesale.
    let demote = db().from("ai_model_configs").update({ is_default: false }).eq("is_default", true);
    if (savedId) demote = demote.neq("id", savedId);
    const { error: demoteError } = await demote;
    if (demoteError) {
      throw new HttpError(
        "The model was saved but could not be made the only default. Check that no " +
          "other model is still flagged as default.",
        400,
      );
    }
  }

  return json({ ok: true });
}

/** §55 — off means no new AI calls; existing analysis stays visible. */
async function setKillSwitch(enabled: boolean) {
  const { data } = await db().from("ai_budgets").select("id").eq("scope", "global").limit(1);
  const existing = ((data ?? []) as { id: string }[])[0];

  const { error } = existing
    ? await db().from("ai_budgets").update({ enabled }).eq("id", existing.id)
    : await db().from("ai_budgets").insert({ scope: "global", enabled });
  if (error) throw new HttpError("Could not change the kill switch.", 400);

  return json({ ok: true, ai_enabled: enabled });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

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
          return json(await preflight());
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
          // What the gate would see right now, for one submission.
          const snapshot = await loadBudget(url.searchParams.get("submission_id"));
          return json({
            ...snapshot,
            utilization: Number(utilization(snapshot).toFixed(4)),
            level: budgetLevel(snapshot),
          });
        }
        default:
          return fail("Unknown view.", 400);
      }
    }

    if (req.method === "POST") {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const view = String(body?.view ?? "");
      switch (view) {
        case "budget":
          return saveBudget((body?.payload ?? {}) as Record<string, unknown>);
        case "budget-delete": {
          const { error } = await db()
            .from("ai_budgets")
            .delete()
            .eq("id", String(body?.budget_id ?? ""));
          if (error) throw new HttpError("Could not delete the budget.", 400);
          return json({ ok: true });
        }
        case "model":
          return saveModel((body?.payload ?? {}) as Record<string, unknown>);
        case "kill-switch":
          return setKillSwitch(Boolean(body?.enabled));
        default:
          return fail("Unknown view.", 400);
      }
    }

    return fail("Method not allowed.", 405);
  }),
);
