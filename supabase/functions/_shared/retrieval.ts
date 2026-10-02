/**
 * Requirement-aware retrieval.
 *
 * The old retriever was asked one fixed question — "does this repository
 * implement the hackathon requirements?" — and scored files by category and
 * path fragments. Those words match every repository equally, so it returned
 * the same generic handful of files whatever the challenge was, and the model
 * was left to judge a requirement from code that had nothing to do with it.
 *
 * This engine is built the other way round. For one requirement it takes the
 * requirement's own concepts — its actions, subjects, phrases and synonyms —
 * and ranks the repository against them, with a separate score for each
 * signal so the admin panel can show *why* a file was retrieved:
 *
 *   semantic   the file's code and identifiers speak the requirement's words
 *   keyword    a literal phrase from the requirement appears in a path or symbol
 *   importance how central the file is to the project
 *   symbol     a symbol inside the file is named after the requirement
 *   route      an endpoint path matches
 *   dataset    a profiled dataset is relevant to the requirement
 *   dependency a manifest or import matches
 *   logic      a calculation, rule or model operation involves the terms
 *
 * There is no technology term anywhere in the ranking. A repository that
 * implements a requirement with a hand-written loop and a repository that
 * implements it with a library are ranked by what they *do*.
 */

import type { ConceptSet, FocusGroup } from "./concepts.ts";
import type { DatasetProfile } from "./datasets.ts";

export interface RetrievalPlan {
  subjectId: string;
  focus: FocusGroup;
  /** Ranked retrieval terms, most significant first. */
  terms: string[];
  /** Literal multi-word phrases to look for. */
  phrases: string[];
  /** Which kinds of file could plausibly show this requirement. */
  artifacts: string[];
  /** Alternative query strings, for diagnostics and for the model prompt. */
  questions: string[];
}

export interface FileHit {
  path: string;
  score: number;
  components: {
    semantic: number;
    keyword: number;
    importance: number;
    symbol: number;
    route: number;
    dataset: number;
    dependency: number;
    logic: number;
    /** The requirement is about this kind of artefact, and this is that kind. */
    artifact: number;
  };
  matchedTerms: string[];
  symbol: string | null;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface RetrievalResult {
  plan: RetrievalPlan;
  files: FileHit[];
  evidenceIds: string[];
  datasetPaths: string[];
  considered: number;
  truncated: boolean;
  /** Terms that matched nothing anywhere. */
  unmatchedTerms: string[];
}

// ── The index ──────────────────────────────────────────────────────────────

export interface IndexFile {
  path: string;
  language?: string | null;
  file_category?: string | null;
  importance?: string | null;
  is_ignored?: boolean;
  is_binary?: boolean;
  line_count?: number | null;
}

export interface IndexChunk {
  file_path?: string;
  path?: string;
  content?: string;
  symbol_name?: string | null;
  symbol_type?: string | null;
  importance?: string | null;
  start_line?: number | null;
  end_line?: number | null;
}

export interface IndexEvidence {
  id: string;
  type: string;
  claim: string;
  file?: string;
  symbol?: string;
  lines?: string;
  confidence: string;
}

export interface IndexRoute {
  method?: string;
  path: string;
  file: string;
  line?: number;
  symbol?: string | null;
}

export interface IndexSemantics {
  path: string;
  calculations: { identifiers: string[]; operation: string }[];
  rules: { identifiers: string[]; operation: string }[];
  models: { identifiers: string[]; operation: string }[];
  dataAccess: { identifiers: string[]; operation: string }[];
  ui: { identifiers: string[]; operation: string }[];
}

export interface RepoIndex {
  files: Map<string, IndexFile>;
  /** Tokens from path, symbols and evidence claims, for a file. */
  termsByPath: Map<string, Set<string>>;
  /** Tokens from the file's own code, for a file. */
  bodyTermsByPath: Map<string, Set<string>>;
  symbolsByPath: Map<string, string[]>;
  chunksByPath: Map<string, IndexChunk[]>;
  evidenceByPath: Map<string, IndexEvidence[]>;
  globalEvidence: IndexEvidence[];
  datasetByPath: Map<string, DatasetProfile>;
  routesByPath: Map<string, IndexRoute[]>;
  semanticsByPath: Map<string, IndexSemantics>;
  manifestPaths: Set<string>;
  relationships: { from_file: string; to_file: string; relation: string }[];
}

const IMPORTANCE_SCORE: Record<string, number> = {
  high: 24,
  medium: 12,
  low: 4,
  ignored: 0,
};

const MAX_TOKENS_PER_FILE = 400;
const STOP = new Set([
  "def", "class", "return", "const", "let", "var", "function", "import",
  "from", "the", "and", "for", "this", "self", "true", "false", "null", "none",
]);

function tokenize(text: string, limit = MAX_TOKENS_PER_FILE): Set<string> {
  const out = new Set<string>();
  const raw = String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./\\]+/g, " ")
    .toLowerCase();
  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token.length < 3 || token.length > 32) continue;
    if (STOP.has(token)) continue;
    out.add(token);
    if (out.size >= limit) break;
  }
  return out;
}

/** Built once per review and reused for every requirement. */
export function buildRepoIndex(input: {
  files: IndexFile[];
  chunks: IndexChunk[];
  evidence: IndexEvidence[];
  routes?: IndexRoute[];
  datasetProfiles?: DatasetProfile[];
  semantics?: IndexSemantics[];
  relationships?: { from_file: string; to_file: string; relation: string }[];
}): RepoIndex {
  const files = new Map<string, IndexFile>();
  const termsByPath = new Map<string, Set<string>>();
  const symbolsByPath = new Map<string, string[]>();
  const chunksByPath = new Map<string, IndexChunk[]>();
  const evidenceByPath = new Map<string, IndexEvidence[]>();
  const bodyTermsByPath = new Map<string, Set<string>>();
  const datasetByPath = new Map<string, DatasetProfile>();
  const routesByPath = new Map<string, IndexRoute[]>();
  const semanticsByPath = new Map<string, IndexSemantics>();
  const globalEvidence: IndexEvidence[] = [];
  const manifestPaths = new Set<string>();

  for (const file of input.files) {
    if (!file?.path) continue;
    files.set(file.path, file);
    const terms = tokenize(file.path);
    termsByPath.set(file.path, terms);
    if (
      /(package\.json|requirements\.txt|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|build\.gradle|composer\.json|pubspec\.yaml)$/i
        .test(file.path)
    ) {
      manifestPaths.add(file.path);
    }
  }

  for (const chunk of input.chunks) {
    const path = (chunk.file_path ?? chunk.path) as string | undefined;
    if (!path) continue;
    const list = chunksByPath.get(path) ?? [];
    list.push(chunk);
    chunksByPath.set(path, list);

    const symbol = String(chunk.symbol_name ?? "");
    if (symbol) {
      const symbols = symbolsByPath.get(path) ?? [];
      symbols.push(symbol);
      symbolsByPath.set(path, symbols);
      for (const token of tokenize(symbol, 20)) {
        termsByPath.get(path)?.add(token);
      }
    }
    const body = bodyTermsByPath.get(path) ?? new Set<string>();
    for (const token of tokenize(String(chunk.content ?? ""))) body.add(token);
    bodyTermsByPath.set(path, body);
  }

  for (const evidence of input.evidence ?? []) {
    if (!evidence?.id) continue;
    if (evidence.file) {
      const list = evidenceByPath.get(evidence.file) ?? [];
      list.push(evidence);
      evidenceByPath.set(evidence.file, list);
      for (const token of tokenize(`${evidence.claim} ${evidence.symbol ?? ""}`, 30)) {
        termsByPath.get(evidence.file)?.add(token);
      }
    } else {
      globalEvidence.push(evidence);
    }
  }

  for (const route of input.routes ?? []) {
    if (!route?.file) continue;
    const list = routesByPath.get(route.file) ?? [];
    list.push(route);
    routesByPath.set(route.file, list);
    for (const token of tokenize(route.path, 20)) {
      termsByPath.get(route.file)?.add(token);
    }
  }

  for (const profile of input.datasetProfiles ?? []) {
    if (!profile?.path) continue;
    datasetByPath.set(profile.path, profile);
    const terms = termsByPath.get(profile.path) ?? new Set<string>();
    for (const name of profile.column_names) {
      for (const token of tokenize(name, 20)) terms.add(token);
    }
    termsByPath.set(profile.path, terms);
  }

  for (const semantics of input.semantics ?? []) {
    if (!semantics?.path) continue;
    semanticsByPath.set(semantics.path, semantics);
  }

  return {
    files,
    termsByPath,
    bodyTermsByPath,
    symbolsByPath,
    chunksByPath,
    evidenceByPath,
    globalEvidence,
    datasetByPath,
    routesByPath,
    semanticsByPath,
    manifestPaths,
    relationships: input.relationships ?? [],
  };
}

// ── The plan ───────────────────────────────────────────────────────────────

const GENERIC_TERMS = new Set([
  "system", "application", "project", "solution", "user", "users", "data",
  "value", "values", "item", "items", "result", "results", "name", "names",
  "id", "ids", "service", "code", "file", "files", "page", "pages", "app",
  "use", "using", "provide", "support", "build", "make", "create", "add",
  "must", "should", "shall", "able", "ensure", "allow", "allow", "need",
  "require", "functionality", "feature", "features", "capability",
]);

/**
 * Turn one requirement's concepts into an executable plan. Everything ranked
 * here came from the requirement text or from the hackathon's own vocabulary.
 */
export function buildRetrievalPlan(subjectId: string, concept: ConceptSet): RetrievalPlan {
  const ranked: { term: string; weight: number }[] = [];
  const seen = new Set<string>();

  const push = (term: string, weight: number) => {
    const key = term.toLowerCase().trim();
    if (key.length < 3 || GENERIC_TERMS.has(key) || seen.has(key)) return;
    seen.add(key);
    ranked.push({ term: key, weight });
  };

  // Domain words the brief itself used are the strongest signal, because they
  // are the vocabulary of this problem.
  for (const term of concept.domainTerms) push(term, 10);
  for (const term of concept.actions) push(term, 9);
  for (const term of concept.subjects) push(term, 8);
  for (const term of concept.terms) push(term, 4);
  for (const phrase of concept.phrases) {
    for (const part of phrase.split(" ")) push(part, 5);
  }

  const phrases = concept.phrases.filter((phrase) => phrase.includes(" "));
  const questions = [
    concept.intent.slice(0, 300),
    [...phrases, ...concept.actions, ...concept.subjects].join(" ").slice(0, 300),
  ].filter(Boolean);

  return {
    subjectId,
    focus: concept.focus,
    // Thirty terms is the useful ceiling. A longer list does not add recall, it
    // dilutes the weights so that every file looks equally relevant to every
    // requirement.
    terms: ranked.sort((a, b) => b.weight - a.weight).map((item) => item.term).slice(0, 30),
    phrases,
    artifacts: concept.artifacts,
    questions,
  };
}

// ── Ranking ────────────────────────────────────────────────────────────────

export interface RetrieveInput {
  plan: RetrievalPlan;
  index: RepoIndex;
  maxFiles?: number;
  maxSnippetLines?: number;
  maxEvidenceIds?: number;
  /** Paths the verifier asked to see. They occupy retrieval slots first. */
  forcePaths?: string[];
}

export function retrieve(input: RetrieveInput): RetrievalResult {
  const { plan, index } = input;
  const maxFiles = input.maxFiles ?? 6;
  const maxLines = input.maxSnippetLines ?? 120;
  const maxEvidence = input.maxEvidenceIds ?? 24;

  const hits: FileHit[] = [];
  const datasetScores = new Map<string, number>();
  const matchedAnywhere = new Set<string>();
  let considered = 0;

  for (const [path, file] of index.files) {
    if (file.is_ignored || file.is_binary) continue;
    // A file with no chunk is not skipped: it is scored on whatever signals it
    // has (path, evidence claims, routes, semantics, dataset profile) and drops
    // out at `score <= 4` if none of them match. Skipping it outright used to
    // make every interface requirement blind to the HTML that implements it.
    considered += 1;

    const pathTerms = index.termsByPath.get(path) ?? new Set<string>();
    const bodyTerms = index.bodyTermsByPath.get(path) ?? new Set<string>();
    const symbols = index.symbolsByPath.get(path) ?? [];
    const routes = index.routesByPath.get(path) ?? [];
    const dataset = index.datasetByPath.get(path);
    const semantics = index.semanticsByPath.get(path);

    const components: FileHit["components"] = {
      semantic: 0,
      keyword: 0,
      importance: 0,
      symbol: 0,
      route: 0,
      dataset: 0,
      dependency: 0,
      logic: 0,
      artifact: artifactAffinity(plan.artifacts, file),
    };
    const matched: string[] = [];

    // Semantic relevance: does the code itself speak the requirement's words?
    // Rank matters, so the first terms are worth more than the last.
    plan.terms.forEach((term, index_) => {
      const weight = Math.max(1, 10 - Math.floor(index_ / 4));
      if (pathTerms.has(term) || symbols.some((symbol) => symbol.toLowerCase().includes(term))) {
        components.symbol += weight;
        components.semantic += weight;
        matched.push(term);
        matchedAnywhere.add(term);
      }
      if (bodyTerms.has(term)) {
        components.semantic += weight;
        matchedAnywhere.add(term);
      }
    });
    components.semantic = Math.min(40, components.semantic);

    // Literal phrase match beats token match.
    for (const phrase of plan.phrases) {
      const needle = phrase.toLowerCase();
      const inPath = path.toLowerCase().includes(needle);
      const inSymbol = symbols.some((symbol) => symbol.toLowerCase().includes(needle));
      if (inPath || inSymbol) {
        components.keyword += 10;
        matched.push(phrase);
        matchedAnywhere.add(phrase);
      }
    }
    components.keyword = Math.min(30, components.keyword);

    components.importance =
      IMPORTANCE_SCORE[String(file.importance ?? "low")] ?? 4;

    for (const route of routes) {
      const routeText = `${route.path} ${route.symbol ?? ""}`.toLowerCase();
      if (plan.terms.some((term) => routeText.includes(term))) {
        components.route += 10;
        matchedAnywhere.add(route.path);
      }
    }

    if (dataset) {
      if (dataset.relevance === "high") components.dataset += 14;
      else if (dataset.relevance === "medium") components.dataset += 7;

      // A dataset's *shape* is evidence too. A requirement about forecasting
      // over a configurable future window is answered by a file that is dated,
      // keyed by item and carries measured amounts; a requirement about
      // reorder quantities is answered by one that carries stock levels. None of
      // that is technology detection, and none of it is a keyword match on a
      // filename.
      const entityHit = [...dataset.entity_columns, ...dataset.identifier_columns].some(
        (column) => plan.terms.some((term) => column.toLowerCase().includes(term)),
      );
      if (entityHit) components.dataset += 10;

      if (
        plan.terms.some((term) =>
          [
            "date", "time", "history", "historical", "trend", "future", "window",
            "horizon", "daily", "weekly", "monthly", "forecast", "demand",
            "season", "overdue", "upcoming",
          ].includes(term),
        ) &&
        dataset.date_columns.length
      ) {
        components.dataset += 8;
      }

      if (
        plan.terms.some((term) =>
          [
            "quantity", "qty", "amount", "stock", "level", "sales", "revenue",
            "price", "count", "volume", "units", "balance", "available",
          ].includes(term),
        ) &&
        (dataset.quantity_columns.length ||
          dataset.stock_columns.length ||
          dataset.price_columns.length)
      ) {
        components.dataset += 8;
      }
    }

    if (index.manifestPaths.has(path)) {
      const fileTokens = pathTerms;
      if (plan.terms.some((term) => fileTokens.has(term))) components.dependency += 6;
    }

    // Business logic: a calculation or rule that involves the requirement's
    // words is the single strongest signal that the behaviour exists.
    if (semantics) {
      const groups = [
        semantics.calculations,
        semantics.rules,
        semantics.models,
        semantics.dataAccess,
      ];
      for (const group of groups) {
        const hit = group.find((item) =>
          item.identifiers.some((identifier) =>
            plan.terms.some((term) => identifier.toLowerCase().includes(term)),
          ),
        );
        if (hit) {
          components.logic += 12;
          matched.push(...hit.identifiers.slice(0, 2));
          matchedAnywhere.add(hit.operation);
        }
      }
      if (plan.artifacts.includes("ui") && semantics.ui.length > 0) {
        const hit = semantics.ui.find((item) =>
          item.identifiers.some((identifier) =>
            plan.terms.some((term) => identifier.toLowerCase().includes(term)),
          ),
        );
        if (hit) components.logic += 6;
      }
    }

    const score =
      components.semantic +
      components.keyword +
      components.importance +
      components.symbol +
      components.route +
      components.dataset +
      components.dependency +
      components.logic +
      components.artifact;

    if (score <= 4) continue;

    if (dataset) datasetScores.set(path, components.dataset + components.semantic);

    const chunk = pickChunk(index, path, plan, maxLines);
    hits.push({
      path,
      score,
      components,
      matchedTerms: [...new Set(matched)].slice(0, 8),
      symbol: chunk?.symbol_name ?? null,
      startLine: Number(chunk?.start_line ?? 1),
      endLine: Number(chunk?.end_line ?? Math.max(1, Number(chunk?.end_line ?? 1))),
      excerpt: chunk ? renderChunk(chunk, maxLines) : "",
    });
  }

  hits.sort((a, b) => b.score - a.score);
  // A repository that keeps a copy of a data file in two places is common, and
  // both copies score identically. Two slots for one fact wastes the packet, so
  // only the best-scoring copy of each name is kept.
  const seenNames = new Set<string>();
  const deduped = hits.filter((hit) => {
    const name = hit.path.slice(hit.path.lastIndexOf("/") + 1).toLowerCase();
    if (seenNames.has(name)) return false;
    seenNames.add(name);
    return true;
  });
  const forced: FileHit[] = [];
  for (const path of input.forcePaths ?? []) {
    if (forced.length >= maxFiles) break;
    const hit = deduped.find((item) => item.path === path) ??
      hitFromPath(index, path, plan, maxLines);
    if (hit) forced.push(hit);
  }
  const lexical = deduped
    .filter((hit) => !forced.some((item) => item.path === hit.path))
    .slice(0, Math.max(1, maxFiles - 2 - forced.length));
  const selectedPathsDraft = new Set(lexical.map((hit) => hit.path));
  const neighbors: FileHit[] = [];
  for (const hit of lexical) {
    for (const edge of index.relationships) {
      if (edge.from_file !== hit.path) continue;
      if (edge.relation !== "calls" && edge.relation !== "imports") continue;
      if (selectedPathsDraft.has(edge.to_file)) continue;
      if (neighbors.some((item) => item.path === edge.to_file)) continue;
      const neighbor = deduped.find((item) => item.path === edge.to_file) ??
        hitFromPath(index, edge.to_file, plan, maxLines);
      if (!neighbor) continue;
      neighbors.push(neighbor);
      selectedPathsDraft.add(neighbor.path);
      if (lexical.length + neighbors.length >= maxFiles) break;
    }
    if (lexical.length + neighbors.length >= maxFiles) break;
  }
  const selected = [...forced, ...lexical, ...neighbors].slice(0, maxFiles);

  const selectedPaths = new Set(selected.map((hit) => hit.path));

  // A dataset is evidence in its own right, not just a file: a forecast
  // requirement is argued from the history, so the two most relevant profiles
  // travel with every requirement even when their file lost the ranking to
  // six source files. A compact profile costs ~200 tokens; the rows behind it
  // never travel at all.
  const datasetPaths = [...datasetScores.entries()]
    .filter(([path, score]) => score > 0 && !selectedPaths.has(path))
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path);
  const seenDatasetNames = new Set<string>(
    [...selectedPaths]
      .filter((path) => index.datasetByPath.has(path))
      .map((path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase()),
  );
  const topDatasets = datasetPaths
    .filter((path) => {
      const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
      if (seenDatasetNames.has(name)) return false;
      seenDatasetNames.add(name);
      return true;
    })
    .slice(0, 2);

  const evidenceIds: string[] = [];
  for (const path of [...selectedPaths, ...datasetPaths]) {
    for (const evidence of index.evidenceByPath.get(path) ?? []) {
      if (!evidenceIds.includes(evidence.id)) evidenceIds.push(evidence.id);
    }
  }
  for (const evidence of index.globalEvidence) {
    if (evidenceIds.length >= maxEvidence) break;
    if (!evidenceIds.includes(evidence.id)) evidenceIds.push(evidence.id);
  }

  return {
    plan,
    files: selected,
    evidenceIds: evidenceIds.slice(0, maxEvidence),
    datasetPaths: [
      ...[...selectedPaths].filter((path) => index.datasetByPath.has(path)),
      ...topDatasets,
    ].slice(0, 3),
    considered,
    truncated: deduped.length > selected.length,
    unmatchedTerms: plan.terms
      .filter((term) => !matchedAnywhere.has(term))
      .slice(0, 12),
  };
}

/**
 * Does the requirement's own artefact list say "this kind of file is where the
 * answer lives"?
 *
 * A brief about an interface points at markup and view files; a brief about a
 * reorder rule points at service code; a brief about a dataset points at data
 * files. This is derived from the requirement's own capability, so it cannot
 * encode an expectation about any technology — a hand-written HTML page and a
 * React page score identically.
 */
function artifactAffinity(artifacts: string[], file: IndexFile): number {
  if (!artifacts.length) return 0;
  const path = String(file.path ?? "").toLowerCase();
  const extension = path.slice(path.lastIndexOf("."));
  const category = String(file.file_category ?? "");

  const wants = (name: string) => artifacts.includes(name);
  let score = 0;

  if (wants("ui") && (category === "component" || [".html", ".css", ".scss", ".vue", ".svelte", ".jsx", ".tsx"].includes(extension))) {
    score += 14;
  }
  if (wants("route") && (category === "api" || /route|controller|endpoint|view\//.test(path))) {
    score += 10;
  }
  if (wants("calculation") && ["source", "api", "model"].includes(category) && [".py", ".js", ".ts", ".go", ".rb", ".java", ".php", ".cs"].includes(extension)) {
    score += 8;
  }
  if (wants("model") && /(model|ml|train|predict)/.test(path)) score += 10;
  if (wants("ingestion") && (/(data|load|ingest|etl|import|seed)/.test(path) || category === "dataset")) {
    score += 10;
  }
  if (wants("schema") && (category === "schema" || category === "database")) score += 8;
  if (wants("query") && [".sql", ".prisma", ".graphql"].includes(extension)) score += 8;
  if (wants("test") && (category === "test" || /test|spec/.test(path))) score += 8;
  if (wants("configuration") && category === "config") score += 4;
  if (wants("readme") && category === "documentation") score += 6;
  if (wants("data_loading") && /(read|load|ingest|etl|data)/.test(path)) score += 6;
  if (wants("file_read") && category === "dataset") score += 6;

  return Math.min(20, score);
}

function hitFromPath(
  index: RepoIndex,
  path: string,
  plan: RetrievalPlan,
  maxLines: number,
): FileHit | null {
  const file = index.files.get(path);
  if (!file || file.is_ignored || file.is_binary) return null;
  const chunk = pickChunk(index, path, plan, maxLines);
  if (!chunk) return null;
  return {
    path,
    score: 5,
    components: {
      semantic: 0,
      keyword: 0,
      importance: 0,
      symbol: 0,
      route: 0,
      dataset: 0,
      dependency: 0,
      logic: 5,
      artifact: 0,
    },
    matchedTerms: ["call"],
    symbol: chunk.symbol_name ?? null,
    startLine: Number(chunk.start_line ?? 1),
    endLine: Number(chunk.end_line ?? 1),
    excerpt: renderChunk(chunk, maxLines),
  };
}

function pickChunk(
  index: RepoIndex,
  path: string,
  plan: RetrievalPlan,
  _maxLines: number,
): IndexChunk | null {
  const chunks = index.chunksByPath.get(path) ?? [];
  if (!chunks.length) return null;
  const scored = chunks
    .map((chunk) => {
      const symbol = String(chunk.symbol_name ?? "").toLowerCase();
      const content = String(chunk.content ?? "").toLowerCase();
      const termHits = plan.terms.filter(
        (term) => symbol.includes(term) || content.includes(term),
      ).length;
      const highImportance = chunk.importance === "high" ? 1 : 0;
      return { chunk, score: termHits * 3 + highImportance };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.chunk ?? null;
}

function renderChunk(chunk: IndexChunk, maxLines: number): string {
  const lines = String(chunk.content ?? "").split("\n");
  const shown = lines.slice(0, maxLines);
  let body = shown.join("\n");
  if (shown.length < lines.length) body += "\n… (truncated)";
  return body;
}

/** The snippet block handed to a model, with file boundaries made explicit. */
export function renderPacket(result: RetrievalResult): string {
  if (!result.files.length) return "";
  return result.files
    .map((hit) => {
      const header =
        `--- ${hit.path}` +
        (hit.symbol ? ` [${hit.symbol}]` : "") +
        ` lines ${hit.startLine}-${hit.endLine}` +
        (hit.matchedTerms.length
          ? ` (matches: ${hit.matchedTerms.slice(0, 4).join(", ")})`
          : "") +
        " ---";
      if (!hit.excerpt) {
        return `${header}\n(no chunk was extracted for this file; the file's ` +
          "identifiers and evidence are listed instead)";
      }
      return `${header}\n${hit.excerpt}`;
    })
    .join("\n\n");
}

/** One line per file, for the admin diagnostics panel. */
export function describeRetrieval(result: RetrievalResult): Record<string, unknown> {
  return {
    subject_id: result.plan.subjectId,
    focus: result.plan.focus,
    queries: result.plan.questions.slice(0, 3),
    terms: result.plan.terms.slice(0, 14),
    files_considered: result.considered,
    files_retrieved: result.files.length,
    truncated: result.truncated,
    files: result.files.map((hit) => ({
      path: hit.path,
      score: hit.score,
      symbol: hit.symbol,
      components: hit.components,
      matched: hit.matchedTerms,
    })),
    unmatched_terms: result.unmatchedTerms,
    evidence_ids: result.evidenceIds,
  };
}
