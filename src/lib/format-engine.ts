/**
 * The scenario/format engine, seen from the browser.
 *
 * Everything in here is a thin, typed wrapper around a Postgres function from
 * `007_scenario_engine_rpcs.sql`. The rules themselves live in the database:
 * this file never decides when a window opens, which fields a format requires,
 * or whether a wildcard may be revealed — it calls the RPC and renders whatever
 * comes back. That is §1's "no hardcoded scenarios" and §13.3's "never trust
 * the browser clock" applied to the client: a UI that decides is a UI that can
 * be lied to.
 *
 * Read paths (`session_brief`, `session_clock`) go straight to Postgres. Write
 * paths go through the same functions too — there is no edge-function hop for
 * the timer, because the timer is the database's own.
 */

import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";

// ── Types ───────────────────────────────────────────────────────────────────

/** §1.1 — every supported format. Drives the whole participant experience. */
export const HACKATHON_TYPES = [
  "problem_statement",
  "open_innovation",
  "theme_based",
  "industry_scenario",
  "government_public_problem",
  "technology_challenge",
  "wildcard",
  "custom",
] as const;

export type HackathonType = (typeof HACKATHON_TYPES)[number];

export const HACKATHON_TYPE_LABELS: Record<HackathonType, string> = {
  problem_statement: "Problem Statement",
  open_innovation: "Open Innovation",
  theme_based: "Theme Based",
  industry_scenario: "Industry Scenario",
  government_public_problem: "Government / Public Problem",
  technology_challenge: "Technology Challenge",
  wildcard: "Wildcard",
  custom: "Custom",
};

/**
 * The submission fields a format requires, exactly as `required_fields_for_type`
 * names them. This union must grow when a new field name is added to that
 * function — which is the point: the compiler, not a missed test, catches the
 * mismatch.
 */
export type RequiredField =
  | "project_name"
  | "project_description"
  | "solution"
  | "key_features"
  | "tech_stack"
  | "github_url"
  | "live_demo_url"
  | "contributions"
  | "identified_problem"
  | "why_it_matters"
  | "target_users"
  | "pain_point"
  | "proposed_solution"
  | "expected_outcome"
  | "ai_tools_used"
  | "theme"
  | "problem"
  | "theme_alignment"
  | "scenario_interpretation"
  | "business_problem"
  | "constraints"
  | "public_problem"
  | "affected_users"
  | "technology"
  | "why_selected"
  | "problem_solved"
  | "implementation";

export const REQUIRED_FIELD_LABELS: Record<RequiredField, string> = {
  project_name: "Project name",
  project_description: "Project description",
  solution: "Solution",
  key_features: "Key features",
  tech_stack: "Tech stack",
  github_url: "GitHub repository",
  live_demo_url: "Live demo URL",
  contributions: "Individual contributions",
  identified_problem: "Identified problem",
  why_it_matters: "Why it matters",
  target_users: "Target users",
  pain_point: "Pain point",
  proposed_solution: "Proposed solution",
  expected_outcome: "Expected outcome",
  ai_tools_used: "AI tools used",
  theme: "Theme",
  problem: "Problem",
  theme_alignment: "Theme alignment",
  scenario_interpretation: "Scenario interpretation",
  business_problem: "Business / user problem",
  constraints: "Constraints",
  public_problem: "Public problem",
  affected_users: "Affected users / community",
  technology: "Technology",
  why_selected: "Why this technology",
  problem_solved: "Problem solved",
  implementation: "Implementation",
};

/**
 * Where a session is in time, computed by `session_clock` on the database
 * clock. The seconds are snapshots — the UI may tick them down locally, but
 * every phase boundary in here is server-derived and is never recomputed
 * client-side.
 */
export interface SessionClock {
  session_id: string;
  status: string;
  started_at: string | null;
  build_ends_at: string | null;
  github_submission_started_at: string | null;
  github_submission_ends_at: string | null;
  build_seconds_remaining: number;
  github_window_seconds_remaining: number;
  build_elapsed: boolean;
  github_window_open: boolean;
  can_edit_build: boolean;
  /** Part 20 — the session's own snapshot of the configured window. */
  github_submission_window_enabled: boolean;
  github_submission_window_minutes: number;
}

/** §1.4 — what a participant may see about their hackathon, per format. */
export interface SessionBrief {
  hackathon: {
    id: string;
    name: string;
    description: string | null;
    hackathon_type: HackathonType;
    theme: string | null;
    domain: string | null;
    /** Null for wildcards that have not been revealed — by design, not by bug. */
    scenario: string | null;
    context: string | null;
    problem_statement: string | null;
    requirements: unknown;
    target_users: string | null;
    constraints: string | null;
    expected_outcome: string | null;
    expected_outcomes: unknown;
    evaluation_criteria: unknown;
    difficulty: string | null;
    hints: string[] | null;
    problem_discovery_required: boolean;
    ai_assistance_allowed: boolean;
  };
  required_fields: RequiredField[];
  clock: SessionClock;
  /** §3.7 — id only; the payload stays sealed until reveal is permitted. */
  wildcard_scenario_id: string | null;
}

export interface ProblemDiscovery {
  id: string;
  problem_statement: string;
  why_it_matters: string;
  target_users: string;
  pain_point: string;
  proposed_solution: string;
  expected_outcome: string;
  status: "draft" | "submitted" | "locked";
}

export interface WildcardReveal {
  id: string;
  title: string;
  is_wildcard: boolean;
  revealed_at?: string | null;
  payload: unknown;
}

export type EntityType =
  | "hackathon"
  | "simulation"
  | "submission"
  | "team"
  | "repository"
  | "project_knowledge"
  | "ai_analysis";

export type DeleteMode = "archive" | "delete" | "restore" | "permanent";

export interface DeletionImpact {
  entity_type: EntityType;
  entity_id: string;
  dependents: Record<string, number>;
}

export interface ManageEntityResult {
  ok: boolean;
  action?: string;
  entity_type?: EntityType;
  entity_id?: string;
  /** Present when the entity demands a typed confirmation first. */
  requires_confirmation?: boolean;
  expected?: string | null;
  reason?: string[] | string;
  blocked?: boolean;
}

export interface AuditLogRow {
  id: string;
  created_at: string;
  admin_user_id: string | null;
  admin_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

/**
 * Postgres error codes this module translates into a real answer instead of a
 * stack-trace-shaped shrug.
 */
const FRIENDLY: Record<string, string> = {
  "42501": "You do not have access to this simulation.",
  P0002: "That record was not found.",
  "22023": "That request is not valid for this record.",
};

function describeError(err: unknown, fallback: string): Error {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  return new Error(FRIENDLY[code] ?? friendlyError(err, fallback));
}

async function rpc<T>(fn: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw describeError(error, fallback);
  return data as T;
}

// ── Clock and phase (§13) ───────────────────────────────────────────────────

/** The single source of truth for where a session is in time. */
export async function getSessionClock(sessionId: string): Promise<SessionClock> {
  return rpc<SessionClock>("session_clock", { p_session_id: sessionId }, "Couldn't load the timer.");
}

/**
 * Advances the session through its phase boundaries — build expiry, window
 * expiry, submission — and returns the resulting status. Idempotent and safe
 * to poll: whoever calls first wins, everyone else sees it already done.
 */
export async function syncSessionPhase(sessionId: string): Promise<string> {
  return rpc<string>("sync_session_phase", { p_session_id: sessionId }, "Couldn't update the session.");
}

/**
 * Opens (or reports) the five-minute GitHub window. The five minutes are not
 * build time, and the answer is computed against `build_ends_at` on the server,
 * so a refreshed page or a doctored device clock cannot reopen it.
 */
export async function openGithubWindow(sessionId: string): Promise<string> {
  return rpc<string>("open_github_window", { p_session_id: sessionId }, "Couldn't open the submission window.");
}

/**
 * What a participant is allowed to see about their hackathon — the brief, the
 * required submission fields for the format, and the clock, in one call.
 */
export async function getSessionBrief(sessionId: string): Promise<SessionBrief> {
  return rpc<SessionBrief>("session_brief", { p_session_id: sessionId }, "Couldn't load the brief.");
}

// ── Wildcard (§1.4) ─────────────────────────────────────────────────────────

/**
 * Reveals a wildcard scenario — server-side only. The function refuses until
 * the build has ended, and the payload never leaves `hackathon_wildcards`
 * before that moment: not in the brief, not in page source, not in a
 * predictable endpoint.
 */
export async function revealWildcard(scenarioId: string): Promise<WildcardReveal> {
  return rpc<WildcardReveal>(
    "reveal_wildcard_scenario",
    { p_scenario_id: scenarioId },
    "That scenario has not been revealed yet.",
  );
}

// ── Problem discovery (§1.3) ────────────────────────────────────────────────

/**
 * Saves (or updates) the team's open-innovation draft. Idempotent: one draft
 * per session is enforced by a partial unique index, so a double-click cannot
 * create two. Refused once the problem is locked.
 */
export async function saveProblemDiscovery(
  sessionId: string,
  input: {
    problemStatement: string;
    whyItMatters: string;
    targetUsers: string;
    painPoint: string;
    proposedSolution: string;
    expectedOutcome: string;
  },
): Promise<string> {
  return rpc<string>(
    "save_problem_discovery",
    {
      p_session_id: sessionId,
      p_problem_statement: input.problemStatement,
      p_why_it_matters: input.whyItMatters,
      p_target_users: input.targetUsers,
      p_pain_point: input.painPoint,
      p_proposed_solution: input.proposedSolution,
      p_expected_outcome: input.expectedOutcome,
    },
    "Couldn't save your problem.",
  );
}

/**
 * Locks the problem — one-way, and only after the build has ended. Returns the
 * missing fields when the draft is incomplete, so the UI can point at the
 * exact inputs rather than showing a generic refusal.
 */
export async function lockProblemDiscovery(
  sessionId: string,
): Promise<{ ok: true; id: string } | { ok: false; missingFields: RequiredField[] }> {
  const result = await rpc<{
    ok: boolean;
    id?: string;
    missing_fields?: RequiredField[];
  }>(
    "lock_problem_discovery",
    { p_session_id: sessionId },
    "Couldn't lock the problem.",
  );
  if (result.ok) return { ok: true, id: result.id as string };
  return { ok: false, missingFields: result.missing_fields ?? [] };
}

// ── Submission lock (§13.5) ─────────────────────────────────────────────────

/**
 * The only path a submission takes to `submitted`. Idempotent: a retried click
 * returns the same answer rather than failing or duplicating. Returns
 * `analysis_required` when the caller should kick off background analysis.
 */
export async function lockSubmission(
  submissionId: string,
): Promise<{ ok: boolean; alreadySubmitted: boolean; analysisRequired: boolean }> {
  const result = await rpc<{
    ok: boolean;
    already_submitted?: boolean;
    analysis_required?: boolean;
  }>(
    "lock_submission",
    { p_submission_id: submissionId },
    "Couldn't submit the project.",
  );
  return {
    ok: Boolean(result.ok),
    alreadySubmitted: Boolean(result.already_submitted),
    analysisRequired: Boolean(result.analysis_required),
  };
}

// ── Phase derivation (server-derived only) ──────────────────────────────────

/**
 * Which submission surface to show, from the server's own clock.
 *
 * Deliberately takes the clock object, not the session's `status` string: the
 * status can lag reality until the next `sync`, while the booleans here are
 * computed from `now()` inside Postgres at the moment of the call.
 */
export function phaseOf(clock: SessionClock): "build" | "window" | "closed" | "done" {
  if (clock.status === "submitted" || clock.status === "cancelled") return "done";
  if (clock.github_window_open) return "window";
  if (clock.build_elapsed && !clock.github_window_open) return "closed";
  return "build";
}

/** Editing build content is a server decision; this only mirrors it. */
export function canEdit(clock: SessionClock): boolean {
  return clock.can_edit_build;
}

/** Submitting is only ever possible inside the server-derived window. */
export function canSubmit(clock: SessionClock): boolean {
  return phaseOf(clock) === "window";
}

// ── Countdown formatting ────────────────────────────────────────────────────

/** `mm:ss` under an hour, `h:mm:ss` above it. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// ── Deletion / data management (§15, Part 16) ───────────────────────────────

/**
 * What a delete would take with it. The UI must show this before asking for
 * confirmation — a silent cascade is the one failure §15.5 explicitly forbids.
 */
export async function getDeletionImpact(
  entityType: EntityType,
  entityId: string,
): Promise<DeletionImpact> {
  return rpc<DeletionImpact>(
    "deletion_impact",
    { p_entity_type: entityType, p_entity_id: entityId },
    "Couldn't calculate the impact of this deletion.",
  );
}

/**
 * Archive / soft delete / restore / permanent delete, in one call.
 *
 * Not a convenience — a guarantee. Every entity goes through this same function
 * so every caller gets the same permission checks, the same typed-confirmation
 * rule for high-impact records, and the same audit row. Hackathons require the
 * entity's name as `confirm`; project knowledge refuses permanent deletion.
 */
export async function manageEntity(
  entityType: EntityType,
  entityId: string,
  mode: DeleteMode,
  options: { reason?: string; confirm?: string } = {},
): Promise<ManageEntityResult> {
  return rpc<ManageEntityResult>(
    "manage_entity",
    {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_mode: mode,
      p_reason: options.reason ?? null,
      p_confirm: options.confirm ?? null,
    },
    "The operation could not be completed.",
  );
}

// ── Audit log (§15.12) ──────────────────────────────────────────────────────

/**
 * Reads the admin audit log through the `ai-admin` edge function, which
 * resolves admin e-mails with the service client — data the browser's own
 * token cannot see.
 */
export async function getAuditLog(params: { days?: number; limit?: number; offset?: number } = {}): Promise<{
  rows: AuditLogRow[];
  count: number;
}> {
  const query = new URLSearchParams({
    view: "audit-log",
    days: String(params.days ?? 30),
    limit: String(params.limit ?? 100),
    offset: String(params.offset ?? 0),
  });
  const { data, error } = await supabase.functions.invoke(`ai-admin?${query.toString()}`, {
    method: "GET",
  });
  if (error) throw new Error(friendlyError(error, "Couldn't load the audit log."));
  const payload = data as { rows?: AuditLogRow[]; count?: number } | null;
  return { rows: payload?.rows ?? [], count: payload?.count ?? 0 };
}

/** Permitted actions for an entity, for building the row menu. */
export function availableActions(entityType: EntityType, isDeleted: boolean): DeleteMode[] {
  if (isDeleted) return ["restore", "permanent"];
  if (entityType === "project_knowledge") return ["archive"];
  if (entityType === "ai_analysis") return ["permanent"];
  return ["archive", "delete"];
}

/** The phrase the typed-confirmation dialog asks for, per entity. */
export function confirmPhrase(entityType: EntityType, name: string): string {
  return entityType === "hackathon" ? name : "DELETE";
}
