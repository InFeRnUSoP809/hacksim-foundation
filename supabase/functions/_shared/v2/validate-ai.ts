import type { V2EvidenceItem, V2VerificationVerdict } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  verdict?: V2VerificationVerdict;
}

export function validateVerifierOutput(
  raw: Record<string, unknown>,
  evidence: V2EvidenceItem[],
  filePaths: Set<string>,
): ValidationResult {
  const errors: string[] = [];
  const allowedVerdicts = new Set([
    "confirmed", "partially_confirmed", "weakly_evidenced", "not_evidenced",
    "unable_to_determine", "contradicted",
  ]);
  const verdict = String(raw.verdict ?? "");
  if (!allowedVerdicts.has(verdict)) errors.push("invalid_verdict");

  const supporting = (raw.supporting_evidence_ids as string[] | undefined) ?? [];
  const evidenceIds = new Set(evidence.map((e) => e.evidenceId));
  for (const id of supporting) {
    if (!evidenceIds.has(id)) errors.push(`unknown_evidence_id:${id}`);
  }

  const additional = (raw.additional_files_needed as string[] | undefined) ?? [];
  for (const path of additional) {
    if (path && !filePaths.has(path)) errors.push(`unknown_file:${path}`);
  }

  if (verdict === "confirmed" && supporting.length === 0) {
    errors.push("confirmed_without_evidence");
  }

  const weakOnly = supporting.every((id) => {
    const ev = evidence.find((e) => e.evidenceId === id);
    return ev?.level === "metadata" || ev?.level === "structural";
  });
  if (verdict === "confirmed" && weakOnly && supporting.length > 0) {
    errors.push("confirmed_on_weak_evidence_only");
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    verdict: {
      verdict: verdict as V2VerificationVerdict["verdict"],
      confidence: String(raw.confidence ?? "medium"),
      verification_level: String(raw.verification_level ?? "source_reviewed"),
      summary: String(raw.summary ?? "").slice(0, 2000),
      supporting_evidence_ids: supporting,
      missing_links: (raw.missing_links as string[] | undefined) ?? [],
      contradictions: (raw.contradictions as string[] | undefined) ?? [],
      additional_files_needed: additional,
      runtime_verified: Boolean(raw.runtime_verified),
      verification_complete: raw.verification_complete !== false,
    },
  };
}
