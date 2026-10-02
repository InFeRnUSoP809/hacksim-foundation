/**
 * The analysis planner.
 *
 * §6 of the product spec, in code: there is no universal project template. A
 * hackathon that asks for a data pipeline and a hackathon that asks for a
 * sketch both get analysed, but not against the same checklist, and neither is
 * measured on characteristics nobody asked for.
 *
 * The planner reads three things and produces two lists:
 *
 *   inputs   the hackathon context, the repository facts, the team's claims
 *   outputs  the dimensions worth looking at, and the AI tasks worth running
 *
 * Every dimension carries a reason and a relevance, and that reason is stored
 * with the analysis. When a student asks "why was my database not mentioned?",
 * the answer is not a shrug: it is `not_applicable — the brief did not ask for
 * a database and the repository has none`.
 *
 * Crucially, a dimension that is skipped is never a finding. Missing is not
 * broken.
 */

import { FOCUS_LABEL, type ConceptSet, type FocusGroup } from "./concepts.ts";
import type { HackathonContext } from "./context.ts";

export type DimensionKey =
  | "problem_alignment"
  | "theme_alignment"
  | "solution_coherence"
  | "functional_implementation"
  | "feature_evidence"
  | "claim_verification"
  | "technical_implementation"
  | "architecture"
  | "data_handling"
  | "ml_ai"
  | "api_implementation"
  | "database_usage"
  | "security"
  | "testing"
  | "performance"
  | "scalability"
  | "deployment"
  | "usability"
  | "engineering_quality"
  | "evaluation_criteria"
  | "constraints"
  | "expected_outcome"
  | "project_properness";

export const DIMENSION_LABEL: Record<DimensionKey, string> = {
  problem_alignment: "Problem alignment",
  theme_alignment: "Theme alignment",
  solution_coherence: "Solution coherence",
  functional_implementation: "Functional implementation",
  feature_evidence: "Feature evidence",
  claim_verification: "Claim verification",
  technical_implementation: "Technical implementation",
  architecture: "Architecture",
  data_handling: "Data handling",
  ml_ai: "ML / AI implementation",
  api_implementation: "API implementation",
  database_usage: "Database usage",
  security: "Security",
  testing: "Testing",
  performance: "Performance",
  scalability: "Scalability",
  deployment: "Deployment",
  usability: "Usability",
  engineering_quality: "Engineering quality",
  evaluation_criteria: "Evaluation criteria",
  constraints: "Constraints",
  expected_outcome: "Expected outcome",
  project_properness: "Project properness",
};

/** `required` = the organiser asked for it. `relevant` = the repo has it. */
export type Relevance = "required" | "relevant" | "not_applicable";

export interface Dimension {
  key: DimensionKey;
  label: string;
  relevance: Relevance;
  /** Why this relevance was chosen. Shown to admins, and to students as "why". */
  reason: string;
  method: "deterministic" | "ai" | "skipped";
  /** Where the expectation came from: the brief, the team, or general practice. */
  expectationSource: "hackathon" | "claim" | "repository" | "general" | "none";
}

export type TaskKind =
  | "brief_verification"
  | "implementation_verification"
  | "engineering_verification"
  | "alignment"
  | "requirements"
  | "constraints"
  | "outcomes"
  | "criteria"
  | "claims"
  | "implementation"
  | "engineering"
  | "properness";

export interface PlannedTask {
  key: string;
  kind: TaskKind;
  scope: string;
  /** The retrieval question. Built from the actual brief, never a fixed string. */
  question: string;
  /** Why a model is needed at all — the deterministic pass could not conclude. */
  reason: string;
  /** Requirement / constraint / outcome ids this call is responsible for. */
  subjectIds: string[];
  /** Indices into the analysis' concept list, when the task is requirement-bound. */
  focus: FocusGroup | null;
  /** Stable ordering key so the plan is reproducible. */
  order: number;
}

export interface RepoFacts {
  fileCount: number;
  sourceFileCount: number;
  datasetCount: number;
  datasetProfileCount: number;
  functionCount: number;
  classCount: number;
  routeCount: number;
  modelFindingCount: number;
  calculationCount: number;
  ruleCount: number;
  dataAccessCount: number;
  uiFindingCount: number;
  testFileCount: number;
  deploymentFileCount: number;
  secretCount: number;
  authDetected: boolean;
  databaseDetected: boolean;
  hasReadme: boolean;
  analysisMode: "full" | "limited";
  stackSummary: string;
}

export interface AnalysisPlan {
  dimensions: Dimension[];
  tasks: PlannedTask[];
  /** False for an open-innovation brief. No requirement analysis is invented. */
  requirementsEnabled: boolean;
  requirementsReason: string;
  /** One line an admin can read to know why the plan looks the way it does. */
  summary: string;
}


function dimension(
  key: DimensionKey,
  relevance: Relevance,
  reason: string,
  method: Dimension["method"] = "ai",
  expectationSource: Dimension["expectationSource"] = "hackathon",
): Dimension {
  return {
    key,
    label: DIMENSION_LABEL[key],
    relevance,
    reason,
    method: relevance === "not_applicable" ? "skipped" : method,
    expectationSource: relevance === "not_applicable" ? "none" : expectationSource,
  };
}

export function planAnalysis(
  context: HackathonContext,
  facts: RepoFacts,
  groups: { focus: FocusGroup; label: string; ids: string[]; questions: string[] }[],
  outcomeIds: string[],
  constraintIds: string[],
  criteriaIds: string[],
  conceptQuestions: string[],
): AnalysisPlan {
  const dimensions: Dimension[] = [];
  const tasks: PlannedTask[] = [];
  let order = 0;
  const next = () => order++;

  // ── Alignment ──────────────────────────────────────────────────────────
  if (context.hasProblem) {
    dimensions.push(
      dimension(
        "problem_alignment",
        "required",
        "The hackathon states a problem, so the project is compared against it.",
        "ai",
        "hackathon",
      ),
    );
  } else {
    dimensions.push(
      dimension(
        "problem_alignment",
        "not_applicable",
        "The hackathon states no problem; the team's own chosen problem is the reference point.",
      ),
    );
  }

  if (context.theme) {
    dimensions.push(
      dimension(
        "theme_alignment",
        "required",
        "The hackathon is theme-based, so the theme is the expected frame.",
        "ai",
        "hackathon",
      ),
    );
  }

  // ── Requirements ───────────────────────────────────────────────────────
  const requirementsEnabled = context.hasRequirements;
  const requirementsReason = context.hasRequirements
    ? `The hackathon lists ${context.requirements.length} requirement(s).`
    : "The hackathon lists no requirements, so none are invented and none are " +
      "checked. The project is assessed against its own stated problem instead.";

  if (requirementsEnabled) {
    for (const group of groups) {
      dimensions.push(
        dimension(
          dimensionForFocus(group.focus),
          "required",
          `The brief includes requirements about ${group.label}.`,
          "ai",
          "hackathon",
        ),
      );
    }
  } else {
    for (const key of [
      "functional_implementation",
      "feature_evidence",
      "data_handling",
      "ml_ai",
      "usability",
    ] as DimensionKey[]) {
      dimensions.push(
        dimension(
          key,
          "not_applicable",
          "No requirements are configured, so this is not assessed as a requirement. " +
            "It is still observed as a general engineering characteristic if the " +
            "repository shows it.",
          "skipped",
          "none",
        ),
      );
    }
  }

  // ── Constraints ────────────────────────────────────────────────────────
  if (context.hasConstraints || context.technologyRestrictions) {
    dimensions.push(
      dimension(
        "constraints",
        "required",
        context.technologyRestrictions
          ? "The hackathon states technology restrictions."
          : `The hackathon lists ${context.constraints.length} constraint(s).`,
        "ai",
        "hackathon",
      ),
    );
  } else {
    dimensions.push(
      dimension(
        "constraints",
        "not_applicable",
        "The hackathon states no constraints, so none are checked.",
      ),
    );
  }

  // ── Expected outcome ───────────────────────────────────────────────────
  if (context.hasOutcomes) {
    dimensions.push(
      dimension(
        "expected_outcome",
        "required",
        `The hackathon states ${context.expectedOutcomes.length} expected outcome(s).`,
        "ai",
        "hackathon",
      ),
    );
  } else {
    dimensions.push(
      dimension(
        "expected_outcome",
        "not_applicable",
        "The hackathon states no expected outcome.",
      ),
    );
  }

  // ── Evaluation criteria ────────────────────────────────────────────────
  if (context.hasCriteria) {
    dimensions.push(
      dimension(
        "evaluation_criteria",
        "required",
        `The hackathon defines ${context.evaluationCriteria.length} evaluation criteria.`,
        "ai",
        "hackathon",
      ),
    );
  } else {
    dimensions.push(
      dimension(
        "evaluation_criteria",
        "not_applicable",
        "The hackathon defines no evaluation criteria, so none are applied.",
      ),
    );
  }

  // ── Brief verification (grouped AI call) ───────────────────────────────
  const briefNeeded =
    context.hasProblem ||
    Boolean(context.theme) ||
    requirementsEnabled ||
    context.hasConstraints ||
    context.hasOutcomes ||
    context.hasCriteria;

  if (briefNeeded) {
    tasks.push({
      key: "brief_verification",
      kind: "brief_verification",
      scope: "alignment, requirements, constraints, outcomes, criteria",
      question: [
        conceptQuestions[0] ?? context.problem.slice(0, 400),
        groups.flatMap((group) => group.questions).join(" "),
        buildConstraintQuestion(context),
        context.evaluationCriteria.slice(0, 6).map((item) => item.text).join(" "),
      ]
        .join(" ")
        .slice(0, 1200),
      reason:
        "The hackathon brief is verified in one evidence-backed call instead of " +
        "many separate passes over the same snippets.",
      subjectIds: [
        ...groups.flatMap((group) => group.ids),
        ...constraintIds,
        ...outcomeIds,
        ...criteriaIds,
      ],
      focus: null,
      order: next(),
    });
  }

  // ── Claims ─────────────────────────────────────────────────────────────
  const hasClaims = Boolean(
    context.claims.description || context.claims.features,
  );
  if (hasClaims) {
    dimensions.push(
      dimension(
        "claim_verification",
        "required",
        "The team describes what it built, so each claim is checked against evidence.",
        "ai",
        "claim",
      ),
    );
  } else {
    dimensions.push(
      dimension(
        "claim_verification",
        "not_applicable",
        "The submission contains no description or feature list to verify.",
      ),
    );
  }

  // ── Implementation and coherence ────────────────────────────────────────
  const hasSource = facts.sourceFileCount > 0;
  if (hasSource) {
    dimensions.push(
      dimension(
        "solution_coherence",
        "required",
        "The repository contains source code, so the chain from problem to output " +
          "can be traced.",
        "ai",
        "general",
      ),
    );
    dimensions.push(
      dimension(
        "technical_implementation",
        "required",
        "Source files are present and carry functions, classes and logic.",
        "ai",
        "general",
      ),
    );
    dimensions.push(
      dimension(
        "architecture",
        "required",
        "Source files are present; structure is described as observed, not judged " +
          "against a template.",
        "ai",
        "general",
      ),
    );
  } else {
    for (const key of ["solution_coherence", "technical_implementation", "architecture"] as DimensionKey[]) {
      dimensions.push(
        dimension(
          key,
          "not_applicable",
          "No readable source file was found in the repository, so implementation " +
            "cannot be described.",
        ),
      );
    }
  }

  // ── Implementation verification (architecture + claims) ─────────────────
  if (hasSource || hasClaims) {
    tasks.push({
      key: "implementation_verification",
      kind: "implementation_verification",
      scope: "flows, architecture, implementation, claims",
      question: [
        buildImplementationQuestion(context, facts),
        context.claims.description,
        context.claims.features,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 1000),
      reason:
        "Functional flows, architecture, and team claims share the same traced " +
        "implementation evidence.",
      subjectIds: [],
      focus: null,
      order: next(),
    });
  }

  // ── Engineering characteristics: relevant when the repo shows them ─────
  const engineering = planEngineering(facts, context);
  dimensions.push(...engineering.dimensions);

  if (engineering.dimensions.some((item) => item.relevance !== "not_applicable")) {
    tasks.push({
      key: "engineering_verification",
      kind: "engineering_verification",
      scope: "security, database, testing, engineering",
      question: engineering.question,
      reason: "Engineering observations share one compact verification call.",
      subjectIds: [],
      focus: null,
      order: next(),
    });
  }

  dimensions.push(
    dimension(
      "project_properness",
      "required",
      "A factual summary is derived from verified conclusions without an extra model pass.",
      "deterministic",
      "general",
    ),
  );

  return {
    dimensions,
    tasks: tasks.sort((a, b) => a.order - b.order).map((task, index) => ({ ...task, order: index })),
    requirementsEnabled,
    requirementsReason,
    summary: summarise(context, facts, requirementsEnabled, tasks),
  };
}

function planEngineering(
  facts: RepoFacts,
  context: HackathonContext,
): { dimensions: Dimension[]; question: string } {
  const dimensions: Dimension[] = [];
  const terms: string[] = [];
  const briefText = [
    context.problem,
    context.claims.description,
    context.claims.features,
    ...context.constraints.map((item) => item.text),
    ...context.evaluationCriteria.map((item) => item.text),
    context.customInstructions ?? "",
  ].join(" ");

  const asks = (...needles: string[]) =>
    needles.some((needle) => briefText.toLowerCase().includes(needle));

  // Security: the brief asks, or the repository actually has credentials or
  // authentication to be careful with.
  if (asks("security", "secure", "privacy", "gdpr", "encrypt", "auth")) {
    dimensions.push(
      dimension("security", "required", "The brief asks about security or privacy.", "ai", "hackathon"),
    );
    terms.push("authentication authorization security secret credential encryption");
  } else if (facts.secretCount > 0 || facts.authDetected) {
    dimensions.push(
      dimension(
        "security",
        "relevant",
        "The repository contains authentication or credential material, so a security " +
          "observation is useful even though the brief did not ask for one.",
        "ai",
        "repository",
      ),
    );
    terms.push("authentication authorization security secret credential");
  } else {
    dimensions.push(
      dimension(
        "security",
        "not_applicable",
        "The brief does not ask about security and the repository has no credentials " +
          "or authentication to comment on.",
      ),
    );
  }

  // Testing: only when asked, or when there are tests to describe.
  if (asks("test", "testing", "tested", "coverage", "unit test")) {
    dimensions.push(
      dimension("testing", "required", "The brief asks about testing.", "ai", "hackathon"),
    );
    terms.push("test tests testing spec fixture mock assert coverage");
  } else if (facts.testFileCount > 0) {
    dimensions.push(
      dimension(
        "testing",
        "relevant",
        `The repository contains ${facts.testFileCount} test file(s) worth describing.`,
        "deterministic",
        "repository",
      ),
    );
  } else {
    dimensions.push(
      dimension(
        "testing",
        "not_applicable",
        "The brief does not ask about testing and the repository has no tests. " +
          "Absence of tests is not a finding here — it is recorded as a general " +
          "observation only.",
        "deterministic",
        "none",
      ),
    );
  }

  // Data handling.
  if (asks("data", "dataset", "ingest", "history", "upload", "csv", "database")) {
    dimensions.push(
      dimension("data_handling", "required", "The brief asks about data.", "ai", "hackathon"),
    );
    terms.push("data dataset csv json ingest read load schema");
  } else if (facts.datasetCount > 0 || facts.dataAccessCount > 0) {
    dimensions.push(
      dimension(
        "data_handling",
        "relevant",
        `The repository ships ${facts.datasetCount} dataset file(s) and performs ` +
          `${facts.dataAccessCount} data access operation(s).`,
        "ai",
        "repository",
      ),
    );
    terms.push("data dataset csv json read load schema query");
  } else {
    dimensions.push(
      dimension(
        "data_handling",
        "not_applicable",
        "The brief does not ask about data and the repository contains no datasets " +
          "or data access operations.",
      ),
    );
  }

  // Database.
  if (facts.databaseDetected) {
    dimensions.push(
      dimension(
        "database_usage",
        "relevant",
        "The repository contains a database or schema, so its use can be described.",
        "ai",
        "repository",
      ),
    );
    terms.push("database schema table query sql migration model repository");
  } else {
    dimensions.push(
      dimension(
        "database_usage",
        "not_applicable",
        "The repository has no database, and the brief did not require one. A project " +
          "that needs no database is not penalised for it.",
      ),
    );
  }

  // APIs.
  if (facts.routeCount > 0) {
    dimensions.push(
      dimension(
        "api_implementation",
        "relevant",
        `The repository exposes ${facts.routeCount} route(s); what sits behind them is ` +
          "described, but a route's existence alone is not treated as a feature.",
        "ai",
        "repository",
      ),
    );
    terms.push("route endpoint api handler request response");
  } else {
    dimensions.push(
      dimension(
        "api_implementation",
        "not_applicable",
        "The repository exposes no routes and the brief did not require an API.",
      ),
    );
  }

  // ML/AI.
  if (facts.modelFindingCount > 0) {
    dimensions.push(
      dimension(
        "ml_ai",
        "relevant",
        `The code performs ${facts.modelFindingCount} model or statistical operation(s). ` +
          "What they compute is described from the code, not from the imports.",
        "ai",
        "repository",
      ),
    );
    terms.push("model predict fit train inference forecast statistics");
  } else {
    dimensions.push(
      dimension(
        "ml_ai",
        "not_applicable",
        "The code contains no model training, inference or statistical computation, and " +
          "the brief did not ask for one. Hand-written rules are a valid answer.",
      ),
    );
  }

  // Deployment.
  if (facts.deploymentFileCount > 0) {
    dimensions.push(
      dimension(
        "deployment",
        "relevant",
        "The repository contains deployment configuration.",
        "ai",
        "repository",
      ),
    );
    terms.push("docker deploy workflow pipeline hosting build");
  } else {
    dimensions.push(
      dimension(
        "deployment",
        "not_applicable",
        "The repository has no deployment configuration and the brief did not ask " +
          "for a deployed service.",
      ),
    );
  }

  // Usability, only when there is an interface to judge.
  if (facts.uiFindingCount > 0) {
    dimensions.push(
      dimension(
        "usability",
        "relevant",
        `The repository contains interface code (${facts.uiFindingCount} interaction or ` +
          "display site(s)).",
        "ai",
        "repository",
      ),
    );
    terms.push("dashboard screen form table button chart display workflow");
  } else {
    dimensions.push(
      dimension(
        "usability",
        "not_applicable",
        "The repository contains no interface code, and the brief did not ask for one.",
      ),
    );
  }

  dimensions.push(
    dimension(
      "engineering_quality",
      "relevant",
      "Source code exists, so general engineering observations can be made.",
      "ai",
      "general",
    ),
  );

  return { dimensions, question: terms.join(" ") || "implementation quality" };
}

function dimensionForFocus(focus: FocusGroup): DimensionKey {
  switch (focus) {
    case "data":
      return "data_handling";
    case "analytics":
      return "ml_ai";
    case "decision":
      return "functional_implementation";
    case "trust":
      return "engineering_quality";
    case "interface":
      return "usability";
    case "platform":
      return "api_implementation";
    default:
      return "functional_implementation";
  }
}

function outcomeText(context: HackathonContext, id: string): string {
  return (
    context.expectedOutcomes.find((outcome) => outcome.id === id)?.text ?? ""
  );
}

function buildConstraintQuestion(context: HackathonContext): string {
  const parts = [
    ...context.constraints.map((constraint) => constraint.text),
    context.technologyRestrictions ?? "",
  ].filter(Boolean);
  const concepts: string[] = [];
  const lower = parts.join(" ").toLowerCase();
  const probes: Record<string, string[]> = {
    paid: ["api", "service", "key", "token", "endpoint", "subscription"],
    data: ["patient", "personal", "data", "privacy", "consent", "pii", "storage"],
    manual: ["form", "input", "manual", "entry", "upload", "csv"],
    hardware: ["sensor", "device", "gpio", "serial", "camera", "arduino", "esp"],
    offline: ["offline", "cache", "local", "service_worker", "indexeddb", "sync"],
    open: ["open", "source", "license", "repository", "public"],
    stack: ["framework", "language", "runtime", "library", "stack"],
  };
  for (const [needle, terms] of Object.entries(probes)) {
    if (lower.includes(needle)) concepts.push(...terms);
  }
  return `${parts.join(" ").slice(0, 600)} ${concepts.join(" ")}`.trim();
}

function buildImplementationQuestion(context: HackathonContext, facts: RepoFacts): string {
  const problem = context.problem.split(/[.\n]/)[0]?.slice(0, 300) ?? "";
  const claim = context.claims.description.split(/[.\n]/)[0]?.slice(0, 300) ?? "";
  return [
    problem,
    claim,
    context.claims.features.split("\n").slice(0, 4).join(" "),
    facts.stackSummary,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 900);
}

function summarise(
  context: HackathonContext,
  facts: RepoFacts,
  requirementsEnabled: boolean,
  tasks: PlannedTask[],
): string {
  const parts = [
    `${context.name} (${context.type.replace(/_/g, " ")})`,
    requirementsEnabled
      ? `${context.requirements.length} requirements`
      : "no requirements configured",
    `${facts.sourceFileCount} source file(s), ${facts.routeCount} route(s), ` +
      `${facts.datasetCount} dataset(s)`,
    `${tasks.length} reasoning call(s) planned`,
  ];
  return parts.join(" · ");
}

/** Concepts for a requirement group, used to build its retrieval question. */
export function questionsForGroup(
  concepts: ConceptSet[],
  limit = 6,
): string[] {
  return concepts
    .flatMap((concept) => [
      ...concept.phrases.slice(0, 4),
      ...concept.actions.slice(0, 3),
      ...concept.subjects.slice(0, 3),
    ])
    .filter((term) => term.length > 2)
    .slice(0, limit * 3);
}

export { FOCUS_LABEL };
