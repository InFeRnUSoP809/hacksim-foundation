/**
 * Requirement understanding.
 *
 * The one question this file answers is: **what would I have to SEE in a
 * repository to believe this requirement is met?**
 *
 * It is deliberately not "which technology would satisfy this". That question
 * is what broke this product: a project that forecasts demand with a moving
 * average was reported as not implementing a forecasting requirement because
 * TensorFlow was absent, and a project that imports scikit-learn was credited
 * with forecasting because the import exists. Both are nonsense. A requirement
 * is a behaviour; behaviour lives in code, data, configuration and interface.
 *
 * So a requirement is decomposed into observable things:
 *
 *   • phrases      — the noun phrases a reviewer would look for ("demand
 *                    forecast", "reorder quantity", "future window")
 *   • actions      — what the system does (forecast, recommend, ingest, display)
 *   • subjects     — what it acts on (medicine, order, user, sensor reading)
 *   • qualifiers   — how it must behave (configurable, per item, real time)
 *   • facets       — the atomic capabilities the requirement is made of
 *   • artifacts    — which kinds of file could possibly show each facet
 *
 * Everything here is pure string work. No model, no tokens, no repository
 * access, and no domain is hard-coded: the vocabulary is generic capability
 * language, and the domain nouns are read out of the hackathon's own brief, so
 * a logistics challenge and a fintech challenge both work.
 */

import type { RequirementEntry, RequirementMap } from "./requirements.ts";

// ── Focus groups ───────────────────────────────────────────────────────────
// Requirements are analysed one at a time, but they are *asked* of the model in
// small thematic batches. Grouping by the capability a requirement is really
// about keeps each call's context tight and its evidence relevant.

export type FocusGroup =
  | "data"
  | "analytics"
  | "decision"
  | "trust"
  | "interface"
  | "platform"
  | "general";

export const FOCUS_ORDER: FocusGroup[] = [
  "data",
  "analytics",
  "decision",
  "trust",
  "interface",
  "platform",
  "general",
];

export const FOCUS_LABEL: Record<FocusGroup, string> = {
  data: "data sources and ingestion",
  analytics: "computation, models and prediction",
  decision: "decision logic, recommendations and risk",
  trust: "confidence, quality and explainability",
  interface: "interface, workflow and usability",
  platform: "platform, APIs and deployment",
  general: "general capability",
};

// ── Capability vocabulary ──────────────────────────────────────────────────
// Each entry is a capability the requirement might be about, the words that
// name it, and the words an implementation of it tends to use. Expansion is
// one-directional in intent but two-directional in practice: a requirement
// saying "forecast" retrieves code that says "predict", and vice versa.

interface Capability {
  group: FocusGroup;
  /** Words that mean the requirement is about this capability. */
  triggers: string[];
  /** Words an implementation of it tends to use, in any language. */
  synonyms: string[];
  /** How much a match on a synonym means. */
  weight: number;
}

const CAPABILITIES: Capability[] = [
  {
    group: "data",
    triggers: [
      "ingest", "ingestion", "import", "upload", "load", "dataset", "data set",
      "csv", "json", "source data", "input data", "historical data", "history",
      "transaction", "records", "read", "parse", "extract", "etl", "schema",
      "preprocess", "clean", "seed", "populate",
    ],
    synonyms: [
      "ingest", "ingestion", "read_csv", "readcsv", "load_csv", "csv", "tsv",
      "jsonl", "ndjson", "parse", "parser", "loader", "load_data", "read_data",
      "import", "upload", "file", "files", "pandas", "dataframe", "dataset",
      "raw", "source", "history", "historical", "transaction", "transactions",
      "record", "records", "row", "rows", "column", "columns", "schema",
      "migration", "seed", "fixture", "sample", "snapshot", "extract",
      "ingested", "preprocess", "clean", "normalize", "scrub", "listdir",
      "exists", "input", "inputs", "bulk", "batch",
    ],
    weight: 6,
  },
  {
    group: "analytics",
    triggers: [
      "forecast", "prediction", "predict", "estimate", "projection", "project",
      "model", "machine learning", "ml", "ai", "inference", "trend", "time series",
      "timeseries", "statistics", "statistical", "regression", "analytics",
      "compute", "calculation", "calculate", "aggregate", "score",
    ],
    synonyms: [
      "forecast", "forecasting", "predict", "predicts", "prediction",
      "predictions", "predicted", "estimate", "estimated", "estimation",
      "projection", "projected", "project", "extrapolate", "interpolate",
      "inference", "infer", "model", "models", "modeling", "regressor",
      "regression", "classifier", "classification", "fit", "train", "training",
      "trained", "predictor", "estimator", "pipeline", "feature", "features",
      "transform", "aggregate", "aggregation", "mean", "average", "moving",
      "trend", "trendline", "seasonal", "seasonality", "horizon", "window",
      "future", "slope", "coefficient", "weight", "weights", "score", "rmse",
      "mae", "mape", "accuracy", "backtest", "holdout", "timeseries", "series",
      "np", "numpy", "pd", "math", "statistics", "linregress", "polyfit",
    ],
    weight: 6,
  },
  {
    group: "decision",
    triggers: [
      "recommend", "recommendation", "suggest", "suggestion", "reorder",
      "replenish", "restock", "alert", "alerts", "risk", "warning", "threshold",
      "prioritise", "prioritize", "triage", "plan", "policy", "rule", "decision",
      "trigger", "notify",
    ],
    synonyms: [
      "recommend", "recommended", "recommendation", "recommendations", "suggest",
      "suggested", "suggestion", "reorder", "reordering", "reorder_quantity",
      "reorder_date", "replenish", "replenishment", "restock", "restocking",
      "refill", "buy", "purchase", "order", "order_quantity", "lead_time",
      "leadtime", "safety_stock", "stockout", "shortage", "low_stock", "risk",
      "risk_score", "risk_level", "alert", "alerts", "alerting", "warn",
      "warning", "threshold", "thresholds", "trigger", "rule", "rules",
      "policy", "decide", "decision", "policy", "priority", "prioritise",
      "prioritize", "triage", "action", "actionable", "plan", "planner",
      "inventory", "stock", "level", "levels", "balance", "onhand", "available",
    ],
    weight: 6,
  },
  {
    group: "trust",
    triggers: [
      "confidence", "uncertainty", "reliability", "explainable", "explainability",
      "transparency", "data quality", "quality", "accuracy", "validation",
      "provenance", "audit", "caveat", "assumption", "limitations", "honest",
    ],
    synonyms: [
      "confidence", "confident", "uncertainty", "uncertain", "reliability",
      "reliable", "explain", "explanation", "explainable", "explainability",
      "rationale", "reason", "because", "justify", "transparent",
      "transparency", "data_quality", "quality", "validate", "validation",
      "valid", "provenance", "audit", "caveat", "assumption", "limitations",
      "missing", "null", "nan", "impute", "outlier", "completeness", "coverage",
      "sample", "samples", "sample_size", "n_obs", "interval", "band",
      "residual", "score", "metric", "metrics", "mae", "rmse", "r2",
      "holdout", "backtest", "cross_validation", "cv", "distribution",
      "std", "variance", "deviation", "accuracy", "benchmark", "baseline",
    ],
    weight: 6,
  },
  {
    group: "interface",
    triggers: [
      "dashboard", "interface", "ui", "screen", "page", "view", "form", "table",
      "chart", "graph", "display", "show", "visualise", "visualize", "user can",
      "workflow", "click", "button", "usability", "usable", "responsive",
      "frontend", "presentation",
    ],
    synonyms: [
      "dashboard", "dashboards", "screen", "screens", "page", "pages", "view",
      "views", "ui", "frontend", "front_end", "client", "app", "application",
      "html", "template", "jinja", "blade", "render", "rendered", "display",
      "displayed", "show", "shown", "chart", "charts", "graph", "plot",
      "canvas", "svg", "table", "tables", "list", "card", "cards", "modal",
      "form", "forms", "input", "button", "buttons", "click", "onclick",
      "submit", "filter", "search", "sort", "column", "badge", "status",
      "spinner", "loading", "toast", "alert_box", "workflow", "usability",
      "usable", "intuitive", "responsive", "css", "style", "layout", "dom",
    ],
    weight: 5,
  },
  {
    group: "platform",
    triggers: [
      "api", "endpoint", "service", "deploy", "deployment", "hosting",
      "authentication", "authorisation", "authorization", "login", "role",
      "permission", "database", "storage", "integration", "webhook", "real-time",
      "realtime", "responsive time", "performance", "scalability", "scale",
    ],
    synonyms: [
      "api", "apis", "endpoint", "endpoints", "route", "routes", "router",
      "controller", "handler", "rest", "graphql", "grpc", "webhook", "service",
      "server", "backend", "back_end", "fastapi", "flask", "express", "django",
      "deploy", "deployment", "deployments", "hosting", "hosted", "docker",
      "container", "vercel", "netlify", "fly", "render", "heroku", "railway",
      "auth", "authenticate", "authentication", "authorize", "authorization",
      "login", "logout", "signup", "register", "session", "jwt", "token",
      "role", "roles", "permission", "permissions", "rbac", "middleware",
      "guard", "database", "db", "sql", "postgres", "postgresql", "mysql",
      "sqlite", "mongo", "mongodb", "supabase", "firebase", "prisma", "orm",
      "query", "queries", "select", "insert", "update", "table", "storage",
      "cache", "redis", "queue", "worker", "cron", "scheduler", "integration",
      "webhook", "socket", "websocket", "sse", "realtime", "real_time",
    ],
    weight: 5,
  },
];

// Words that carry no retrieval signal. Domain words are NOT here: they are the
// whole point.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can",
  "for", "from", "has", "have", "in", "into", "is", "it", "its", "of", "on",
  "or", "that", "the", "their", "them", "then", "there", "these", "this",
  "those", "to", "was", "were", "what", "when", "where", "which", "while",
  "who", "why", "will", "with", "within", "without", "would", "should",
  "could", "must", "may", "able", "each", "every", "any", "all", "both",
  "per", "via", "using", "use", "used", "able", "user", "users", "system",
  "solution", "project", "application", "app", "build", "provide", "provides",
  "allow", "allows", "allow", "support", "supports", "make", "makes", "need",
  "needs", "want", "wants", "should", "given", "based", "including", "include",
  "includes", "such", "than", "other", "others", "some", "more", "most",
  "not", "no", "also", "only", "over", "under", "about", "after", "before",
  "between", "up", "down", "out", "off", "again", "further", "once", "here",
  "does", "doing", "done", "how", "very", "just", "now", "new", "one", "two",
  "three", "first", "second", "next", "last", "same", "own", "too", "s",
  "t", "don", "doesn", "isn", "product", "option", "options", "default",
  "default", "simple", "easily", "quickly", "small", "large", "different",
  "sure", "etc", "eg", "ie",
]);

/** Terms that are too generic to rank anything on their own. */
const WEAK_TERMS = new Set([
  "data", "model", "models", "system", "app", "application", "file", "files",
  "code", "page", "pages", "list", "value", "values", "item", "items", "user",
  "users", "result", "results", "type", "types", "name", "names", "id", "ids",
  "service", "services", "state", "info", "information", "number", "count",
  "set", "get", "run", "use", "make", "add", "new", "all", "test", "tests",
]);

// ── Tokenising ─────────────────────────────────────────────────────────────

/** Split identifiers and prose into comparable terms. */
export function termsOf(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const raw = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase
    .replace(/[_\-./\\]+/g, " ") // snake_case, kebab-case, paths
    .toLowerCase();

  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token.length < 2 || token.length > 40) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * A conservative stemmer. Only inflections that keep the word recognisable are
 * folded, and the unstemmed form is always kept too, so a search for "reorder"
 * still finds "reordering" and a search for "reordering" still finds "reorder".
 */
function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const [suffix, min] of [
    ["ies", 5], ["ing", 6], ["ed", 5], ["es", 5], ["s", 4],
  ] as const) {
    if (word.endsWith(suffix) && word.length >= min) {
      const base = word.slice(0, word.length - suffix.length);
      // "ingest" must not become "ing"; "business" must not become "busines".
      if (base.length >= 3 && !/[aeiou]{3}/.test(base.slice(-3)) === false) {
        return base;
      }
    }
  }
  return word;
}

function termVariants(terms: string[]): string[] {
  const out = new Set<string>();
  for (const term of terms) {
    out.add(term);
    const stemmed = stem(term);
    if (stemmed !== term) out.add(stemmed);
  }
  return [...out];
}

// ── The analysed requirement ───────────────────────────────────────────────

export interface Facet {
  /** What this facet is about, in the requirement's own words. */
  phrase: string;
  focus: FocusGroup;
  /** Retrieval terms for this facet, most significant first. */
  terms: string[];
}

export interface ConceptSet {
  /** The requirement text, unchanged. */
  text: string;
  /** One line: what this requirement asks for, in the requirement's words. */
  intent: string;
  focus: FocusGroup;
  /** Noun phrases, 1–3 tokens, useful as literal search strings. */
  phrases: string[];
  /** Capability words found in the requirement itself. */
  actions: string[];
  /** Domain words: either capability words or nouns drawn from the brief. */
  subjects: string[];
  /** "configurable", "per item", "in real time", "without paid services". */
  qualifiers: string[];
  /** Retrieval terms, deduplicated, capability synonyms included. */
  terms: string[];
  /** Domain words worth searching for that came from the brief. */
  domainTerms: string[];
  facets: Facet[];
  /** Where an implementation of this would most plausibly live. */
  artifacts: string[];
}

export interface BriefVocabulary {
  words: Set<string>;
  phrases: string[];
}

/** Read the whole brief so domain nouns can be recognised in any requirement. */
export function briefVocabulary(map: RequirementMap): BriefVocabulary {
  const words = new Set<string>();
  const phrases: string[] = [];

  const source = [
    map.problem_summary ?? "",
    ...(map.requirements ?? []).map((r) => r.text),
    ...(map.constraints ?? []).map((r) => r.text),
    ...(map.expected_outcomes ?? []).map((r) => r.text),
  ].join("\n");

  for (const term of termsOf(source)) {
    words.add(term);
    words.add(stem(term));
  }

  for (const entry of [
    ...(map.requirements ?? []),
    ...(map.expected_outcomes ?? []),
  ]) {
    for (const phrase of nounPhrases(entry.text)) {
      if (phrase.split(" ").length > 1) phrases.push(phrase);
    }
  }

  return { words, phrases: [...new Set(phrases)].slice(0, 120) };
}

/** Contiguous runs of content words, up to three tokens long. */
export function nounPhrases(text: string): string[] {
  const tokens = termsOf(text);
  const phrases: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    phrases.push(tokens[i]);
    if (i + 1 < tokens.length) phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
    if (i + 2 < tokens.length) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }
  return [...new Set(phrases)].filter((p) => p.length > 2);
}

function capabilityFor(word: string): Capability | null {
  for (const capability of CAPABILITIES) {
    if (capability.triggers.includes(word)) return capability;
  }
  return null;
}

function artifactHintsFor(group: FocusGroup): string[] {
  switch (group) {
    case "data":
      return [
        "dataset", "data_loading", "file_read", "schema", "query", "ingestion",
      ];
    case "analytics":
      return ["calculation", "model", "function", "route", "dataset"];
    case "decision":
      return ["calculation", "route", "function", "ui"];
    case "trust":
      return ["calculation", "test", "readme", "model", "dataset"];
    case "interface":
      return ["ui", "route", "function", "readme"];
    case "platform":
      return ["route", "configuration", "dependency", "file", "schema"];
    default:
      return ["function", "route", "ui", "dataset", "configuration", "readme"];
  }
}

/**
 * The heart of the redesign: turn one requirement into an observable brief.
 *
 * Note what is absent. There is no technology anywhere in here, no expected
 * library list, and no way for a *missing* library to influence the result. If
 * a requirement says "forecast", the retrieval plan looks for forecasting
 * behaviour — a symbol, a calculation, a route parameter, a dataset column or
 * a paragraph of code that computes a future value. Whether that behaviour is
 * written in Python with TensorFlow, in JavaScript with a moving average, or in
 * SQL is not the question, and never was.
 */
export function analyseRequirement(
  text: string,
  vocabulary?: BriefVocabulary,
  map?: RequirementMap,
): ConceptSet {
  const clean = String(text ?? "").trim();
  const own = termsOf(clean);

  // Capability words present in the requirement itself.
  const present = new Map<FocusGroup, { capability: Capability; hits: number }>();
  for (const word of own) {
    const capability = capabilityFor(word) ?? capabilityFor(stem(word));
    if (!capability) continue;
    const slot = present.get(capability.group);
    if (slot) slot.hits += 1;
    else present.set(capability.group, { capability, hits: 1 });
  }

  const groups = [...present.values()].sort((a, b) => b.hits - a.hits);
  const focus: FocusGroup = groups[0]?.capability.group ?? "general";

  // Retrieval terms: the requirement's own words first, then the synonyms of
  // every capability it touches, so "forecast" also retrieves "predict".
  const termSet = new Set<string>(termVariants(own));
  const actions = new Set<string>();
  const subjects = new Set<string>();

  for (const word of own) {
    const capability = capabilityFor(word) ?? capabilityFor(stem(word));
    if (capability) {
      actions.add(word);
      // A trigger word is a capability, not a subject. "forecast" does not
      // mean the subject of the requirement is forecasting.
      continue;
    }
    if (WEAK_TERMS.has(word)) continue;
    subjects.add(word);
  }

  for (const { capability } of groups) {
    for (const synonym of capability.synonyms) {
      termSet.add(synonym);
      termSet.add(stem(synonym));
    }
  }

  // Domain vocabulary: nouns from the brief that this requirement also uses,
  // plus the requirement's own content words. This is what makes the engine
  // domain-agnostic — the "medicine" in a pharmacy challenge and the
  // "transaction" in a fintech challenge come from the brief, not from here.
  const domainTerms = new Set<string>();
  for (const word of subjects) {
    if (vocabulary?.words.has(word) || vocabulary?.words.has(stem(word))) {
      domainTerms.add(word);
    }
  }
  for (const term of termSet) {
    if (vocabulary?.words.has(term)) domainTerms.add(term);
  }

  const qualifiers = detectQualifiers(clean);
  const phrases = nounPhrases(clean).filter((phrase) => {
    const parts = phrase.split(" ");
    return parts.every((part) => !capabilityFor(part));
  });

  const facets = buildFacets(clean, own, groups.map((g) => g.capability.group));

  return {
    text: clean,
    intent: intentOf(clean, map),
    focus,
    phrases: [...new Set(phrases)].slice(0, 24),
    actions: [...actions].slice(0, 12),
    subjects: [...subjects].slice(0, 16),
    qualifiers,
    terms: [...termSet],
    domainTerms: [...domainTerms].slice(0, 40),
    facets,
    artifacts: artifactHintsFor(focus),
  };
}

const QUALIFIER_PATTERNS: RegExp[] = [
  /\bconfigurable\b/i,
  /\bcustomi[sz]able\b/i,
  /\badjustable\b/i,
  /\beditable\b/i,
  /\boptional\b/i,
  /\breal[\s-]?time\b/i,
  /\bnear[\s-]?real[\s-]?time\b/i,
  /\blive\b/i,
  /\bper\s+\w+/i,
  /\bfor\s+each\b/i,
  /\bwithin\s+\w+\s+\w+/i,
  /\bwithout\b/i,
  /\bmust\s+not\b/i,
  /\bno\s+\w+\s+services?\b/i,
  /\bfree\b/i,
  /\bpaid\b/i,
  /\boffline\b/i,
  /\bautomatically\b/i,
  /\bmanually\b/i,
  /\bsecure\b/i,
  /\bscalable\b/i,
  /\bfast\b/i,
  /\bquickly\b/i,
  /\bunder\s+\w+\s+\w+/i,
];

function detectQualifiers(text: string): string[] {
  const found: string[] = [];
  for (const pattern of QUALIFIER_PATTERNS) {
    const match = text.match(pattern);
    if (match) found.push(match[0].toLowerCase().trim());
  }
  return [...new Set(found)].slice(0, 8);
}

function intentOf(text: string, map?: RequirementMap): string {
  const first = text.split(/[.;\n]/)[0]?.trim() ?? text;
  const goal = first.replace(/^(the|a|an)\s+/i, "").slice(0, 220);
  if (!map) return goal;
  const problem = (map.problem_summary ?? "").split(/[.\n]/)[0]?.trim();
  return problem ? `${goal} (in service of: ${problem.slice(0, 160)})` : goal;
}

function buildFacets(
  text: string,
  own: string[],
  groups: FocusGroup[],
): Facet[] {
  const facets: Facet[] = [];
  const seen = new Set<string>();

  // One facet per capability the requirement touches. Each is a separate thing
  // to look for, which is what stops "ingest history AND forecast per item"
  // being judged by whichever half happened to be retrieved.
  for (const group of groups) {
    const capability = CAPABILITIES.find((c) => c.group === group);
    if (!capability) continue;
    const matching = own.filter(
      (word) => capability.triggers.includes(word) ||
        capability.triggers.includes(stem(word)),
    );
    const label = matching[0] ?? group;
    const key = `${group}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facets.push({
      phrase: matching.join(" ") || group,
      focus: group,
      terms: [label, ...capability.synonyms.slice(0, 24)],
    });
  }

  // One facet per multi-word phrase: "future window", "reorder quantity".
  for (const phrase of nounPhrases(text)) {
    const parts = phrase.split(" ");
    if (parts.length < 2 || parts.length > 3) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    facets.push({ phrase, focus: "general", terms: [phrase, ...parts] });
  }

  return facets.slice(0, 8);
}

// ── Grouping ───────────────────────────────────────────────────────────────

export interface RequirementGroup {
  focus: FocusGroup;
  label: string;
  entries: RequirementEntry[];
  concepts: ConceptSet[];
}

/**
 * Batch requirements by capability for the model, without ever merging their
 * verdicts. Each requirement keeps its own retrieval plan and its own answer;
 * grouping only decides which evidence travels together in one request.
 */
export function groupRequirements(map: RequirementMap): RequirementGroup[] {
  const vocabulary = briefVocabulary(map);
  const groups = new Map<FocusGroup, RequirementGroup>();

  for (const entry of map.requirements ?? []) {
    const concepts = analyseRequirement(entry.text, vocabulary, map);
    const existing = groups.get(concepts.focus);
    if (existing) {
      existing.entries.push(entry);
      existing.concepts.push(concepts);
    } else {
      groups.set(concepts.focus, {
        focus: concepts.focus,
        label: FOCUS_LABEL[concepts.focus],
        entries: [entry],
        concepts: [concepts],
      });
    }
  }

  return FOCUS_ORDER.filter((focus) => groups.has(focus)).map((focus) =>
    groups.get(focus)!
  );
}

/** The same treatment for constraints, outcomes and criteria. */
export function analyseBriefItems(
  items: RequirementEntry[],
  map: RequirementMap,
): ConceptSet[] {
  const vocabulary = briefVocabulary(map);
  return items.map((item) => analyseRequirement(item.text, vocabulary, map));
}

/**
 * Exposed for the admin diagnostics panel and for tests: the vocabulary itself,
 * so a reviewer can see exactly which words a requirement will search for.
 */
export function capabilitySummary(): { group: FocusGroup; terms: string[] }[] {
  return CAPABILITIES.map((capability) => ({
    group: capability.group,
    terms: [...new Set([...capability.triggers, ...capability.synonyms])].slice(0, 40),
  }));
}
