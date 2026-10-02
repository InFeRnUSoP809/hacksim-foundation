/**
 * Phase 5 + Phase 6 domain types.
 *
 * These mirror the shapes the scanner and the reviewer produce. The rule the
 * whole product rests on is visible in the types: an `Evidence` always names a
 * file or is explicitly a repository-level fact, and an `AiFinding` always
 * carries `evidence_ids`. A conclusion without evidence is not representable.
 */

// ── Evidence (§26) ──────────────────────────────────────────────────────────

export type EvidenceType =
  | "repository"
  | "analysis_mode"
  | "framework"
  | "dependency"
  | "database"
  | "database_schema"
  | "authentication"
  | "route"
  | "secret"
  | "test_framework"
  | "testing"
  | "config"
  | "readme"
  // Behaviour, not technology. These are what a requirement is judged on.
  | "file"
  | "function"
  | "class"
  | "calculation"
  | "rule"
  | "model"
  | "data_access"
  | "ui"
  | "dataset"
  | "dataset_profile"
  | "integration"
  | "test"
  | "data_flow"
  | "transformation"
  | "parsing"
  | "api_call"
  | "prompt";

export interface Evidence {
  id: string;
  type: EvidenceType | string;
  claim: string;
  file?: string;
  symbol?: string;
  lines?: string;
  confidence: "high" | "medium" | "low";
  detail?: Record<string, unknown>;
}

// ── Project map (§27) ──────────────────────────────────────────────────────

export interface ProjectMapIdentity {
  owner?: string | null;
  repo?: string | null;
  default_branch?: string | null;
  commit?: string;
  visibility?: string | null;
  stars?: number | null;
  forks?: number | null;
}

export interface ProjectMap {
  /** §88 — "limited" means only relevant files were read. */
  analysis_mode: "full" | "limited";
  /** Identifier of the analysis engine that produced this map. */
  engine_id?: string | null;
  identity: ProjectMapIdentity;
  stack: {
    primary_language?: string | null;
    languages: Record<string, number>;
    frameworks: string[];
    dependencies_by_category: Record<string, string[]>;
    package_managers: string[];
  };
  architecture: {
    layers: string[];
    has_frontend: boolean;
    has_backend: boolean;
    monorepo: boolean;
  };
  frontend: {
    components: number;
    pages: string[];
    state_management: string[];
    styling: string[];
  };
  backend: {
    languages: string[];
    endpoint_count: number;
    entrypoints: string[];
  };
  database: {
    technologies: string[];
    schema_files: string[];
    orm_evidence: string[];
  };
  authentication: {
    detected: string[];
    evidence: string[];
    authorization_checks: boolean;
  };
  apis: ApiRoute[];
  external_integrations: ExternalIntegration[];
  features: string[];
  /** §36 — every dataset the scan profiled, with its structure. */
  data_sources: DatasetProfile[];
  /** §20 — what the code computes, independent of which library it imported. */
  business_logic: Record<string, unknown>[];
  calculations: Record<string, unknown>[];
  models: Record<string, unknown>[];
  data_access: Record<string, unknown>[];
  ui_flows: Record<string, unknown>[];
  flows?: {
    id: string;
    files: string[];
    closed: boolean;
    hops: { file: string; symbol: string | null; relation: string; line: number }[];
    behaviors?: {
      id: string;
      kind: string;
      claim: string;
      file: string;
      symbol: string | null;
      lines: string;
      level: string;
    }[];
  }[];
  evidence_chains?: {
    id: string;
    flow_id: string | null;
    label: string;
    closed: boolean;
    links: {
      evidence_id: string;
      claim: string;
      file: string | null;
      symbol: string | null;
      level: string;
    }[];
  }[];
  analysis_coverage?: Record<string, number>;
  implementation_behaviors?: {
    id: string;
    kind: string;
    claim: string;
    file: string;
    symbol: string | null;
    start_line: number;
    end_line: number;
    level: string;
  }[];
  implementation_workflows?: {
    id: string;
    label: string;
    closed: boolean;
    missing_links: string[];
    flow_id: string | null;
    files: string[];
    steps: {
      kind: string;
      label: string;
      file: string;
      symbol: string | null;
      start_line: number;
      end_line: number;
      behavior_id: string | null;
      evidence_level: string;
      confidence: string;
    }[];
  }[];
  testing: {
    test_file_count: number;
    frameworks: string[];
    commands: string[];
    has_tests: boolean;
  };
  deployment: { files: string[]; ci: string[] };
  repository_stats: {
    file_count: number;
    total_files_seen: number;
    line_count: number;
    symbol_count: number;
    secret_findings: number;
  };
  readme: {
    present: boolean;
    description: string;
    technologies: string[];
  };
  security: {
    hardcoded_secrets: {
      type: string;
      file: string;
      line: number;
    }[];
    secret_file_present: boolean;
  };
  important_files: {
    path: string;
    category: string | null;
    importance: string | null;
    lines: number | null;
  }[];
  warnings: string[];
  truncated: Record<string, number>;
}

/**
 * A dataset, described rather than quoted. The rows behind this never reach a
 * model; only the structure and a couple of samples do.
 */
export interface DatasetProfile {
  path: string;
  format: "csv" | "tsv" | "json" | "jsonl" | "text";
  size_bytes: number;
  approx_row_count: number;
  row_count_exact: boolean;
  column_names: string[];
  date_columns: string[];
  entity_columns: string[];
  quantity_columns: string[];
  stock_columns: string[];
  price_columns: string[];
  supplier_columns: string[];
  identifier_columns: string[];
  numeric_columns: string[];
  categorical_columns: string[];
  sample_rows?: string[][];
  likely_purpose: string;
  relevance: "high" | "medium" | "low" | "none";
  relevance_terms?: string[];
  notes?: string[];
}

export interface ApiRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  symbol?: string | null;
  framework?: string | null;
}

export interface ExternalIntegration {
  url: string;
  file: string;
  line: number;
  method?: string | null;
}

// ── Repository (§9) ────────────────────────────────────────────────────────

export type AnalysisStatus =
  | "pending"
  | "scanning"
  | "completed"
  | "failed"
  | "stale"
  | "limited";

export interface Repository {
  id: string;
  submission_id: string;
  github_url: string;
  owner: string | null;
  repo_name: string | null;
  default_branch: string | null;
  latest_commit_sha: string | null;
  analyzed_commit_sha: string | null;
  visibility: string | null;
  language: string | null;
  stars: number | null;
  forks: number | null;
  analysis_status: AnalysisStatus;
  analysis_version: string | null;
  analysis_mode: "full" | "limited";
  project_map: ProjectMap | null;
  file_count: number;
  secret_count: number;
  error_code: string | null;
  error_message: string | null;
  last_analyzed_at: string | null;
  updated_at: string;
}

export interface AdminRepositoryRow {
  id: string;
  submission_id: string;
  project_name: string | null;
  team_name: string;
  owner: string | null;
  repo_name: string | null;
  commit_sha: string | null;
  analysis_status: AnalysisStatus;
  analysis_mode: string;
  file_count: number;
  secret_count: number;
  review_status: string | null;
  last_analyzed_at: string | null;
}

// ── Requirements (§30, §33) ────────────────────────────────────────────────

export type RequirementStatus =
  | "confirmed"
  | "partially_confirmed"
  | "weakly_evidenced"
  | "contradicted"
  | "evidence_found"
  | "partial_evidence"
  | "not_evidenced"
  | "unable_to_determine";

export type Confidence = "high" | "medium" | "low" | "none";

export interface RequirementItem {
  id: string;
  text: string;
  category: string;
  importance: "critical" | "important" | "optional" | string;
}

export interface RequirementMap {
  version: number;
  requirements: RequirementItem[];
  constraints: RequirementItem[];
  expected_outcomes: RequirementItem[];
  evaluation_criteria: RequirementItem[];
}

/** How a conclusion was reached. Shown so a reader can trust the method. */
export type ConclusionMethod =
  | "deterministic_count"
  | "deterministic_literal"
  | "ai_evidence"
  | "ai_insufficient_inspection"
  | "not_evaluated";

export type ConclusionKind =
  | "requirement"
  | "constraint"
  | "outcome"
  | "criterion"
  | "claim";

export interface RequirementEvaluation {
  id: string;
  requirement_id: string;
  kind?: ConclusionKind;
  status: RequirementStatus;
  evidence_ids: string[];
  confidence: Confidence;
  explanation: string | null;
  source: "deterministic" | "ai" | "skipped";
  /** The specific part that is not established, named rather than implied. */
  missing_or_unclear?: string[];
  method?: ConclusionMethod;
  /** The queries the retrieval plan generated from this requirement's wording. */
  retrieval_queries?: string[];
  relevant_files?: string[];
  evidence_count?: number;
  ai_used?: boolean;
  ai_reason?: string;
}

/** One planned analysis dimension and why it was or was not relevant. */
export interface AnalysisDimension {
  key: string;
  label: string;
  relevance: "required" | "relevant" | "not_applicable";
  reason: string;
  method: "deterministic" | "ai" | "skipped";
  expectation_source: string;
}

/**
 * §50 — a structured factual assessment, never a score. Every field is a
 * sentence about the evidence; `gaps` and `uncertainties` are first-class
 * output, not failure.
 */
export interface ProjectAssessment {
  headline: string;
  understanding: string;
  problem_relevance: string;
  solution_coherence: string;
  implementation_evidence: string;
  functional_completeness: string;
  technical_quality: string;
  claim_accuracy: string;
  hackathon_alignment: string;
  evidence_ids?: string[];
  strengths?: string[];
  gaps?: string[];
  uncertainties?: string[];
  engineering_concerns?: string[];
}

export interface EngineeringObservation {
  topic: string;
  status: "observed" | "not_applicable" | "concern";
  summary: string;
  evidence_ids: string[];
  concern: string;
  improvement: string;
}

export interface ClaimCheck {
  claim: string;
  status: "supported" | "partially_supported" | "not_evidenced";
  confidence?: Confidence;
  evidence_ids: string[];
  files?: string[];
  explanation: string;
}

/** The §34 coverage matrix: one row per requirement. */
export interface CoverageRow {
  requirement: RequirementItem;
  evaluation: RequirementEvaluation | null;
}

// ── Review (§41, §46) ──────────────────────────────────────────────────────

export type FindingType =
  | "strength"
  | "observation"
  | "potential_issue"
  | "confirmed_issue"
  | "security_concern"
  | "testing_gap"
  | "architecture_concern"
  | "scalability_concern"
  | "claim_mismatch"
  | "clarification_needed";

export type Severity = "critical" | "high" | "medium" | "low" | "informational";

export interface AiFinding {
  id?: string;
  project_review_id?: string;
  finding_type: FindingType;
  severity: Severity;
  title: string;
  description: string | null;
  evidence_ids: string[];
  files: string[];
  symbols: string[];
  why_it_matters: string | null;
  suggested_improvement: string | null;
  confidence: "high" | "medium" | "low";
  created_at?: string;
}

export interface ProblemAlignment {
  status:
    | "strongly_aligned"
    | "partially_aligned"
    | "weakly_evidenced"
    | "unclear";
  confidence: Confidence;
  evidence_ids: string[];
  explanation: string;
  source?: "deterministic" | "ai";
}

export interface ReviewSummary {
  headline: string;
  strengths: string[];
  areas_to_clarify: string[];
  source?: string;
}

/** One piece of evidence, as a stored snapshot records it. */
export interface EvidenceRef {
  id: string;
  claim: string;
  file?: string | null;
}

/**
 * §45 — what a re-analysis changed. It compares two runs, so an unchanged
 * re-analysis produces nothing here rather than an empty "0 changes" panel.
 */
export interface AnalysisDiff {
  previous_commit: string | null;
  commit: string | null;
  previous_run_at: string | null;
  changed: { id: string; kind: string; from: string; to: string }[];
  added: string[];
  removed: string[];
  evidence_added: EvidenceRef[];
  evidence_removed: EvidenceRef[];
}

export interface ProjectReview {
  id: string;
  submission_id: string;
  repository_id: string;
  status: "pending" | "running" | "partial" | "completed" | "failed";
  model: string | null;
  prompt_version: string | null;
  estimated_cost_usd?: number;
  total_tokens?: number;
  summary:
    | (ReviewSummary & {
        verification_tasks?: VerificationTaskRecord[] | null;
        engineering_observations?: unknown[] | null;
        last_verification_run?: Record<string, unknown> | null;
        cumulative_cost_usd?: number;
        cumulative_tokens?: number;
      })
    | null;
  problem_alignment: ProblemAlignment | null;
  requirements: unknown;
  constraints: unknown;
  expected_outcomes: unknown;
  evaluation_criteria: unknown;
  architecture: Record<string, unknown> | null;
  implementation: Record<string, unknown> | null;
  security: Record<string, unknown> | null;
  database_review: Record<string, unknown> | null;
  testing: Record<string, unknown> | null;
  scalability: Record<string, unknown> | null;
  technical_decisions?: Record<string, unknown> | null;
  updated_at: string;
  // ── The rebuilt pipeline ────────────────────────────────────────────
  analysis_version?: string | null;
  hackathon_version?: string | null;
  scanner_version?: string | null;
  commit_sha?: string | null;
  dimensions?: AnalysisDimension[] | null;
  requirement_rows?: RequirementEvaluation[] | null;
  constraint_rows?: RequirementEvaluation[] | null;
  outcome_rows?: RequirementEvaluation[] | null;
  criterion_rows?: RequirementEvaluation[] | null;
  assessment?: ProjectAssessment | null;
  engineering?: EngineeringObservation[] | null;
  diff?: AnalysisDiff | null;
  contributions?: ValidatedClaimsVerification | null;
}

export interface VerificationTaskRecord {
  kind: "brief" | "implementation" | "engineering" | "claims";
  status: "executed" | "cached" | "skipped" | "failed";
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  verdict: string | null;
  confidence: string | null;
  verification_level: string | null;
  evidence_count: number;
  missing_links: string[];
  validation_errors: string[];
  rounds: number;
}

export interface ValidatedClaimsVerification {
  verification_type?: string;
  members?: {
    member_id: string;
    status: string;
    evidence_ids: string[];
    explanation: string;
    relevant_files: string[];
    missing_links: string[];
  }[];
}

// ── Defence targets (§50) ──────────────────────────────────────────────────

export type DefensePriority = "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

export interface DefenseTarget {
  id: string;
  submission_id: string;
  user_id: string | null;
  topic: string;
  reason: string | null;
  priority: DefensePriority;
  evidence_ids: string[];
  question_area: string | null;
  status: "open" | "ready" | "dismissed";
}

// ── The §80 payload ────────────────────────────────────────────────────────

/** One analysis run, with what it cost. Admin only. */
export interface AnalysisRun {
  id: string;
  commit_sha: string | null;
  created_at: string;
  analysis_version: string | null;
  hackathon_version: string | null;
  evidence_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost_usd: number;
}

export interface SubmissionAnalysis {
  submission: Record<string, unknown>;
  hackathon: Record<string, unknown>;
  team: Record<string, unknown>;
  repository: Repository | null;
  project_map: ProjectMap | null;
  evidence: Evidence[];
  requirement_map: RequirementMap | null;
  requirements: RequirementEvaluation[];
  review: ProjectReview | null;
  findings: AiFinding[];
  defense_targets: DefenseTarget[];
  /** Admin only — one row per analysis run, newest first. */
  analysis_runs?: AnalysisRun[] | null;
  /** Admin only — a student never receives this key. */
  ai_usage: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cost_usd: number;
    operations: Record<string, number>;
  } | null;
}

// ── Admin dashboards ───────────────────────────────────────────────────────

export interface AdminAnalysisStats {
  users: number;
  teams: number;
  hackathons: number;
  active_sessions: number;
  completed_sessions: number;
  expired_sessions: number;
  submitted_sessions: number;
  submissions_draft: number;
  submissions_final: number;
  repositories: number;
  analyzed: number;
  analysis_failed: number;
  reviews: number;
  requirements_checked: number;
  evidence_found: number;
  partial_evidence: number;
  not_evidenced: number;
  findings: number;
  defense_targets: number;
}

export interface AdminProjectReviewRow {
  id: string;
  submission_id: string;
  project_name: string | null;
  team_name: string;
  status: string;
  requirements_done: number;
  findings: number;
  cost_usd: number;
  total_tokens: number;
  updated_at: string;
}

// ── AI operations (§68–§77) ────────────────────────────────────────────────

export interface AiBudgetView {
  max_cost_usd: number | null;
  used_cost_usd: number;
  max_requests: number | null;
  used_requests: number;
  max_input_tokens: number | null;
  used_input_tokens: number;
  utilization: number;
  level: "normal" | "warning" | "critical" | "stop";
  enabled: boolean;
}

export interface AiOverview {
  window_days: number;
  total_requests: number;
  successful: number;
  failed: number;
  rejected: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_miss_tokens: number;
  cache_hit_rate: number;
  total_cost_usd: number;
  average_cost_per_submission: number;
  successful_analyses: number;
  error_codes: Record<string, number>;
  global_budget: AiBudgetView | null;
}

export interface AiUsageRow {
  id: string;
  created_at: string;
  user_email: string | null;
  project_name: string | null;
  submission_id: string | null;
  operation: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  estimated_cost_usd: number;
  status: "pending" | "success" | "failed" | "rejected";
  error_code: string | null;
  duration_ms: number | null;
  request_id: string | null;
}

export interface AiBudgetRow extends AiBudgetView {
  id: string;
  scope: "global" | "user" | "submission";
  user_id: string | null;
  submission_id: string | null;
  project_name: string | null;
  user_email: string | null;
  max_output_tokens: number | null;
  used_output_tokens: number;
  used_requests: number;
}

export interface AiModelConfig {
  id: string;
  provider: string;
  model_name: string;
  enabled: boolean;
  is_default: boolean;
  input_price_per_million_cache_hit: number;
  input_price_per_million_cache_miss: number;
  output_price_per_million: number;
  max_input_tokens: number;
  max_output_tokens: number;
  reasoning_mode: "off" | "low" | "medium" | "high";
}

export interface CostForecast {
  analyzed_submissions: number;
  avg_cost_usd: number;
  avg_tokens: number;
  projections: { submissions: number; estimated_cost_usd: number }[];
  basis: string;
  is_estimate: boolean;
}

export interface CacheAnalytics {
  window_days: number;
  cached_tokens: number;
  uncached_tokens: number;
  cache_hit_rate: number;
  estimated_cache_savings_usd: number;
}

/** What one module of a review run did. */
export interface ReviewModuleOutcome {
  module: string;
  status: "skipped" | "completed" | "failed" | "cached";
  source: "deterministic" | "ai";
  reason: string;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}

export interface ReviewRunResult {
  status: string;
  review_id: string | null;
  modules: ReviewModuleOutcome[];
  error: string | null;
}

/**
 * One preflight check. `ok` is the answer to "can the pipeline run right now",
 * not "is this variable set" — the GitHub check makes a real request, because a
 * set-but-expired token is indistinguishable from a working one from inside.
 */
export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  token_configured?: boolean;
  key_configured?: boolean;
  model_priced?: boolean;
  latency_ms?: number;
  rate_limit?: { limit?: number; remaining?: number; reset_epoch?: number };
}

export interface PreflightReport {
  ok: boolean;
  checks_passed: string;
  checks: PreflightCheck[];
}
