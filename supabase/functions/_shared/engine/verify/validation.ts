/**
 * Post-AI validation for engine verification groups.
 */

import {
  filterCitations,
  type EvidenceSet,
} from "../../evidence.ts";
import {
  validateBriefVerification,
  validateClaims,
  type BriefVerificationPayload,
} from "../../validate.ts";
import { validateFindings } from "../../evidence.ts";

export interface ValidatedImplementationVerification {
  verification_type: "implementation";
  verdict: string;
  confidence: string;
  verification_level: string;
  implementation_summary: string;
  important_behaviors: { description: string; evidence_ids: string[] }[];
  verified_workflows: { workflow_id: string; evidence_ids: string[] }[];
  missing_links: string[];
  contradictions: string[];
  additional_files_needed: string[];
  runtime_verified: boolean;
  verification_complete: boolean;
  findings: ReturnType<typeof validateFindings>;
  errors: string[];
}

export interface ValidatedEngineeringVerification {
  verification_type: "engineering";
  architecture_summary: string;
  database_summary: string;
  security_summary: string;
  testing_summary: string;
  observations: {
    topic: string;
    status: string;
    summary: string;
    evidence_ids: string[];
    concern: string;
    improvement: string;
  }[];
  findings: ReturnType<typeof validateFindings>;
  additional_files_needed: string[];
  errors: string[];
}

export interface ValidatedClaimsVerification {
  verification_type: "claims";
  members: {
    member_id: string;
    status: string;
    evidence_ids: string[];
    explanation: string;
    relevant_files: string[];
    missing_links: string[];
  }[];
  errors: string[];
}

function stringList(raw: unknown, limit = 8): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, limit);
}

function workflowIds(projectMap: Record<string, unknown>): Set<string> {
  const workflows = (projectMap.implementation_workflows ?? []) as { id?: string }[];
  return new Set(workflows.map((w) => String(w.id ?? "")).filter(Boolean));
}

export function validateImplementationVerification(
  payload: unknown,
  evidence: EvidenceSet,
  projectMap: Record<string, unknown>,
  knownFiles: Set<string>,
): ValidatedImplementationVerification {
  const errors: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  const wfIds = workflowIds(projectMap);

  const summary = String(record.implementation_summary ?? record.summary ?? "").trim()
    .slice(0, 4000);
  if (summary.length < 20) errors.push("implementation_summary too short");

  let runtimeVerified = Boolean(record.runtime_verified);
  if (runtimeVerified) {
    runtimeVerified = false;
    errors.push("runtime_verified forced false for static analysis");
  }

  const importantRaw = Array.isArray(record.important_behaviors)
    ? record.important_behaviors
    : [];
  const important_behaviors: ValidatedImplementationVerification["important_behaviors"] = [];
  for (const item of importantRaw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const description = String(row.description ?? "").trim().slice(0, 800);
    if (description.length < 8) continue;
    const citations = filterCitations(row.evidence_ids, evidence);
    if (citations.rejected.length) {
      errors.push(`rejected evidence in behavior: ${citations.rejected.join(",")}`);
    }
    if (citations.accepted.length === 0) continue;
    important_behaviors.push({ description, evidence_ids: citations.accepted });
  }

  const wfRaw = Array.isArray(record.verified_workflows) ? record.verified_workflows : [];
  const verified_workflows: ValidatedImplementationVerification["verified_workflows"] = [];
  for (const item of wfRaw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const workflow_id = String(row.workflow_id ?? "").trim();
    if (!workflow_id || !wfIds.has(workflow_id)) {
      errors.push(`unknown workflow_id ${workflow_id}`);
      continue;
    }
    const citations = filterCitations(row.evidence_ids, evidence);
    verified_workflows.push({
      workflow_id,
      evidence_ids: citations.accepted,
    });
  }

  const additional = stringList(record.additional_files_needed, 4);
  for (const file of additional) {
    if (!knownFiles.has(file)) errors.push(`additional file not in index: ${file}`);
  }

  const verdict = String(record.verdict ?? "unable_to_determine").slice(0, 40);
  const confidence = String(record.confidence ?? "low").slice(0, 20);
  const verification_level = String(record.verification_level ?? "semantic").slice(0, 40);

  const findings = validateFindings(record.findings ?? null, evidence, "general");

  return {
    verification_type: "implementation",
    verdict,
    confidence,
    verification_level,
    implementation_summary: summary || "No implementation summary produced.",
    important_behaviors: important_behaviors.slice(0, 12),
    verified_workflows: verified_workflows.slice(0, 8),
    missing_links: stringList(record.missing_links, 10),
    contradictions: stringList(record.contradictions, 6),
    additional_files_needed: additional,
    runtime_verified: runtimeVerified,
    verification_complete: Boolean(record.verification_complete ?? important_behaviors.length > 0),
    findings,
    errors: errors.slice(0, 12),
  };
}

export function validateEngineeringVerification(
  payload: unknown,
  evidence: EvidenceSet,
  knownFiles: Set<string>,
): ValidatedEngineeringVerification {
  const errors: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  const text = (key: string) => String(record[key] ?? "").trim().slice(0, 2000);

  const observationsRaw = Array.isArray(record.observations) ? record.observations : [];
  const observations: ValidatedEngineeringVerification["observations"] = [];
  for (const item of observationsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const summary = String(row.summary ?? "").trim().slice(0, 1200);
    if (summary.length < 10) continue;
    const citations = filterCitations(row.evidence_ids, evidence);
    observations.push({
      topic: String(row.topic ?? "general").slice(0, 40),
      status: String(row.status ?? "observed").slice(0, 30),
      summary,
      evidence_ids: citations.accepted,
      concern: String(row.concern ?? "").slice(0, 800),
      improvement: String(row.improvement ?? "").slice(0, 800),
    });
  }

  const additional = stringList(record.additional_files_needed, 4);
  for (const file of additional) {
    if (!knownFiles.has(file)) errors.push(`additional file not in index: ${file}`);
  }

  const findings = validateFindings(record.findings ?? null, evidence, "general");

  return {
    verification_type: "engineering",
    architecture_summary: text("architecture_summary"),
    database_summary: text("database_summary"),
    security_summary: text("security_summary"),
    testing_summary: text("testing_summary"),
    observations: observations.slice(0, 12),
    findings,
    additional_files_needed: additional,
    errors: errors.slice(0, 12),
  };
}

export function validateMemberClaimsVerification(
  payload: unknown,
  evidence: EvidenceSet,
  memberIds: string[],
): ValidatedClaimsVerification {
  const errors: string[] = [];
  const allowed = new Set(memberIds);
  const record = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(record.members) ? record.members : [];
  const members: ValidatedClaimsVerification["members"] = [];
  const seen = new Set<string>();

  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const member_id = String(row.member_id ?? "").trim();
    if (!member_id || !allowed.has(member_id)) {
      errors.push(`invalid member_id ${member_id}`);
      continue;
    }
    if (seen.has(member_id)) continue;
    seen.add(member_id);
    const explanation = String(row.explanation ?? "").trim().slice(0, 1500);
    if (explanation.length < 12) {
      errors.push(`member ${member_id} missing explanation`);
      continue;
    }
    let status = String(row.status ?? "not_yet_verified");
    const citations = filterCitations(row.evidence_ids, evidence);
    if (
      status === "supported_by_repository" &&
      citations.accepted.length === 0
    ) {
      status = "partially_supported";
      errors.push(`${member_id} downgraded: no evidence for supported status`);
    }
    members.push({
      member_id,
      status,
      evidence_ids: citations.accepted,
      explanation,
      relevant_files: stringList(row.relevant_files, 8),
      missing_links: stringList(row.missing_links, 6),
    });
  }

  return {
    verification_type: "claims",
    members,
    errors: errors.slice(0, 12),
  };
}

export {
  validateBriefVerification,
  validateClaims,
  validateFindings,
  type BriefVerificationPayload,
};
