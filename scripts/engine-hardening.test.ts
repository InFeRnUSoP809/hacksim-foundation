/**
 * v1 hardening unit tests (no DeepSeek / DB).
 * Run: npx tsx scripts/engine-hardening.test.ts
 */
import assert from "node:assert/strict";
import { mergeFindings, findingStableKey } from "../supabase/functions/_shared/engine/persistence/merge.ts";
import { planVerificationTasks } from "../supabase/functions/_shared/engine/verify/tasks.ts";
import {
  verificationContextHash,
  fingerprintEvidence,
} from "../supabase/functions/_shared/engine/verify/cache.ts";
import { filterAdditionalFiles } from "../supabase/functions/_shared/engine/verify/retrieval.ts";
import { validateImplementationVerification } from "../supabase/functions/_shared/engine/verify/validation.ts";
import { buildEvidenceSet } from "../supabase/functions/_shared/evidence.ts";
import { asRawEvidence } from "../supabase/functions/_shared/validate.ts";

const baseFinding = {
  finding_type: "observation" as const,
  severity: "low" as const,
  title: "Missing error handling on API route",
  description: "Handler does not catch failures.",
  evidence_ids: ["EV-001"],
  files: ["api.ts"],
  symbols: ["handler"],
  why_it_matters: "Failures may surface as 500s.",
  suggested_improvement: "Add try/catch.",
  confidence: "medium",
  expectation_source: "general" as const,
};

const updated = {
  ...baseFinding,
  description: "Handler now documents uncertainty.",
  evidence_ids: ["EV-002"],
};

const merged = mergeFindings([baseFinding], [updated]);
assert.equal(merged.length, 1);
assert.equal(merged[0].evidence_ids[0], "EV-002");
assert.equal(findingStableKey(baseFinding), findingStableKey(updated));

const preserved = mergeFindings(
  [baseFinding, { ...baseFinding, title: "Separate issue", finding_type: "strength" }],
  [updated],
);
assert.equal(preserved.length, 2);

const emptyBrief = planVerificationTasks({
  projectMap: { implementation_workflows: [], implementation_behaviors: [] },
  requirementCount: 0,
  constraintCount: 0,
  outcomeCount: 0,
  criterionCount: 0,
  hasBriefContext: false,
  memberCount: 0,
});
assert.ok(!emptyBrief.some((t) => t.kind === "brief"), "brief skipped with no brief context");

const withProblem = planVerificationTasks({
  projectMap: { implementation_workflows: [], implementation_behaviors: [] },
  requirementCount: 0,
  hasBriefContext: true,
  memberCount: 0,
});
assert.ok(withProblem.some((t) => t.kind === "brief"), "brief runs when problem/claims exist");

const hashCommitA = verificationContextHash({
  commitSha: "aaa",
  taskKind: "implementation",
  promptVersion: "verify-v1-implementation",
  model: "deepseek-chat",
  evidenceFingerprint: fingerprintEvidence(["EV-1"]),
  workflowFingerprint: "IWF-001",
  requirementFingerprint: "REQ-1",
  extraPaths: [],
});
const hashCommitB = verificationContextHash({
  commitSha: "bbb",
  taskKind: "implementation",
  promptVersion: "verify-v1-implementation",
  model: "deepseek-chat",
  evidenceFingerprint: fingerprintEvidence(["EV-1"]),
  workflowFingerprint: "IWF-001",
  requirementFingerprint: "REQ-1",
  extraPaths: [],
});
assert.notEqual(hashCommitA, hashCommitB, "commit change invalidates cache hash");

const hashPrompt = verificationContextHash({
  commitSha: "aaa",
  taskKind: "implementation",
  promptVersion: "verify-v1-implementation-v2",
  model: "deepseek-chat",
  evidenceFingerprint: fingerprintEvidence(["EV-1"]),
  workflowFingerprint: "IWF-001",
  requirementFingerprint: "REQ-1",
  extraPaths: [],
});
assert.notEqual(hashCommitA, hashPrompt, "prompt version change invalidates cache");

const { accepted, rejected } = filterAdditionalFiles(
  ["services/run.ts", "../../../etc/passwd"],
  new Set(["services/run.ts"]),
);
assert.deepEqual(accepted, ["services/run.ts"]);
assert.ok(rejected.length >= 1);

const ev = buildEvidenceSet(
  asRawEvidence([{ id: "EV-001", type: "api_call", claim: "AI call", confidence: "high" }]),
);
const invalid = validateImplementationVerification(
  {
    verification_type: "implementation",
    implementation_summary: "x".repeat(25),
    important_behaviors: [{ description: "AI used", evidence_ids: ["EV-999"] }],
    verified_workflows: [{ workflow_id: "IWF-404", evidence_ids: [] }],
    runtime_verified: true,
  },
  ev,
  { implementation_workflows: [{ id: "IWF-001" }] },
  new Set(["a.ts"]),
);
assert.equal(invalid.runtime_verified, false);
assert.ok(invalid.important_behaviors.length === 0, "drops behaviors with bad evidence ids");
assert.ok(invalid.errors.some((e) => e.includes("IWF-404")), "unknown workflow rejected");

console.log("engine-hardening: ok");
