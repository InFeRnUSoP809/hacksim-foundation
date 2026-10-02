import type { EvidenceRegistry } from "../infra/github.ts";
import type { DatasetProfile } from "../../datasets.ts";
import type { SemanticsResult } from "../../semantics.ts";

/** Register L0/L1 facts from structure scan (descriptive only). */
export function registerStructuralFacts(
  registry: EvidenceRegistry,
  input: {
    owner: string;
    repo: string;
    branch: string;
    commitSha: string;
    analysisMode: "full" | "limited";
    frameworks: { name: string; evidence: string; file?: string | null }[];
    dependencies: { package: string; category: string }[];
    routes: { method: string; path: string; file: string; framework: string }[];
  },
): void {
  registry.add({
    type: "repository",
    claim: `Repository ${input.owner}/${input.repo} frozen at commit ${input.commitSha.slice(0, 12)}`,
    confidence: "high",
    detail: { branch: input.branch, engine: "hacksim-analysis-v1" },
  });
  registry.add({
    type: "analysis_mode",
    claim: input.analysisMode === "limited" ? "Limited read set." : "Full read within budget.",
    confidence: "high",
  });
  for (const fw of input.frameworks.slice(0, 20)) {
    registry.add({
      type: "framework",
      claim: `${fw.name} referenced (${fw.evidence})`,
      file: fw.file ?? null,
      confidence: fw.file ? "high" : "medium",
      detail: { level: "L0" },
    });
  }
  for (const dep of input.dependencies.slice(0, 40)) {
    if (["utility", "testing"].includes(dep.category)) continue;
    registry.add({
      type: "dependency",
      claim: `Dependency \`${dep.package}\` (${dep.category})`,
      symbol: dep.package,
      confidence: "high",
      detail: { level: "L0" },
    });
  }
  for (const route of input.routes.filter((r) => r.framework !== "File-based routing").slice(0, 80)) {
    registry.add({
      type: "route",
      claim: `${route.method} ${route.path} declared`,
      file: route.file,
      confidence: "high",
      detail: { level: "L1" },
    });
  }
}

export function registerSemanticFacts(
  registry: EvidenceRegistry,
  semantics: SemanticsResult[],
): void {
  for (const file of semantics) {
    for (const item of file.calculations.slice(0, 4)) {
      registry.add({
        type: "calculation",
        claim: item.claim,
        file: file.path,
        symbol: item.symbol,
        lines: item.lines,
        confidence: "high",
        detail: { level: "L3", operation: item.operation },
      });
    }
    for (const item of file.rules.slice(0, 3)) {
      registry.add({
        type: "rule",
        claim: item.claim,
        file: file.path,
        symbol: item.symbol,
        lines: item.lines,
        confidence: "high",
        detail: { level: "L3" },
      });
    }
  }
}

export function registerBehaviorFacts(
  registry: EvidenceRegistry,
  behaviors: {
    kind: string;
    claim: string;
    file: string;
    symbol: string | null;
    start_line: number;
    end_line: number;
    level: string;
    id: string;
    excerpt: string;
    detail: Record<string, unknown>;
  }[],
): void {
  const typeFor = (kind: string): string => {
    if (kind === "structured_json_expected") return "structured_output";
    if (kind === "parse_json" || kind === "serialize_json") return "parsing";
    if (kind === "ai_api_call" || kind === "http_request") return "api_call";
    if (kind === "prompt_construction") return "prompt";
    if (kind === "database_read" || kind === "database_write") return "data_access";
    return "transformation";
  };
  for (const behavior of behaviors.slice(0, 120)) {
    registry.add({
      type: typeFor(behavior.kind),
      claim: behavior.claim,
      file: behavior.file,
      symbol: behavior.symbol,
      lines: `${behavior.start_line}-${behavior.end_line}`,
      confidence: behavior.level === "L3" ? "high" : "medium",
      detail: {
        behavior_id: behavior.id,
        kind: behavior.kind,
        level: behavior.level,
        excerpt: behavior.excerpt,
        ...behavior.detail,
      },
    });
  }
}

export function registerWorkflowFacts(
  registry: EvidenceRegistry,
  claims: {
    claim: string;
    file: string | null;
    symbol: string | null;
    lines: string;
    detail: Record<string, unknown>;
  }[],
): void {
  for (const item of claims.slice(0, 80)) {
    registry.add({
      type: "implementation_workflow",
      claim: item.claim,
      file: item.file,
      symbol: item.symbol,
      lines: item.lines,
      confidence: item.detail.confidence === "low" ? "low" : "high",
      detail: { level: "L3", ...item.detail },
    });
  }
}

export function registerDatasetFacts(registry: EvidenceRegistry, profiles: DatasetProfile[]): void {
  for (const profile of profiles.slice(0, 20)) {
    registry.add({
      type: "dataset_profile",
      claim:
        `Dataset \`${profile.path}\` (${profile.format}, ~${profile.approx_row_count} rows)`,
      file: profile.path,
      confidence: "high",
      detail: { level: "L1", columns: profile.column_names.slice(0, 12) },
    });
  }
}
