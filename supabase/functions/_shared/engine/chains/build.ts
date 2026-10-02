/**
 * Evidence chains link scanner-produced evidence into ordered sequences.
 * Chains are created only when file/symbol adjacency in a flow supports them.
 */

import type { Flow } from "../graph/build.ts";
import type { ImplementationBehavior } from "../behavior/extract.ts";

export interface EvidenceChainLink {
  evidence_id: string;
  claim: string;
  file: string | null;
  symbol: string | null;
  level: string;
}

export interface EvidenceChain {
  id: string;
  flow_id: string | null;
  label: string;
  closed: boolean;
  links: EvidenceChainLink[];
}

interface ChainEvidence {
  id: string;
  type: string;
  claim: string;
  file?: string | null;
  symbol?: string | null;
  lines?: string;
  detail?: Record<string, unknown>;
}

function levelFor(item: ChainEvidence): string {
  const fromDetail = item.detail?.level;
  if (typeof fromDetail === "string") return fromDetail;
  if (item.type === "dependency" || item.type === "framework") return "L0";
  if (item.type === "route" || item.type === "file") return "L1";
  if (item.type === "api_call" || item.type === "data_access") return "L2";
  if (item.type === "transformation" || item.type === "parsing" || item.type === "rule") {
    return "L3";
  }
  return "L2";
}

export function buildEvidenceChains(input: {
  evidence: ChainEvidence[];
  flows: Flow[];
  behaviors: ImplementationBehavior[];
}): EvidenceChain[] {
  const byFile = new Map<string, ChainEvidence[]>();
  for (const item of input.evidence) {
    if (!item.file) continue;
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const chains: EvidenceChain[] = [];
  let chainNum = 1;

  for (const flow of input.flows.slice(0, 16)) {
    const links: EvidenceChainLink[] = [];
    const seenIds = new Set<string>();

    for (const file of flow.files) {
      const items = (byFile.get(file) ?? [])
        .filter((item) =>
          ["data_flow", "route", "api_call", "parsing", "transformation", "prompt", "data_access", "calculation", "rule"]
            .includes(item.type),
        )
        .slice(0, 8);
      for (const item of items) {
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        links.push({
          evidence_id: item.id,
          claim: item.claim,
          file: item.file ?? null,
          symbol: item.symbol ?? null,
          level: levelFor(item),
        });
      }
    }

    for (const behavior of input.behaviors.filter((b) => flow.files.includes(b.file)).slice(0, 8)) {
      const syntheticId = behavior.id;
      if (seenIds.has(syntheticId)) continue;
      seenIds.add(syntheticId);
      links.push({
        evidence_id: syntheticId,
        claim: behavior.claim,
        file: behavior.file,
        symbol: behavior.symbol,
        level: behavior.level,
      });
    }

    if (links.length < 2) continue;
    chains.push({
      id: `CHAIN-${String(chainNum).padStart(3, "0")}`,
      flow_id: flow.id,
      label: flow.hops.map((hop) => hop.symbol ?? hop.file).join(" → "),
      closed: flow.closed,
      links,
    });
    chainNum += 1;
  }

  return chains.slice(0, 24);
}
