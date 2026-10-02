/** Independent identity for the new analysis engine (not legacy p6/p7/p8). */
export const HACKSIM_ENGINE_ID = "hacksim-analysis-v1";
export const ENGINE_SCAN_VERSION = "new-engine-v1";
export const ENGINE_VERIFY_PROMPT_VERSION = "verify-v1";

export const ENGINE_VERIFY_PROMPTS = {
  brief: "verify-v1-brief",
  implementation: "verify-v1-implementation",
  engineering: "verify-v1-engineering",
  claims: "verify-v1-claims",
} as const;

export type EngineVerifyTaskKind = keyof typeof ENGINE_VERIFY_PROMPTS;

export const MAX_VERIFICATION_ROUNDS = 2;

/** Server-side runtime identity (every edge response should echo this). */
export function engineRuntimeIdentity(): {
  engine_id: typeof HACKSIM_ENGINE_ID;
  analysis_version: typeof ENGINE_SCAN_VERSION;
} {
  return {
    engine_id: HACKSIM_ENGINE_ID,
    analysis_version: ENGINE_SCAN_VERSION,
  };
}

export const ANALYSIS_STAGES = [
  "queued",
  "discovering_repository",
  "scanning_structure",
  "analyzing_code",
  "building_evidence",
  "verifying_with_ai",
  "requesting_additional_evidence",
  "validating_ai",
  "finalizing",
  "completed",
  "failed",
  "partial",
] as const;
