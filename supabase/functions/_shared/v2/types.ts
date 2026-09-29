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
  | "writes_file"
  | "loads_prompt"
  | "calls_ai_provider"
  | "parses_response"
  | "persists_result"
  | "renders"
  | "triggers"
  | "tests"
  | "configures";

export type VerdictStatus =
  | "confirmed"
  | "partially_confirmed"
  | "weakly_evidenced"
  | "not_evidenced"
  | "unable_to_determine"
  | "contradicted";

export interface V2FileRecord {
  path: string;
  sizeBytes: number;
  extension: string;
  language: string | null;
  category: string;
  importanceScore: number;
  reasons: string[];
  ignored: boolean;
  generated: boolean;
  binary: boolean;
  sensitive: boolean;
  contentHash: string | null;
  content: string;
}

export interface V2SymbolRecord {
  symbolKey: string;
  filePath: string;
  name: string;
  symbolType: string;
  language: string | null;
  startLine: number;
  endLine: number;
  signature: string | null;
  parentSymbol: string | null;
  importance: number;
  uncertain: boolean;
}

export interface V2Relationship {
  relationship: RelationshipType;
  confidence: "high" | "medium" | "low";
  sourceSymbolKey?: string;
  targetSymbolKey?: string;
  sourceFile: string;
  targetFile?: string;
  sourceLines?: string;
  detail?: Record<string, unknown>;
}

export interface V2EvidenceItem {
  evidenceId: string;
  level: EvidenceLevel;
  evidenceType: string;
  claim: string;
  filePath: string | null;
  symbolName: string | null;
  startLine: number | null;
  endLine: number | null;
  snippetHash: string | null;
  snippetExcerpt: string | null;
  confidence: "high" | "medium" | "low";
  detail?: Record<string, unknown>;
}

export interface V2FeatureCandidate {
  featureKey: string;
  name: string;
  workflow: { step: string; evidenceId?: string; symbolKey?: string }[];
  entrySymbolKeys: string[];
  symbolKeys: string[];
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
}

export interface V2VerificationVerdict {
  verdict: VerdictStatus;
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

export interface V2EngineContext {
  runId: string;
  submissionId: string;
  repositoryId: string;
  commitSha: string;
  owner: string;
  repoName: string;
  defaultBranch: string;
  files: V2FileRecord[];
  symbols: V2SymbolRecord[];
  relationships: V2Relationship[];
  evidence: V2EvidenceItem[];
  features: V2FeatureCandidate[];
  chains: { chainKey: string; name: string; orderedEvidenceIds: string[]; featureKey?: string }[];
}
