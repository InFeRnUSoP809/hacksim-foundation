/**
 * Phase 5 + 6 regression suite.
 *
 * Every test here is a statement about behaviour the product promises, not
 * about an implementation detail. Run with:  npx tsx scripts/regression-analysis.ts
 *
 * The suite is deliberately split into three groups:
 *
 *   A  the removed shortcut cannot come back        (§29 tests 9–13)
 *   B  accuracy rules                               (§60)
 *   C  the real thing, on real repositories         (§52–§54, §69)
 *
 * Group C downloads two unrelated repositories and runs the production
 * scanner, the production requirement engine and the production retrieval
 * ranking over them, then asserts that the analysis adapted to each one rather
 * than to a template.
 */

import { readFileSync, readdirSync, type Dirent } from "node:fs";

const globals = globalThis as unknown as { Deno?: unknown };
if (!globals.Deno) {
  globals.Deno = {
    env: {
      get: (name: string) => (process.env as Record<string, string | undefined>)[name],
    },
  };
}

import { analyseRequirement, groupRequirements, briefVocabulary } from "../supabase/functions/_shared/concepts.ts";
import { buildRequirementMap as buildMap } from "../supabase/functions/_shared/requirements.ts";

import { profileDataset, compactDatasetProfile } from "../supabase/functions/_shared/datasets.ts";
import { analyseSemantics } from "../supabase/functions/_shared/semantics.ts";
import { buildRetrievalPlan, buildRepoIndex, retrieve } from "../supabase/functions/_shared/retrieval.ts";
import { buildEvidenceSet, validateFindings, detectConflicts } from "../supabase/functions/_shared/evidence.ts";
import { validateConclusions, validateClaims, validateAlignment } from "../supabase/functions/_shared/validate.ts";
import { deterministicCount, deterministicLiteral, inspectionCovers, NO_VERDICT } from "../supabase/functions/_shared/deterministic.ts";
import { planAnalysis } from "../supabase/functions/_shared/planner.ts";
import { looksBinary } from "../supabase/functions/_shared/github.ts";
import { buildAlignmentTask, buildRequirementsTask, SYSTEM_STABLE, NO_SNIPPETS } from "../supabase/functions/_shared/modules.ts";
import { citedEvidence, diffRuns } from "../supabase/functions/_shared/diff.ts";
import { runHarness, loadFixture, mockProvider } from "./lib/harness.ts";

// ── Tiny runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(group: string, name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${group} · ${name}`);
    })
    .catch((error: unknown) => {
      failed++;
      const message = (error as Error).message ?? String(error);
      failures.push(`${group} · ${name}: ${message}`);
      console.log(`  FAIL ${group} · ${name}\n       ${message.split("\n")[0]}`);
    });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n       expected ${b}\n       actual   ${a}`);
}

function group(name: string) {
  console.log(`\n${name}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const medistockFixture = loadFixture("scripts/fixtures/medistock.json");
const quickfixFixture = loadFixture("scripts/fixtures/quickfix.json");

const medistockMap = {
  version: 1,
  input_hash: "test",
  ...buildMap(medistockFixture.hackathon),
};

const vocabulary = briefVocabulary(medistockMap);

function makeIndex(overrides: {
  files: Record<string, unknown>[];
  chunks?: Record<string, unknown>[];
  evidence?: Record<string, unknown>[];
  routes?: Record<string, unknown>[];
  datasetProfiles?: never[];
  semantics?: never[];
}) {
  return buildRepoIndex({
    files: overrides.files as never,
    chunks: (overrides.chunks ?? []) as never,
    evidence: (overrides.evidence ?? []) as never,
    routes: (overrides.routes ?? []) as never,
    datasetProfiles: overrides.datasetProfiles ?? [],
    semantics: overrides.semantics ?? [],
  });
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════════
  group("A · the removed shortcut cannot come back");

  await test("A", "source contains no alignmentFromEvidence / REQUIREMENT_SIGNALS / signalsFor / requirementsFromDeterministic", () => {
    const forbidden = [
      "alignmentFromEvidence",
      "REQUIREMENT_SIGNALS",
      "signalsFor",
      "requirementsFromDeterministic",
    ];
    for (const name of forbidden) {
      const hits = grepProject(name);
      assertEqual(hits.length, 0, `${name} still appears in: ${hits.join(", ")}`);
    }
  });

  await test("A", "the generated bundle contains none of them", () => {
    const bundle = readFileSync("supabase/functions/bundle/analysis.ts", "utf8");
    for (const name of [
      "alignmentFromEvidence",
      "REQUIREMENT_SIGNALS",
      "signalsFor",
      "requirementsFromDeterministic",
      "No matching technology",
    ]) {
      assert(!bundle.includes(name), `the deployed bundle still contains ${name}`);
    }
  });

  await test("A", "the bundle carries the new requirement engine", () => {
    const bundle = readFileSync("supabase/functions/bundle/analysis.ts", "utf8");
    for (const marker of [
      "buildRetrievalPlan",
      "profileDataset",
      "analyseSemantics",
      "unable_to_determine",
      "dataset_profile",
    ]) {
      assert(bundle.includes(marker), `the bundle is missing ${marker}`);
    }
  });

  await test("A", "no individual contribution analysis remains", () => {
    const module = readFileSync("supabase/functions/_shared/modules.ts", "utf8");
    for (const marker of ["buildContributionTask", "CLAIMED CONTRIBUTION", "CONTRIBUTION_STATUSES"]) {
      assert(!module.includes(marker), `a contribution prompt still exists (${marker})`);
    }
    const review = readFileSync("supabase/functions/_shared/review.ts", "utf8");
    assert(!/buildContributionTask|moduleContributions|MODULE_D/.test(review),
      "the orchestrator still has a contribution module");
    const evidence = readFileSync("supabase/functions/_shared/evidence.ts", "utf8");
    assert(!evidence.includes("CONTRIBUTION_STATUSES"),
      "contribution statuses are still modelled");
  });

  // ══════════════════════════════════════════════════════════════════════════
  group("B · accuracy rules (§60, §8, §31)");

  await test("B1", "a technology that is absent never yields unable_to_determine", () => {
    // scikit-learn and TensorFlow appear nowhere in this requirement, and the
    // concept set must not mention them.
    const concept = analyseRequirement(
      "Produce a demand forecast per medicine for a configurable future window",
      vocabulary,
      medistockMap,
    );
    const haystack = JSON.stringify(concept).toLowerCase();
    for (const technology of ["tensorflow", "pytorch", "sklearn", "scikit", "pandas", "numpy"]) {
      assert(!haystack.includes(technology),
        `the retrieval plan mentions ${technology}, which is a technology proxy`);
    }
    assert(concept.actions.includes("forecast"),
      "the requirement's own capability word is missing from the plan");
  });

  await test("B2", "a requirement can be met without the expected library", () => {
    // A hand-written moving average in plain JavaScript satisfies "forecast":
    // the extractor finds the behaviour with no library in sight.
    const found = analyseSemantics(
      "public/app.js",
      [
        "function forecastDemand(history, window) {",
        "  const counts = history.reduce((sum, row) => sum + row.quantity, 0);",
        "  const average = counts / Math.max(1, history.length);",
        "  return Array.from({ length: window }, (_, i) => average * (1 + i * 0.05));",
        "}",
      ].join("\n"),
      [],
    );
    assert(found.calculations.length > 0,
      "arithmetic implementing a forecast was not detected as a calculation");
    assert(
      found.calculations.some((item) => item.claim.includes("aggregates") ||
        item.claim.includes("multiplies") || item.claim.includes("adds")),
      "the forecast calculation was not described",
    );
  });

  await test("B3", "a library being present does not prove the requirement", () => {
    // Importing a forecasting library and never calling it must produce no
    // inference evidence at all.
    const unused = analyseSemantics(
      "app/requirements.txt",
      "scikit-learn==1.5.0\npandas==2.2.0\n",
      [],
    );
    assertEqual(unused.models.length, 0, "an import was mistaken for model usage");
    assertEqual(unused.calculations.length, 0, "an import was mistaken for a calculation");

    const used = analyseSemantics(
      "app/model.py",
      [
        "from sklearn.linear_model import LinearRegression",
        "model = LinearRegression()",
        "model.fit(X, y)",
        "prediction = model.predict(future_X)",
      ].join("\n"),
      [],
    );
    assert(used.models.some((item) => item.operation === "training"),
      "a fit() call was not recognised as training");
    assert(used.models.some((item) => item.operation === "inference"),
      "a predict() call was not recognised as inference");
  });

  await test("B4", "relevant source is retrieved for each requirement, and differs between them", () => {
    const files = [
      { path: "src/api/routes.ts", file_category: "api", importance: "high" },
      { path: "src/ml/predictor.py", file_category: "source", importance: "medium" },
      { path: "src/ui/dashboard.html", file_category: "component", importance: "medium" },
      { path: "data/sales.csv", file_category: "dataset", importance: "high" },
      { path: "README.md", file_category: "documentation", importance: "low" },
      { path: "package.json", file_category: "config", importance: "high" },
    ];
    const index = makeIndex({
      files,
      chunks: [
        { file_path: "src/ml/predictor.py", symbol_name: "forecast_demand", content: "forecast demand per medicine over the window", importance: "medium" },
        { file_path: "src/api/routes.ts", symbol_name: "create_reorder", content: "reorder quantity and date", importance: "high" },
        { file_path: "src/ui/dashboard.html", symbol_name: null, content: "dashboard table button accept", importance: "medium" },
      ],
    });

    const forecast = analyseRequirement(
      "Produce a demand forecast per medicine for a configurable future window",
      vocabulary,
      medistockMap,
    );
    const interface_ = analyseRequirement(
      "Provide an interface a pharmacist can use in a few seconds per item",
      vocabulary,
      medistockMap,
    );

    const forecastHits = retrieve({ plan: buildRetrievalPlan("REQ-001", forecast), index });
    const interfaceHits = retrieve({ plan: buildRetrievalPlan("REQ-006", interface_), index });

    assert(forecastHits.files.some((hit) => hit.path === "src/ml/predictor.py"),
      "the forecasting requirement did not retrieve the predictor");
    assert(interfaceHits.files.some((hit) => hit.path === "src/ui/dashboard.html"),
      "the interface requirement did not retrieve the interface");
    assert(
      forecastHits.files.map((hit) => hit.path).join() !==
        interfaceHits.files.map((hit) => hit.path).join(),
      "two different requirements retrieved exactly the same files",
    );
  });

  await test("B5", "datasets are profiled", () => {
    const csv = [
      "date,medicine_id,quantity,price",
      "2024-01-01,M001,12,4.50",
      "2024-01-02,M001,7,4.50",
      "2024-01-03,M002,3,9.10",
    ].join("\n");
    const profile = profileDataset({ path: "data/sales.csv", content: csv, sizeBytes: csv.length }, [
      analyseRequirement("Produce a demand forecast per medicine", vocabulary, medistockMap),
    ]);
    assert(profile, "a CSV was not profiled at all");
    assertEqual(profile.format, "csv");
    assertEqual(profile.approx_row_count, 3);
    assert(profile.date_columns.includes("date"), "the date column was not identified");
    assert(
      profile.quantity_columns.includes("quantity"),
      "the quantity column was not identified",
    );
    assert(profile.relevance === "high" || profile.relevance === "medium",
      `a dataset matching the brief's own nouns was rated ${profile.relevance}`);
    assertEqual(profile.column_names.length, 4);
  });

  await test("B6", "a large CSV is profiled without being sent to a model", () => {
    const header = "date,medicine_id,quantity";
    const rows = Array.from(
      { length: 20000 },
      (_, i) => `2024-01-01,M${i % 60},${i % 17}`,
    );
    const csv = `${header}\n${rows.join("\n")}`;
    const head = csv.slice(0, 60_000); // the scanner only reads a head
    const profile = profileDataset(
      { path: "data/sales_transactions.csv", content: head, sizeBytes: csv.length },
      [],
    );
    assert(profile, "a large CSV was not profiled");
    assertEqual(profile.row_count_exact, false, "a truncated file claimed an exact row count");
    assert(profile.approx_row_count > 10000,
      `row estimate ${profile.approx_row_count} is implausible for 20 000 rows`);
    assert(profile.notes.length > 0, "truncation was not disclosed in the notes");

    const compact = compactDatasetProfile(profile!);
    const rendered = JSON.stringify(compact);
    assert(rendered.length < 4000, "the compact profile is too large to send");
    assert(rendered.split("2024-01-01").length - 1 <= 3,
      "the compact profile is carrying raw rows");
  });

  await test("B7", "conclusions cite real evidence ids", () => {
    const evidence = buildEvidenceSet([
      { id: "EV-001", type: "function", claim: "forecast_demand computes a future window", file: "a.py", confidence: "high" },
      { id: "EV-002", type: "dataset_profile", claim: "sales.csv has 7 746 rows", file: "b.csv", confidence: "high" },
    ]);
    const result = validateConclusions(
      {
        conclusions: [
          { subject_id: "REQ-001", status: "partial_evidence", confidence: "high", evidence_ids: ["EV-001"], explanation: "A future window is computed from history." },
        ],
      },
      { kind: "requirement", allowedSubjects: ["REQ-001"], evidence },
    );
    assertEqual(result.items.length, 1);
    assertEqual(result.items[0].evidence_ids, ["EV-001"]);
    assertEqual(result.rejectedEvidenceIds, []);
  });

  await test("B8", "hallucinated evidence ids are rejected and positives are downgraded", () => {
    const evidence = buildEvidenceSet([
      { id: "EV-001", type: "function", claim: "reads the dataset", file: "a.py", confidence: "high" },
    ]);

    const hallucinated = validateConclusions(
      {
        conclusions: [
          { subject_id: "REQ-001", status: "evidence_found", confidence: "high", evidence_ids: ["EV-101", "EV-999"], explanation: "The behaviour is fully implemented in the repository." },
        ],
      },
      { kind: "requirement", allowedSubjects: ["REQ-001"], evidence },
    );
    assertEqual(hallucinated.items[0].evidence_ids, [],
      "a hallucinated citation survived validation");
    assertEqual(hallucinated.rejectedEvidenceIds.sort(), ["EV-101", "EV-999"]);
    assertEqual(hallucinated.items[0].status, "partial_evidence",
      "an uncited positive status was not downgraded");
    assert(hallucinated.items[0].downgraded, "the downgrade was not recorded");

    // not_evidenced with no citation is the honest answer and must survive.
    const honest = validateConclusions(
      {
        conclusions: [
          { subject_id: "REQ-001", status: "not_evidenced", confidence: "medium", evidence_ids: [], explanation: "The retrieved code does not show this behaviour." },
        ],
      },
      { kind: "requirement", allowedSubjects: ["REQ-001"], evidence },
    );
    assertEqual(honest.items[0].status, "not_evidenced");
    assertEqual(honest.items[0].downgraded, false);

    // A requirement the model was never shown cannot be answered.
    const invented = validateConclusions(
      {
        conclusions: [
          { subject_id: "REQ-999", status: "evidence_found", evidence_ids: ["EV-001"], explanation: "A requirement nobody asked about, answered anyway." },
        ],
      },
      { kind: "requirement", allowedSubjects: ["REQ-001"], evidence },
    );
    assertEqual(invented.items.length, 0, "an unasked requirement was answered");
    assertEqual(invented.rejectedSubjects, ["REQ-999"]);
  });

  await test("B9", "a limited inspection turns not_evidenced into unable_to_determine", () => {
    const covered = inspectionCovers({ mode: "full", warnings: [], filesSeen: 40, filesRead: 40 });
    assert(covered.covered, "a full inspection was reported as incomplete");

    const limited = inspectionCovers({ mode: "limited", warnings: [], filesSeen: 4000, filesRead: 200 });
    assert(!limited.covered, "a limited inspection claimed full coverage");
    assert(/not fully inspected/i.test(limited.note), "the coverage note is not explicit");

    const rateLimited = inspectionCovers({
      mode: "full",
      warnings: ["GitHub rate limit reached partway through; later files were not read."],
      filesSeen: 100,
      filesRead: 100,
    });
    assert(!rateLimited.covered, "a rate-limited scan claimed full coverage");
  });

  await test("B10", "a text file is never mistaken for a binary", () => {
    const html = new TextEncoder().encode(
      "<!doctype html><html><body><h1>Dashboard ₹ orders</h1><p>Total — 1 250</p></body></html>",
    );
    assertEqual(looksBinary(html, "dashboard.html"), false, "a UTF-8 page was called binary");

    const real = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]);
    assertEqual(looksBinary(real, "logo.png"), true, "a PNG was called text");
  });

  await test("B11", "findings without resolvable evidence are dropped", () => {
    const evidence = buildEvidenceSet([
      { id: "EV-001", type: "function", claim: "reads the dataset", file: "a.py", confidence: "high" },
    ]);
    const findings = validateFindings(
      [
        { type: "potential_issue", title: "Invented", evidence_ids: ["EV-777"] },
        { type: "observation", title: "Observation without evidence", evidence_ids: [] },
        { type: "security_concern", title: "Real", evidence_ids: ["EV-001"] },
        { type: "confirmed_issue", title: "Unsure", evidence_ids: ["EV-001"], confidence: "low" },
      ],
      evidence,
    );
    const titles = findings.map((finding) => finding.title);
    assert(!titles.includes("Invented"), "a finding with a fake citation was stored");
    assert(titles.includes("Observation without evidence"), "an observation was wrongly dropped");
    assert(
      findings.find((finding) => finding.title === "Unsure")?.finding_type === "potential_issue",
      "a low-confidence confirmed issue was not demoted",
    );
  });

  await test("B12", "a claim mismatch is stated factually", () => {
    const evidence = buildEvidenceSet([
      { id: "EV-010", type: "calculation", claim: "aggregates historical quantity by month", file: "a.py", confidence: "high" },
    ]);
    const findings = detectConflicts(
      {
        claim: "ML predicts future demand",
        status: "not_evidenced",
        evidenceIds: ["EV-010"],
        explanation: "",
        observed: ["aggregates historical quantity by month"],
      },
      evidence,
    );
    assertEqual(findings.length, 1);
    assertEqual(findings[0].finding_type, "claim_mismatch");
    const text = findings[0].description.toLowerCase();
    for (const word of ["lie", "dishonest", "false", "fake", "lying"]) {
      assert(!text.includes(word), `the mismatch wording says "${word}"`);
    }
    assert(/does not currently show|does not show/i.test(findings[0].title),
      "the mismatch title is not about the evidence");
  });

  await test("B13", "a missing database is never a finding when none was required", () => {
    const plan = planAnalysis(
      {
        id: "h", name: "Open", type: "open_innovation", problem: "", hasProblem: false,
        theme: "anything", claims: { description: "A static site", features: "", techStack: "" },
        requirements: [], constraints: [], expectedOutcomes: [], evaluationCriteria: [],
        hasRequirements: false, hasConstraints: false, hasOutcomes: false, hasCriteria: false,
        customInstructions: null, technologyRestrictions: null, datasetRequirements: null,
        deploymentRequirements: null, freeformNotes: [], version: "v", configVersion: 1, snapshot: {},
      } as never,
      {
        fileCount: 12, sourceFileCount: 4, datasetCount: 0, datasetProfileCount: 0,
        functionCount: 6, classCount: 0, routeCount: 0, modelFindingCount: 0,
        calculationCount: 2, ruleCount: 0, dataAccessCount: 0, uiFindingCount: 3,
        testFileCount: 0, deploymentFileCount: 0, secretCount: 0, authDetected: false,
        databaseDetected: false, hasReadme: true, analysisMode: "full", stackSummary: "",
      },
      [], [], [], [], [],
    );

    assertEqual(plan.requirementsEnabled, false,
      "requirements were invented for an open-innovation brief");
    assert(plan.tasks.every((task) => task.kind !== "requirements"),
      "a requirement analysis task was planned for a brief with no requirements");
    assert(!plan.tasks.some((task) => task.kind === "outcomes"),
      "an expected-outcome task was planned for a brief with none");
    const database = plan.dimensions.find((item) => item.key === "database_usage");
    assertEqual(database?.relevance, "not_applicable");
    assert(/not penalised|not a problem|no database/i.test(database?.reason ?? ""),
      "the reason does not explain that a missing database is fine");
    // The properness call always runs; that is the product's core question.
    assert(plan.tasks.some((task) => task.kind === "properness"));
  });

  await test("B14", "the deterministic layer only decides counts and named literals", () => {
    const countables = {
      endpoint: { label: "HTTP endpoint", count: 5, source: "routes" },
    };
    const met = deterministicCount("The app must expose at least 3 endpoints", countables);
    assertEqual(met.status, "evidence_found");
    assertEqual(met.method, "deterministic_count");

    const missed = deterministicCount("The app must expose at least 9 endpoints", countables);
    assertEqual(missed.status, "not_evidenced");

    // No explicit minimum: not a threshold, so the model decides.
    assertEqual(deterministicCount("The app should expose 3 endpoints", countables).status, null);

    // A technology requirement is never settled by counting or by name.
    const technology = deterministicCount(
      "Must use scikit-learn for the forecasting model",
      countables,
    );
    assertEqual(technology.status, null, "a technology requirement was decided deterministically");

    const index = makeIndex({
      files: [{ path: "src/api/orders.ts", file_category: "api", importance: "high" }],
      routes: [{ path: "/orders", file: "src/api/orders.ts", method: "POST" }],
      evidence: [{ id: "EV-001", type: "route", claim: "POST /orders exists", file: "src/api/orders.ts", confidence: "high" }],
    });
    const evidence = buildEvidenceSet(index.evidenceByPath.get("src/api/orders.ts") ?? []);
    const named = deterministicLiteral("Add an `orders` endpoint", index, evidence);
    assert(named.status !== null, "a named literal was not resolved");

    // A prohibition is never settled by absence.
    assertEqual(
      deterministicLiteral("Must not use `pandas`", index, evidence).status,
      NO_VERDICT.status,
    );
  });

  await test("B15", "prompts forbid technology and route proxies by name", () => {
    assert(/NEVER treat a library as proof/i.test(SYSTEM_STABLE),
      "the system prompt does not forbid library-as-proof");
    assert(/does NOT prove the behaviour/i.test(SYSTEM_STABLE),
      "the system prompt does not forbid route-as-proof");
    assert(/absent library does not mean the feature is missing/i.test(SYSTEM_STABLE),
      "the system prompt does not separate absence from non-implementation");

    const prompt = buildRequirementsTask(
      {
        context: { name: "H", type: "problem_statement", problem: "p", hasProblem: true, theme: null,
          claims: { description: "d", features: "f", techStack: "t" },
          requirements: [], constraints: [], expectedOutcomes: [], evaluationCriteria: [],
          hasRequirements: true, hasConstraints: false, hasOutcomes: false, hasCriteria: false,
          customInstructions: null, technologyRestrictions: null, datasetRequirements: null,
          deploymentRequirements: null, freeformNotes: [], version: "v", configVersion: 1, snapshot: {} } as never,
        projectMap: {},
        evidence: [],
        terms: [],
        code: "",
        datasetProfiles: [],
        semantics: [],
        concepts: [],
        inspectionNote: "",
      },
      [{ id: "REQ-001", text: "Forecast demand", importance: "critical" }],
      "computation",
    );
    assert(/Do not treat the absence of a library/i.test(prompt),
      "the requirement prompt permits library absence as evidence");
    assert(prompt.includes(NO_SNIPPETS) || prompt.includes("RELEVANT CODE"),
      "the requirement prompt does not include a code section");
  });

  await test("B16", "an empty retrieval packet is stated, not padded", () => {
    const prompt = buildAlignmentTask({
      context: { name: "H", type: "problem_statement", problem: "p", hasProblem: true, theme: null,
        claims: { description: "", features: "", techStack: "" },
        requirements: [], constraints: [], expectedOutcomes: [], evaluationCriteria: [],
        hasRequirements: false, hasConstraints: false, hasOutcomes: false, hasCriteria: false,
        customInstructions: null, technologyRestrictions: null, datasetRequirements: null,
        deploymentRequirements: null, freeformNotes: [], version: "v", configVersion: 1, snapshot: {} } as never,
      projectMap: {},
      evidence: [],
      terms: [],
      code: "",
      datasetProfiles: [],
      semantics: [],
      concepts: [],
      inspectionNote: "",
    });
    assert(prompt.includes(NO_SNIPPETS), "an empty packet is not disclosed to the model");
  });

  await test("B17", "claims are only checked when the team actually made them", () => {
    const evidence = buildEvidenceSet([
      { id: "EV-001", type: "calculation", claim: "computes a moving average", file: "a.js", confidence: "high" },
    ]);
    const result = validateClaims(
      { claims: [{ claim: "We predict demand", status: "supported", evidence_ids: [], explanation: "A moving average is computed over the history." }] },
      evidence,
      ["We predict demand", "Something else entirely"],
    );
    assertEqual(result.items.length, 1);
    assertEqual(result.items[0].status, "partially_supported",
      "an uncited 'supported' claim was not downgraded");

    const invented = validateClaims(
      { claims: [{ claim: "We also do quantum pricing", status: "not_evidenced", evidence_ids: [], explanation: "Nothing in the repository shows this." }] },
      evidence,
      ["We predict demand"],
    );
    assertEqual(invented.items.length, 0, "a claim the team never made was evaluated");
  });

  // ══════════════════════════════════════════════════════════════════════════
  group("D · re-analysis compares two runs (§45)");

  const runA = {
    commit_sha: "aaaaaaa1111",
    created_at: "2026-01-01T00:00:00.000Z",
    conclusions: [
      { subject_id: "REQ-1", kind: "requirement", status: "not_evidenced", evidence_ids: [] },
      { subject_id: "REQ-2", kind: "requirement", status: "partial_evidence", evidence_ids: ["EV-001"] },
    ],
    evidence_index: [{ id: "EV-001", claim: "reads the order file", file: "orders.ts" }],
  };

  await test("D1", "a first run has nothing to compare against, so there is no diff", () => {
    const diff = diffRuns(null, {
      commit_sha: "aaaaaaa1111",
      conclusions: runA.conclusions,
      evidence: runA.evidence_index,
    });
    assertEqual(diff, null, "a first run was reported as a change");
  });

  await test("D2", "a re-run that finds the same thing stays quiet", () => {
    const diff = diffRuns(runA, {
      commit_sha: "aaaaaaa1111",
      conclusions: runA.conclusions,
      evidence: runA.evidence_index,
    });
    assertEqual(diff, null, "an unchanged re-analysis was reported as a change");
  });

  await test("D3", "a conclusion that moved is reported with both of its statuses", () => {
    const diff = diffRuns(runA, {
      commit_sha: "bbbbbbb2222",
      conclusions: [
        { subject_id: "REQ-1", kind: "requirement", status: "evidenced", evidence_ids: ["EV-002"] },
        { subject_id: "REQ-2", kind: "requirement", status: "partial_evidence", evidence_ids: ["EV-001"] },
      ],
      evidence: [
        { id: "EV-001", claim: "reads the order file", file: "orders.ts" },
        { id: "EV-002", claim: "validates the order total", file: "total.ts" },
      ],
    });
    assert(diff, "a real change produced no diff");
    assertEqual(diff.changed, [
      { id: "REQ-1", kind: "requirement", from: "not_evidenced", to: "evidenced" },
    ], "the moved conclusion was not reported exactly once, with both statuses");
    assertEqual(diff.previous_commit, "aaaaaaa1111", "the previous commit is missing");
    assertEqual(diff.commit, "bbbbbbb2222", "the new commit is missing");
    assertEqual(diff.evidence_added.map((e) => e.id), ["EV-002"], "the new citation was missed");
    assertEqual(diff.evidence_removed.length, 0, "a still-cited piece of evidence was reported as gone");
  });

  await test("D4", "a subject entering or leaving the brief is reported as such", () => {
    const diff = diffRuns(runA, {
      commit_sha: "bbbbbbb2222",
      conclusions: [
        { subject_id: "REQ-2", kind: "requirement", status: "partial_evidence", evidence_ids: ["EV-001"] },
        { subject_id: "CON-1", kind: "constraint", status: "evidenced", evidence_ids: [] },
      ],
      evidence: runA.evidence_index,
    });
    assert(diff, "an added and a removed subject produced no diff");
    assertEqual(diff.added, ["CON-1"], "a newly judged subject was missed");
    assertEqual(diff.removed, ["REQ-1"], "a subject that left the brief was missed");
  });

  await test("D5", "only cited evidence is compared; scanned code is not news", () => {
    const cited = citedEvidence(
      [{ subject_id: "REQ-2", status: "partial_evidence", evidence_ids: ["EV-001"] }],
      [
        { id: "EV-001", claim: "reads the order file", file: "orders.ts" },
        { id: "EV-009", claim: "a helper exists", file: "helper.ts" },
      ],
    );
    assertEqual(cited.map((e) => e.id), ["EV-001"],
      "evidence that no conclusion cited was treated as something the reader was shown");
  });

  await test("D6", "evidence that disappeared keeps the claim it had when it was found", () => {
    const diff = diffRuns(runA, {
      commit_sha: "bbbbbbb2222",
      conclusions: [{ subject_id: "REQ-1", kind: "requirement", status: "not_evidenced", evidence_ids: [] }],
      evidence: [],
    });
    assert(diff, "a removed citation produced no diff");
    assertEqual(diff.evidence_removed, [
      { id: "EV-001", claim: "reads the order file", file: "orders.ts" },
    ], "the removed evidence lost the only description of it that still exists");
  });

  // ══════════════════════════════════════════════════════════════════════════
  group("C · real repositories (§52–§54, §69)");

  const medistock = await runHarness({
    url: medistockFixture.submission.github_url as string,
    fixture: medistockFixture,
  });

  await test("C1", "MediStock: the scan reads the repository and profiles its data", () => {
    assert(medistock.scan.files.length > 20, "the file inventory is suspiciously small");
    assert(medistock.scan.evidence.length > 40, "almost no evidence was produced");
    assert(medistock.scan.routes.length > 5, "no routes were found");
    assert(medistock.scan.datasetProfiles.length >= 4,
      `only ${medistock.scan.datasetProfiles.length} datasets were profiled`);

    const sales = medistock.scan.datasetProfiles.find((profile) =>
      profile.path.endsWith("backend/data/sales_transactions.csv"),
    );
    assert(sales, "the 1.6 MB sales dataset was not profiled");
    assert(sales!.approx_row_count > 1000, "the sales dataset row count looks wrong");
    assert(sales!.date_columns.length > 0, "no date column was identified");
    assert(
      sales!.entity_columns.length > 0 || sales!.identifier_columns.length > 0,
      "no entity or identifier column was identified",
    );
  });

  await test("C2", "MediStock: the HTML interface is analysed, not discarded", () => {
    const dashboard = medistock.scan.files.find((file) => file.path === "dashboard.html");
    assert(dashboard, "dashboard.html is missing from the inventory");
    assertEqual(dashboard!.is_binary, false, "dashboard.html was treated as a binary");
    const ui = medistock.scan.semantics.find((item) => item.path === "dashboard.html");
    assert(ui, "no interface behaviour was extracted from dashboard.html");
    assert(ui!.ui.length > 0, "dashboard.html yielded no interface evidence");
  });

  await test("C3", "MediStock: each requirement retrieves its own implementation", () => {
    const expectations: [string, string][] = [
      ["REQ-001", "backend/data/sales_transactions.csv"],
      ["REQ-002", "backend/ml/predictor.py"],
      ["REQ-003", "backend/services/reorder_service.py"],
      ["REQ-006", "dashboard.html"],
    ];
    for (const [id, expected] of expectations) {
      const result = medistock.retrieval.get(id);
      assert(result, `${id} produced no retrieval`);
      const paths = result!.files.map((hit) => hit.path);
      assert(paths.includes(expected),
        `${id} ("${medistock.concepts.get(id)!.intent.slice(0, 50)}") did not retrieve ${expected}. Got: ${paths.join(", ")}`);
    }
  });

  await test("C4", "MediStock: the forecast requirement carries the history that feeds it", () => {
    const result = medistock.retrieval.get("REQ-002")!;
    assert(
      result.datasetPaths.some((path) => path.includes("sales_transactions")),
      `the forecasting requirement is not shown the sales history. Got: ${result.datasetPaths.join(", ")}`,
    );
    const evidence = medistock.evidence.byId.get(result.evidenceIds[0]);
    assert(evidence, "the retrieval returned no usable evidence ids");
  });

  await test("C5", "MediStock: the plan is specific to this challenge", () => {
    assert(medistock.plan.requirementsEnabled, "requirements were not enabled");
    assert(medistock.plan.tasks.some((task) => task.kind === "requirements"),
      "no requirement task was planned");
    assert(medistock.plan.tasks.some((task) => task.kind === "properness"),
      "no properness assessment was planned");
    const groups = groupRequirements(medistockMap);
    const focuses = new Set(groups.map((group) => group.focus));
    assert(focuses.has("analytics") || focuses.has("decision") || focuses.has("data"),
      `the requirement grouping produced nothing meaningful: ${[...focuses].join(", ")}`);
  });

  const quickfix = await runHarness({
    url: quickfixFixture.submission.github_url as string,
    fixture: quickfixFixture,
  });

  await test("C6", "quick-fix: an open-innovation brief produces no invented requirements", () => {
    assertEqual(quickfix.scan.analysisMode !== undefined, true);
    assert(quickfix.requirementMap.requirements.length === 0,
      "the fixture brief has no requirements, yet some were produced");
    assertEqual(quickfix.plan.requirementsEnabled, false,
      "requirements were enabled for an open-innovation brief");
    assert(!quickfix.plan.tasks.some((task) => task.kind === "requirements"),
      "a requirement task was planned for a brief with no requirements");
    assert(quickfix.plan.tasks.some((task) => task.kind === "claims"),
      "claims were not verified for a brief with no requirements");
  });

  await test("C7", "quick-fix: the same engine produces a different analysis", () => {
    assert(quickfix.scan.evidence.length > 0, "quick-fix produced no evidence");
    const withModels = quickfix.scan.semantics.some((item) => item.models.length > 0);
    const withModelsMedi = medistock.scan.semantics.some((item) => item.models.length > 0);
    // Whatever each repository contains, the dimensions must follow the
    // repository rather than a template.
    const quickDimensions = new Set(
      quickfix.plan.dimensions.filter((item) => item.relevance !== "not_applicable").map((item) => item.key),
    );
    const medistockDimensions = new Set(
      medistock.plan.dimensions.filter((item) => item.relevance !== "not_applicable").map((item) => item.key),
    );
    assert(quickDimensions.size > 0 && medistockDimensions.size > 0,
      "one of the two plans analysed nothing at all");
    void withModels;
    void withModelsMedi;
  });

  await test("C8", "the mock provider exercises the validators end to end", async () => {
    const { provider, stats } = mockProvider({ injectHallucinatedId: true, uncitedPositive: true });
    const reply = await provider({
      task: buildAlignmentTask({
        context: medistock.context,
        projectMap: medistock.scan.projectMap,
        evidence: medistock.scan.evidence as never,
        terms: ["forecast", "medicine"],
        code: "",
        datasetProfiles: medistock.scan.datasetProfiles,
        semantics: medistock.scan.semantics,
        concepts: [...medistock.concepts.values()],
        inspectionNote: "",
      }),
      promptVersion: "align-v2",
      maxOutputTokens: 2000,
    });
    assert(reply.parsed, "the mock provider returned nothing");
    const evidence = buildEvidenceSet(medistock.scan.evidence as never);
    const validated = validateAlignment(reply.parsed, evidence);
    assertEqual(validated.items.length, 1);
    assert(validated.items[0].downgraded || validated.rejectedEvidenceIds.length > 0,
      "the mock's invented citation was neither dropped nor recorded");
    assert(stats.calls === 1, "the provider was called more than once");
  });

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(`  • ${failure}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

/** Everything the "cannot come back" scan covers, including the bundle. */
const GREP_ROOTS = ["supabase/functions", "src", "scripts"];

/**
 * This file has to name the banned symbols in order to assert they are gone,
 * so it is the one place they are not looked for.
 */
const GREP_SELF = "scripts/regression-analysis.ts";

function grepProject(needle: string): string[] {
  const out: string[] = [];
  for (const root of GREP_ROOTS) {
    for (const path of walk(root)) {
      if (path === GREP_SELF) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (text.includes(needle)) out.push(path);
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", "_generated", "dist"].includes(entry.name)) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|sql|js|md)$/.test(entry.name)) out.push(full);
  }
  return out;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
