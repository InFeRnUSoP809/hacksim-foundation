/**
 * Implementation-depth + verification acceptance (generic fixture).
 * Run: npx tsx scripts/engine-acceptance.test.ts
 */
import assert from "node:assert/strict";
import { buildRepositoryGraph } from "../supabase/functions/_shared/engine/graph/build.ts";
import { extractImplementationBehaviors } from "../supabase/functions/_shared/engine/behavior/extract.ts";
import { discoverImplementationWorkflows } from "../supabase/functions/_shared/engine/workflows/discover.ts";
import {
  normalizeVerifyTaskName,
  planVerificationTasks,
} from "../supabase/functions/_shared/engine/verify/tasks.ts";
import { buildSharedVerifyContext, packetForTask } from "../supabase/functions/_shared/engine/verify/context.ts";
import { filterAdditionalFiles } from "../supabase/functions/_shared/engine/verify/retrieval.ts";
import {
  verificationContextHash,
  fingerprintEvidence,
} from "../supabase/functions/_shared/engine/verify/cache.ts";
import { validateImplementationVerification } from "../supabase/functions/_shared/engine/verify/validation.ts";
import { buildEvidenceSet } from "../supabase/functions/_shared/evidence.ts";
import { asRawEvidence } from "../supabase/functions/_shared/validate.ts";

const backendHandler = [
  "export async function runDiagnosis(input: { text: string }) {",
  "  const template = await db.from('prompt_templates').select().eq('active', true).single();",
  "  const messages = [{ role: 'user', content: template.data.body + input.text }];",
  "  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {",
  "    method: 'POST',",
  "    body: JSON.stringify({ model: 'deepseek-chat', messages, response_format: { type: 'json_object' } }),",
  "  });",
  "  const raw = await res.json();",
  "  const parsed = JSON.parse(raw.choices[0].message.content);",
  "  const alphaList = parsed.alphaList.slice(0, 3);",
  "  const betaList = parsed.betaList.slice(0, 5);",
  "  await db.from('diagnosis_runs').insert({ alphaList, betaList });",
  "  return { alphaList, betaList };",
  "}",
].join("\n");

const frontend = [
  "export function SubmitPanel() {",
  "  const send = () => fetch('/v1/diagnose', { method: 'POST', body: JSON.stringify({ text: 'x' }) });",
  "  return null;",
  "}",
].join("\n");

const graph = buildRepositoryGraph({
  files: [
    { path: "apps/portal/SubmitPanel.tsx", language: "TypeScript", content: frontend },
    { path: "services/diagnose/run.ts", language: "TypeScript", content: backendHandler },
  ],
  symbols: [
    { name: "SubmitPanel", symbol_type: "function", line: 1, file: "apps/portal/SubmitPanel.tsx" },
    { name: "runDiagnosis", symbol_type: "function", line: 1, file: "services/diagnose/run.ts" },
  ],
  routes: [
    {
      method: "POST",
      path: "/v1/diagnose",
      file: "services/diagnose/run.ts",
      line: 1,
      framework: "Express",
    },
  ],
});

const scanFiles = [
  { path: "apps/portal/SubmitPanel.tsx", content: frontend, language: "TypeScript" },
  { path: "services/diagnose/run.ts", content: backendHandler, language: "TypeScript" },
];

const behaviors = extractImplementationBehaviors({
  files: scanFiles,
  symbols: graph.symbols,
});

const workflows = discoverImplementationWorkflows({
  behaviors,
  graph,
  flows: graph.flows,
});

assert.ok(behaviors.some((b) => b.kind === "ai_api_call"), "positive fixture: AI HTTP call behavior");
assert.ok(behaviors.some((b) => b.kind === "parse_json"), "positive fixture: JSON parse behavior");
assert.ok(
  behaviors.some((b) => b.kind === "structured_json_expected"),
  "positive fixture: structured JSON request",
);
assert.ok(
  behaviors.some((b) => b.kind === "limit_collection" && String(b.detail?.limit) === "3"),
  "positive fixture: limit 3",
);
assert.ok(
  behaviors.some((b) => b.kind === "limit_collection" && String(b.detail?.limit) === "5"),
  "positive fixture: limit 5",
);
assert.ok(behaviors.some((b) => b.kind === "database_write"), "positive fixture: persistence");

const symbolWorkflow = workflows.find((w) => w.label.includes("runDiagnosis"));
assert.ok(symbolWorkflow, "symbol-level AI workflow");
const kinds = new Set(symbolWorkflow!.steps.map((s) => s.kind));
assert.ok(kinds.has("ai_request"), "workflow includes AI request");
assert.ok(kinds.has("parse_response"), "workflow includes parse");
assert.ok(kinds.has("transform_limit"), "workflow includes limits");
assert.ok(kinds.has("database_write"), "workflow includes persistence");

const limitSteps = symbolWorkflow!.steps.filter((s) => s.kind === "transform_limit");
assert.ok(limitSteps.some((s) => /3/.test(s.label)), "workflow step documents limit 3");
assert.ok(limitSteps.some((s) => /5/.test(s.label)), "workflow step documents limit 5");

const cross = workflows.find((w) => w.flow_id);
assert.ok(cross?.steps.some((s) => s.kind === "frontend_request"), "cross-layer frontend hop");

const depOnly = extractImplementationBehaviors({
  files: [{ path: "package.json", content: '{ "dependencies": { "deepseek": "1.0.0" } }', language: "JSON" }],
  symbols: [],
});
assert.equal(depOnly.filter((b) => b.kind === "ai_api_call").length, 0, "dependency alone must not prove AI call");

const readmeOnly = extractImplementationBehaviors({
  files: [{ path: "README.md", content: "# AI-powered platform\nUses DeepSeek for magic.", language: null }],
  symbols: [],
});
assert.equal(readmeOnly.filter((b) => b.kind === "ai_api_call").length, 0, "README must not prove AI implementation");

const uiSlice = extractImplementationBehaviors({
  files: [
    {
      path: "components/Carousel.tsx",
      content: [
        "export function Carousel({ displayItems }) {",
        "  return displayItems.slice(0, 3).map(x => <span>{x}</span>);",
        "}",
      ].join("\n"),
      language: "TypeScript",
    },
  ],
  symbols: [
    {
      name: "Carousel",
      symbol_type: "function",
      file: "components/Carousel.tsx",
      start_line: 1,
      end_line: 3,
      language: "TypeScript",
    },
  ],
});
const uiLimit = uiSlice.find((b) => b.kind === "limit_collection");
assert.ok(uiLimit, "UI slice detected");
assert.equal(
  (uiLimit!.detail as { interpretation?: string }).interpretation,
  "ui_display_only",
  "UI slice should be classified as display-only",
);
assert.equal(uiLimit!.level, "L2", "UI-only limit should not be L3 business proof");

const projectMap = {
  implementation_workflows: workflows,
  implementation_behaviors: behaviors,
  flows: graph.flows,
  analysis_coverage: { files_deeply_read: 2 },
  backend: { endpoint_count: 1 },
  database: { technologies: ["postgres"] },
  authentication: { detected: [] },
};

const plan = planVerificationTasks({
  projectMap,
  requirementCount: 3,
  memberCount: 0,
});
assert.ok(plan.some((t) => t.kind === "brief" && t.useAi), "plan includes brief");
assert.ok(plan.some((t) => t.kind === "implementation" && t.useAi), "plan includes implementation AI");
assert.ok(plan.find((t) => t.kind === "claims")?.useAi === false, "claims skipped without members");

const onlyImpl = planVerificationTasks({
  projectMap,
  requirementCount: 3,
  memberCount: 0,
  onlyTasks: ["implementation"],
});
assert.equal(onlyImpl.length, 1);
assert.equal(onlyImpl[0].kind, "implementation");

assert.equal(normalizeVerifyTaskName("implementation_verification"), "implementation");
assert.equal(normalizeVerifyTaskName("retry-brief"), "brief");

const evSet = buildEvidenceSet(
  asRawEvidence(
    behaviors.map((b, i) => ({
      id: `EV-${String(i + 1).padStart(3, "0")}`,
      type: "transformation",
      claim: b.claim,
      file: b.file,
      confidence: "high",
    })),
  ),
);
const shared = buildSharedVerifyContext({
  hackathonBlock: "Analyze user problems with AI.",
  evidenceSet: evSet,
  projectMap,
  codeSnippet: "// snippet",
});
const implPacket = packetForTask("implementation", shared);
assert.ok(implPacket.includes("IMPLEMENTATION WORKFLOWS"), "implementation packet includes workflows");
assert.ok(shared.flowsBlock.includes("IWF-"), "shared context includes workflow ids");

const { rejected } = filterAdditionalFiles(["/etc/passwd", "missing.ts"], new Set(scanFiles.map((f) => f.path)));
assert.ok(rejected.length >= 1, "rejects unknown additional files");

const hashA = verificationContextHash({
  commitSha: "abc",
  taskKind: "brief",
  promptVersion: "verify-v1-brief",
  model: "deepseek-chat",
  evidenceFingerprint: fingerprintEvidence(["EV-001"]),
  workflowFingerprint: "IWF-001",
  requirementFingerprint: "REQ-1",
  extraPaths: [],
});
const hashB = verificationContextHash({
  commitSha: "abc",
  taskKind: "brief",
  promptVersion: "verify-v1-brief",
  model: "deepseek-chat",
  evidenceFingerprint: fingerprintEvidence(["EV-001"]),
  workflowFingerprint: "IWF-001",
  requirementFingerprint: "REQ-1",
  extraPaths: [],
});
assert.equal(hashA, hashB, "cache hash stable for identical context");

const wfId = symbolWorkflow!.id;
const validated = validateImplementationVerification(
  {
    verification_type: "implementation",
    verdict: "confirmed",
    confidence: "high",
    verification_level: "flow_verified",
    implementation_summary:
      "Backend handler calls DeepSeek, parses JSON, limits alphaList to 3 and betaList to 5, then persists.",
    important_behaviors: [
      { description: "Limits alphaList to 3", evidence_ids: ["EV-001"] },
    ],
    verified_workflows: [{ workflow_id: wfId, evidence_ids: ["EV-001"] }],
    runtime_verified: true,
    verification_complete: true,
  },
  evSet,
  projectMap,
  new Set(scanFiles.map((f) => f.path)),
);
assert.equal(validated.runtime_verified, false, "static verify cannot be runtime verified");
assert.ok(validated.implementation_summary.includes("3"), "preserves concrete limit detail");

const frontendOnly = buildRepositoryGraph({
  files: [{ path: "ui/Submit.tsx", language: "TypeScript", content: frontend }],
  symbols: [{ name: "SubmitPanel", symbol_type: "function", line: 1, file: "ui/Submit.tsx" }],
  routes: [],
});
const feOnlyBehaviors = extractImplementationBehaviors({
  files: [{ path: "ui/Submit.tsx", content: frontend, language: "TypeScript" }],
  symbols: frontendOnly.symbols,
});
const feWorkflows = discoverImplementationWorkflows({
  behaviors: feOnlyBehaviors,
  graph: frontendOnly,
  flows: frontendOnly.flows,
});
assert.ok(
  !feWorkflows.some((w) => w.closed && w.steps.some((s) => s.kind === "ai_request")),
  "frontend-only fetch should not close AI workflow",
);

console.log("engine-acceptance: ok");
