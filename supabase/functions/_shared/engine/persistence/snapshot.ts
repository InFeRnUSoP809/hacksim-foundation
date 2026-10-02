import { db } from "../../http.ts";
import { ENGINE_SCAN_VERSION, HACKSIM_ENGINE_ID, ENGINE_VERIFY_PROMPTS } from "../constants.ts";
import type { VerificationTaskRecord } from "../verify/orchestrator.ts";

export async function saveEngineSnapshot(input: {
  submissionId: string;
  repositoryId: string;
  commitSha: string;
  contextVersion: string;
  plan: { kind: string; reason: string; useAi: boolean }[];
  taskRecords: VerificationTaskRecord[];
  evidenceCount: number;
  totalCostUsd: number;
  totalTokens: number;
}): Promise<void> {
  try {
    await db().from("analysis_snapshots").insert({
      submission_id: input.submissionId,
      repository_id: input.repositoryId,
      commit_sha: input.commitSha,
      hackathon_version: input.contextVersion,
      analysis_version: HACKSIM_ENGINE_ID,
      scanner_version: ENGINE_SCAN_VERSION,
      prompt_versions: ENGINE_VERIFY_PROMPTS,
      plan: { tasks: input.plan },
      hackathon_snapshot: null,
      conclusions: input.taskRecords,
      evidence_index: [],
      evidence_count: input.evidenceCount,
      input_tokens: input.taskRecords.reduce((n, t) => n + t.input_tokens, 0),
      output_tokens: input.taskRecords.reduce((n, t) => n + t.output_tokens, 0),
      cached_tokens: input.taskRecords.reduce((n, t) => n + t.cached_tokens, 0),
      estimated_cost_usd: input.totalCostUsd,
    });
  } catch (error) {
    console.warn("[hacksim.engine] could not save analysis snapshot:", error);
  }
}
