import { analyseSemantics } from "../semantics.ts";
import { extractSymbols } from "../github.ts";
import type { V2EvidenceItem, V2FileRecord, V2Relationship } from "./types.ts";
import { snippetHash } from "./hash.ts";

let evidenceCounter = 0;

function nextId(): string {
  evidenceCounter += 1;
  return `EV-${String(evidenceCounter).padStart(3, "0")}`;
}

export function resetEvidenceCounter(): void {
  evidenceCounter = 0;
}

const WEAK_ONLY = new Set([
  "dependency_installed",
  "framework_detected",
  "readme_claim",
  "filename_signal",
  "route_exists_only",
]);

export async function compileEvidence(
  files: V2FileRecord[],
  relationships: V2Relationship[],
): Promise<V2EvidenceItem[]> {
  const items: V2EvidenceItem[] = [];

  for (const file of files) {
    if (file.ignored || !file.content) continue;
    const { symbols: fileSymbols } = extractSymbols(file.path, file.content);
    const symbolLines = fileSymbols.map((s) => ({
      name: s.name,
      symbol_type: s.symbol_type,
      line: s.line,
    }));
    const semantics = analyseSemantics(file.path, file.content, symbolLines);
    const groups = [
      ...semantics.calculations,
      ...semantics.rules,
      ...semantics.models,
      ...semantics.dataAccess,
      ...semantics.ui,
    ] as { claim: string; symbol: string | null; line: number; lines: string; excerpt: string }[];

    for (const finding of groups) {
      items.push({
        evidenceId: nextId(),
        level: "implementation",
        evidenceType: "behavior",
        claim: finding.claim,
        filePath: file.path,
        symbolName: finding.symbol,
        startLine: finding.line,
        endLine: Number(finding.lines.split("-").pop()) || finding.line,
        snippetHash: await snippetHash(finding.excerpt),
        snippetExcerpt: finding.excerpt.slice(0, 500),
        confidence: "high",
      });
    }
  }

  for (const rel of relationships) {
    if (rel.relationship === "routes_to") {
      const path = String(rel.detail?.path ?? "");
      items.push({
        evidenceId: nextId(),
        level: "structural",
        evidenceType: "route",
        claim: `HTTP route declared: ${rel.detail?.method ?? "?"} ${path}`,
        filePath: rel.sourceFile,
        symbolName: rel.detail?.handler as string | null ?? null,
        startLine: rel.sourceLines ? Number(rel.sourceLines) : null,
        endLine: null,
        snippetHash: null,
        snippetExcerpt: null,
        confidence: rel.confidence,
        detail: { ...rel.detail, not_implementation_proof: true },
      });
    } else if (
      ["calls_api", "calls_ai_provider", "loads_prompt", "parses_response", "persists_result",
        "reads_database", "calls"].includes(rel.relationship)
    ) {
      items.push({
        evidenceId: nextId(),
        level: rel.relationship === "calls" ? "relationship" : "relationship",
        evidenceType: rel.relationship,
        claim: `${rel.relationship} in ${rel.sourceFile}`,
        filePath: rel.sourceFile,
        symbolName: null,
        startLine: rel.sourceLines ? Number(rel.sourceLines) : null,
        endLine: null,
        snippetHash: null,
        snippetExcerpt: null,
        confidence: rel.confidence,
        detail: rel.detail,
      });
    }
  }

  // Metadata context (never sufficient alone for confirmation)
  for (const file of files.filter((f) => f.category === "dependency" && !f.ignored)) {
    items.push({
      evidenceId: nextId(),
      level: "metadata",
      evidenceType: "dependency_manifest",
      claim: `Dependency manifest present: ${file.path}`,
      filePath: file.path,
      symbolName: null,
      startLine: null,
      endLine: null,
      snippetHash: null,
      snippetExcerpt: null,
      confidence: "low",
      detail: { weak_signal: true, type: WEAK_ONLY.has("dependency_installed") ? "dependency_installed" : "context" },
    });
  }

  return items;
}

export function evidenceById(items: V2EvidenceItem[]): Map<string, V2EvidenceItem> {
  return new Map(items.map((e) => [e.evidenceId, e]));
}

export function implementationEvidence(items: V2EvidenceItem[]): V2EvidenceItem[] {
  return items.filter((e) =>
    e.level === "implementation" || e.level === "relationship" || e.level === "workflow"
  );
}
