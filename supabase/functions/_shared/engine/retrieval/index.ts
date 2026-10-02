/** Engine v1 — requirement-aware retrieval (independent implementation). */

export interface IndexFile {
  path: string;
  importance?: string | null;
  file_category?: string | null;
}

export interface IndexChunk {
  file_path?: string;
  path?: string;
  content?: string;
  symbol_name?: string | null;
}

export interface IndexEvidence {
  id: string;
  type: string;
  claim: string;
  file?: string;
  symbol?: string;
}

export interface RepoIndex {
  files: Map<string, IndexFile>;
  chunksByPath: Map<string, IndexChunk[]>;
  evidenceByPath: Map<string, IndexEvidence[]>;
  globalEvidence: IndexEvidence[];
  relationships: { from_file: string; to_file: string; relation: string }[];
}

export function buildRepoIndex(input: {
  files: IndexFile[];
  chunks: IndexChunk[];
  evidence: IndexEvidence[];
  relationships?: { from_file: string; to_file: string; relation: string }[];
}): RepoIndex {
  const files = new Map<string, IndexFile>();
  const chunksByPath = new Map<string, IndexChunk[]>();
  const evidenceByPath = new Map<string, IndexEvidence[]>();
  const globalEvidence: IndexEvidence[] = [];
  for (const file of input.files) {
    if (file?.path) files.set(file.path, file);
  }
  for (const chunk of input.chunks) {
    const path = chunk.file_path ?? chunk.path;
    if (!path) continue;
    const list = chunksByPath.get(path) ?? [];
    list.push(chunk);
    chunksByPath.set(path, list);
  }
  for (const item of input.evidence) {
    globalEvidence.push(item);
    if (item.file) {
      const list = evidenceByPath.get(item.file) ?? [];
      list.push(item);
      evidenceByPath.set(item.file, list);
    }
  }
  return {
    files,
    chunksByPath,
    evidenceByPath,
    globalEvidence,
    relationships: input.relationships ?? [],
  };
}

export function retrieveForTerms(
  index: RepoIndex,
  terms: string[],
  forcePaths?: string[],
  limit = 8,
): { paths: string[]; snippet: string } {
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 3);
  const scored: { path: string; score: number }[] = [];
  for (const [path, file] of index.files) {
    if (file.importance === "ignored") continue;
    let score = file.importance === "high" ? 5 : file.importance === "medium" ? 2 : 0;
    const hay = path.toLowerCase();
    for (const needle of needles) {
      if (hay.includes(needle)) score += 3;
    }
    for (const edge of index.relationships) {
      if (edge.to_file === path || edge.from_file === path) score += 1;
    }
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const forced = (forcePaths ?? []).filter((p) => index.files.has(p));
  const paths = [...new Set([...forced, ...scored.map((s) => s.path)])].slice(0, limit);
  const parts: string[] = [];
  for (const path of paths) {
    const chunks = index.chunksByPath.get(path) ?? [];
    const chunk = chunks[0];
    if (chunk?.content) {
      parts.push(`// ${path}\n${String(chunk.content).slice(0, 1200)}`);
    }
    const ev = (index.evidenceByPath.get(path) ?? []).slice(0, 4);
    for (const item of ev) {
      parts.push(`[${item.id}] ${item.claim}`);
    }
  }
  return { paths, snippet: parts.join("\n\n").slice(0, 8000) };
}
