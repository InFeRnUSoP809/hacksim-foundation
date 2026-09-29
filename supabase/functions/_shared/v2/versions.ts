/** HackSim V2 engine version identifiers (cache keys). */
export const V2_SCANNER_VERSION = "v2-1";
export const V2_ANALYSIS_VERSION = "v2";
export const V2_PROMPT_VERSION = "verify-v1";

export const V2_DEFAULT_BUDGET = {
  maxInputTokens: 10_000,
  maxSourceBytes: 120_000,
  maxFiles: 12,
  maxSymbols: 24,
  maxRelationships: 40,
  maxVerificationRounds: 2,
} as const;
