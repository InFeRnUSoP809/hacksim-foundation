/** Merge scanner chunks into approximate per-file source text. */
export function contentByPath(
  chunks: Record<string, unknown>[],
): Map<string, string> {
  const byPath = new Map<string, { start: number; end: number; content: string }[]>();

  for (const chunk of chunks) {
    const path = String(chunk.file_path ?? chunk.path ?? "");
    if (!path) continue;
    const start = Number(chunk.start_line ?? 1);
    const end = Number(chunk.end_line ?? start);
    const content = String(chunk.content ?? "");
    const list = byPath.get(path) ?? [];
    list.push({ start, end, content });
    byPath.set(path, list);
  }

  const out = new Map<string, string>();
  for (const [path, parts] of byPath) {
    parts.sort((a, b) => a.start - b.start);
    out.set(path, parts.map((p) => p.content).join("\n"));
  }
  return out;
}
