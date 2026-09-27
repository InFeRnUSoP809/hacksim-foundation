/**
 * The analysis harness.
 *
 * Runs the real pipeline — the same scanner, the same requirement engine, the
 * same validators, the same persistence shape — against a real repository on
 * disk. Two providers:
 *
 *   mock      a scripted model that answers from the evidence ids present in
 *             the prompt, including one invented id, so the citation filter and
 *             the "positive status with no evidence" downgrade are exercised
 *             for real rather than asserted about. Free, offline, repeatable.
 *   deepseek  the actual provider, when a key is present in the environment.
 *
 * Nothing here is part of the deployed application.
 */

import { readFileSync } from "node:fs";

// The edge modules read Deno.env; under Node a two-line shim is enough and it
// keeps the production code free of test-only branches.
const globals = globalThis as unknown as { Deno?: unknown };
if (!globals.Deno) {
  globals.Deno = {
    env: {
      get: (name: string) => (process.env as Record<string, string | undefined>)[name],
    },
  };
}

import { fetchRepo, LocalRepoClient, type LocalRepo } from "./local-source.ts";
import { scanRepository } from "../../supabase/functions/_shared/scanner.ts";
import { buildRequirementMap, requirementMapHash } from "../../supabase/functions/_shared/requirements.ts";
import { rescoreRelevance } from "../../supabase/functions/_shared/datasets.ts";
import {
  briefVocabulary,
  analyseRequirement,
  type ConceptSet,
} from "../../supabase/functions/_shared/concepts.ts";
import { buildHackathonContext } from "../../supabase/functions/_shared/context.ts";
import { planAnalysis } from "../../supabase/functions/_shared/planner.ts";
import { buildRepoIndex, buildRetrievalPlan, retrieve } from "../../supabase/functions/_shared/retrieval.ts";
import { buildEvidenceSet, type EvidenceSet } from "../../supabase/functions/_shared/evidence.ts";
import type { AIResponse } from "../../supabase/functions/_shared/ai.ts";

type RequirementMapShape = ReturnType<typeof buildRequirementMap> & {
  version: number;
  input_hash: string;
};

export interface Fixture {
  hackathon: Record<string, unknown>;
  submission: Record<string, unknown>;
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export interface HarnessResult {
  repo: LocalRepo;
  scan: Awaited<ReturnType<typeof scanRepository>>;
  requirementMap: RequirementMapShape;
  index: ReturnType<typeof buildRepoIndex>;
  evidence: EvidenceSet;
  concepts: Map<string, ConceptSet>;
  retrieval: Map<string, ReturnType<typeof retrieve>>;
  plan: ReturnType<typeof planAnalysis>;
  context: Awaited<ReturnType<typeof buildHackathonContext>>;
}

export async function runHarness(options: {
  url: string;
  fixture: Fixture;
}): Promise<HarnessResult> {
  const repo = fetchRepo(options.url);
  const client = new LocalRepoClient(repo) as unknown as Parameters<
    typeof scanRepository
  >[0];
  const scan = await scanRepository(client, repo.owner, repo.repo);

  const hackathon = options.fixture.hackathon;
  // The DB-cached variant of this map is the same deterministic build plus a
  // cache row, so the offline harness calls the deterministic half directly.
  const requirementMap: RequirementMapShape = {
    version: 1,
    input_hash: await requirementMapHash(hackathon),
    ...buildRequirementMap(hackathon),
  };
  const context = await buildHackathonContext(hackathon, requirementMap, options.fixture.submission);

  const vocabulary = briefVocabulary(requirementMap);
  const concepts = new Map<string, ConceptSet>();
  for (const entry of requirementMap.requirements ?? []) {
    concepts.set(entry.id, analyseRequirement(entry.text, vocabulary, requirementMap));
  }

  // Dataset relevance is answered here, where the brief is known — exactly as
  // the edge function does it.
  const claimConcepts: ConceptSet[] = [
    ...[...concepts.values()],
    {
      text: String(options.fixture.submission.project_description ?? ""),
      intent: String(options.fixture.submission.project_description ?? "").slice(0, 200),
      focus: "general",
      phrases: [],
      actions: [],
      subjects: [],
      qualifiers: [],
      terms: [],
      domainTerms: [],
      facets: [],
      artifacts: [],
    },
  ];
  scan.datasetProfiles = scan.datasetProfiles.map((profile) =>
    rescoreRelevance(profile, claimConcepts),
  );
  scan.projectMap.data_sources = scan.datasetProfiles as unknown as never;

  const evidence = buildEvidenceSet(
    scan.evidence.map((item) => ({
      id: item.id,
      type: item.type,
      claim: item.claim,
      file: item.file,
      symbol: item.symbol,
      lines: item.lines,
      confidence: item.confidence,
    })),
  );

  const index = buildRepoIndex({
    files: scan.files as never,
    chunks: scan.chunks as never,
    evidence: [...evidence.byId.values()],
    routes: scan.routes as never,
    datasetProfiles: scan.datasetProfiles,
    semantics: scan.semantics as never,
  });

  const retrieval = new Map<string, ReturnType<typeof retrieve>>();
  for (const [id, concept] of concepts) {
    retrieval.set(id, retrieve({ plan: buildRetrievalPlan(id, concept), index }));
  }

  const { groupRequirements } = await import(
    "../../supabase/functions/_shared/concepts.ts"
  );
  const groups = groupRequirements(requirementMap);
  const { questionsForGroup } = await import(
    "../../supabase/functions/_shared/planner.ts"
  );

  const semantics = scan.semantics ?? [];
  const facts = {
    fileCount: scan.files.length,
    sourceFileCount: scan.files.filter((file) =>
      ["source", "component", "api", "model", "schema", "database"].includes(
        String(file.file_category),
      ),
    ).length,
    datasetCount: scan.datasetProfiles.length,
    datasetProfileCount: scan.datasetProfiles.length,
    functionCount: scan.chunks.filter((chunk) =>
      ["function", "method"].includes(String(chunk.symbol_type)),
    ).length,
    classCount: scan.chunks.filter((chunk) => String(chunk.symbol_type) === "class").length,
    routeCount: scan.routes.length,
    modelFindingCount: semantics.reduce((sum, item) => sum + item.models.length, 0),
    calculationCount: semantics.reduce((sum, item) => sum + item.calculations.length, 0),
    ruleCount: semantics.reduce((sum, item) => sum + item.rules.length, 0),
    dataAccessCount: semantics.reduce((sum, item) => sum + item.dataAccess.length, 0),
    uiFindingCount: semantics.reduce((sum, item) => sum + item.ui.length, 0),
    testFileCount: (scan.projectMap.testing as { test_file_count: number }).test_file_count,
    deploymentFileCount: scan.files.filter((file) => file.file_category === "deployment")
      .length,
    secretCount: (scan.projectMap.security as { hardcoded_secrets: unknown[] })
      .hardcoded_secrets.length,
    authDetected: Boolean(
      (scan.projectMap.authentication as { detected: string[] }).detected.length,
    ),
    databaseDetected: Boolean(
      (scan.projectMap.database as { technologies: string[] }).technologies.length,
    ),
    hasReadme: (scan.projectMap.readme as { present: boolean }).present,
    analysisMode: scan.analysisMode,
    stackSummary: [
      ...Object.keys((scan.projectMap.stack as { languages: Record<string, number> }).languages),
      ...(scan.projectMap.stack as { frameworks: string[] }).frameworks,
    ].join(" "),
  };

  const plan = planAnalysis(
    context,
    facts,
    groups.map((group) => ({
      focus: group.focus,
      label: group.label,
      ids: group.entries.map((entry) => entry.id),
      questions: questionsForGroup(group.concepts),
    })),
    (requirementMap.expected_outcomes ?? []).map((entry) => entry.id),
    (requirementMap.constraints ?? []).map((entry) => entry.id),
    (requirementMap.evaluation_criteria ?? []).map((entry) => entry.id),
    [],
  );

  return { repo, scan, requirementMap, index, evidence, concepts, retrieval, plan, context };
}

// ── The mock provider ──────────────────────────────────────────────────────

function idsIn(task: string): string[] {
  const found = new Set<string>();
  for (const match of task.matchAll(/\bEV-\d{3}\b/g)) found.add(match[0]);
  return [...found];
}

function subjectsIn(task: string): string[] {
  const found = new Set<string>();
  for (const match of task.matchAll(/\b(?:REQ|CON|OUT|EVAL)-\d{3}\b/g)) {
    found.add(match[0]);
  }
  return [...found];
}

export interface MockOptions {
  /** Inject one id that does not exist, to prove citations are filtered. */
  injectHallucinatedId?: boolean;
  /** Answer a positive status with no citations, to prove the downgrade. */
  uncitedPositive?: boolean;
  /** Return malformed JSON on the first call of each task, to prove the repair. */
  malformedFirst?: boolean;
}

/**
 * A model that only says what the evidence in its own prompt supports. It is
 * not trying to be clever; it is trying to be a *well-behaved* provider, so the
 * validators are tested against something realistic.
 */
export function mockProvider(options: MockOptions = {}) {
  const seen = new Map<string, number>();
  const stats = { calls: 0, repairs: 0, malformed: 0 };

  const provider = async (args: {
    task: string;
    promptVersion: string;
    maxOutputTokens: number;
  }): Promise<AIResponse> => {
    stats.calls += 1;
    if (args.promptVersion.endsWith("-r1")) stats.repairs += 1;
    const key = args.task.slice(0, 120);
    const attempt = (seen.get(key) ?? 0) + 1;
    seen.set(key, attempt);

    if (options.malformedFirst && attempt === 1) {
      stats.malformed += 1;
      return reply("this is not json at all", args.promptVersion, false);
    }

    const ids = idsIn(args.task);
    const cited = options.uncitedPositive
      ? []
      : ids.slice(0, 6);
    if (options.injectHallucinatedId && ids.length) cited.push("EV-999");

    let payload: Record<string, unknown>;

    if (args.task.startsWith("Assess each requirement")) {
      payload = {
        conclusions: subjectsIn(args.task).map((id) => ({
          subject_id: id,
          status: cited.length ? "partial_evidence" : "not_evidenced",
          confidence: cited.length ? "medium" : "low",
          evidence_ids: cited,
          explanation:
            `Mock provider: the retrieved evidence for ${id} was inspected and ` +
            "part of the required behaviour is visible; the remainder is not " +
            "established by this repository.",
          missing_or_unclear: ["mock: one specific aspect left unverified"],
        })),
        findings: [],
      };
    } else if (args.task.startsWith("Check each constraint")) {
      payload = {
        conclusions: subjectsIn(args.task).map((id) => ({
          subject_id: id,
          status: cited.length ? "supported" : "not_evidenced",
          confidence: cited.length ? "medium" : "low",
          evidence_ids: cited,
          explanation: `Mock provider: constraint ${id} was checked against the retrieved evidence.`,
          missing_or_unclear: [],
        })),
        findings: [],
      };
    } else if (args.task.startsWith("Determine whether this submission")) {
      payload = {
        problem_alignment: {
          status: cited.length ? "partially_aligned" : "unclear",
          confidence: "medium",
          evidence_ids: cited,
          explanation: "Mock provider: the retrieved implementation was read against the stated problem.",
          approach: "Mock approach derived from the retrieved files.",
        },
        approach_notes: [],
        findings: [],
      };
    } else if (args.task.startsWith("Check whether this repository")) {
      payload = {
        conclusions: subjectsIn(args.task).map((id) => ({
          subject_id: id,
          status: cited.length ? "partially_supported" : "not_evidenced",
          confidence: "low",
          evidence_ids: cited,
          explanation: `Mock provider: outcome ${id} was traced through the retrieved code.`,
          missing_or_unclear: [],
        })),
        findings: [],
      };
    } else if (args.task.startsWith("Describe each evaluation criterion")) {
      payload = {
        conclusions: subjectsIn(args.task).map((id) => ({
          subject_id: id,
          status: cited.length ? "partially_supported" : "not_evidenced",
          confidence: "low",
          evidence_ids: cited,
          explanation: `Mock provider: criterion ${id} described from the evidence.`,
          missing_or_unclear: ["mock: not measurable from the repository alone"],
        })),
        findings: [],
      };
    } else if (args.task.startsWith("Check each feature the team claims")) {
      const claims = [...args.task.matchAll(/^- (.+)$/gm)]
        .map((match) => match[1].trim())
        .filter((line) => line.length > 8)
        .slice(0, 6);
      payload = {
        claims: claims.map((claim) => ({
          claim,
          status: cited.length ? "partially_supported" : "not_evidenced",
          confidence: "low",
          evidence_ids: cited,
          explanation: "Mock provider: the claim was traced through the retrieved code.",
        })),
        findings: [],
      };
    } else if (args.task.startsWith("Describe how this project is built")) {
      payload = {
        architecture: {
          summary: "Mock provider: structure described from the retrieved files.",
          layers: [],
          entry_points: [],
          evidence_ids: cited,
        },
        technical_decisions: [],
        implementation: {
          summary: "Mock provider: implementation described.",
          strengths: [],
          observations: [],
          incomplete_or_dead: [],
        },
        findings: [],
      };
    } else if (args.task.startsWith("Make general engineering observations")) {
      payload = {
        observations: [
          {
            topic: "security",
            status: "observed",
            summary: "Mock provider: general observation.",
            evidence_ids: cited,
            concern: "",
            improvement: "",
          },
        ],
        findings: [],
      };
    } else if (args.task.startsWith("Give the final factual assessment")) {
      payload = {
        assessment: {
          headline: "Mock provider: a coherent prototype with partial evidence.",
          understanding: "Mock understanding.",
          problem_relevance: "Mock relevance.",
          solution_coherence: "Mock coherence.",
          implementation_evidence: "Mock evidence summary.",
          functional_completeness: "Mock completeness.",
          technical_quality: "Mock quality.",
          claim_accuracy: "Mock claim accuracy.",
          hackathon_alignment: "Mock alignment.",
          evidence_ids: cited,
        },
        strengths: ["mock strength"],
        gaps: ["mock gap"],
        uncertainties: ["mock uncertainty"],
        engineering_concerns: [],
        findings: [],
      };
    } else {
      payload = { findings: [] };
    }

    return reply(JSON.stringify(payload), args.promptVersion, true);
  };

  return { provider, stats };
}

function reply(content: string, promptVersion: string, parsed: boolean): AIResponse {
  const inputTokens = Math.ceil(content.length / 4);
  return {
    content,
    parsed: parsed ? (JSON.parse(content) as Record<string, unknown>) : null,
    requestId: "mock",
    model: "mock",
    inputTokens,
    outputTokens: Math.ceil(content.length / 4),
    totalTokens: inputTokens * 2,
    cachedTokens: 0,
    cacheMissTokens: inputTokens,
    durationMs: 1,
    promptVersion,
  };
}
