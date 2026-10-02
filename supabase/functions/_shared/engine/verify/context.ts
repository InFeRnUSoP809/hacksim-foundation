/**
 * Compact verification context packets per group.
 */

import type { EvidenceSet } from "../../evidence.ts";
import type { RepoIndex } from "../retrieval/index.ts";
import type { EngineVerifyTaskKind } from "../constants.ts";

export interface VerifySharedContext {
  hackathonBlock: string;
  evidenceBlock: string;
  codeBlock: string;
  flowsBlock: string;
  graphBlock: string;
  coverageBlock: string;
  knownFiles: string[];
}

export function buildSharedVerifyContext(input: {
  hackathonBlock: string;
  evidenceSet: EvidenceSet;
  projectMap: Record<string, unknown>;
  codeSnippet: string;
  maxEvidence?: number;
}): VerifySharedContext {
  const maxEvidence = input.maxEvidence ?? 48;
  const evidenceBlock = input.evidenceSet.byId.size
    ? [...input.evidenceSet.byId.values()]
      .slice(0, maxEvidence)
      .map((e) => `[${e.id}] ${e.claim}`)
      .join("\n")
    : "(no evidence)";

  const flowsBlock = JSON.stringify(
    {
      flows: ((input.projectMap.flows ?? []) as unknown[]).slice(0, 6),
      implementation_workflows: ((input.projectMap.implementation_workflows ?? []) as unknown[])
        .slice(0, 6),
      behaviors: ((input.projectMap.implementation_behaviors ?? []) as unknown[]).slice(0, 24),
      chains: ((input.projectMap.evidence_chains ?? []) as unknown[]).slice(0, 6),
    },
    null,
    0,
  ).slice(0, 6000);

  const graph = (input.projectMap.graph ?? {}) as {
    relationships?: unknown[];
  };
  const graphBlock = JSON.stringify(
    { relationships: (graph.relationships ?? []).slice(0, 40) },
    null,
    0,
  ).slice(0, 3000);

  const coverage = (input.projectMap.analysis_coverage ?? {}) as Record<string, unknown>;
  const coverageBlock = JSON.stringify(coverage).slice(0, 1200);

  const files = ((input.projectMap.repository_stats as { file_count?: number } | undefined)) ??
    {};
  const knownFiles = Object.keys(
    ((input.projectMap as { file_index?: Record<string, unknown> }).file_index) ?? {},
  );
  void files;

  return {
    hackathonBlock: input.hackathonBlock.slice(0, 3500),
    evidenceBlock,
    codeBlock: input.codeSnippet.slice(0, 8000),
    flowsBlock,
    graphBlock,
    coverageBlock,
    knownFiles,
  };
}

export function packetForTask(
  kind: EngineVerifyTaskKind,
  shared: VerifySharedContext,
  extra: Record<string, string> = {},
): string {
  const parts = [`TASK: ${kind}`, shared.hackathonBlock];
  if (kind === "brief") {
    parts.push("FLOWS", shared.flowsBlock, "EVIDENCE", shared.evidenceBlock, "CODE", shared.codeBlock);
  }
  if (kind === "implementation") {
    parts.push(
      "IMPLEMENTATION WORKFLOWS AND BEHAVIORS",
      shared.flowsBlock,
      "GRAPH",
      shared.graphBlock,
      "EVIDENCE",
      shared.evidenceBlock,
      "CODE",
      shared.codeBlock,
      "COVERAGE",
      shared.coverageBlock,
    );
  }
  if (kind === "engineering") {
    parts.push(
      "STRUCTURE",
      shared.flowsBlock.slice(0, 2500),
      "EVIDENCE",
      shared.evidenceBlock,
      "CODE",
      shared.codeBlock.slice(0, 4000),
    );
  }
  if (kind === "claims") {
    parts.push("EVIDENCE", shared.evidenceBlock, "WORKFLOWS", shared.flowsBlock.slice(0, 3000));
  }
  for (const [k, v] of Object.entries(extra)) {
    parts.push(k, v);
  }
  return parts.join("\n\n").slice(0, 12000);
}

export function buildKnownFileSet(index: RepoIndex): Set<string> {
  return new Set(index.files.keys());
}
