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
  | "readme";

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

export interface RequirementEvaluation {
  id: string;
  requirement_id: string;
  status: RequirementStatus;
  evidence_ids: string[];
  confidence: Confidence;
  explanation: string | null;
  source: "deterministic" | "ai" | "skipped";
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

export interface ClaimCheck {
  claim: string;
  status: "supported" | "partially_supported" | "not_evidenced";
  evidence_ids: string[];
  files?: string[];
  symbols?: string[];
  explanation: string;
}

export interface ContributionCheck {
  user_id: string;
  member_id: string;
  status:
    | "supported_by_repository"
    | "partially_supported"
    | "not_yet_verified";
  confidence: Confidence;
  evidence_ids: string[];
  matched_files: string[];
  matched_symbols: string[];
  explanation: string;
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
  summary: ReviewSummary | null;
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
  technical_decisions: unknown;
  contributions: Record<string, ContributionCheck> | null;
  updated_at: string;
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
  contributions: Record<string, unknown>[];
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
