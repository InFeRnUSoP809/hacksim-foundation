import { db } from "../http.ts";
import type { V2EvidenceItem, V2FeatureCandidate, V2FileRecord, V2Relationship } from "./types.ts";
import { AnalysisStore } from "../scanner.ts";
import { attachContent, contentByPath } from "./content.ts";
import { buildFileInventory } from "./discover.ts";

export async function evidenceCountForRun(runId: string): Promise<number> {
  const { count } = await db()
    .from("v2_evidence_items")
    .select("*", { count: "exact", head: true })
    .eq("analysis_run_id", runId);
  return count ?? 0;
}

export async function loadPersistedEvidence(runId: string): Promise<V2EvidenceItem[]> {
  const { data } = await db()
    .from("v2_evidence_items")
    .select("*")
    .eq("analysis_run_id", runId);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    evidenceId: String(row.evidence_id),
    level: row.level as V2EvidenceItem["level"],
    evidenceType: String(row.evidence_type),
    claim: String(row.claim),
    filePath: row.file_path as string | null,
    symbolName: row.symbol_name as string | null,
    startLine: row.start_line as number | null,
    endLine: row.end_line as number | null,
    snippetHash: row.snippet_hash as string | null,
    snippetExcerpt: row.snippet_excerpt as string | null,
    confidence: row.confidence as V2EvidenceItem["confidence"],
    detail: (row.detail as Record<string, unknown>) ?? {},
  }));
}

export async function loadPersistedRelationships(runId: string): Promise<V2Relationship[]> {
  const { data } = await db()
    .from("v2_code_relationships")
    .select("relationship_type, confidence, source_file, source_lines, detail")
    .eq("analysis_run_id", runId)
    .limit(5000);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    relationship: row.relationship_type as V2Relationship["relationship"],
    confidence: row.confidence as V2Relationship["confidence"],
    sourceFile: String(row.source_file ?? ""),
    sourceLines: row.source_lines as string | undefined,
    detail: (row.detail as Record<string, unknown>) ?? {},
  }));
}

export async function loadPersistedFeatures(runId: string): Promise<V2FeatureCandidate[]> {
  const { data } = await db()
    .from("v2_feature_candidates")
    .select("*")
    .eq("analysis_run_id", runId);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    featureKey: String(row.feature_key),
    name: String(row.name),
    workflow: (row.workflow as V2FeatureCandidate["workflow"]) ?? [],
    entrySymbolKeys: [],
    symbolKeys: [],
    evidenceIds: (row.evidence_ids as string[]) ?? [],
    confidence: row.confidence as V2FeatureCandidate["confidence"],
  }));
}

/** Rebuild in-memory files from Phase 5 chunks (no GitHub fetch). */
export async function rebuildFilesFromSubmission(submissionId: string): Promise<V2FileRecord[]> {
  const store = new AnalysisStore();
  const loaded = await store.loadForReview(submissionId);
  if (!loaded) return [];
  const pathByFileId = new Map(
    (loaded.files as { id: string; path: string; file_size?: number }[]).map((f) => [f.id, f]),
  );
  const chunks = (loaded.chunks ?? []).map((c) => ({
    file_path: pathByFileId.get(String(c.file_id))?.path ?? "",
    start_line: c.start_line as number | null,
    content: String(c.content ?? ""),
  })).filter((c) => c.file_path);
  const byPath = contentByPath(chunks);
  const tree = [...byPath.keys()].map((path) => ({
    path,
    size: byPath.get(path)?.length ?? 0,
  }));
  const inventory = buildFileInventory(tree, byPath);
  return attachContent(inventory, byPath);
}
