import { V2_DEFAULT_BUDGET as DEFAULT_BUDGET } from "./versions.ts";
import type { V2_DEFAULT_BUDGET } from "./versions.ts";
import type { V2EvidenceItem, V2FileRecord, V2Relationship } from "./types.ts";
import { packetHash } from "./hash.ts";

export interface EvidencePacket {
  subjectIds: string[];
  evidenceIds: string[];
  snippets: { evidenceId: string; file: string; lines: string; excerpt: string }[];
  relationships: V2Relationship[];
  graphSummary: string;
  tokenEstimate: number;
  packetHash: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function buildEvidencePacket(input: {
  subjectIds: string[];
  evidence: V2EvidenceItem[];
  files: V2FileRecord[];
  relationships: V2Relationship[];
  seedEvidenceIds: string[];
  budget?: typeof V2_DEFAULT_BUDGET;
  missingLink?: string;
}): Promise<EvidencePacket> {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const byId = new Map(input.evidence.map((e) => [e.evidenceId, e]));
  const selected = new Set<string>(input.seedEvidenceIds);

  // Graph expansion: add relationship-linked evidence from same files
  for (const rel of input.relationships) {
    if (selected.size >= budget.maxSymbols) break;
    for (const ev of input.evidence) {
      if (ev.filePath === rel.sourceFile) selected.add(ev.evidenceId);
    }
  }

  if (input.missingLink) {
    const needle = input.missingLink.toLowerCase();
    for (const rel of input.relationships) {
      const blob = JSON.stringify(rel.detail ?? {}).toLowerCase();
      if (blob.includes(needle) || rel.sourceFile.toLowerCase().includes(needle)) {
        for (const ev of input.evidence) {
          if (ev.filePath === rel.sourceFile) selected.add(ev.evidenceId);
        }
      }
    }
  }

  const snippets: EvidencePacket["snippets"] = [];
  let bytes = 0;
  let tokens = 0;
  const fileSet = new Set<string>();

  for (const id of selected) {
    const ev = byId.get(id);
    if (!ev) continue;
    const excerpt = ev.snippetExcerpt ?? "";
    const piece = `${ev.claim}\n${excerpt}`;
    const nextTokens = tokens + estimateTokens(piece);
    const nextBytes = bytes + piece.length;
    if (nextTokens > budget.maxInputTokens || nextBytes > budget.maxSourceBytes) break;
    if (ev.filePath) fileSet.add(ev.filePath);
    if (fileSet.size > budget.maxFiles) break;
    snippets.push({
      evidenceId: id,
      file: ev.filePath ?? "",
      lines: ev.startLine ? `${ev.startLine}-${ev.endLine ?? ev.startLine}` : "",
      excerpt: excerpt.slice(0, 800),
    });
    tokens = nextTokens;
    bytes = nextBytes;
  }

  const relSlice = input.relationships
    .filter((r) => r.sourceFile && fileSet.has(r.sourceFile))
    .slice(0, budget.maxRelationships);

  const graphSummary = relSlice
    .map((r) => `${r.relationship}: ${r.sourceFile}${r.targetFile ? ` → ${r.targetFile}` : ""}`)
    .join("\n");

  const hash = await packetHash([
    input.subjectIds.join(","),
    snippets.map((s) => s.evidenceId).join(","),
    graphSummary,
  ]);

  return {
    subjectIds: input.subjectIds,
    evidenceIds: snippets.map((s) => s.evidenceId),
    snippets,
    relationships: relSlice,
    graphSummary,
    tokenEstimate: tokens + estimateTokens(graphSummary),
    packetHash: hash,
  };
}
