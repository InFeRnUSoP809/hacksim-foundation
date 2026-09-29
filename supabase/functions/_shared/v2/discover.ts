import { basenameOf, categoryOf, extensionOf, isIgnored, isSensitive, languageOf } from "../github.ts";
import type { V2FileRecord } from "./types.ts";

const GENERATED_HINTS = [
  "/dist/", "/build/", "/.next/", "/coverage/", ".min.js", ".min.css", ".map",
  "/generated/", "__generated__",
];

const V2_CATEGORY_MAP: Record<string, string> = {
  source: "source",
  component: "frontend",
  api: "api",
  model: "model",
  schema: "schema",
  database: "database",
  config: "configuration",
  dependency: "dependency",
  documentation: "documentation",
  test: "test",
  dataset: "dataset",
  asset: "asset",
  unknown: "unknown",
};

function mapCategory(legacy: string, path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes("supabase/functions") || lower.includes("edge-functions")) {
    return "backend";
  }
  if (lower.includes("migration") || lower.endsWith(".sql") && lower.includes("migrate")) {
    return "migration";
  }
  if (lower.includes("prompt") || lower.endsWith(".prompt.md")) return "prompt";
  if (lower.includes("deploy") || lower === "dockerfile") return "deployment";
  return V2_CATEGORY_MAP[legacy] ?? "unknown";
}

function looksGenerated(path: string): boolean {
  const lower = path.toLowerCase();
  return GENERATED_HINTS.some((hint) => lower.includes(hint));
}

export function buildFileInventory(
  treeEntries: { path: string; size?: number }[],
  contentByPath: Map<string, string>,
): Omit<V2FileRecord, "content">[] {
  return treeEntries.map((entry) => {
    const path = entry.path;
    const ignored = isIgnored(path) || isSensitive(path);
    const binary = [".png", ".jpg", ".pdf", ".zip", ".ico", ".woff"].some((ext) =>
      path.toLowerCase().endsWith(ext)
    );
    const category = mapCategory(categoryOf(path, binary), path);
    const generated = looksGenerated(path);
    return {
      path,
      sizeBytes: Number(entry.size ?? 0),
      extension: extensionOf(path),
      language: languageOf(path),
      category,
      importanceScore: 0,
      reasons: [] as string[],
      ignored,
      generated,
      binary,
      sensitive: isSensitive(path),
      contentHash: null,
    };
  });
}

export function scoreImportance(
  files: Omit<V2FileRecord, "content">[],
  inDegree: Map<string, number>,
  routeFiles: Set<string>,
  entryFiles: Set<string>,
): Omit<V2FileRecord, "content">[] {
  return files.map((file) => {
    if (file.ignored || file.generated) {
      return { ...file, importanceScore: 0, reasons: ["ignored_or_generated"] };
    }
    let score = 0.2;
    const reasons: string[] = [];
    const indeg = inDegree.get(file.path) ?? 0;
    if (indeg >= 5) {
      score += 0.35;
      reasons.push("high_in_degree");
    } else if (indeg >= 2) {
      score += 0.15;
      reasons.push("imported_by_others");
    }
    if (entryFiles.has(file.path)) {
      score += 0.25;
      reasons.push("entry_point");
    }
    if (routeFiles.has(file.path)) {
      score += 0.2;
      reasons.push("route_handler");
    }
    if (["api", "backend", "database", "model"].includes(file.category)) {
      score += 0.1;
      reasons.push("core_category");
    }
    if (file.category === "test") score += 0.05;
    if (file.category === "documentation") score -= 0.15;
    if (file.category === "dependency") score -= 0.2;
    score = Math.max(0, Math.min(1, score));
    return { ...file, importanceScore: Number(score.toFixed(4)), reasons };
  });
}

export function entryPointCandidates(paths: string[]): Set<string> {
  const names = new Set([
    "main.py", "app.py", "index.ts", "index.js", "main.ts", "main.go",
    "server.ts", "server.js", "manage.py", "wsgi.py", "asgi.py",
  ]);
  const out = new Set<string>();
  for (const path of paths) {
    const base = basenameOf(path).toLowerCase();
    if (names.has(base)) out.add(path);
    if (path.includes("supabase/functions/") && base === "index.ts") out.add(path);
  }
  return out;
}
