/**
 * The deterministic layer.
 *
 * §37: the repository is scanned first, and a model is called only where the
 * scan genuinely cannot conclude. This file is the whole of that "genuinely
 * cannot conclude" gate, and it is deliberately tiny and conservative.
 *
 * A model is skipped in exactly two situations:
 *
 *   1. **Countable.** The requirement states a minimum count of something the
 *      scan counts directly ("at least 3 endpoints"). Counting is arithmetic.
 *
 *   2. **Literal.** The requirement names a specific identifier — a filename, a
 *      quoted symbol, a route path — and the scan found it. A named artefact is
 *      found by looking, not by asking.
 *
 * Everything else goes to the model, including everything that could be argued
 * about. And there is a third rule, the most important one in this file:
 *
 *   3. **Refusal.** If the inspection was limited — a truncated tree, a rate
 *      limit, files that could not be read — then "I found nothing" is NOT an
 *      answer. It becomes `unable_to_determine`, which is a statement about the
 *      scan and not about the project.
 *
 * Note what is absent: no technology list, no "expected library", no branch
 * that can turn a missing framework into a failed requirement.
 */

import type { EvidenceSet } from "./evidence.ts";

export interface CountFact {
  label: string;
  count: number;
  source: string;
}

export interface DeterministicVerdict {
  status: "evidence_found" | "partial_evidence" | "not_evidenced" | "unable_to_determine" | null;
  explanation: string;
  evidenceIds: string[];
  method: "deterministic_count" | "deterministic_literal" | null;
}

export const NO_VERDICT: DeterministicVerdict = {
  status: null,
  explanation: "",
  evidenceIds: [],
  method: null,
};

/** Everything the scan counted, keyed by the words a brief would use. */
export interface CountableFacts {
  [word: string]: CountFact;
}

export function countablesFrom(input: {
  projectMap: Record<string, unknown>;
  functionCount: number;
  classCount: number;
  routeCount: number;
  datasetCount: number;
  modelCount: number;
  fileCount: number;
  calculationCount: number;
  testFileCount: number;
}): CountableFacts {
  const map = input.projectMap;
  const frontend = (map.frontend ?? {}) as Record<string, unknown>;
  const stats = (map.repository_stats ?? {}) as Record<string, unknown>;
  const stack = (map.stack ?? {}) as Record<string, unknown>;
  const languages = (stack.languages ?? {}) as Record<string, number>;
  const deps = (stack.dependencies_by_category ?? {}) as Record<string, string[]>;
  const depCount = Object.values(deps).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  );

  const facts: CountableFacts = {
    endpoint: { label: "HTTP endpoint", count: input.routeCount, source: "routes" },
    route: { label: "HTTP endpoint", count: input.routeCount, source: "routes" },
    api: { label: "HTTP endpoint", count: input.routeCount, source: "routes" },
    page: {
      label: "page or screen",
      count: ((frontend.pages as string[]) ?? []).length,
      source: "frontend",
    },
    screen: {
      label: "page or screen",
      count: ((frontend.pages as string[]) ?? []).length,
      source: "frontend",
    },
    test: { label: "test file", count: input.testFileCount, source: "testing" },
    dataset: { label: "dataset", count: input.datasetCount, source: "data" },
    function: { label: "function or method", count: input.functionCount, source: "symbols" },
    class: { label: "class", count: input.classCount, source: "symbols" },
    model: { label: "model or statistical operation", count: input.modelCount, source: "logic" },
    calculation: { label: "calculation", count: input.calculationCount, source: "logic" },
    file: { label: "source file", count: input.fileCount, source: "inventory" },
    language: { label: "language", count: Object.keys(languages).length, source: "stack" },
    dependenc: {
      label: "dependency",
      count: depCount,
      source: "manifests",
    },
    line: { label: "line of code", count: Number(stats.line_count ?? 0), source: "stats" },
  };
  return facts;
}

const COUNT_WORDS: [RegExp, string][] = [
  [/\bendpoints?\b/i, "endpoint"],
  [/\broutes?\b/i, "route"],
  [/\bapis?\b/i, "api"],
  [/\bpages?\b/i, "page"],
  [/\bscreens?\b/i, "screen"],
  [/\btests?\b/i, "test"],
  [/\bdatasets?\b/i, "dataset"],
  [/\bdata ?files?\b/i, "dataset"],
  [/\bfunctions?\b/i, "function"],
  [/\bclasses?\b/i, "class"],
  [/\bmodels?\b/i, "model"],
  [/\bcalculations?\b/i, "calculation"],
  [/\b(languages|programming languages)\b/i, "language"],
  [/\b(dependencies|packages|libraries)\b/i, "dependenc"],
];

/**
 * A requirement that states an explicit minimum of something countable.
 * "at least 3 endpoints" qualifies; "3 endpoints" on its own does not, because a
 * brief saying "3 endpoints" is usually describing a design, not a threshold.
 */
export function deterministicCount(
  text: string,
  facts: CountableFacts,
): DeterministicVerdict {
  if (!/\b(?:at least|minimum|atleast|minimum of|no fewer than|>=|or more)\b/i.test(text)) {
    return NO_VERDICT;
  }
  const minimum = text.match(/\b(\d{1,4})\b/);
  if (!minimum) return NO_VERDICT;
  const required = Number(minimum[1]);
  if (!Number.isFinite(required) || required <= 0) return NO_VERDICT;

  for (const [pattern, key] of COUNT_WORDS) {
    if (!pattern.test(text)) continue;
    const fact = facts[key];
    if (!fact) continue;
    if (fact.count >= required) {
      return {
        status: "evidence_found",
        explanation:
          `The scan found ${fact.count} ${fact.label}${fact.count === 1 ? "" : "s"} ` +
          `in the repository; this requirement asks for at least ${required}.`,
        evidenceIds: [],
        method: "deterministic_count",
      };
    }
    return {
      status: "not_evidenced",
      explanation:
        `The scan found ${fact.count} ${fact.label}${fact.count === 1 ? "" : "s"}; ` +
        `this requirement asks for at least ${required}. This is a count of what the ` +
        "scan read, not a judgement about the approach.",
      evidenceIds: [],
      method: "deterministic_count",
    };
  }
  return NO_VERDICT;
}

/**
 * A named file, symbol, or route is a place to look, not proof that a
 * requirement is implemented. This always returns no verdict.
 */
export function deterministicLiteral(
  text: string,
  index: {
    files: Map<string, unknown>;
    symbolsByPath: Map<string, string[]>;
    routesByPath: Map<string, IndexRouteLike[]>;
  },
  evidence: EvidenceSet,
): DeterministicVerdict {
  void text;
  void index;
  void evidence;
  return NO_VERDICT;
}

interface IndexRouteLike {
  path: string;
  file: string;
  method?: string;
}

/**
 * §8/§31, the refusal rule.
 *
 * When the scan could not read the whole repository, "not found" is not an
 * answer. This converts what would have been a negative into an honest
 * "we could not look properly", and says why.
 */
export function inspectionCovers(
  inspection: { mode: "full" | "limited"; warnings: string[]; filesRead: number; filesSeen: number },
): { covered: boolean; note: string } {
  const problems: string[] = [];
  if (inspection.mode === "limited") problems.push("the repository was too large to read fully");
  if (inspection.filesRead < inspection.filesSeen) {
    problems.push(
      `${inspection.filesSeen - inspection.filesRead} of ${inspection.filesSeen} files were not read`,
    );
  }
  for (const warning of inspection.warnings) {
    if (/rate limit|could not read|truncated/i.test(warning)) problems.push(warning);
  }
  if (!problems.length) return { covered: true, note: "" };
  return {
    covered: false,
    note:
      "This repository was not fully inspected (" +
      problems.slice(0, 3).join("; ") +
      "), so absence of evidence here is not evidence of absence.",
  };
}
