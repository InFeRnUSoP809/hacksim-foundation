import type { ValidatedFinding } from "../../evidence.ts";

/** Stable identity for finding reconciliation across partial retries. */
export function findingStableKey(finding: {
  finding_type: string;
  title: string;
}): string {
  const title = finding.title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  return `${finding.finding_type}|${title}`;
}

/**
 * Merge findings for partial verification retries.
 * Incoming findings replace existing entries with the same stable key; others are preserved.
 */
export function mergeFindings(
  existing: ValidatedFinding[],
  incoming: ValidatedFinding[],
): ValidatedFinding[] {
  const byKey = new Map<string, ValidatedFinding>();
  for (const item of existing) {
    byKey.set(findingStableKey(item), item);
  }
  for (const item of incoming) {
    byKey.set(findingStableKey(item), item);
  }
  return [...byKey.values()].slice(0, 32);
}
