export const V2_SCANNER_VERSION = "v2-1";
export const V2_ANALYSIS_VERSION = "v2";
export const V2_PROMPT_VERSION = "verify-v1";

export const V2_DEFAULT_BUDGET = {
  maxInputTokens: 6000,
  maxSourceBytes: 120_000,
  maxFiles: 24,
  maxSymbols: 40,
  maxRelationships: 80,
  smallVerificationTokens: 2000,
};

export const V2_STAGE_PROGRESS: Record<string, number> = {
  queued: 0,
  discovering_repository: 5,
  scanning_repository: 15,
  building_code_graph: 35,
  discovering_features: 50,
  mapping_requirements: 60,
  verifying: 75,
  validating: 88,
  finalizing: 95,
  completed: 100,
  partial: 100,
  failed: 100,
};
