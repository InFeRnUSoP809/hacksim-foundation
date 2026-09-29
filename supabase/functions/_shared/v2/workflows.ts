import type { V2EvidenceItem, V2FeatureCandidate, V2Relationship } from "./types.ts";

const FLOW_ORDER = [
  "loads_prompt",
  "calls_ai_provider",
  "parses_response",
  "persists_result",
  "calls_api",
  "routes_to",
  "reads_database",
  "calls",
] as const;

export function discoverFeatureWorkflows(
  relationships: V2Relationship[],
  evidence: V2EvidenceItem[],
): V2FeatureCandidate[] {
  const features: V2FeatureCandidate[] = [];
  const byFile = new Map<string, V2Relationship[]>();
  for (const rel of relationships) {
    const list = byFile.get(rel.sourceFile) ?? [];
    list.push(rel);
    byFile.set(rel.sourceFile, list);
  }

  // AI pipeline feature: prompt → provider → parse → persist
  const aiFiles = [...byFile.entries()].filter(([, rels]) =>
    rels.some((r) => r.relationship === "calls_ai_provider")
  );
  if (aiFiles.length) {
    const workflow: V2FeatureCandidate["workflow"] = [];
    const evidenceIds: string[] = [];
    for (const step of FLOW_ORDER) {
      for (const [, rels] of aiFiles) {
        const hit = rels.find((r) => r.relationship === step);
        if (!hit) continue;
        const ev = evidence.find((e) =>
          e.filePath === hit.sourceFile && e.evidenceType === step
        );
        workflow.push({ step, evidenceId: ev?.evidenceId });
        if (ev) evidenceIds.push(ev.evidenceId);
      }
    }
    features.push({
      featureKey: "ai-analysis-pipeline",
      name: "AI analysis pipeline",
      workflow,
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: [...new Set(evidenceIds)],
      confidence: workflow.length >= 3 ? "high" : workflow.length >= 2 ? "medium" : "low",
    });
  }

  // Full-stack API flow
  const apiCalls = relationships.filter((r) => r.relationship === "calls_api");
  const routes = relationships.filter((r) => r.relationship === "routes_to");
  if (apiCalls.length && routes.length) {
    const workflow = [
      { step: "frontend_api_call", evidenceId: evidence.find((e) => e.evidenceType === "calls_api")?.evidenceId },
      { step: "backend_route", evidenceId: evidence.find((e) => e.evidenceType === "route")?.evidenceId },
    ].filter((w) => w.evidenceId);
    features.push({
      featureKey: "frontend-backend-api",
      name: "Frontend to backend API flow",
      workflow,
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: workflow.map((w) => w.evidenceId!).filter(Boolean),
      confidence: workflow.length >= 2 ? "medium" : "low",
    });
  }

  // UI-heavy apps (forms, survey flows) — from implementation/ui semantics, not README
  const uiEvidence = evidence.filter((e) =>
    e.level === "implementation" && (e.detail?.kind === "ui" || e.claim.includes("displays") || e.claim.includes("form")),
  );
  if (uiEvidence.length >= 2 && !features.some((f) => f.featureKey === "ui-interaction-flow")) {
    features.push({
      featureKey: "ui-interaction-flow",
      name: "UI interaction flow",
      workflow: uiEvidence.slice(0, 6).map((e) => ({ step: "ui_behavior", evidenceId: e.evidenceId })),
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: uiEvidence.map((e) => e.evidenceId),
      confidence: uiEvidence.length >= 4 ? "medium" : "low",
    });
  }

  // Database access feature
  const db = relationships.filter((r) =>
    r.relationship === "reads_database" || r.relationship === "writes_database"
  );
  if (db.length) {
    features.push({
      featureKey: "data-access",
      name: "Data access layer",
      workflow: db.slice(0, 5).map((r) => ({
        step: r.relationship,
        evidenceId: evidence.find((e) => e.filePath === r.sourceFile)?.evidenceId,
      })),
      entrySymbolKeys: [],
      symbolKeys: [],
      evidenceIds: evidence.filter((e) => db.some((d) => d.sourceFile === e.filePath)).map((e) => e.evidenceId),
      confidence: "medium",
    });
  }

  return features;
}

export function buildEvidenceChains(
  features: V2FeatureCandidate[],
): { chainKey: string; name: string; orderedEvidenceIds: string[]; featureKey?: string }[] {
  return features.map((f) => ({
    chainKey: `chain-${f.featureKey}`,
    name: f.name,
    orderedEvidenceIds: f.workflow.map((w) => w.evidenceId).filter((id): id is string => Boolean(id)),
    featureKey: f.featureKey,
  }));
}
