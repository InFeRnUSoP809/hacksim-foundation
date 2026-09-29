/**
 * HackSim V2 acceptance tests (A–P where runnable offline).
 * Run: deno run -A scripts/v2-acceptance.ts
 */
import { attachContent, contentByPath } from "../supabase/functions/_shared/v2/content.ts";
import { buildFileInventory, entryPointCandidates, scoreImportance } from "../supabase/functions/_shared/v2/discover.ts";
import { compileEvidence, resetEvidenceCounter } from "../supabase/functions/_shared/v2/evidence.ts";
import { buildRelationshipGraph } from "../supabase/functions/_shared/v2/graph.ts";
import { indexSymbols } from "../supabase/functions/_shared/v2/symbols.ts";
import { discoverFeatureWorkflows } from "../supabase/functions/_shared/v2/workflows.ts";
import { validateVerifierOutput } from "../supabase/functions/_shared/v2/validate-ai.ts";
import { buildCacheKey } from "../supabase/functions/_shared/v2/verifier.ts";
type Result = "PASS" | "FAIL" | "BLOCKED";

const results: Record<string, Result> = {};

function pass(id: string) { results[id] = "PASS"; }
function fail(id: string, msg: string) { results[id] = "FAIL"; console.error(id, msg); }
function blocked(id: string) { results[id] = "BLOCKED"; }

async function analyze(files: { path: string; content: string }[]) {
  resetEvidenceCounter();
  const byPath = contentByPath(files.map((f) => ({ file_path: f.path, content: f.content, start_line: 1 })));
  let inventory = buildFileInventory(files.map((f) => ({ path: f.path, size: f.content.length })), byPath);
  let provisional = attachContent(inventory, byPath);
  let symbols = indexSymbols(provisional);
  const { relationships, inDegree, routeFiles } = buildRelationshipGraph(provisional, symbols);
  inventory = scoreImportance(inventory, inDegree, routeFiles, entryPointCandidates(provisional.map((f) => f.path)));
  const merged = attachContent(inventory, byPath);
  symbols = indexSymbols(merged);
  const evidence = await compileEvidence(merged, relationships);
  const features = discoverFeatureWorkflows(relationships, evidence);
  return { evidence, features, relationships, merged };
}

// A — simple HTML
const a = await analyze([{ path: "index.html", content: "<html><body><h1>Hi</h1></body></html>" }]);
a.features.length === 0 ? pass("A") : fail("A", "expected no workflow features");

// B — full stack hints
const b = await analyze([
  { path: "src/App.tsx", content: "export function App(){ fetch('/api/x'); return null; }" },
  { path: "server.ts", content: "app.get('/api/x', () => {});" },
]);
b.relationships.some((r) => r.relationship === "calls_api") && b.features.some((f) => f.featureKey === "frontend-backend-api")
  ? pass("B") : fail("B", "missing api workflow");

// C — AI pipeline
const c = await analyze([{
  path: "fn/index.ts",
  content: "const p=loadPrompt(); await deepseek.chat.completions.create({}); JSON.parse(x); await db.insert();",
}]);
c.features.some((f) => f.featureKey === "ai-analysis-pipeline") ? pass("C") : fail("C", "no ai pipeline");

// D — unused dep
const d = await analyze([
  { path: "requirements.txt", content: "scikit-learn" },
  { path: "app.py", content: "print('hi')" },
]);
d.evidence.some((e) => e.level === "implementation" && e.claim.includes("sklearn")) ? fail("D", "ml confirmed") : pass("D");

// E — readme only
const e = await analyze([{ path: "README.md", content: "We implement forecasting with ML" }]);
e.evidence.filter((x) => x.level === "implementation" && x.claim.toLowerCase().includes("forecast")).length === 0
  ? pass("E") : fail("E", "readme proved implementation");

// F — route only
const f = await analyze([{ path: "api.ts", content: "app.post('/predict', handler);" }]);
f.evidence.some((x) => x.level === "implementation" && x.claim.includes("predict")) ? fail("F", "route confirmed impl") : pass("F");

// G — multi-file workflow
const g = await analyze([
  { path: "a.ts", content: "fetch('/api/run');" },
  { path: "b.ts", content: "app.post('/api/run', run); function run(){ service(); }" },
  { path: "c.ts", content: "export function service(){ db.query(); }" },
]);
g.relationships.length >= 2 ? pass("G") : fail("G", "weak cross-file graph");

// H — large repo simulation (many files, retrieval budget not run here)
blocked("H");

// I — adaptive retrieval (offline blocked)
blocked("I");

// J — hallucinated evidence
const j = validateVerifierOutput(
  { verdict: "confirmed", supporting_evidence_ids: ["EV-404"], summary: "x" },
  [{ evidenceId: "EV-001", level: "implementation", evidenceType: "b", claim: "c", filePath: "a", symbolName: null, startLine: 1, endLine: 1, snippetHash: null, snippetExcerpt: "x", confidence: "high" }],
  new Set(["a"]),
);
!j.ok ? pass("J") : fail("J", "validator accepted hallucination");

// K — cache key stability
const k1 = await buildCacheKey({
  commitSha: "abc", analysisVersion: "v2", operation: "op", subjectIds: ["REQ-001"],
  evidenceHash: "eh", packetHash: "ph", promptVersion: "verify-v1", model: "deepseek",
});
const k2 = await buildCacheKey({
  commitSha: "abc", analysisVersion: "v2", operation: "op", subjectIds: ["REQ-001"],
  evidenceHash: "eh", packetHash: "ph", promptVersion: "verify-v1", model: "deepseek",
});
k1 === k2 ? pass("K") : fail("K", "cache key unstable");

// L — incremental invalidation (needs DB)
blocked("L");

// M/N — real repos
blocked("M");
blocked("N");

// O — async enqueue (structural: startV2Analysis must not sync scan — grep test)
const engineSource = await Deno.readTextFile("supabase/functions/_shared/v2/engine.ts");
!engineSource.includes("const pre = await analyzeSubmission") ? pass("O") : fail("O", "sync scan in start");

// P — report reopen uses RPC on frontend
const apiSource = await Deno.readTextFile("src/lib/api.ts");
apiSource.includes("getV2AnalysisSummaryRpc") ? pass("P") : fail("P", "missing rpc summary");

console.log("\n=== V2 Acceptance ===");
for (const [id, r] of Object.entries(results).sort()) {
  console.log(`${id}: ${r}`);
}
if (Object.values(results).includes("FAIL")) Deno.exit(1);
