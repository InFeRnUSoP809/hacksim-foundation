/**
 * Adaptive verification plan — which groups run, and whether AI is needed.
 */

import type { EngineVerifyTaskKind } from "../constants.ts";

export type VerificationTaskPlan = {
  kind: EngineVerifyTaskKind;
  key: string;
  reason: string;
  useAi: boolean;
};

const TASK_ALIASES: Record<string, EngineVerifyTaskKind> = {
  brief: "brief",
  brief_verification: "brief",
  implementation: "implementation",
  implementation_verification: "implementation",
  engineering: "engineering",
  engineering_verification: "engineering",
  claims: "claims",
  claim_verification: "claims",
  contributions: "claims",
  retry_brief: "brief",
};

export function normalizeVerifyTaskName(raw: string): EngineVerifyTaskKind | null {
  const key = raw.trim().toLowerCase().replace(/-/g, "_");
  return TASK_ALIASES[key] ?? null;
}

export function planVerificationTasks(input: {
  projectMap: Record<string, unknown>;
  requirementCount: number;
  constraintCount?: number;
  outcomeCount?: number;
  criterionCount?: number;
  hasBriefContext?: boolean;
  memberCount: number;
  onlyTasks?: EngineVerifyTaskKind[] | null;
}): VerificationTaskPlan[] {
  const workflows = (input.projectMap.implementation_workflows ?? []) as unknown[];
  const behaviors = (input.projectMap.implementation_behaviors ?? []) as { kind?: string }[];
  const coverage = (input.projectMap.analysis_coverage ?? {}) as Record<string, number>;
  const backend = (input.projectMap.backend ?? {}) as { endpoint_count?: number };
  const databases = (input.projectMap.database ?? {}) as { technologies?: string[] };
  const auth = (input.projectMap.authentication ?? {}) as { detected?: string[] };

  const hasL3 = behaviors.some((b) =>
    ["ai_api_call", "parse_json", "limit_collection", "database_write", "prompt_construction"]
      .includes(String(b.kind))
  );
  const hasWorkflows = workflows.length > 0;
  const hasEngineeringSignals =
    (backend.endpoint_count ?? 0) > 0 ||
    (databases.technologies?.length ?? 0) > 0 ||
    (auth.detected?.length ?? 0) > 0 ||
    (coverage.files_deeply_read ?? 0) > 3;

  const briefContext = input.hasBriefContext ??
    (
      input.requirementCount > 0 ||
      (input.constraintCount ?? 0) > 0 ||
      (input.outcomeCount ?? 0) > 0 ||
      (input.criterionCount ?? 0) > 0
    );

  const all: VerificationTaskPlan[] = [
    {
      kind: "brief",
      key: "brief",
      reason: briefContext
        ? "Problem alignment and brief subjects"
        : "No hackathon brief subjects — brief AI skipped",
      useAi: briefContext,
    },
    {
      kind: "implementation",
      key: "implementation",
      reason: hasWorkflows || hasL3
        ? "L3 behaviors and implementation workflows present"
        : "No L3 workflow signal — skipped",
      useAi: hasWorkflows || hasL3,
    },
    {
      kind: "engineering",
      key: "engineering",
      reason: hasEngineeringSignals
        ? "Backend, data, or auth signals present"
        : "Minimal engineering surface — skipped",
      useAi: hasEngineeringSignals,
    },
    {
      kind: "claims",
      key: "claims",
      reason: input.memberCount > 0
        ? "Team member contribution statements present"
        : "No member contributions — skipped",
      useAi: input.memberCount > 0,
    },
  ];

  const filtered = input.onlyTasks?.length
    ? all.filter((t) => input.onlyTasks!.includes(t.kind))
    : all;

  return filtered.filter((t) => t.useAi);
}
