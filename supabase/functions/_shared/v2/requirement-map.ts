import type { RequirementMap } from "../requirements.ts";
import type { V2EvidenceItem, V2FeatureCandidate, VerdictStatus } from "./types.ts";
import { implementationEvidence } from "./evidence.ts";

export interface RequirementLinkRow {
  requirementId: string;
  kind: string;
  status: VerdictStatus;
  confidence: string;
  explanation: string;
  uncertainties: string[];
  evidenceIds: string[];
  workflowIds: string[];
}

function seedTerms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3).slice(0, 12);
}

function scoreRequirement(
  text: string,
  impl: V2EvidenceItem[],
  features: V2FeatureCandidate[],
): { evidenceIds: string[]; workflowIds: string[]; status: VerdictStatus; explanation: string; confidence: string } {
  const terms = seedTerms(text);
  const matched = impl.filter((e) => {
    const blob = `${e.claim} ${e.filePath ?? ""} ${e.symbolName ?? ""}`.toLowerCase();
    return terms.some((t) => blob.includes(t));
  });
  const workflows = features.filter((f) =>
    f.name.toLowerCase().split(/\s+/).some((w) => terms.includes(w)) ||
    matched.some((m) => f.evidenceIds.includes(m.evidenceId)),
  );

  if (matched.length >= 2 && workflows.length >= 1) {
    return {
      evidenceIds: matched.slice(0, 8).map((m) => m.evidenceId),
      workflowIds: workflows.slice(0, 2).map((w) => w.featureKey),
      status: "partially_confirmed",
      confidence: "medium",
      explanation: "Implementation and workflow evidence connected to requirement keywords; AI verification required for confirmation.",
    };
  }
  if (matched.length >= 1) {
    return {
      evidenceIds: matched.slice(0, 6).map((m) => m.evidenceId),
      workflowIds: workflows.slice(0, 1).map((w) => w.featureKey),
      status: "weakly_evidenced",
      confidence: "low",
      explanation: "Some implementation evidence matches requirement themes; insufficient workflow proof without verification.",
    };
  }
  return {
    evidenceIds: [],
    workflowIds: [],
    status: "unable_to_determine",
    confidence: "low",
    explanation: "No implementation evidence strongly linked to this requirement from deterministic mapping.",
  };
}

export function mapRequirements(
  requirementMap: RequirementMap,
  evidence: V2EvidenceItem[],
  features: V2FeatureCandidate[],
): RequirementLinkRow[] {
  const impl = implementationEvidence(evidence);
  const rows: RequirementLinkRow[] = [];
  for (const req of requirementMap.requirements ?? []) {
    const scored = scoreRequirement(req.text, impl, features);
    rows.push({
      requirementId: req.id,
      kind: "requirement",
      status: scored.status,
      confidence: scored.status === "partially_confirmed" ? "medium" : "low",
      explanation: scored.explanation,
      uncertainties: scored.status === "unable_to_determine"
        ? ["Insufficient deterministic linkage; verification may add evidence."]
        : [],
      evidenceIds: scored.evidenceIds,
      workflowIds: scored.workflowIds,
    });
  }
  return rows;
}

export function mapClaims(
  claims: string[],
  evidence: V2EvidenceItem[],
  features: V2FeatureCandidate[],
): { claimText: string; status: VerdictStatus; confidence: string; explanation: string; evidenceIds: string[]; chainKeys: string[] }[] {
  const impl = implementationEvidence(evidence);
  return claims.filter(Boolean).map((claim) => {
    const scored = scoreRequirement(claim, impl, features);
    return {
      claimText: claim,
      status: scored.status,
      confidence: scored.confidence ?? "low",
      explanation: scored.explanation,
      evidenceIds: scored.evidenceIds,
      chainKeys: scored.workflowIds.map((w) => `chain-${w}`),
    };
  });
}
