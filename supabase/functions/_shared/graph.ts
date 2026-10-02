import { extractClientRequestEdges } from "./crosslayer.ts";

/**
 * Structural graph over a repository snapshot.
 *
 * Facts only: symbol spans, resolved relative imports, direct calls between
 * known symbols, and declared routes attached to the enclosing symbol.
 * A flow is "closed" only when an entry, a call, and a data read or write
 * are all present. A filename or a dependency never closes a flow.
 *
 * Repository text is data. Nothing in this file executes it.
 */

export interface SpanSymbol {
  name: string;
  symbol_type: string;
  file: string;
  start_line: number;
  end_line: number;
  language: string | null;
}

export interface GraphEdge {
  from_file: string;
  to_file: string;
  from_symbol: string | null;
  to_symbol: string | null;
  relation:
    | "imports"
    | "calls"
    | "routes_to"
    | "reads"
    | "writes"
    | "client_request"
    | "serves";
  line: number;
  confidence: "high" | "medium";
}

export interface FlowHop {
  file: string;
  symbol: string | null;
  relation: GraphEdge["relation"] | "entry";
  line: number;
}

export interface Flow {
  id: string;
  hops: FlowHop[];
  files: string[];
  closed: boolean;
}

export interface RepoGraph {
  symbols: SpanSymbol[];
  relationships: GraphEdge[];
  flows: Flow[];
  importance: Record<string, number>;
}

const CALL_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class",
  "import", "from", "new", "await", "typeof", "instanceof", "super", "print",
  "len", "str", "int", "float", "range", "list", "dict", "set", "map", "filter",
  "console", "log", "push", "pop", "join", "split", "append", "extend",
]);

const READ_RE =
  /pd\.read_|read_csv|read_json|open\s*\(|fetch\s*\(|axios\.|requests\.(get|post|put|patch|delete)|supabase\.|\.from\s*\(|\.query\s*\(|\.execute\s*\(|SELECT\b|fs\.read/i;
const WRITE_RE =
  /\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(|\.save\s*\(|INSERT\s+INTO|UPDATE\s+\w+|to_csv|json\.dump|write\s*\(/i;

export function endLineFor(
  content: string,
  startLine: number,
  language: string | null,
): number {
  const lines = content.split("\n");
  const start = Math.max(0, startLine - 1);
  if (start >= lines.length) return startLine;
  if (language === "Python") {
    const base = lines[start].length - lines[start].trimStart().length;
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        end = i;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= base) break;
      end = i;
    }
    return end + 1;
  }
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length && i < start + 400; i++) {
    const line = lines[i];
    const code = line.replace(/\/\/.*$/, "").replace(/#.*$/, "");
    for (const ch of code) {
      if (ch === "{") {
        depth += 1;
        seen = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (seen && depth <= 0) return i + 1;
  }
  return Math.min(lines.length, startLine + 40);
}

export function extractImportSpecs(content: string): { spec: string; line: number }[] {
  const found: { spec: string; line: number }[] = [];
  const patterns = [
    /import\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /from\s+([.\w/\\]+) import\s+/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1]?.trim();
      if (!spec) continue;
      const line = content.slice(0, match.index).split("\n").length;
      found.push({ spec, line });
      if (found.length >= 80) return found;
    }
  }
  return found;
}

export function resolveRelativeImport(
  fromFile: string,
  spec: string,
  known: Set<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = fromFile.split("/").slice(0, -1);
  const stack = [...dir];
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const base = stack.join("/");
  const suffixes = [
    "",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".vue", ".svelte",
    ".go", ".java", ".rb", ".php", ".rs",
    "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/__init__.py",
  ];
  for (const suffix of suffixes) {
    const candidate = `${base}${suffix}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function enclosing(
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

export function buildRepositoryGraph(input: {
  files: { path: string; content: string; language: string | null }[];
  symbols: { name: string; symbol_type: string; line: number; file?: string }[];
  routes: { method: string; path: string; file: string; line: number; framework: string }[];
}): RepoGraph {
  const known = new Set(input.files.map((file) => file.path));
  const byFile = new Map<string, SpanSymbol[]>();
  const symbols: SpanSymbol[] = [];

  const scoped = input.symbols.filter((symbol) => symbol.file && known.has(symbol.file));
  const contentByPath = new Map(input.files.map((file) => [file.path, file]));

  for (const symbol of scoped) {
    const file = contentByPath.get(symbol.file!)!;
    const end = endLineFor(file.content, symbol.line, file.language);
    const span: SpanSymbol = {
      name: symbol.name,
      symbol_type: symbol.symbol_type,
      file: symbol.file!,
      start_line: symbol.line,
      end_line: Math.max(symbol.line, end),
      language: file.language,
    };
    symbols.push(span);
    const list = byFile.get(span.file) ?? [];
    list.push(span);
    byFile.set(span.file, list);
  }

  const nameIndex = new Map<string, SpanSymbol[]>();
  for (const symbol of symbols) {
    const list = nameIndex.get(symbol.name) ?? [];
    list.push(symbol);
    nameIndex.set(symbol.name, list);
  }

  const relationships: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (edge: GraphEdge) => {
    const key = [
      edge.relation,
      edge.from_file,
      edge.to_file,
      edge.from_symbol ?? "",
      edge.to_symbol ?? "",
    ].join("|");
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    relationships.push(edge);
  };

  for (const file of input.files) {
    for (const imported of extractImportSpecs(file.content)) {
      const target = resolveRelativeImport(file.path, imported.spec, known);
      if (!target || target === file.path) continue;
      addEdge({
        from_file: file.path,
        to_file: target,
        from_symbol: null,
        to_symbol: null,
        relation: "imports",
        line: imported.line,
        confidence: "high",
      });
    }

    const lines = file.content.split("\n");
    lines.forEach((line, index) => {
      const lineNo = index + 1;
      const owner = enclosing(symbols, file.path, lineNo);
      if (READ_RE.test(line)) {
        addEdge({
          from_file: file.path,
          to_file: file.path,
          from_symbol: owner?.name ?? null,
          to_symbol: null,
          relation: "reads",
          line: lineNo,
          confidence: "medium",
        });
      }
      if (WRITE_RE.test(line)) {
        addEdge({
          from_file: file.path,
          to_file: file.path,
          from_symbol: owner?.name ?? null,
          to_symbol: null,
          relation: "writes",
          line: lineNo,
          confidence: "medium",
        });
      }
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = callRe.exec(line)) !== null) {
        const name = match[1];
        if (CALL_SKIP.has(name) || name === owner?.name) continue;
        const targets = (nameIndex.get(name) ?? []).filter(
          (symbol) => symbol.file !== file.path || symbol.name !== owner?.name,
        );
        const target = targets[0];
        if (!target) continue;
        addEdge({
          from_file: file.path,
          to_file: target.file,
          from_symbol: owner?.name ?? null,
          to_symbol: target.name,
          relation: "calls",
          line: lineNo,
          confidence: target.file === file.path ? "high" : "medium",
        });
      }
    });
  }

  for (const route of input.routes) {
    if (route.framework === "File-based routing") continue;
    const owner = enclosing(symbols, route.file, route.line);
    addEdge({
      from_file: route.file,
      to_file: route.file,
      from_symbol: owner?.name ?? null,
      to_symbol: route.path,
      relation: "routes_to",
      line: route.line,
      confidence: "high",
    });
  }

  const clientEdges = extractClientRequestEdges({
    files: input.files.map((file) => ({ path: file.path, content: file.content })),
    routes: input.routes
      .filter((route) => route.framework !== "File-based routing")
      .map((route) => ({
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.line,
      })),
    enclosingSymbol: (file, line) => enclosing(symbols, file, line)?.name ?? null,
  });
  for (const client of clientEdges) {
    addEdge({
      from_file: client.from_file,
      to_file: client.to_file,
      from_symbol: client.from_symbol,
      to_symbol: client.path,
      relation: "client_request",
      line: client.line,
      confidence: client.confidence,
    });
    addEdge({
      from_file: client.to_file,
      to_file: client.from_file,
      from_symbol: client.path,
      to_symbol: client.from_symbol,
      relation: "serves",
      line: client.line,
      confidence: client.confidence,
    });
  }

  const importance: Record<string, number> = {};
  for (const edge of relationships) {
    importance[edge.to_file] = (importance[edge.to_file] ?? 0) +
      (edge.relation === "imports" ||
          edge.relation === "calls" ||
          edge.relation === "client_request"
        ? 2
        : 1);
    importance[edge.from_file] = (importance[edge.from_file] ?? 0) + 1;
  }

  const flows = buildFlows(relationships).slice(0, 24);

  return {
    symbols: symbols.slice(0, 400),
    relationships: relationships.slice(0, 500),
    flows,
    importance,
  };
}

function buildFlows(edges: GraphEdge[]): Flow[] {
  const calls = edges.filter((edge) => edge.relation === "calls");
  const entries = edges.filter((edge) => edge.relation === "routes_to");
  const clientStarts = edges.filter((edge) => edge.relation === "client_request");
  const flows: Flow[] = [];
  let n = 1;

  const starts = clientStarts.length
    ? clientStarts.map((edge) => ({
      from_file: edge.from_file,
      from_symbol: edge.from_symbol,
      to_file: edge.to_file,
      to_symbol: edge.to_symbol,
      relation: "client_request" as const,
      line: edge.line,
      confidence: edge.confidence,
    }))
    : entries.length
    ? entries
    : calls.filter((edge) => edge.from_symbol).slice(0, 12);

  for (const entry of starts.slice(0, 16)) {
    const startRelation = entry.relation === "routes_to"
      ? "routes_to"
      : entry.relation === "client_request"
      ? "client_request"
      : "entry";
    const hops: FlowHop[] = [
      {
        file: entry.from_file,
        symbol: entry.from_symbol,
        relation: startRelation,
        line: entry.line,
      },
    ];
    if (entry.relation === "client_request") {
      hops.push({
        file: entry.to_file,
        symbol: entry.to_symbol,
        relation: "serves",
        line: entry.line,
      });
    }
    let cursorFile = entry.relation === "client_request" ? entry.to_file : entry.from_file;
    let cursorSymbol = entry.relation === "client_request" ? null : entry.from_symbol;
    const seen = new Set<string>([`${cursorFile}:${cursorSymbol ?? ""}`]);
    for (let depth = 0; depth < 4; depth++) {
      const next = calls.find((edge) =>
        edge.from_file === cursorFile &&
        (cursorSymbol == null || edge.from_symbol === cursorSymbol) &&
        !seen.has(`${edge.to_file}:${edge.to_symbol ?? ""}`),
      );
      if (!next) break;
      hops.push({
        file: next.to_file,
        symbol: next.to_symbol,
        relation: "calls",
        line: next.line,
      });
      seen.add(`${next.to_file}:${next.to_symbol ?? ""}`);
      cursorFile = next.to_file;
      cursorSymbol = next.to_symbol;
    }
    const data = edges.find((edge) =>
      (edge.relation === "reads" || edge.relation === "writes") &&
      hops.some((hop) => hop.file === edge.from_file &&
        (hop.symbol == null || edge.from_symbol === hop.symbol || edge.from_symbol == null)),
    );
    if (data) {
      hops.push({
        file: data.from_file,
        symbol: data.from_symbol,
        relation: data.relation,
        line: data.line,
      });
    }
    if (hops.length < 2) continue;
    const files = [...new Set(hops.map((hop) => hop.file))];
    flows.push({
      id: `FLOW-${String(n).padStart(3, "0")}`,
      hops,
      files,
      closed: flowIsClosed(hops),
    });
    n += 1;
  }
  return flows;
}

export function flowIsClosed(hops: FlowHop[]): boolean {
  const relations = new Set(hops.map((hop) => hop.relation));
  const hasEntry = relations.has("routes_to") ||
    relations.has("entry") ||
    relations.has("client_request");
  const hasWork = relations.has("calls") || relations.has("serves");
  const hasData = relations.has("reads") || relations.has("writes");
  return hasEntry && hasWork && hasData;
}

/**
 * Pick a closed flow whose symbols/files overlap requirement terms.
 * Used only to prioritize retrieval and AI context — never as proof that a
 * requirement is satisfied (semantic claims still need verification).
 */
export function closedFlowFor(
  terms: string[],
  flows: Flow[],
): Flow | null {
  const needles = terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 3);
  if (!needles.length) return null;
  let best: Flow | null = null;
  let bestScore = 0;
  for (const flow of flows) {
    if (!flow.closed) continue;
    const hay = flow.hops
      .map((hop) => `${hop.file} ${hop.symbol ?? ""}`)
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const needle of needles) {
      if (hay.includes(needle)) score += 1;
    }
    if (score >= 2 && score > bestScore) {
      best = flow;
      bestScore = score;
    }
  }
  return best;
}
