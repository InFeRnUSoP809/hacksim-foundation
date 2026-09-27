/**
 * Hackathon context.
 *
 * Everything downstream is relative to *this* hackathon. A brief with explicit
 * requirements, a theme-only "open innovation" brief and a fully custom brief
 * are three different shapes of problem, and analysing them with one fixed
 * template is how a team gets marked down for not having a database they were
 * never asked for.
 *
 * So the first thing the pipeline does is read the hackathon and answer:
 *
 *   • what kind of challenge is this?
 *   • what problem, if any, is stated?
 *   • what does the organiser expect, and how explicitly?
 *   • what must not happen (constraints)?
 *   • what will the work be judged on (criteria)?
 *
 * The answer decides which analysis dimensions run at all. A hackathon with no
 * requirements gets no requirement analysis — not because requirements are
 * hard, but because inventing REQ-001 for a team that was asked to choose its
 * own problem would be inventing a requirement.
 */

import { shortHash } from "./ai.ts";
import type { RequirementMap } from "./requirements.ts";

export type HackathonType =
  | "problem_statement"
  | "open_innovation"
  | "theme_based"
  | "ai_ml"
  | "web"
  | "mobile"
  | "iot_hardware"
  | "data_science"
  | "security"
  | "blockchain"
  | "custom";

export const HACKATHON_TYPES: HackathonType[] = [
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
  "custom",
];

/**
 * Free-form is allowed on purpose. §5 of the product spec is explicit that the
 * list of types must not be hard-coded into the engine, so a hackathon row may
 * carry any label and it is carried through untouched.
 */
export function normaliseType(value: unknown): HackathonType | string {
  const raw = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return "problem_statement";
  return (HACKATHON_TYPES as string[]).includes(raw) ? raw : raw;
}

export interface HackathonContext {
  id: string;
  name: string;
  type: string;
  /** A short statement of what the organiser is actually asking for. */
  problem: string;
  hasProblem: boolean;
  theme: string | null;
  /** What the team says it built. */
  claims: { description: string; features: string; techStack: string };
  requirements: RequirementMap["requirements"];
  constraints: RequirementMap["constraints"];
  expectedOutcomes: RequirementMap["expected_outcomes"];
  evaluationCriteria: RequirementMap["evaluation_criteria"];
  /** False for open innovation. Drives whether requirement analysis runs. */
  hasRequirements: boolean;
  hasConstraints: boolean;
  hasOutcomes: boolean;
  hasCriteria: boolean;
  customInstructions: string | null;
  technologyRestrictions: string | null;
  datasetRequirements: string | null;
  deploymentRequirements: string | null;
  /** Anything the organiser wrote that is not one of the known fields. */
  freeformNotes: string[];
  /**
   * Identity of this configuration. Stored with every analysis so that
   * changing a brief later never silently rewrites what an old run concluded.
   */
  version: string;
  configVersion: number;
  snapshot: Record<string, unknown>;
}

function text(value: unknown, limit = 2000): string {
  return String(value ?? "").trim().slice(0, limit);
}

function list(value: unknown): string[] {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*+]\s*/, "").trim())
    .filter(Boolean);
}

export async function buildHackathonContext(
  hackathon: Record<string, unknown>,
  requirementMap: RequirementMap,
  submission: Record<string, unknown> | null,
): Promise<HackathonContext> {
  const problem = text(hackathon.problem_statement, 4000);
  const requirements = requirementMap.requirements ?? [];
  const constraints = requirementMap.constraints ?? [];
  const outcomes = requirementMap.expected_outcomes ?? [];
  const criteria = requirementMap.evaluation_criteria ?? [];

  // A hackathon row may carry organiser notes in any of several fields, and
  // unknown ones are collected rather than ignored — an organiser who wrote
  // something the engine does not model should still have it read.
  const known = new Set([
    "id", "name", "problem_statement", "requirements", "constraints",
    "expected_outcome", "evaluation_criteria", "hackathon_type", "theme",
    "custom_instructions", "technology_restrictions", "dataset_requirements",
    "deployment_requirements", "simulation_duration_minutes", "status",
    "practice_enabled", "config_version", "created_at", "updated_at",
    "description", "submission_rules", "hardware_requirements",
  ]);
  const freeformNotes: string[] = [];
  for (const [key, value] of Object.entries(hackathon)) {
    if (known.has(key)) continue;
    const body = text(value, 600);
    if (!body) continue;
    freeformNotes.push(`${key.replace(/_/g, " ")}: ${body}`);
  }

  const snapshot: Record<string, unknown> = {
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
    deployment_requirements: hackathon.deployment_requirements ?? null,
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
      techStack: text(submission?.tech_stack, 600),
    },
    requirements,
    constraints,
    expectedOutcomes: outcomes,
    evaluationCriteria: criteria,
    hasRequirements: requirements.length > 0,
    hasConstraints: constraints.length > 0,
    hasOutcomes: outcomes.length > 0,
    hasCriteria: criteria.length > 0,
    customInstructions: hackathon.custom_instructions
      ? text(hackathon.custom_instructions, 1500)
      : null,
    technologyRestrictions: hackathon.technology_restrictions
      ? text(hackathon.technology_restrictions, 800)
      : null,
    datasetRequirements: hackathon.dataset_requirements
      ? text(hackathon.dataset_requirements, 800)
      : null,
    deploymentRequirements: hackathon.deployment_requirements
      ? text(hackathon.deployment_requirements, 800)
      : null,
    freeformNotes: freeformNotes.slice(0, 8),
    version: await shortHash(JSON.stringify(snapshot)),
    configVersion: Number(hackathon.config_version ?? 1) || 1,
    snapshot,
  };
}

/** Bullet lines of a field, used for organiser-authored lists. */
export function fieldLines(hackathon: Record<string, unknown>, field: string): string[] {
  return list(hackathon[field]).slice(0, 30);
}
