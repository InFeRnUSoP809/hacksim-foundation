/**
 * Implementation-level behavior extraction (L3).
 *
 * Structural graph edges say what connects; this module inspects symbol bodies
 * for concrete operations: limits, parsing, HTTP/AI calls, persistence, and
 * collection transforms. Patterns are generic — no repository names or magic
 * output labels.
 */

import { endLineFor, type SpanSymbol } from "./graph.ts";

export type EvidenceLevel = "L0" | "L1" | "L2" | "L3" | "L4";

export type BehaviorKind =
  | "limit_collection"
  | "filter_map_reduce"
  | "parse_json"
  | "serialize_json"
  | "http_request"
  | "ai_api_call"
  | "prompt_construction"
  | "database_write"
  | "database_read"
  | "validation"
  | "branch_threshold"
  | "return_output";

export interface ImplementationBehavior {
  id: string;
  kind: BehaviorKind;
  /** Factual sentence about what the code does at this location. */
  claim: string;
  file: string;
  symbol: string | null;
  start_line: number;
  end_line: number;
  excerpt: string;
  level: EvidenceLevel;
  /** Optional structured detail (limits, identifiers, endpoint hints). */
  detail: Record<string, unknown>;
}

const AI_PROVIDER_RE =
  /openai|deepseek|anthropic|cohere|gemini|mistral|groq|together\.ai|api\.openai|chat\.completions|\/v1\/chat/i;
const PROMPT_RE =
  /(?:system|user|assistant)\s*[:=]|messages\s*:\s*\[|role\s*:\s*['"]|prompt\s*[=+]|buildPrompt|getPrompt/i;

let behaviorSeq = 0;

function nextId(): string {
  behaviorSeq += 1;
  return `BEH-${String(behaviorSeq).padStart(3, "0")}`;
}

function enclosingSymbol(
  symbols: SpanSymbol[],
  file: string,
  line: number,
): SpanSymbol | null {
  let best: SpanSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.file !== file) continue;
    if (symbol.start_line <= line && line <= symbol.end_line) {
      if (!best || symbol.start_line >= best.start_line) best = symbol;
    }
  }
  return best;
}

function sliceLimitClaim(match: RegExpExecArray, line: string): string | null {
  const raw = match[0];
  const limitMatch = raw.match(/slice\s*\(\s*0\s*,\s*(\d+)\s*\)/i) ??
    raw.match(/slice\s*\(\s*0\s*,\s*(\d+)\s*\)/i) ??
    raw.match(/take\s*\(\s*(\d+)\s*\)/i) ??
    raw.match(/limit\s*\(\s*(\d+)\s*\)/i) ??
    raw.match(/head\s*\(\s*(\d+)\s*\)/i) ??
    raw.match(/\[:\s*(\d+)\s*\]/);
  if (!limitMatch) return null;
  const n = limitMatch[1];
  const target = match[1] ?? "collection";
  return `Limits \`${target.trim()}\` to at most ${n} element(s)`;
}

const LIMIT_RES: { re: RegExp; kind: BehaviorKind }[] = [
  {
    re: /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*slice\s*\(\s*0\s*,\s*(\d+)\s*\)/g,
    kind: "limit_collection",
  },
  {
    re: /\b([A-Za-z_$][\w$]*)\s*\[\s*:\s*(\d+)\s*\]/g,
    kind: "limit_collection",
  },
];

export function extractImplementationBehaviors(input: {
  files: { path: string; content: string; language: string | null }[];
  symbols: SpanSymbol[];
  maxPerFile?: number;
}): ImplementationBehavior[] {
  behaviorSeq = 0;
  const maxPerFile = input.maxPerFile ?? 24;
  const byFile = new Map<string, SpanSymbol[]>();
  for (const symbol of input.symbols) {
    const list = byFile.get(symbol.file) ?? [];
    list.push(symbol);
    byFile.set(symbol.file, list);
  }

  const out: ImplementationBehavior[] = [];

  for (const file of input.files) {
    let count = 0;
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length && count < maxPerFile; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      const owner = enclosingSymbol(input.symbols, file.path, lineNo);
      const excerpt = line.trim().slice(0, 240);

      for (const { re, kind } of LIMIT_RES) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line)) !== null && count < maxPerFile) {
          const claim = sliceLimitClaim(match, line);
          if (!claim) continue;
          out.push({
            id: nextId(),
            kind,
            claim,
            file: file.path,
            symbol: owner?.name ?? null,
            start_line: lineNo,
            end_line: lineNo,
            excerpt,
            level: "L3",
            detail: { pattern: "limit", limit: match[2] ?? match[1], target: match[1] },
          });
          count += 1;
        }
      }

      if (/JSON\.parse\s*\(|json\.loads\s*\(|serde_json::from_str|ObjectMapper|decode\s*\(\s*['"]application\/json/i.test(line)) {
        out.push({
          id: nextId(),
          kind: "parse_json",
          claim: "Parses JSON from a string or response body",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L3",
          detail: {},
        });
        count += 1;
      }

      if (/JSON\.stringify\s*\(|json\.dumps\s*\(|serde_json::to_string/i.test(line)) {
        out.push({
          id: nextId(),
          kind: "serialize_json",
          claim: "Serializes data to JSON",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L3",
          detail: {},
        });
        count += 1;
      }

      if (AI_PROVIDER_RE.test(line) && /fetch\s*\(|axios|requests\.|openai|createChatCompletion|chat\.completions/i.test(line)) {
        out.push({
          id: nextId(),
          kind: "ai_api_call",
          claim: "Performs an HTTP request to an AI provider API",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L3",
          detail: {},
        });
        count += 1;
      } else if (/fetch\s*\(|axios\.|requests\.(get|post|put|patch|delete)|http\.request|got\s*\(|urllib\.request/i.test(line) &&
        !/node_modules|\.test\.|\.spec\./i.test(file.path)) {
        out.push({
          id: nextId(),
          kind: "http_request",
          claim: "Performs an HTTP request to an external endpoint",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L2",
          detail: {},
        });
        count += 1;
      }

      if (PROMPT_RE.test(line)) {
        out.push({
          id: nextId(),
          kind: "prompt_construction",
          claim: "Constructs or assembles a prompt or message list for a model",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L3",
          detail: {},
        });
        count += 1;
      }

      if (/\.insert\s*\(|\.upsert\s*\(|\.update\s*\(|INSERT\s+INTO|\.execute\s*\(\s*['"]\s*insert/i.test(line)) {
        out.push({
          id: nextId(),
          kind: "database_write",
          claim: "Writes or updates persisted data",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L3",
          detail: {},
        });
        count += 1;
      }

      if (/\.select\s*\(|\.from\s*\(|SELECT\b|\.query\s*\(|findMany|findOne/i.test(line) &&
        /\.insert|INSERT|upsert|update|DELETE/i.test(lines.slice(Math.max(0, i - 2), i + 3).join("\n")) === false) {
        if (/\.from\s*\(\s*['"]\w+['"]\s*\)|SELECT\b|findMany|findOne/.test(line)) {
          out.push({
            id: nextId(),
            kind: "database_read",
            claim: "Reads persisted data via a query or ORM call",
            file: file.path,
            symbol: owner?.name ?? null,
            start_line: lineNo,
            end_line: lineNo,
            excerpt,
            level: "L2",
            detail: {},
          });
          count += 1;
        }
      }

      if (/\.filter\s*\(|\.map\s*\(|\.reduce\s*\(|Array\.from\s*\(/i.test(line)) {
        out.push({
          id: nextId(),
          kind: "filter_map_reduce",
          claim: "Transforms a collection with filter/map/reduce or similar",
          file: file.path,
          symbol: owner?.name ?? null,
          start_line: lineNo,
          end_line: lineNo,
          excerpt,
          level: "L3",
          detail: {},
        });
        count += 1;
      }
    }

    // Symbol-span summaries for high-importance handlers (cap cost).
    for (const symbol of (byFile.get(file.path) ?? []).slice(0, 8)) {
      if (count >= maxPerFile) break;
      const body = lines.slice(symbol.start_line - 1, symbol.end_line).join("\n");
      if (body.length < 40) continue;
      const hasAi = AI_PROVIDER_RE.test(body) && /fetch|axios|requests|openai|completions/i.test(body);
      const hasParse = /JSON\.parse|json\.loads/i.test(body);
      const hasPersist = /\.insert|\.upsert|INSERT INTO/i.test(body);
      if (hasAi && hasParse && hasPersist && count < maxPerFile) {
        out.push({
          id: nextId(),
          kind: "ai_api_call",
          claim:
            `Symbol \`${symbol.name}\` chains AI HTTP, JSON parsing, and persistence ` +
            `(implementation-level workflow candidate)`,
          file: file.path,
          symbol: symbol.name,
          start_line: symbol.start_line,
          end_line: symbol.end_line,
          excerpt: body.split("\n").slice(0, 3).join(" ").trim().slice(0, 200),
          level: "L3",
          detail: { workflow_candidate: true },
        });
        count += 1;
      }
    }
  }

  return out.slice(0, 400);
}

/** Attach L3 behavior summaries to closed/open flows for admin display. */
export function behaviorsForFlow(
  flowFiles: string[],
  behaviors: ImplementationBehavior[],
): ImplementationBehavior[] {
  const set = new Set(flowFiles);
  return behaviors
    .filter((behavior) => set.has(behavior.file))
    .slice(0, 16);
}

export function symbolSpanEnd(
  content: string,
  startLine: number,
  language: string | null,
): number {
  return endLineFor(content, startLine, language);
}
