/**
 * Targeted code retrieval (§28).
 *
 * This file is the reason Phase 6 is affordable. For a given question it
 * assembles the smallest useful packet:
 *
 *     ≤ 6 files
 *     ≤ 120 lines per snippet
 *
 * Selection is deterministic and ranked, never a blind "first N files that look
 * relevant". If nothing ranks, the caller gets an empty packet and is expected
 * to record `not_evidenced` rather than pad the prompt.
 */

import { settings } from "./ai.ts";

// Terms that, when present in a question, point at a kind of file.
const QUESTION_SIGNALS: Record<string, string[]> = {
  security: [
    "auth", "login", "password", "token", "jwt", "session", "cookie", "permission",
    "role", "secret", "key", "credential", "encrypt", "hash",
  ],
  database: [
    "database", "db", "schema", "migration", "table", "query", "sql", "model",
    "orm", "index", "postgres", "supabase", "storage", "data",
  ],
  api: [
    "api", "endpoint", "route", "request", "response", "controller", "handler",
    "rest", "graphql", "webhook", "fetch", "http",
  ],
  frontend: [
    "ui", "component", "page", "screen", "form", "render", "view", "react", "vue",
    "dashboard", "interface", "click", "button",
  ],
  testing: ["test", "spec", "coverage", "assert", "mock", "fixture"],
  prediction: [
    "predict", "forecast", "model", "train", "inference", "ml", "machine learning",
    "algorithm", "score", "accuracy", "dataset",
  ],
  deployment: ["deploy", "docker", "build", "ci", "pipeline", "hosting", "vercel"],
  configuration: ["config", "setting", "environment", "env", "variable", "option"],
};

// Path fragments that indicate a file answers a category.
const PATH_SIGNALS: Record<string, string[]> = {
  security: ["auth", "login", "session", "permission", "middleware", "guard", "acl"],
  database: ["schema", "migration", "model", "db", "database", "sql", "prisma", "repository"],
  api: ["route", "router", "controller", "api", "endpoint", "handler", "view"],
  frontend: ["component", "page", "view", "screen", "ui", "app/", "layout"],
  testing: ["test", "spec", "__tests__", "fixtures"],
  deployment: ["docker", "workflow", "deploy", "ci", "vercel", "netlify"],
  configuration: ["config", "settings", ".env", "settings.py", "constants"],
};

// Category → file_category preference, used when the question has no signal.
const CATEGORY_PREFERENCE: Record<string, string[]> = {
  security: ["source", "api", "config", "model"],
  database: ["database", "schema", "model", "source"],
  api: ["api", "source", "component"],
  frontend: ["component", "source"],
  testing: ["test"],
  deployment: ["deployment", "config"],
  configuration: ["config", "deployment", "source"],
};

export interface Snippet {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
  language: string | null;
  score: number;
}

export class ContextPacket {
  constructor(
    readonly question: string,
    readonly category: string,
  ) {}

  snippets: Snippet[] = [];
  filesConsidered = 0;
  truncated = false;

  get isEmpty(): boolean {
    return this.snippets.length === 0;
  }

  /** A deliberately crude estimate — good enough to gate a budget. */
  estimateTokens(): number {
    return Math.floor(this.snippets.reduce((sum, s) => sum + s.content.length, 0) / 4);
  }

  render(maxSnippetLines = settings().retrievalMaxSnippetLines): string {
    if (this.snippets.length === 0) return "";

    const blocks = this.snippets.map((snippet) => {
      const all = snippet.content.split("\n");
      const shown = all.slice(0, maxSnippetLines);
      let body = shown.join("\n");
      if (shown.length < all.length) body += "\n… (truncated)";
      return (
        `--- ${snippet.path} [${snippet.symbol ?? "file"}] ` +
        `lines ${snippet.startLine}-${snippet.endLine} ---\n${body}`
      );
    });

    return blocks.join("\n\n");
  }
}

/** Pick the single most relevant retrieval category for a question. */
export function classifyQuestion(question: string, categories?: string[]): string {
  const lowered = (question ?? "").toLowerCase();
  const wanted = categories ?? Object.keys(QUESTION_SIGNALS);

  let bestCategory = "general";
  let bestScore = 0;
  for (const category of wanted) {
    const score = (QUESTION_SIGNALS[category] ?? []).filter((term) => lowered.includes(term)).length;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  return bestCategory;
}

/**
 * Assemble the packet for one question.
 *
 * `files` is the Phase 5 inventory and `chunks` its symbol-level chunks. Files
 * are ranked by category signal, then by lexical overlap with the question, then
 * by Phase 5 importance.
 */
export function buildPacket(input: {
  question: string;
  files: Record<string, unknown>[];
  chunks: Record<string, unknown>[];
  category?: string;
  maxFiles?: number;
  maxLines?: number;
}): ContextPacket {
  const config = settings();
  const limitFiles = input.maxFiles ?? config.retrievalMaxFiles;
  const limitLines = input.maxLines ?? config.retrievalMaxSnippetLines;

  const category = input.category ?? classifyQuestion(input.question);
  const packet = new ContextPacket(input.question, category);
  packet.filesConsidered = input.files.length;

  if (input.files.length === 0) return packet;

  const questionTerms = (input.question ?? "")
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 3);

  const pathTerms = PATH_SIGNALS[category] ?? [];
  const preferredCategories = CATEGORY_PREFERENCE[category] ?? [];
  const importanceWeight: Record<string, number> = {
    high: 30, medium: 15, low: 5, ignored: 0,
  };

  const chunksByFile = new Map<string, Record<string, unknown>[]>();
  for (const chunk of input.chunks) {
    const path = (chunk.file_path ?? chunk.path) as string | undefined;
    if (!path) continue;
    const list = chunksByFile.get(path) ?? [];
    list.push(chunk);
    chunksByFile.set(path, list);
  }

  interface Ranked {
    score: number;
    path: string;
    language: string | null;
    chunks: Record<string, unknown>[];
  }

  const ranked: Ranked[] = [];

  for (const record of input.files) {
    const path = (record.path as string) ?? "";
    if (!path || record.is_ignored || record.is_binary) continue;
    if (record.importance === "ignored") continue;

    const lowered = path.toLowerCase();
    let score = importanceWeight[(record.importance as string) ?? "low"] ?? 5;

    if (pathTerms.some((fragment) => lowered.includes(fragment))) score += 40;
    if (preferredCategories.includes(record.file_category as string)) score += 20;
    score += questionTerms.filter((term) => lowered.includes(term)).length * 6;

    const candidateChunks = chunksByFile.get(path) ?? [];
    if (
      candidateChunks.some((chunk) => {
        const symbol = String(chunk.symbol_name ?? "").toLowerCase();
        return Boolean(symbol) && questionTerms.some((term) => symbol.includes(term));
      })
    ) {
      score += 18;
    }

    if (score <= 5) continue;
    ranked.push({ score, path, language: (record.language as string) ?? null, chunks: candidateChunks });
  }

  ranked.sort((a, b) => b.score - a.score);

  const selected = ranked.slice(0, limitFiles);
  if (ranked.length > selected.length) packet.truncated = true;

  for (const item of selected) {
    if (item.chunks.length) {
      // Prefer a chunk whose symbol matches the question.
      const chosen = [...item.chunks].sort((a, b) => {
        const highA = a.importance === "high" ? 1 : 0;
        const highB = b.importance === "high" ? 1 : 0;
        if (highA !== highB) return highB - highA;
        const termsA = questionTerms.filter((term) =>
          String(a.symbol_name ?? "").toLowerCase().includes(term),
        ).length;
        const termsB = questionTerms.filter((term) =>
          String(b.symbol_name ?? "").toLowerCase().includes(term),
        ).length;
        return termsB - termsA;
      })[0];

      const start = Number(chosen.start_line ?? 1);
      const end = Math.min(
        start + limitLines - 1,
        Number(chosen.end_line ?? start + limitLines),
      );
      packet.snippets.push({
        path: item.path,
        symbol: (chosen.symbol_name as string) ?? null,
        startLine: start,
        endLine: end,
        content: (chosen.content as string) ?? "",
        language: item.language,
        score: item.score,
      });
    } else {
      // A file with no symbol chunk contributes its identity only — we never
      // fetch content the scanner did not already read.
      packet.snippets.push({
        path: item.path,
        symbol: null,
        startLine: 1,
        endLine: limitLines,
        content: "",
        language: item.language,
        score: item.score,
      });
    }
  }

  return packet;
}
