/**
 * Shared presentation for Phase 5 + Phase 6 results.
 *
 * These components are used by both the admin analysis page and the student
 * review page, so the two surfaces can never drift into telling a team
 * different things about the same evidence.
 *
 * Two rules are enforced here rather than in each page:
 *   * nothing renders an AI conclusion without the evidence it cites, and
 *   * "not evidenced" is always explained as a limit of the analysis, never as
 *     a claim that the feature is missing.
 */

import {
  AlertTriangle,
  FileCode2,
  Info,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  AiFinding,
  AnalysisDiff,
  AnalysisRun,
  Confidence,
  DatasetProfile,
  DefenseTarget,
  Evidence,
  EvidenceRef,
  ProjectMap,
  RequirementStatus,
  Severity,
  SubmissionAnalysis,
} from "@/types/analysis";

// ── Status vocabulary ──────────────────────────────────────────────────────

/** §33 — the wording matters. "not_evidenced" is not "missing". */
const REQUIREMENT_TONE: Record<
  RequirementStatus,
  { label: string; className: string; help: string }
> = {
  evidence_found: {
    label: "Evidence found",
    className: "border-stage-report/35 bg-stage-report/10 text-stage-report",
    help: "The repository contains code that implements this.",
  },
  partial_evidence: {
    label: "Partial evidence",
    className: "border-stage-build/35 bg-stage-build/10 text-stage-build",
    help: "Something related was found, but not the whole requirement.",
  },
  not_evidenced: {
    label: "Not evidenced",
    className: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
    help:
      "The analysed repository did not provide enough evidence to decide. " +
      "This is not a statement that the feature is absent.",
  },
  unable_to_determine: {
    label: "Unable to determine",
    className: "border-border bg-muted text-muted-foreground",
    help: "The analysis did not look deeply enough to answer this.",
  },
};

const SEVERITY_TONE: Record<Severity, string> = {
  critical: "border-destructive/40 bg-destructive/10 text-destructive",
  high: "border-destructive/30 bg-destructive/5 text-destructive",
  medium: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  low: "border-border bg-muted text-muted-foreground",
  informational: "border-border bg-muted text-muted-foreground",
};

const SEVERITY_ORDER: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

const FINDING_ICON: Record<string, typeof Info> = {
  strength: Sparkles,
  security_concern: ShieldAlert,
  potential_issue: AlertTriangle,
  confirmed_issue: AlertTriangle,
  testing_gap: AlertTriangle,
  architecture_concern: Info,
  scalability_concern: Info,
  claim_mismatch: AlertTriangle,
  clarification_needed: Info,
  observation: Info,
};

export function RequirementStatusPill({
  status,
  className,
}: {
  status: RequirementStatus;
  className?: string;
}) {
  const tone = REQUIREMENT_TONE[status] ?? REQUIREMENT_TONE.unable_to_determine;
  return (
    <span
      title={tone.help}
      className={cn(
        "label-mono inline-flex items-center rounded-full border px-2.5 py-1",
        tone.className,
        className,
      )}
    >
      {tone.label}
    </span>
  );
}

export function SeverityPill({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "label-mono inline-flex items-center rounded-full border px-2.5 py-1 uppercase",
        SEVERITY_TONE[severity] ?? SEVERITY_TONE.low,
        className,
      )}
    >
      {severity}
    </span>
  );
}

export function ConfidenceBadge({ level }: { level: Confidence }) {
  if (level === "none") return null;
  return (
    <Badge variant="outline" className="label-mono text-[10px]">
      {level} confidence
    </Badge>
  );
}

// ── Evidence ───────────────────────────────────────────────────────────────

/** Resolves evidence ids to objects so a citation always shows its source. */
export function EvidenceList({
  ids,
  evidence,
  className,
}: {
  /** Optional on purpose: a section that cited nothing stores no key at all. */
  ids?: string[] | null;
  evidence?: Evidence[] | null;
  className?: string;
}) {
  const pool = Array.isArray(evidence) ? evidence : [];
  const cited = Array.isArray(ids) ? ids : [];
  const byId = new Map(pool.map((item) => [item.id, item]));
  const found = cited.map((id) => byId.get(id)).filter(Boolean) as Evidence[];

  if (found.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        No repository evidence was cited for this.
      </p>
    );
  }

  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {found.map((item) => (
        <li
          key={item.id}
          className="rounded-md border border-border bg-card/40 px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-mono text-[10px] text-brand">{item.id}</span>
            <span className="label-mono text-[10px] text-muted-foreground">
              {item.type.replace(/_/g, " ")}
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed">{item.claim}</p>
          {item.file && (
            <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <FileCode2 className="size-3 shrink-0" />
              {item.file}
              {item.lines ? `:${item.lines}` : ""}
              {item.symbol ? ` · ${item.symbol}` : ""}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── §34 coverage matrix ────────────────────────────────────────────────────

export function CoverageMatrix({
  rows,
  evidence,
}: {
  rows: {
    requirement: {
      id: string;
      text: string;
      importance: string;
      category: string;
    };
    evaluation: {
      status: RequirementStatus;
      confidence: Confidence;
      explanation: string | null;
      evidence_ids: string[];
      source: string;
      missing_or_unclear?: string[];
      ai_used?: boolean;
    } | null;
  }[];
  evidence: Evidence[];
}) {
  if (rows.length === 0) {
    return (
      <NoticeState
        title="No requirements to check yet"
        message="The hackathon brief has not been turned into a requirement map."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="label-mono px-4 py-2.5 text-muted-foreground">
              Requirement
            </th>
            <th className="label-mono px-4 py-2.5 text-muted-foreground">
              Repository evidence
            </th>
            <th className="label-mono px-4 py-2.5 text-muted-foreground">
              Status
            </th>
            <th className="label-mono px-4 py-2.5 text-muted-foreground">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ requirement, evaluation }) => (
            <tr
              key={requirement.id}
              className="border-b border-border align-top last:border-0"
            >
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="label-mono text-[10px] text-brand">
                    {requirement.id}
                  </span>
                  {requirement.importance === "critical" && (
                    <Badge
                      variant="outline"
                      className="label-mono border-stage-submit/40 text-[10px] text-stage-submit"
                    >
                      critical
                    </Badge>
                  )}
                </div>
                <p className="mt-1 max-w-md leading-relaxed">
                  {requirement.text}
                </p>
                {evaluation?.explanation && (
                  <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
                    {evaluation.explanation}
                  </p>
                )}
                {(evaluation?.missing_or_unclear ?? []).length > 0 && (
                  <ul className="mt-2 flex max-w-md flex-col gap-1">
                    {(evaluation?.missing_or_unclear ?? []).map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-1.5 text-xs leading-relaxed text-stage-submit"
                      >
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="px-4 py-3">
                {evaluation && (evaluation.evidence_ids ?? []).length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {evaluation.evidence_ids.slice(0, 4).map((id) => {
                      const item = evidence.find((e) => e.id === id);
                      if (!item) return null;
                      return (
                        <li
                          key={id}
                          className="font-mono text-[11px] text-muted-foreground"
                        >
                          <span className="text-brand">{id}</span>{" "}
                          {item.file ?? item.claim.slice(0, 60)}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    None cited
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                {evaluation ? (
                  <div className="flex flex-col gap-1.5">
                    <RequirementStatusPill status={evaluation.status} />
                    <ConfidenceBadge level={evaluation.confidence} />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                <span
                  className="label-mono text-[10px] text-muted-foreground"
                  title={
                    evaluation?.ai_used === false
                      ? "Decided without a model, because a count or a named file settled it."
                      : "Read from the retrieved code by the model."
                  }
                >
                  {evaluation?.ai_used === false
                    ? "measured"
                    : (evaluation?.source ?? "—")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── §46 findings ───────────────────────────────────────────────────────────

export function FindingsList({
  findings,
  evidence,
  emptyMessage = "No findings were produced for this submission.",
}: {
  findings?: AiFinding[] | null;
  evidence?: Evidence[] | null;
  emptyMessage?: string;
}) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return <NoticeState title="Nothing to report" message={emptyMessage} />;
  }

  const ordered = [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  return (
    <div className="flex flex-col gap-3">
      {ordered.map((finding, index) => {
        const Icon = FINDING_ICON[finding.finding_type] ?? Info;
        return (
          <Card key={finding.id ?? `${finding.title}-${index}`} className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <SeverityPill severity={finding.severity} />
              <span className="label-mono text-[10px] text-muted-foreground">
                {finding.finding_type.replace(/_/g, " ")}
              </span>
              <ConfidenceBadge level={finding.confidence} />
            </div>
            <h4 className="mt-2.5 text-sm font-semibold">{finding.title}</h4>
            {finding.description && (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {finding.description}
              </p>
            )}
            {finding.why_it_matters && (
              <p className="mt-2.5 text-sm leading-relaxed">
                <span className="font-medium">Why it matters: </span>
                {finding.why_it_matters}
              </p>
            )}
            {finding.suggested_improvement && (
              <p className="mt-1.5 text-sm leading-relaxed">
                <span className="font-medium">Suggested: </span>
                {finding.suggested_improvement}
              </p>
            )}
            {finding.files?.length > 0 && (
              <p className="mt-2.5 font-mono text-[11px] text-muted-foreground">
                {finding.files.slice(0, 6).join(" · ")}
              </p>
            )}
            <EvidenceList
              ids={finding.evidence_ids}
              evidence={evidence}
              className="mt-3"
            />
          </Card>
        );
      })}
    </div>
  );
}

// ── §50 defence targets ────────────────────────────────────────────────────

export function DefenseTargetList({
  targets,
  className,
}: {
  targets?: DefenseTarget[] | null;
  className?: string;
}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return (
      <NoticeState
        title="Nothing flagged for defence"
        message="No requirement, contribution or security area needs extra preparation yet."
      />
    );
  }

  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {targets.map((target) => (
        <li key={target.id} className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "label-mono text-[10px]",
                target.priority === "P0" || target.priority === "P1"
                  ? "border-destructive/40 text-destructive"
                  : "border-border text-muted-foreground",
              )}
            >
              {target.priority}
            </Badge>
            {target.question_area && (
              <span className="label-mono text-[10px] text-muted-foreground">
                {target.question_area.replace(/_/g, " ")}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm font-medium leading-relaxed">
            {target.topic}
          </p>
          {target.reason && (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {target.reason}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── The structured assessment (§50) ────────────────────────────────────────

/**
 * The assessment. Every field is a sentence about evidence, and the three lists
 * — strengths, gaps, uncertainties — are the point: an honest analysis says what
 * it could not establish, and this component refuses to hide that behind a
 * summary line. There is no score and no verdict, by design.
 */
export function AssessmentCard({
  assessment,
  evidence,
  strengths,
  gaps,
  uncertainties,
}: {
  assessment: {
    headline: string;
    understanding: string;
    problem_relevance: string;
    solution_coherence: string;
    implementation_evidence: string;
    functional_completeness: string;
    technical_quality: string;
    claim_accuracy: string;
    hackathon_alignment: string;
    evidence_ids?: string[];
  } | null;
  evidence: Evidence[];
  strengths?: string[];
  gaps?: string[];
  uncertainties?: string[];
}) {
  if (!assessment) {
    return (
      <NoticeState
        title="No assessment yet"
        message="The analysis has not been run for this submission."
      />
    );
  }

  const dimensions: [string, string][] = [
    ["What this project is", assessment.understanding],
    ["Relation to the problem", assessment.problem_relevance],
    ["Does it form a working chain", assessment.solution_coherence],
    ["Implementation evidence", assessment.implementation_evidence],
    ["What is complete", assessment.functional_completeness],
    ["Technical quality", assessment.technical_quality],
    ["Description vs implementation", assessment.claim_accuracy],
    ["This hackathon's expectations", assessment.hackathon_alignment],
  ];

  return (
    <div className="flex flex-col gap-5">
      <p className="text-base leading-relaxed">{assessment.headline}</p>

      <dl className="grid gap-4 sm:grid-cols-2">
        {dimensions
          .filter(([, body]) => Boolean(body?.trim()))
          .map(([label, body]) => (
            <div key={label}>
              <dt className="label-mono text-[10px] text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-1 text-sm leading-relaxed">{body}</dd>
            </div>
          ))}
      </dl>

      <div className="grid gap-4 sm:grid-cols-3">
        <ListBlock
          title="What works"
          items={strengths ?? []}
          empty="Nothing was singled out as a strength."
          tone="text-stage-report"
        />
        <ListBlock
          title="What is missing or partial"
          items={gaps ?? []}
          empty="Nothing was recorded as missing."
          tone="text-stage-submit"
        />
        <ListBlock
          title="What could not be determined"
          items={uncertainties ?? []}
          empty="Nothing was left uncertain."
          tone="text-muted-foreground"
        />
      </div>

      <EvidenceList
        ids={assessment.evidence_ids ?? []}
        evidence={evidence}
        className="border-t border-border pt-4"
      />
    </div>
  );
}

function ListBlock({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: string[];
  empty: string;
  tone: string;
}) {
  return (
    <div>
      <p className="label-mono text-[10px] text-muted-foreground">{title}</p>
      {items.length === 0 ? (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item} className={cn("text-xs leading-relaxed", tone)}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Which characteristics were looked at, and why. The rows marked "not looked
 * at" are the important ones: they are how a reader learns that a missing
 * database was a decision, not an oversight.
 */
export function DimensionList({
  dimensions,
}: {
  dimensions: { key: string; label: string; relevance: string; reason: string }[];
}) {
  const relevant = dimensions.filter((item) => item.relevance !== "not_applicable");
  const skipped = dimensions.filter((item) => item.relevance === "not_applicable");

  return (
    <div className="flex flex-col gap-4">
      {relevant.length > 0 && (
        <ul className="flex flex-col gap-2">
          {relevant.map((item) => (
            <li key={item.key} className="flex flex-wrap items-baseline gap-2">
              <Badge
                variant="outline"
                className="label-mono text-[10px]"
              >
                {item.relevance === "required" ? "asked for" : "looked at"}
              </Badge>
              <span className="text-sm">{item.label}</span>
              <span className="w-full text-xs leading-relaxed text-muted-foreground sm:w-auto">
                {item.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <div>
          <p className="label-mono text-[10px] text-muted-foreground">
            Not looked at, and why
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {skipped.map((item) => (
              <li
                key={item.key}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                <span className="text-foreground">{item.label}</span> — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** §36 — the datasets the scan profiled, described rather than dumped. */
export function DatasetList({ datasets }: { datasets: DatasetProfile[] }) {
  if (!datasets?.length) {
    return (
      <NoticeState
        title="No datasets in this repository"
        message="Nothing in the repository looked like a data file. That is only a problem if the challenge needed one."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {datasets.map((dataset) => (
        <li key={dataset.path} className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <FileCode2 className="size-3.5 shrink-0 text-brand" />
            <span className="font-mono text-xs">{dataset.path}</span>
            <span className="label-mono text-[10px] text-muted-foreground">
              {dataset.format} · ~
              {dataset.approx_row_count.toLocaleString()} rows
              {dataset.row_count_exact ? "" : " (estimated)"} ·{" "}
              {Math.round(dataset.size_bytes / 1024)} KB
            </span>
            {dataset.relevance === "high" && (
              <Badge variant="outline" className="label-mono text-[10px]">
                matches the brief
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {dataset.likely_purpose}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {dataset.column_names.slice(0, 12).map((column) => (
              <Badge key={column} variant="outline" className="text-[10px]">
                {column}
              </Badge>
            ))}
          </div>
          {(dataset.notes ?? []).length > 0 && (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {(dataset.notes ?? []).join(" ")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Project map ────────────────────────────────────────────────────────────

export function ProjectMapSummary({ map }: { map: ProjectMap | null }) {
  if (!map) {
    return (
      <NoticeState
        title="No project map yet"
        message="Run repository analysis to build one. It costs no AI tokens."
      />
    );
  }

  const stats = map.repository_stats;
  const truncatedCount = Object.values(map.truncated ?? {}).reduce(
    (total, value) => total + (value || 0),
    0,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="Files analysed" value={stats.file_count} />
        <MiniStat label="Lines" value={stats.line_count.toLocaleString()} />
        <MiniStat label="Endpoints" value={map.backend.endpoint_count} />
        <MiniStat label="Test files" value={map.testing.test_file_count} />
      </div>

      {map.analysis_mode === "limited" && (
        <NoticeState
          title="Large repository detected"
          message="Analysis was limited to relevant files."
        />
      )}

      {(map.warnings ?? []).length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {(map.warnings ?? []).map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
            >
              <Info className="mt-0.5 size-3 shrink-0" />
              {warning}
            </li>
          ))}
        </ul>
      )}

      {truncatedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {truncatedCount} further items exist and were not listed here. This
          summary is deliberately capped to keep the AI prompt small.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <MapList title="Frameworks" items={map.stack.frameworks} />
        <MapList title="Authentication" items={map.authentication.detected} />
        <MapList title="Database" items={map.database.technologies} />
        <MapList
          title="Primary language"
          items={map.stack.primary_language ? [map.stack.primary_language] : []}
        />
      </div>

      {(map.apis ?? []).length > 0 && (
        <div>
          <p className="label-mono text-muted-foreground">Endpoints</p>
          <ul className="mt-2 flex flex-col gap-1">
            {(map.apis ?? []).slice(0, 12).map((route) => (
              <li
                key={`${route.method}-${route.path}-${route.file}`}
                className="font-mono text-[11px]"
              >
                <span className="text-brand">{route.method}</span>{" "}
                <span>{route.path}</span>{" "}
                <span className="text-muted-foreground">
                  {route.file}:{route.line}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MapList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="label-mono text-muted-foreground">{title}</p>
      {items.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">Not detected</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Badge key={item} variant="outline" className="text-[11px]">
              {item}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className="label-mono text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

// ── Local NoticeState, so this file has no import cycle with States ────────

export function NoticeState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

// ── Re-analysis (§45) ──────────────────────────────────────────────────────

/** "evidence_found" → "evidence found". The vocabulary is stored snake_case. */
function words(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * What a re-analysis changed, in the order a reader cares: conclusions first,
 * then the evidence behind them.
 *
 * Shown only when there is something to say. A re-analysis that found the same
 * thing produces no diff at all, so there is no "0 changes" panel to explain
 * away.
 */
export function ChangeList({
  diff,
  evidence,
}: {
  diff: AnalysisDiff;
  evidence: Evidence[];
}) {
  const changes = diff.changed.length + diff.added.length + diff.removed.length;
  const evidenceChanges =
    diff.evidence_added.length + diff.evidence_removed.length;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {diff.previous_commit && diff.commit && (
          <span className="font-mono">
            {diff.previous_commit.slice(0, 7)} → {diff.commit.slice(0, 7)}
          </span>
        )}
        {diff.previous_run_at && (
          <span>· compared with the run of {formatRunDate(diff.previous_run_at)}</span>
        )}
      </div>

      {changes > 0 && (
        <div className="mt-4">
          <p className="label-mono text-[10px] text-muted-foreground">
            What changed
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {diff.changed.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="label-mono text-[10px] text-brand">{row.id}</span>
                <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                  {words(row.from)}
                </span>
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <span className="font-medium">{words(row.to)}</span>
              </li>
            ))}
            {diff.added.map((id) => (
              <li key={id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="label-mono text-[10px] text-brand">{id}</span>
                <span className="font-medium">now checked</span>
              </li>
            ))}
            {diff.removed.map((id) => (
              <li key={id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="label-mono text-[10px] text-muted-foreground">
                  {id}
                </span>
                <span className="text-muted-foreground">no longer part of the brief</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {evidenceChanges > 0 && (
        <div className="mt-4">
          <p className="label-mono text-[10px] text-muted-foreground">
            The evidence behind them
          </p>
          <EvidenceDelta label="Newly found" items={diff.evidence_added} evidence={evidence} />
          <EvidenceDelta
            label="No longer found"
            items={diff.evidence_removed}
            evidence={evidence}
          />
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Only the evidence the conclusions rest on is listed here. Code that was
        scanned but never cited is not something you were shown, so its arrival
        is not reported as a change.
      </p>
    </Card>
  );
}

function EvidenceDelta({
  label,
  items,
  evidence,
}: {
  label: string;
  items: EvidenceRef[];
  evidence: Evidence[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium">{label}</p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {items.slice(0, 12).map((item) => {
          // Removed evidence is not in the current set, so its stored claim is
          // the only description of it that still exists.
          const current = evidence.find((entry) => entry.id === item.id);
          return (
            <li key={item.id} className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-mono text-[10px] text-brand">{item.id}</span>{" "}
              {current?.claim ?? item.claim}
              {item.file && (
                <span className="font-mono text-[10px]"> — {item.file}</span>
              )}
            </li>
          );
        })}
        {items.length > 12 && (
          <li className="text-xs text-muted-foreground">
            and {items.length - 12} more
          </li>
        )}
      </ul>
    </div>
  );
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

// ── AI usage (admin only) ─────────────────────────────────────────────────

/**
 * What this submission has cost so far, and what each run cost.
 *
 * Admin-only on purpose: §84 — a student never sees token counts or cost. The
 * RPC sends this key to admins only, so a null here means the viewer is not an
 * admin rather than a rendering bug.
 */
export function AiUsagePanel({
  usage,
  runs,
}: {
  usage: NonNullable<SubmissionAnalysis["ai_usage"]> | null;
  runs: AnalysisRun[];
}) {
  if (!usage) {
    return (
      <NoticeState
        title="No AI usage recorded"
        message="No model has been called for this submission. The repository analysis alone costs no tokens."
      />
    );
  }

  const cost = Number(usage.cost_usd);
  const operations = Object.entries(usage.operations ?? {}).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="Requests" value={usage.requests} />
        <MiniStat label="Input tokens" value={usage.input_tokens.toLocaleString()} />
        <MiniStat label="Output tokens" value={usage.output_tokens.toLocaleString()} />
        <MiniStat label="Cost" value={`$${cost.toFixed(4)}`} />
      </div>

      {operations.length > 0 && (
        <div>
          <p className="label-mono text-[10px] text-muted-foreground">
            Calls by task
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {operations.map(([operation, count]) => (
              <Badge key={operation} variant="outline" className="text-[11px]">
                {operation} · {count}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label-mono px-3 py-2 text-muted-foreground">Run</th>
                <th className="label-mono px-3 py-2 text-muted-foreground">Commit</th>
                <th className="label-mono px-3 py-2 text-muted-foreground">Evidence</th>
                <th className="label-mono px-3 py-2 text-muted-foreground">Tokens</th>
                <th className="label-mono px-3 py-2 text-muted-foreground">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-border align-top last:border-0"
                >
                  <td className="px-3 py-2.5">
                    <p>{formatRunDate(run.created_at)}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {run.analysis_version ?? "—"}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[10px]">
                    {run.commit_sha ? run.commit_sha.slice(0, 8) : "—"}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
                    {run.evidence_count}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
                    {(run.input_tokens + run.output_tokens).toLocaleString()}
                    {run.cached_tokens > 0 && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        ({run.cached_tokens.toLocaleString()} cached)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
                    ${Number(run.estimated_cost_usd).toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
