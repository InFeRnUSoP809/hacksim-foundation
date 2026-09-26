/** The two roles HackSim recognises today. */
export const ROLES = ["student", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Row shape of the public `profiles` table (see supabase/001_profiles.sql). */
export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export function isAdmin(profile: Profile | null): boolean {
  return profile?.role === "admin";
}

/**
 * The five stages of a simulated hackathon, in the order they run.
 * The `hue` maps to a stage colour token in index.css — colour is the stage
 * identity across the whole product.
 */
export const STAGES = [
  {
    id: "build",
    label: "Build",
    hue: "var(--stage-build)",
    summary: "Turn a brief into a working prototype against the clock.",
  },
  {
    id: "submit",
    label: "Submit",
    hue: "var(--stage-submit)",
    summary: "Package the work and hand it in before the deadline.",
  },
  {
    id: "present",
    label: "Present",
    hue: "var(--stage-present)",
    summary: "Pitch the idea in five minutes and hold the room.",
  },
  {
    id: "defend",
    label: "Defend",
    hue: "var(--stage-defend)",
    summary: "Answer an AI panel that pushes on your weakest points.",
  },
  {
    id: "report",
    label: "Report",
    hue: "var(--stage-report)",
    summary: "Get a written read on how the whole run went.",
  },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export function stageById(id: StageId) {
  return STAGES.find((stage) => stage.id === id) ?? STAGES[0];
}

// ── Hackathons ──────────────────────────────────────────────────────────────

export const HACKATHON_STATUSES = ["draft", "active", "archived"] as const;
export type HackathonStatus = (typeof HACKATHON_STATUSES)[number];

export interface Hackathon {
  id: string;
  name: string;
  problem_statement: string;
  requirements: string;
  constraints: string;
  expected_outcome: string;
  evaluation_criteria: string;
  simulation_duration_minutes: number;
  status: HackathonStatus;
  practice_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** The fields an admin can edit. */
export type HackathonDraft = Omit<
  Hackathon,
  "id" | "practice_enabled" | "created_at" | "updated_at"
>;

// ── Teams ───────────────────────────────────────────────────────────────────

/** Contribution areas a team member can claim. Kept open-ended by design. */
export const CONTRIBUTION_AREAS = [
  "Frontend",
  "Backend",
  "Database",
  "AI/ML",
  "UI/UX",
  "DevOps",
  "Research",
  "Product",
  "Hardware",
  "Testing",
  "Documentation",
  "Other",
] as const;

export type ContributionArea = (typeof CONTRIBUTION_AREAS)[number];

export interface Team {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

/** A team member joined to the profile fields the UI displays. */
export interface TeamMemberWithProfile extends TeamMember {
  full_name: string | null;
  email: string;
}

// ── Build sessions ──────────────────────────────────────────────────────────

export const SESSION_STATUSES = [
  "not_started",
  "running",
  "break",
  "completed",
  "expired",
  "submitted",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses a session can still be resumed from. */
export const LIVE_STATUSES: SessionStatus[] = ["running", "break"];

export function isLive(status: SessionStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

export interface BuildSession {
  id: string;
  hackathon_id: string;
  team_id: string;
  started_by: string;
  started_at: string;
  ends_at: string;
  break_ends_at: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
}

/** A session joined to the names the admin tables need. */
export interface SessionWithNames extends BuildSession {
  hackathon_name: string;
  team_name: string;
  started_by_name: string;
}

/** The authoritative clock, always computed by Postgres. */
export interface SessionState {
  status: SessionStatus;
  remaining_seconds: number;
  break_remaining_seconds: number;
  server_now: string;
}

// ── Checkpoints ─────────────────────────────────────────────────────────────

export const CHECKPOINT_TYPES = [
  "planning",
  "building",
  "progress",
  "remaining_work",
  "final_preparation",
] as const;
export type CheckpointType = (typeof CHECKPOINT_TYPES)[number];

/** Order, label and prompt for each checkpoint in the build. */
export const CHECKPOINTS: {
  type: CheckpointType;
  label: string;
  question: string;
}[] = [
  {
    type: "planning",
    label: "Planning",
    question: "What are you planning to build?",
  },
  {
    type: "building",
    label: "Building",
    question: "What are you currently implementing?",
  },
  {
    type: "progress",
    label: "Progress",
    question: "What have you completed so far?",
  },
  {
    type: "remaining_work",
    label: "Remaining Work",
    question: "What is still left to complete?",
  },
  {
    type: "final_preparation",
    label: "Final Preparation",
    question: "What are you preparing before submission?",
  },
];

export interface BuildCheckpoint {
  id: string;
  session_id: string;
  checkpoint_type: CheckpointType;
  response: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Submissions ─────────────────────────────────────────────────────────────

export const SUBMISSION_STATUSES = ["draft", "submitted"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export interface Submission {
  id: string;
  session_id: string;
  hackathon_id: string;
  team_id: string;
  submitted_by: string;
  project_name: string;
  project_description: string;
  github_url: string | null;
  live_demo_url: string | null;
  tech_stack: string;
  key_features: string;
  status: SubmissionStatus;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One person's contribution and AI disclosure within a submission. */
export interface SubmissionMember {
  id: string;
  submission_id: string;
  user_id: string;
  contribution_description: string;
  contribution_areas: string[];
  planned_responsibilities: string;
  ai_tools_used: string;
  ai_usage_description: string;
  created_at: string;
  updated_at: string;
}

/** A submission member joined to their profile fields. */
export interface SubmissionMemberWithProfile extends SubmissionMember {
  full_name: string | null;
  email: string;
  /** Their team role, for display alongside the contribution. */
  team_role: string;
}
