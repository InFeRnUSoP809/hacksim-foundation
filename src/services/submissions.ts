import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import type {
  Submission,
  SubmissionMemberWithProfile,
  SubmissionStatus,
} from "@/types";

const SUBMISSION_COLUMNS =
  "id, session_id, hackathon_id, team_id, submitted_by, project_name, project_description, github_url, live_demo_url, tech_stack, key_features, status, submitted_at, created_at, updated_at";

// ── URL validation (shape only — Phase 4 never fetches either URL) ───────────

const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
const HTTP_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/;

/** Returns an error message, or null when the URL looks right. */
export function validateGithubUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!GITHUB_RE.test(trimmed)) {
    return "Enter a GitHub repository URL, like https://github.com/user/repo";
  }
  return null;
}

export function validateHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!HTTP_RE.test(trimmed)) {
    return "Enter a full URL starting with http:// or https://";
  }
  return null;
}

// ── Draft lifecycle ─────────────────────────────────────────────────────────

/** The submission for a session, or null if no draft has been started. */
export async function getSubmission(
  sessionId: string,
): Promise<Submission | null> {
  const { data, error } = await supabase
    .from("submissions")
    .select(SUBMISSION_COLUMNS)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) {
    // A missing draft is a normal state, not a failure.
    if (/no rows/i.test(error.message)) return null;
    throw new Error(friendlyError(error, "Couldn't load the submission."));
  }
  return (data as Submission | null) ?? null;
}

/**
 * Creates the draft if it does not exist yet. Idempotent — calling it twice is
 * harmless, and it will never resurrect a finalised submission.
 */
export async function ensureDraft(sessionId: string): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_draft_submission", {
    p_session_id: sessionId,
  });
  if (error) throw new Error(friendlyError(error, "Couldn't start the submission."));
  return data as string;
}

export interface DraftInput {
  projectName: string;
  projectDescription: string;
  githubUrl: string;
  liveDemoUrl: string;
  techStack: string;
  keyFeatures: string;
}

/** Saves the project-level draft. Refused once the submission is finalised. */
export async function saveDraft(
  sessionId: string,
  input: DraftInput,
): Promise<string> {
  const githubError = validateGithubUrl(input.githubUrl);
  if (githubError) throw new Error(githubError);

  const demoError = validateHttpUrl(input.liveDemoUrl);
  if (demoError) throw new Error(demoError);

  if (!input.projectName.trim()) {
    throw new Error("Project name is required.");
  }

  const { data, error } = await supabase.rpc("save_submission_draft", {
    p_session_id: sessionId,
    p_project_name: input.projectName,
    p_project_description: input.projectDescription,
    p_github_url: input.githubUrl,
    p_live_demo_url: input.liveDemoUrl,
    p_tech_stack: input.techStack,
    p_key_features: input.keyFeatures,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't save the draft."));
  return data as string;
}

// ── Contributions ───────────────────────────────────────────────────────────

/** Row shape returned by the `submission_roster` SQL function. */
interface RosterRow {
  member_id: string;
  user_id: string;
  full_name: string | null;
  email: string;
  team_role: string;
  contribution_description: string;
  contribution_areas: string[] | null;
  planned_responsibilities: string;
  ai_tools_used: string;
  ai_usage_description: string;
}

/** Every member's contribution for a submission. */
export async function getSubmissionMembers(
  submissionId: string,
): Promise<SubmissionMemberWithProfile[]> {
  const { data, error } = await supabase.rpc("submission_roster", {
    p_submission_id: submissionId,
  });
  if (error) {
    throw new Error(friendlyError(error, "Couldn't load the contributions."));
  }

  return ((data ?? []) as RosterRow[]).map((row) => ({
    id: row.member_id,
    submission_id: submissionId,
    user_id: row.user_id,
    contribution_description: row.contribution_description,
    contribution_areas: row.contribution_areas ?? [],
    planned_responsibilities: row.planned_responsibilities,
    ai_tools_used: row.ai_tools_used,
    ai_usage_description: row.ai_usage_description,
    created_at: "",
    updated_at: "",
    full_name: row.full_name,
    email: row.email,
    team_role: row.team_role,
  }));
}

export interface ContributionInput {
  contributionDescription: string;
  contributionAreas: string[];
  plannedResponsibilities: string;
  aiToolsUsed: string;
  aiUsageDescription: string;
}

/** Saves only the caller's own contribution row. */
export async function saveMyContribution(
  submissionId: string,
  input: ContributionInput,
): Promise<void> {
  const { error } = await supabase.rpc("save_my_contribution", {
    p_submission_id: submissionId,
    p_contribution_description: input.contributionDescription,
    p_contribution_areas: input.contributionAreas,
    p_planned_responsibilities: input.plannedResponsibilities,
    p_ai_tools_used: input.aiToolsUsed,
    p_ai_usage_description: input.aiUsageDescription,
  });

  if (error) {
    throw new Error(
      friendlyError(error, "Couldn't save your contribution."),
    );
  }
}

// ── Finalisation ────────────────────────────────────────────────────────────

/**
 * Finalises the submission and locks it. The database sets `submitted_at` from
 * its own clock and refuses any later edit; the UI's read-only state mirrors
 * that rather than being the thing that enforces it.
 */
export async function finalizeSubmission(sessionId: string): Promise<string> {
  const { data, error } = await supabase.rpc("finalize_submission", {
    p_session_id: sessionId,
  });
  if (error) throw new Error(friendlyError(error, "Couldn't submit the project."));
  return data as string;
}

export function isLocked(status: SubmissionStatus): boolean {
  return status === "submitted";
}

/** Reads one submission by its own id. Used by the admin detail view. */
export async function getSubmissionById(
  id: string,
): Promise<Submission | null> {
  const { data, error } = await supabase
    .from("submissions")
    .select(SUBMISSION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(friendlyError(error, "Couldn't load the submission."));
  return (data as Submission | null) ?? null;
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface AdminSubmissionRow {
  id: string;
  session_id: string;
  project_name: string;
  team_name: string;
  hackathon_name: string;
  status: SubmissionStatus;
  github_url: string | null;
  live_demo_url: string | null;
  submitted_at: string | null;
  member_count: number;
}

export async function listSubmissionsForAdmin(): Promise<AdminSubmissionRow[]> {
  const { data, error } = await supabase.rpc("admin_submissions");
  if (error) throw new Error(friendlyError(error, "Couldn't load submissions."));

  return ((data ?? []) as AdminSubmissionRow[]).map((row) => ({
    ...row,
    member_count: Number(row.member_count ?? 0),
  }));
}
