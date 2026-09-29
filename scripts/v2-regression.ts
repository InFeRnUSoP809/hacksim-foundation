/**
 * V2 deterministic regression (fixtures A–D subset).
 * Run: deno run -A scripts/v2-regression.ts
 */

import { attachContent, contentByPath } from "../supabase/functions/_shared/v2/content.ts";
import { buildFileInventory, entryPointCandidates, scoreImportance } from "../supabase/functions/_shared/v2/discover.ts";
import { compileEvidence, resetEvidenceCounter } from "../supabase/functions/_shared/v2/evidence.ts";
import { buildRelationshipGraph } from "../supabase/functions/_shared/v2/graph.ts";
import { indexSymbols } from "../supabase/functions/_shared/v2/symbols.ts";
import { discoverFeatureWorkflows } from "../supabase/functions/_shared/v2/workflows.ts";
import { validateVerifierOutput } from "../supabase/functions/_shared/v2/validate-ai.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function analyzeFixture(name: string, files: { path: string; content: string }[]) {
  resetEvidenceCounter();
  const tree = files.map((f) => ({ path: f.path, size: f.content.length }));
  const byPath = contentByPath(files.map((f) => ({ file_path: f.path, content: f.content, start_line: 1 })));
  let inventory = buildFileInventory(tree, byPath);
  let provisional = attachContent(inventory, byPath);
  let symbols = indexSymbols(provisional);
  const { relationships, inDegree, routeFiles } = buildRelationshipGraph(provisional, symbols);
  inventory = scoreImportance(inventory, inDegree, routeFiles, entryPointCandidates(provisional.map((f) => f.path)));
  const merged = attachContent(inventory, byPath);
  symbols = indexSymbols(merged);
  const evidence = await compileEvidence(merged, relationships);
  const features = discoverFeatureWorkflows(relationships, evidence);
  return { name, evidence, features, relationships };
}

// Fixture A — simple HTML
const fixtureA = [{ path: "index.html", content: "<html><body><h1>Hello</h1></body></html>" }];

// Fixture B — React → API hint
const fixtureB = [
  {
    path: "src/App.tsx",
    content: `
export function App() {
  async function load() {
    await fetch("/api/items");
  }
  return null;
}`,
  },
  {
    path: "server/index.ts",
    content: `
import express from "express";
const app = express();
app.get("/api/items", (req, res) => res.json([]));
`,
  },
];

// Fixture C — AI pipeline
const fixtureC = [
  {
    path: "supabase/functions/analyze/index.ts",
    content: `
const prompt = loadPrompt();
const res = await deepseek.chat.completions.create({ messages: [{ role: "user", content: prompt }] });
const parsed = JSON.parse(res.choices[0].message.content);
await supabase.from("results").insert(parsed);
`,
  },
];

// Fixture D — unused sklearn in requirements.txt only
const fixtureD = [
  { path: "requirements.txt", content: "scikit-learn\nflask" },
  { path: "app.py", content: "from flask import Flask\napp = Flask(__name__)\n@app.get('/')\ndef home(): return 'ok'" },
];

// Fixture I — hallucinated evidence rejection
const hallucinated = validateVerifierOutput(
  {
    verdict: "confirmed",
    supporting_evidence_ids: ["EV-999"],
    summary: "confirmed",
  },
  [{ evidenceId: "EV-001", level: "implementation", evidenceType: "x", claim: "c", filePath: "a", symbolName: null, startLine: 1, endLine: 1, snippetHash: null, snippetExcerpt: "x", confidence: "high" }],
  new Set(["a"]),
);

const results = await Promise.all([
  analyzeFixture("A", fixtureA),
  analyzeFixture("B", fixtureB),
  analyzeFixture("C", fixtureC),
  analyzeFixture("D", fixtureD),
]);

const a = results[0];
assert(a.features.length === 0, "A should not build workflow features (minimal analysis scope)");

const b = results[1];
assert(b.relationships.some((r) => r.relationship === "calls_api"), "B should detect frontend API call");
assert(b.features.some((f) => f.featureKey === "frontend-backend-api"), "B should build API workflow");

const c = results[2];
assert(c.features.some((f) => f.featureKey === "ai-analysis-pipeline"), "C should detect AI pipeline");

const d = results[3];
const mlConfirmed = d.evidence.some((e) => e.level === "implementation" && e.claim.toLowerCase().includes("sklearn"));
assert(!mlConfirmed, "D must not confirm ML from dependency alone");

assert(!hallucinated.ok, "I validator must reject unknown evidence ids");

console.log("v2-regression: all checks passed");
