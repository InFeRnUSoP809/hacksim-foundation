import { extractRoutes, type Route } from "../github.ts";
import type { V2FileRecord, V2Relationship, V2SymbolRecord } from "./types.ts";

const IMPORT_RE =
  /(?:import\s+(?:[\w*{}\s,]+)\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]\s+import)/gm;

const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

const FETCH_RE =
  /(?:fetch|axios\.(?:get|post|put|delete|patch)|supabase\.(?:from|rpc|functions\.invoke))\s*\(\s*['"`]([^'"`]+)['"`]/gi;

const DB_RE =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|INTO)\b|\.(?:from|insert|update|delete|upsert|rpc)\s*\(/gi;

const AI_PROVIDER_RE =
  /\b(?:openai|deepseek|anthropic|cohere|ollama|chat\.completions|completions\.create)\b/i;

const PROMPT_LOAD_RE = /\b(?:prompt|systemPrompt|getPrompt|loadPrompt)\b/i;
const PARSE_JSON_RE = /\b(?:JSON\.parse|parseJson|z\.object|safeParse)\b/;
const PERSIST_RE = /\b(?:insert|upsert|update|save|persist)\b/i;

function resolveImport(fromPath: string, spec: string, allPaths: Set<string>): string | null {
  if (spec.startsWith(".")) {
    const baseParts = fromPath.split("/").slice(0, -1);
    const specParts = spec.split("/");
    const merged: string[] = [...baseParts];
    for (const part of specParts) {
      if (part === ".") continue;
      if (part === "..") merged.pop();
      else merged.push(part);
    }
    const candidates = [
      merged.join("/"),
      `${merged.join("/")}.ts`,
      `${merged.join("/")}.tsx`,
      `${merged.join("/")}.js`,
      `${merged.join("/")}/index.ts`,
    ];
    for (const c of candidates) {
      if (allPaths.has(c)) return c;
    }
    return null;
  }
  return null;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function nearestSymbol(symbols: V2SymbolRecord[], filePath: string, line: number): string | undefined {
  const inFile = symbols.filter((s) => s.filePath === filePath);
  let best: V2SymbolRecord | null = null;
  for (const sym of inFile) {
    if (sym.startLine <= line && sym.endLine >= line) {
      if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
    }
  }
  return best?.symbolKey;
}

export function buildRelationshipGraph(
  files: V2FileRecord[],
  symbols: V2SymbolRecord[],
): { relationships: V2Relationship[]; inDegree: Map<string, number>; routeFiles: Set<string> } {
  const relationships: V2Relationship[] = [];
  const inDegree = new Map<string, number>();
  const routeFiles = new Set<string>();
  const pathSet = new Set(files.map((f) => f.path));

  for (const file of files) {
    if (file.ignored || !file.content) continue;

    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(file.content)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const target = resolveImport(file.path, spec, pathSet);
      if (target) {
        relationships.push({
          relationship: "imports",
          confidence: "high",
          sourceFile: file.path,
          targetFile: target,
          sourceLines: String(lineOf(file.content, match.index)),
        });
        inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }

    const routes: Route[] = extractRoutes(file.path, file.content);
    for (const route of routes) {
      routeFiles.add(file.path);
      const handlerKey = nearestSymbol(symbols, file.path, route.line);
      relationships.push({
        relationship: "routes_to",
        confidence: route.symbol ? "high" : "medium",
        sourceFile: file.path,
        sourceSymbolKey: handlerKey,
        sourceLines: `${route.line}`,
        detail: {
          method: route.method,
          path: route.path,
          handler: route.symbol ?? null,
          handler_unresolved: !route.symbol,
        },
      });
    }

    FETCH_RE.lastIndex = 0;
    while ((match = FETCH_RE.exec(file.content)) !== null) {
      const url = match[1];
      relationships.push({
        relationship: "calls_api",
        confidence: "medium",
        sourceFile: file.path,
        sourceSymbolKey: nearestSymbol(symbols, file.path, lineOf(file.content, match.index)),
        sourceLines: String(lineOf(file.content, match.index)),
        detail: { target: url },
      });
    }

    if (DB_RE.test(file.content)) {
      relationships.push({
        relationship: "reads_database",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1",
        detail: { note: "database access pattern detected in file" },
      });
    }

    if (AI_PROVIDER_RE.test(file.content)) {
      relationships.push({
        relationship: "calls_ai_provider",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1",
      });
    }
    if (PROMPT_LOAD_RE.test(file.content)) {
      relationships.push({
        relationship: "loads_prompt",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1",
      });
    }
    if (PARSE_JSON_RE.test(file.content)) {
      relationships.push({
        relationship: "parses_response",
        confidence: "medium",
        sourceFile: file.path,
        sourceLines: "1",
      });
    }
    if (PERSIST_RE.test(file.content)) {
      relationships.push({
        relationship: "persists_result",
        confidence: "low",
        sourceFile: file.path,
        sourceLines: "1",
      });
    }

    // Intra-file call edges (conservative: same-file symbols only)
    const fileSymbols = symbols.filter((s) => s.filePath === file.path);
    const names = new Map(fileSymbols.map((s) => [s.name, s.symbolKey]));
    CALL_RE.lastIndex = 0;
    while ((match = CALL_RE.exec(file.content)) !== null) {
      const callee = match[1];
      const targetKey = names.get(callee);
      if (!targetKey) continue;
      const callerKey = nearestSymbol(symbols, file.path, lineOf(file.content, match.index));
      if (!callerKey || callerKey === targetKey) continue;
      relationships.push({
        relationship: "calls",
        confidence: "medium",
        sourceSymbolKey: callerKey,
        targetSymbolKey: targetKey,
        sourceFile: file.path,
        sourceLines: String(lineOf(file.content, match.index)),
      });
    }
  }

  return { relationships, inDegree, routeFiles };
}
