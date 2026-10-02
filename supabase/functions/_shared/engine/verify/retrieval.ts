/**
 * Targeted retrieval for verification rounds (indexed files only).
 */

import {
  buildRepoIndex,
  retrieveForTerms,
  type RepoIndex,
} from "../retrieval/index.ts";

export function mergeSnippet(
  index: RepoIndex,
  paths: string[],
  prior: string,
  limit = 9000,
): string {
  const parts = prior ? [prior] : [];
  for (const path of paths) {
    const chunks = index.chunksByPath.get(path) ?? [];
    const chunk = chunks[0];
    if (chunk?.content) {
      parts.push(`// ${path}\n${String(chunk.content).slice(0, 1600)}`);
    }
    const ev = (index.evidenceByPath.get(path) ?? []).slice(0, 6);
    for (const item of ev) {
      parts.push(`[${item.id}] ${item.claim}`);
    }
  }
  return parts.join("\n\n").slice(0, limit);
}

/** Validate model-requested paths against the scan index. */
export function filterAdditionalFiles(
  requested: string[],
  known: Set<string>,
  limit = 4,
): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const raw of requested) {
    const path = String(raw ?? "").trim().replace(/\\/g, "/");
    if (!path || path.includes("..")) {
      rejected.push(path);
      continue;
    }
    if (known.has(path)) {
      if (!accepted.includes(path)) accepted.push(path);
    } else {
      const match = [...known].find(
        (k) => k.endsWith(`/${path}`) || k === path || k.endsWith(path),
      );
      if (match && !accepted.includes(match)) accepted.push(match);
      else rejected.push(path);
    }
    if (accepted.length >= limit) break;
  }
  return { accepted, rejected };
}

export function retrieveForVerification(
  index: RepoIndex,
  terms: string[],
  workflowFiles: string[],
): { paths: string[]; snippet: string } {
  return retrieveForTerms(index, terms, workflowFiles.slice(0, 8), 10);
}

export { buildRepoIndex };
