/** The two roles HackSim recognises today. */
export const ROLES = ["student", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Row shape of the public `users` table (see supabase/schema.sql). */
export interface Profile {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
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
    tailwind: "text-stage-build",
    summary: "Turn a brief into a working prototype against the clock.",
  },
  {
    id: "submit",
    label: "Submit",
    hue: "var(--stage-submit)",
    tailwind: "text-stage-submit",
    summary: "Package the work and hand it in before the deadline.",
  },
  {
    id: "present",
    label: "Present",
    hue: "var(--stage-present)",
    tailwind: "text-stage-present",
    summary: "Pitch the idea in five minutes and hold the room.",
  },
  {
    id: "defend",
    label: "Defend",
    hue: "var(--stage-defend)",
    tailwind: "text-stage-defend",
    summary: "Answer an AI panel that pushes on your weakest points.",
  },
  {
    id: "report",
    label: "Report",
    hue: "var(--stage-report)",
    tailwind: "text-stage-report",
    summary: "Get a written read on how the whole run went.",
  },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export function stageById(id: StageId) {
  return STAGES.find((stage) => stage.id === id) ?? STAGES[0];
}

export type Difficulty = "Open" | "Intermediate" | "Advanced";

/**
 * One entry in the scenario catalog — a complete simulated hackathon a
 * participant can enrol in.
 */
export interface Scenario {
  id: string;
  title: string;
  sponsor: string;
  track: string;
  difficulty: Difficulty;
  /** Total simulated hours, e.g. 24 for a standard weekend event. */
  durationHours: number;
  teamSize: number;
  summary: string;
  /** Stages this scenario emphasises most heavily. */
  focus: StageId[];
  tags: string[];
  /** Seats left, or null for an open event. */
  seatsLeft: number | null;
  featured?: boolean;
}
