export type EvidenceLevel =
  | "metadata"
  | "structural"
  | "implementation"
  | "relationship"
  | "workflow"
  | "runtime";

export type RelationshipType =
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "handles"
  | "routes_to"
  | "calls_api"
  | "reads_database"
  | "writes_database"
  | "uses_model"
  | "reads_dataset"
  | "loads_prompt"
  | "calls_ai_provider"
  | "parses_response"
  | "persists_result"
  | "renders"
  | "tests"
  | "configures";

export interface V2FileRecord {
  path: string;
  size_bytes: number;
  extension: string;
  language: string | null;
  category: string;
  importance_score: number;
  importance_reasons: string[];
  ignored: boolean;
  generated: boolean;
  binary: boolean;
  sensitive: boolean;
  content_hash: string | null;
  content: string | null;
}

export interface V2SymbolRecord {
  symbol_key: string;
  file_path: string;
  name: string;
  symbol_type: string;
  language: string | null;
  start_line: number;
  end_line: number;
  signature: string;
  parent_symbol: string | null;
  importance: number;
  uncertain: boolean;
}

export interface V2Relationship {
  source_symbol_key: string | null;
  target_symbol_key: string | null;
  source_file: string;
  target_file: string | null;
  relationship_type: RelationshipType;
  confidence: "high" | "medium" | "low" | "uncertain";
  source_lines: string;
  detail?: Record<string, unknown>;
}

export interface V2EvidenceItem {
  evidence_id: string;
  level: EvidenceLevel;
  evidence_type: string;
  claim: string;
  file_path?: string;
  symbol_name?: string;
  start_line?: number;
  end_line?: number;
  snippet_hash?: string;
  snippet_excerpt?: string;
  confidence: "high" | "medium" | "low";
  detail?: Record<string, unknown>;
}

export interface V2FeatureCandidate {
  feature_key: string;
  name: string;
  workflow: { label: string; evidence_id?: string; symbol_key?: string }[];
  symbol_keys: string[];
  relationship_keys: string[];
  evidence_ids: string[];
  confidence: string;
}

export interface V2VerificationVerdict {
  verdict: string;
  confidence: string;
  verification_level: string;
  summary: string;
  supporting_evidence_ids: string[];
  missing_links: string[];
  contradictions: string[];
  additional_files_needed: string[];
  runtime_verified: boolean;
  verification_complete: boolean;
}

export type AnalysisRunStatus =
  | "queued"
  | "discovering_repository"
  | "scanning_repository"
  | "building_code_graph"
  | "discovering_features"
  | "mapping_requirements"
  | "verifying"
  | "validating"
  | "finalizing"
  | "completed"
  | "partial"
  | "failed";
