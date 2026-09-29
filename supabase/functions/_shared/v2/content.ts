import type { V2FileRecord } from "./types.ts";

/** Merge chunk rows into per-path source text (deterministic order). */
export function contentByPath(
  chunks: { file_path: string; start_line?: number | null; content: string }[],
): Map<string, string> {
  const grouped = new Map<string, { start: number; content: string }[]>();
  for (const chunk of chunks) {
    const path = chunk.file_path;
    const list = grouped.get(path) ?? [];
    list.push({ start: Number(chunk.start_line ?? 0), content: chunk.content });
    grouped.set(path, list);
  }
  const out = new Map<string, string>();
  for (const [path, list] of grouped) {
    list.sort((a, b) => a.start - b.start);
    out.set(path, list.map((row) => row.content).join("\n"));
  }
  return out;
}

export function attachContent(
  files: Omit<V2FileRecord, "content">[],
  byPath: Map<string, string>,
): V2FileRecord[] {
  return files.map((file) => ({
    ...file,
    content: byPath.get(file.path) ?? "",
  }));
}
