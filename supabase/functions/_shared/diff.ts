/**
 * §45 — what changed between two analysis runs.
 *
 * A diff is only honest if it compares two *runs*, so the previous side comes
 * from a stored snapshot rather than the live tables: those are overwritten by
 * the current run before anything can be compared against them.
 *
 * The evidence side is scoped to the evidence the conclusions actually cite. A
 * file that was merely scanned is not something a reader was told about, so its
 * arrival is not news; a citation that appears or disappears is.
 *
 * Returns `null` for a first run and for a run that changed nothing, so a
 * re-analysis that found the same thing stays quiet instead of inventing a
 * change.
 */

export interface EvidenceRef {
  id: string;
  claim: string;
  file?: string | null;
}

export interface DiffableConclusion {
  subject_id: string;
  kind?: string;
  status: string;
  evidence_ids?: string[];
}

export interface StoredRun {
  commit_sha?: string | null;
  created_at?: string | null;
  conclusions?: DiffableConclusion[] | null;
  evidence_index?: EvidenceRef[] | null;
}

export interface AnalysisDiff {
  previous_commit: string | null;
  commit: string | null;
  previous_run_at: string | null;
  /** A subject whose status moved, e.g. not_evidenced → partial_evidence. */
  changed: { id: string; kind: string; from: string; to: string }[];
  /** Subjects this run judged that the previous run did not have. */
  added: string[];
  /** Subjects the previous run judged that this run no longer has. */
  removed: string[];
  evidence_added: EvidenceRef[];
  evidence_removed: EvidenceRef[];
}

/** The evidence the conclusions rest on — what a reader was actually told. */
export function citedEvidence(
  conclusions: DiffableConclusion[],
  known: Iterable<EvidenceRef>,
): EvidenceRef[] {
  const cited = new Set<string>();
  for (const row of conclusions) {
    for (const id of row.evidence_ids ?? []) cited.add(id);
  }
  const out: EvidenceRef[] = [];
  for (const item of known) {
    if (cited.has(item.id)) {
      out.push({ id: item.id, claim: item.claim, file: item.file ?? null });
    }
  }
  return out;
}

export function diffRuns(
  previous: StoredRun | null,
  current: {
    commit_sha: string | null;
    conclusions: DiffableConclusion[];
    evidence: EvidenceRef[];
  },
): AnalysisDiff | null {
  if (!previous) return null;

  const before = new Map(
    (previous.conclusions ?? []).map((row) => [row.subject_id, row]),
  );
  const after = new Map(
    current.conclusions.map((row) => [row.subject_id, row]),
  );

  const changed: AnalysisDiff["changed"] = [];
  const added: string[] = [];
  for (const [id, row] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push(id);
      continue;
    }
    if (prior.status !== row.status) {
      changed.push({
        id,
        kind: row.kind ?? prior.kind ?? "requirement",
        from: prior.status,
        to: row.status,
      });
    }
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));

  const beforeEvidence = new Map(
    (previous.evidence_index ?? []).map((item) => [item.id, item]),
  );
  const afterEvidence = new Map(current.evidence.map((item) => [item.id, item]));
  const evidence_added = current.evidence.filter(
    (item) => !beforeEvidence.has(item.id),
  );
  const evidence_removed = (previous.evidence_index ?? []).filter(
    (item) => !afterEvidence.has(item.id),
  );

  if (
    !changed.length &&
    !added.length &&
    !removed.length &&
    !evidence_added.length &&
    !evidence_removed.length
  ) {
    return null;
  }

  return {
    previous_commit: previous.commit_sha ?? null,
    commit: current.commit_sha,
    previous_run_at: previous.created_at ?? null,
    changed,
    added,
    removed,
    evidence_added,
    evidence_removed,
  };
}
