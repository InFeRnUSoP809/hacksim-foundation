/**
 * Requirement map construction (§30, §31).
 *
 * Turns a hackathon's free-text brief into stable, addressable requirements with
 * ids the rest of the system can reference. Deterministic first: a bullet list is
 * already a requirement list, so no model is involved. Only a brief with no
 * structure at all is sent to a model, and only once — the result is cached in
 * `hackathon_requirement_maps` forever.
 *
 * Ids are positional and stable (`REQ-001`…), which is what lets requirement
 * evaluations, findings and defence targets refer to a requirement across runs.
 *
 * This file costs zero LLM tokens: everything here is string work.
 */

import { db } from "./http.ts";
import { shortHash } from "./config.ts";

export const PROMPT_VERSION = "reqmap-v1";

// Categorisation is keyword-based, not model-based: these are stable, auditable
// and free.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  ai_ml: [
    "predict", "forecast", "model", "machine learning", "ml", "ai", "algorithm",
    "classify", "anomaly", "recommend", "score", "learn", "dataset", "training",
    "inference", "accuracy",
  ],
  data: [
    "data", "dataset", "ingest", "import", "export", "store", "database",
    "record", "track", "log", "history", "metric", "report", "dashboard",
  ],
  interface: [
    "ui", "interface", "screen", "page", "form", "button", "display", "visual",
    "user can", "view", "click", "navigate", "responsive",
  ],
  api: ["api", "endpoint", "rest", "graphql", "webhook", "integration", "service"],
  authentication: ["auth", "login", "sign in", "role", "permission", "user account"],
  deployment: ["deploy", "hosting", "docker", "ci", "pipeline", "run locally"],
  quality: [
    "test", "testing", "documentation", "readme", "explain", "explainable",
    "confidence", "error handling", "edge case", "maintainable", "structure",
  ],
  core_functionality: [],
};

const IMPORTANCE_KEYWORDS: [string, string[]][] = [
  ["critical", ["must", "required", "requirement", "core", "essential", "need to", "has to"]],
  ["important", ["should", "provide", "expose", "surface", "support"]],
  ["optional", ["optional", "if you have the time", "nice to have", "bonus", "ideally"]],
];

// Markdown structure to strip before treating a line as one requirement.
const HEADING = /^#{1,6}\s+/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TASK = /^\s*-\s*\[\s*[ xX]?\s*\]\s*/;
const NOISE = /^(?:[-*+]\s*)?(?:usage|contents|table of contents)\s*:?\s*$/i;

function clean(line: string): string {
  return line
    .replace(HEADING, "")
    .replace(BULLET, "")
    .replace(TASK, "")
    .trim()
    .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
    .trim();
}

export function truncate(text: string, limit = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.slice(0, 40);
}

/**
 * Turn a brief field into a clean list of one-line statements.
 *
 * Bullets win when they exist. Otherwise paragraphs become items, and otherwise
 * sentences do — in that order of preference, so a well-structured brief never
 * gets re-fragmented.
 */
export function splitItems(text: string | null | undefined): string[] {
  if (!text || !text.trim()) return [];

  const lines = text.split("\n");
  const bullets: string[] = [];
  for (const line of lines) {
    if (!BULLET.test(line)) continue;
    const cleaned = clean(line);
    if (cleaned && !NOISE.test(cleaned) && cleaned.length > 2) bullets.push(cleaned);
  }

  if (bullets.length >= 2) {
    return dedupe(bullets.map((bullet) => truncate(bullet)));
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) {
    return dedupe(paragraphs.map((p) => truncate(p)));
  }

  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  if (sentences.length) {
    return dedupe(sentences.map((s) => truncate(s)));
  }

  return [truncate(text.trim())];
}

export function categorise(text: string): string {
  const lowered = text.toLowerCase();
  let best = "core_functionality";
  let bestHits = 0;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const hits = keywords.filter((keyword) => lowered.includes(keyword)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = category;
    }
  }
  return best;
}

export function importanceOf(text: string): string {
  const lowered = text.toLowerCase();
  for (const [level, keywords] of IMPORTANCE_KEYWORDS) {
    if (keywords.some((keyword) => lowered.includes(keyword))) return level;
  }
  return "important";
}

export interface RequirementEntry {
  id: string;
  text: string;
  category: string;
  importance: string;
}

function entries(prefix: string, items: string[], category: string): RequirementEntry[] {
  return items.map((item, index) => ({
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    text: item,
    category,
    importance: importanceOf(item),
  }));
}

export interface RequirementMap {
  version: number;
  input_hash: string;
  problem_summary: string;
  requirements: RequirementEntry[];
  constraints: RequirementEntry[];
  expected_outcomes: RequirementEntry[];
  evaluation_criteria: RequirementEntry[];
}

/** Deterministic map. No model, no tokens. */
export function buildRequirementMap(
  hackathon: Record<string, unknown>,
): Omit<RequirementMap, "version" | "input_hash"> {
  return {
    requirements: entries(
      "REQ",
      splitItems(hackathon.requirements as string | null),
      "core_functionality",
    ),
    constraints: entries(
      "CON",
      splitItems(hackathon.constraints as string | null),
      "constraint",
    ),
    expected_outcomes: entries(
      "OUT",
      splitItems(hackathon.expected_outcome as string | null),
      "outcome",
    ),
    evaluation_criteria: entries(
      "EVAL",
      splitItems(hackathon.evaluation_criteria as string | null),
      "evaluation",
    ),
    problem_summary: truncate((hackathon.problem_statement as string) || "", 1500),
  };
}

/** Identity of a brief's structure, so we can tell when it changed. */
export function requirementMapHash(hackathon: Record<string, unknown>): Promise<string> {
  const payload = [
    "problem_statement",
    "requirements",
    "constraints",
    "expected_outcome",
    "evaluation_criteria",
  ]
    .map((field) => String(hackathon[field] ?? ""))
    .join("|");
  return shortHash(payload);
}

/**
 * Return the cached map, building and storing one if the brief changed.
 *
 * §31 — a structured brief is never sent to a model again once parsed.
 */
export async function getRequirementMap(
  hackathonId: string,
  hackathon: Record<string, unknown>,
): Promise<RequirementMap> {
  const wantedHash = await requirementMapHash(hackathon);

  const { data } = await db()
    .from("hackathon_requirement_maps")
    .select("*")
    .eq("hackathon_id", hackathonId)
    .order("version", { ascending: false })
    .limit(1);

  const rows = (data ?? []) as Record<string, unknown>[];
  const row = rows[0];

  if (row && row.input_hash === wantedHash) {
    return {
      version: (row.version as number) ?? 1,
      input_hash: wantedHash,
      problem_summary: (row.problem_summary as string) ?? "",
      requirements: (row.requirements as RequirementEntry[]) ?? [],
      constraints: (row.constraints as RequirementEntry[]) ?? [],
      expected_outcomes: (row.expected_outcomes as RequirementEntry[]) ?? [],
      evaluation_criteria: (row.evaluation_criteria as RequirementEntry[]) ?? [],
    };
  }

  const fresh = buildRequirementMap(hackathon);
  const version = row ? ((row.version as number) ?? 1) + 1 : 1;

  const { error } = await db().from("hackathon_requirement_maps").insert({
    hackathon_id: hackathonId,
    version,
    problem_summary: fresh.problem_summary,
    requirements: fresh.requirements,
    constraints: fresh.constraints,
    expected_outcomes: fresh.expected_outcomes,
    evaluation_criteria: fresh.evaluation_criteria,
    input_hash: wantedHash,
  });
  // A cache write must never block a review.
  if (error) console.warn("[hacksim.requirements] could not cache map:", error.message);

  return { version, input_hash: wantedHash, ...fresh };
}

// ── Optional AI fallback (§31, only for unstructured briefs) ───────────────

/** True only when the brief yielded nothing usable at all. */
export function needsAiFallback(requirementMap: RequirementMap): boolean {
  return requirementMap.requirements.length === 0 && requirementMap.expected_outcomes.length === 0;
}

export function fallbackPrompt(hackathon: Record<string, unknown>): string {
  return (
    "This hackathon brief has no usable structure. Split it into atomic, " +
    "individually checkable statements.\n\n" +
    `Problem:\n${String(hackathon.problem_statement ?? "").slice(0, 3000)}\n\n` +
    `Expected outcome:\n${String(hackathon.expected_outcome ?? "").slice(0, 1500)}\n\n` +
    'Return JSON: {"requirements":[{"text":"...","category":"core_functionality|' +
    'ai_ml|data|interface|api|authentication|deployment|quality","importance":' +
    '"critical|important|optional"}],"expected_outcomes":[{"text":"...",' +
    '"category":"outcome","importance":"important"}]}'
  );
}

/** Validate the fallback shape. Anything malformed yields nothing. */
export function parseFallback(payload: Record<string, unknown> | null): {
  requirements: RequirementEntry[];
  constraints: RequirementEntry[];
  expected_outcomes: RequirementEntry[];
  evaluation_criteria: RequirementEntry[];
} {
  const readList = (value: unknown, prefix: string, fixedCategory?: string) =>
    (Array.isArray(value) ? value : [])
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && Boolean(item.text),
      )
      .map((item, index) => ({
        id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
        text: truncate(String(item.text)),
        category: fixedCategory ?? String(item.category || "core_functionality"),
        importance: String(item.importance || "important"),
      }));

  return {
    requirements: readList(payload?.requirements, "REQ").slice(0, 40),
    constraints: [],
    expected_outcomes: readList(payload?.expected_outcomes, "OUT", "outcome").slice(0, 20),
    evaluation_criteria: [],
  };
}
