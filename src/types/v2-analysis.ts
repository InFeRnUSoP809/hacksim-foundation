export type V2RunStatus =
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

export interface V2AnalysisStatus {
  run_id?: string;
  status?: V2RunStatus;
  progress_stage?: string;
  progress_percent?: number;
  coverage_level?: string;
  commit_sha?: string;
  error_message?: string;
  engine?: string;
}

export interface V2RequirementLink {
  requirement_id: string;
  status: string;
  confidence: string;
  explanation?: string;
  evidence_ids?: string[];
  workflow_ids?: string[];
  uncertainties?: unknown[];
}

export interface V2Feature {
  feature_key: string;
  name: string;
  workflow: { step: string; evidenceId?: string }[];
  evidence_ids?: string[];
  confidence?: string;
}

export interface V2AnalysisSummary {
  ready: boolean;
  run_id?: string;
  run?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  coverage?: Record<string, number>;
  summary?: {
    headline?: string;
    implementation_summary?: string;
    strong_points?: string[];
    uncertainties?: { title?: string; detail?: string }[];
    defense_questions?: string[];
  };
  requirements?: V2RequirementLink[];
  claims?: Record<string, unknown>[];
  features?: V2Feature[];
}
