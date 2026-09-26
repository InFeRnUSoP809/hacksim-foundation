/**
 * Shared HTTP, auth and database helpers for the HackSim edge functions.
 *
 * Security model:
 *   * The Supabase platform verifies the caller's JWT before a function runs,
 *     so `Authorization` is trustworthy and the service-role client can be used
 *     internally. That key is never returned to the caller.
 *   * Authorisation is still re-checked here — a valid token proves who you
 *     are, not what you may touch. Every read re-checks team membership.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function fail(message: string, status = 400, extra?: unknown): Response {
  return json({ detail: message, ...(extra ? { extra } : {}) }, status);
}

export function preflight(): Response {
  return new Response("ok", { headers: corsHeaders });
}

// ── Clients ────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set on the edge function.`);
  return value;
}

let serviceClient: SupabaseClient | null = null;

/**
 * Service-role client. Server-side only — never returned to the browser.
 *
 * The row type is left open on purpose: this project has no generated
 * `Database` type, and supabase-js would otherwise hand every read a
 * `GenericStringError`. Each call site narrows its own rows, which keeps the
 * narrowing visible instead of hiding it behind one large generated type.
 */
export function db(): SupabaseClient<any> {
  if (!serviceClient) {
    serviceClient = createClient<any>(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return serviceClient;
}

export interface Caller {
  id: string;
  email: string;
  role: "student" | "admin";
}

let callerCache: { token: string; caller: Caller } | null = null;

/**
 * Resolve the caller from their bearer token. The role is read from
 * `profiles`, not from the token payload, so a promoted admin is never shown a
 * stale "student" state.
 */
export async function getCaller(req: Request): Promise<Caller | null> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  if (callerCache && callerCache.token === token) return callerCache.caller;

  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) return null;

  const user = data.user;
  const { data: profile } = await db()
    .from("profiles")
    .select("id, email, role")
    .eq("id", user.id)
    .maybeSingle();

  const caller: Caller = {
    id: user.id,
    email: profile?.email ?? user.email ?? "",
    role: profile?.role === "admin" ? "admin" : "student",
  };
  callerCache = { token, caller };
  return caller;
}

export function requireAdmin(caller: Caller | null): Caller {
  if (!caller) throw new HttpError("Invalid or expired session.", 401);
  if (caller.role !== "admin") {
    throw new HttpError("You are not authorized to perform this action.", 403);
  }
  return caller;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ── Domain guards ──────────────────────────────────────────────────────────

export interface Submission {
  id: string;
  session_id: string;
  hackathon_id: string;
  team_id: string;
  project_name: string | null;
  project_description: string | null;
  github_url: string | null;
  live_demo_url: string | null;
  tech_stack: string | null;
  key_features: string | null;
  status: string;
}

export async function loadSubmission(submissionId: string): Promise<Submission> {
  const { data, error } = await db()
    .from("submissions")
    .select(
      "id, session_id, hackathon_id, team_id, project_name, " +
        "project_description, github_url, live_demo_url, tech_stack, " +
        "key_features, status",
    )
    .eq("id", submissionId)
    .maybeSingle();

  if (error) throw new HttpError("Could not read the submission.", 500);
  if (!data) throw new HttpError("That submission was not found.", 404);
  return data as unknown as Submission;
}

/**
 * Admins pass. Everyone else must be on the session's team — resolved here,
 * not from anything the caller claims.
 */
export async function requireTeamAccess(
  submission: Submission,
  caller: Caller,
): Promise<void> {
  if (caller.role === "admin") return;

  const { data: session } = await db()
    .from("build_sessions")
    .select("team_id")
    .eq("id", submission.session_id)
    .maybeSingle();

  if (!session) throw new HttpError("That simulation was not found.", 404);

  const { data: membership } = await db()
    .from("team_members")
    .select("id")
    .eq("team_id", session.team_id)
    .eq("user_id", caller.id)
    .maybeSingle();

  if (!membership) {
    throw new HttpError("You are not authorized to perform this action.", 403);
  }
}

export async function loadHackathon(hackathonId: string) {
  const { data, error } = await db()
    .from("hackathons")
    .select("*")
    .eq("id", hackathonId)
    .maybeSingle();
  if (error) throw new HttpError("Could not read the hackathon.", 500);
  if (!data) throw new HttpError("That hackathon was not found.", 404);
  return data as Record<string, string>;
}

export async function loadMembers(submissionId: string) {
  // supabase-js infers `GenericStringError` for rows when the client has no
  // generated Database type, so every read is narrowed here rather than at each
  // use site.
  const { data: raw } = await db()
    .from("submission_members")
    .select(
      "id, user_id, contribution_description, contribution_areas, " +
        "planned_responsibilities, ai_tools_used, ai_usage_description",
    )
    .eq("submission_id", submissionId)
    .order("created_at");

  const members = (raw ?? []) as unknown as Omit<ContributionMember, "full_name" | "email">[];
  if (members.length === 0) return [];

  const { data: rawProfiles } = await db()
    .from("profiles")
    .select("id, full_name, email")
    .in(
      "id",
      members.map((m) => m.user_id).filter((id): id is string => Boolean(id)),
    );

  const profiles = (rawProfiles ?? []) as unknown as {
    id: string;
    full_name: string | null;
    email: string | null;
  }[];
  const byId = new Map(profiles.map((p) => [p.id, p]));

  return members.map((member) => {
    const profile = byId.get(member.user_id as string);
    return {
      ...member,
      full_name: profile?.full_name ?? null,
      email: profile?.email ?? null,
    };
  }) as ContributionMember[];
}

export interface ContributionMember {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  contribution_description: string | null;
  contribution_areas: string[] | null;
  planned_responsibilities: string | null;
  ai_tools_used: string | null;
  ai_usage_description: string | null;
}

/** Wraps a handler so thrown HttpErrors become clean JSON responses. */
export function withErrorHandling(
  handler: (req: Request, url: URL) => Response | Promise<Response>,
) {
  return async (req: Request): Promise<Response> => {
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
