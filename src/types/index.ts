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
