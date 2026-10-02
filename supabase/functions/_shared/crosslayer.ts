/**
 * Cross-layer edges: frontend HTTP clients → declared routes/handlers.
 * Generic path matching only — no repository-specific rules.
 */

export interface DeclaredRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}

export interface ClientRequestEdge {
  from_file: string;
  to_file: string;
  from_symbol: string | null;
  path: string;
  method: string | null;
  line: number;
  confidence: "high" | "medium";
}

const CLIENT_RES: { re: RegExp; method: string | null }[] = [
  { re: /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g, method: null },
  { re: /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]\s*,\s*\{[^}]*method\s*:\s*['"](\w+)['"]/gi, method: null },
  { re: /axios\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi, method: null },
  { re: /\.(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/g, method: null },
  { re: /supabase\.functions\.invoke\s*\(\s*[`'"]([^`'"]+)[`'"]/g, method: "POST" },
];

function normalizePath(raw: string): string {
  let path = raw.trim();
  if (path.includes("://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* keep raw */
    }
  }
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return path;
}

function routeMatches(clientPath: string, routePath: string): boolean {
  const a = normalizePath(clientPath);
  const b = normalizePath(routePath);
  if (a === b) return true;
  if (a.endsWith(b) && b.length > 1) return true;
  if (b.endsWith(a) && a.length > 1) return true;
  const aTail = a.split("/").pop() ?? "";
  const bTail = b.split("/").pop() ?? "";
  return aTail.length > 2 && aTail === bTail;
}

export function extractClientRequestEdges(input: {
  files: { path: string; content: string }[];
  routes: DeclaredRoute[];
  enclosingSymbol: (file: string, line: number) => string | null;
}): ClientRequestEdge[] {
  const routes = input.routes.filter((r) => r.path && r.file);
  const edges: ClientRequestEdge[] = [];
  const seen = new Set<string>();

  for (const file of input.files) {
    const isLikelyFrontend =
      /pages?\/|components?\/|src\/.*\.(tsx|jsx|vue|svelte)$/i.test(file.path) ||
      /\.(tsx|jsx|vue|svelte)$/i.test(file.path);
    if (!isLikelyFrontend && !/client|frontend|app\.(tsx|jsx)/i.test(file.path)) {
      continue;
    }
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      for (const { re } of CLIENT_RES) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line)) !== null) {
          let pathSpec = match[1] ?? match[2];
          let method: string | null = match[1]?.match(/^(get|post|put|patch|delete)$/i)
            ? match[1].toUpperCase()
            : null;
          if (!pathSpec && match[2]) {
            method = (match[1] ?? "").toUpperCase();
            pathSpec = match[2];
          }
          if (!pathSpec || pathSpec.length < 2) continue;
          if (pathSpec.startsWith("${") || pathSpec.includes("${")) continue;

          const normalized = normalizePath(pathSpec);
          const hit = routes.find((route) => routeMatches(normalized, route.path));
          if (!hit || hit.file === file.path) continue;

          const key = `${file.path}|${hit.file}|${normalized}`;
          if (seen.has(key)) continue;
          seen.add(key);

          edges.push({
            from_file: file.path,
            to_file: hit.file,
            from_symbol: input.enclosingSymbol(file.path, lineNo),
            path: normalized,
            method: method ?? hit.method ?? null,
            line: lineNo,
            confidence: routeMatches(normalized, hit.path) ? "high" : "medium",
          });
          if (edges.length >= 80) return edges;
        }
      }
    }
  }
  return edges;
}
