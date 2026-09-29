import {
  basenameOf,
  categoryOf,
  extensionOf,
  importanceOf,
  isIgnored,
  isSensitive,
  languageOf,
} from "../github.ts";
import type { V2FileRecord } from "./types.ts";
import { sha256Hex } from "./hash.ts";

const GENERATED_HINTS = [
  "/dist/", "/build/", "/out/", ".min.", ".generated.", "/__generated__/",
  ".egg-info/", "/target/release/", "/.next/",
];

export function mapCategory(path: string, fileCategory: string): string {
  const lower = path.toLowerCase();
  if (fileCategory === "component") return "frontend";
  if (fileCategory === "api") return "api";
  if (fileCategory === "database" || fileCategory === "schema") return "schema";
  if (fileCategory === "dataset") return "dataset";
  if (fileCategory === "test") return "test";
  if (fileCategory === "documentation") return "documentation";
  if (fileCategory === "dependency") return "dependency";
  if (fileCategory === "deployment") return "deployment";
  if (fileCategory === "config") return "configuration";
  if (/prompt|system\.md|instructions/i.test(lower)) return "prompt";
  if (fileCategory === "source") return "source";
  if (fileCategory === "model") return "model";
  return fileCategory || "unknown";
}

function looksGenerated(path: string): boolean {
  const lower = path.toLowerCase();
  return GENERATED_HINTS.some((hint) => lower.includes(hint));
}

export async function discoverFiles(input: {
  files: Record<string, unknown>[];
  contentByPath: Map<string, string>;
}): Promise<V2FileRecord[]> {
  const out: V2FileRecord[] = [];

  for (const row of input.files) {
    const path = String(row.path ?? "");
    if (!path) continue;
    const ignored = Boolean(row.is_ignored) || isIgnored(path);
    const sensitive = isSensitive(path);
    const binary = Boolean(row.is_binary);
    const categoryRaw = String(row.file_category ?? categoryOf(path, binary));
    const category = mapCategory(path, categoryRaw);
    const content = input.contentByPath.get(path) ?? null;
    const hash = content ? await sha256Hex(content) : null;

    out.push({
      path,
      size_bytes: Number(row.file_size ?? 0),
      extension: String(row.extension ?? extensionOf(path)),
      language: (row.language as string) ?? languageOf(path),
      category,
      importance_score: 0,
      importance_reasons: [],
      ignored: ignored || sensitive,
      generated: looksGenerated(path),
      binary,
      sensitive,
      content_hash: hash,
      content: content && content.length <= 200_000 ? content : content?.slice(0, 200_000) ?? null,
    });
  }

  return out;
}
