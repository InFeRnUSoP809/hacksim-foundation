import { StudentLayout } from "@/layouts/StudentLayout";
import { ErrorState, LoadingState } from "@/components/States";
import {
  CoverageMatrix,
  DefenseTargetList,
  EvidenceList,
  FindingsList,
  NoticeState,
  ProjectMapSummary,
  RequirementStatusPill,
} from "@/components/analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import {
  analyzeRepository,
  getSubmissionAnalysis,
  isApiConfigured,
  runReview,
} from "@/lib/api";
import { friendlyError } from "@/services/errors";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { CoverageRow, Evidence, RequirementItem } from "@/types/analysis";

/** The two steps of the automatic pipeline, in the order they run. */
type Stage = "scan" | "review";

const STAGE_COPY: Record<Stage, { title: string; body: string }> = {
  scan: {
    title: "Reading your repository",
    body: "Cloning the repository from GitHub, indexing its files and mapping them onto the brief. This is the same pipeline the admin playground runs — nothing here is a preview.",
  },
  review: {
    title: "Writing the review",
    body: "The repository is mapped. An AI reviewer is now comparing what you built against the challenge and writing what you should be ready to explain.",
  },
};

/** A repository is usable once the scan has produced something to read. */
function isScanned(status: string | undefined): boolean {
  return status === "completed" || status === "stale";
}

/** A review is usable once it has produced a verdict, even a partial one. */
function isReviewed(status: string | undefined): boolean {
  return status === "completed" || status === "partial";
}

/**
 * §84 — the student project review.
 *
 * Deliberately absent (§84): AI tokens, AI cost, internal prompts, admin
 * configuration, and anything about another team. The RPC enforces this on the
 * server too — this component simply never asks for it.
 *
 * §86 — no overall score. Evidence, strengths, findings, coverage and areas to
 * clarify, and nothing else.
 */
export default function ProjectReview() {
  const { id = "" } = useParams<{ id: string }>();

  const analysis = useAsync(() => getSubmissionAnalysis(id), [id]);

  if (analysis.isLoading) {
    return (
      <StudentLayout>
        <LoadingState label="Loading your review" />
      </StudentLayout>
    );
  }

  if (analysis.error || !analysis.data) {
    return (
      <StudentLayout>
        <ErrorState
          title="Couldn't load your review"
          message={analysis.error ?? "Not found."}
        />
      </StudentLayout>
    );
  }

  const data = analysis.data;
  const review = data.review;
  const evidence: Evidence[] = data.evidence ?? [];
  const projectMap = data.project_map;
  const brief = data.hackathon as Record<string, string>;

  const coverage: CoverageRow[] = (
    (data.requirement_map?.requirements ?? []) as RequirementItem[]
  ).map((requirement) => ({
    requirement,
    evaluation:
      data.requirements.find((row) => row.requirement_id === requirement.id) ??
      null,
  }));

  const strengths = data.findings.filter((f) => f.finding_type === "strength");
  const improvements = data.findings.filter(
    (f) => f.finding_type !== "strength" && f.finding_type !== "observation",
  );

  return (
    <StudentLayout>
      <div className="flex flex-col gap-2">
        <p className="label-mono text-brand">Review</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">
          Your project review
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          How what you built compares to the challenge you were given, and what
          you should be ready to explain.
        </p>
      </div>

      {!data.repository && (
        <Card className="mt-8 border-dashed p-6">
          <p className="text-sm font-semibold">No analysis yet</p>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Once your repository has been analysed, this page will show how your
            code relates to the brief.
            {!isApiConfigured &&
              " The analysis edge function has not been configured on this deployment yet."}
          </p>
        </Card>
      )}

      {data.repository && data.repository.analysis_status === "failed" && (
        <Card className="mt-8 border-destructive/40 p-6">
          <p className="text-sm font-semibold">Repository analysis failed</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {data.repository.error_message ??
              "The repository could not be read from GitHub."}
          </p>
        </Card>
      )}

      {/* ── The challenge, shown before any conclusion ────────── */}
      <Block title="The challenge you were given">
        <Card className="p-5">
          <p className="label-mono text-[10px] text-muted-foreground">
            Problem statement
          </p>
          <p className="mt-1.5 max-w-3xl whitespace-pre-line text-sm leading-relaxed">
            {brief.problem_statement || "Not provided."}
          </p>
          {brief.requirements && (
            <>
              <p className="label-mono mt-5 text-[10px] text-muted-foreground">
                Requirements
              </p>
              <p className="mt-1.5 max-w-3xl whitespace-pre-line text-sm leading-relaxed">
                {brief.requirements}
              </p>
            </>
          )}
        </Card>
      </Block>

      {review?.summary && (
        <Card className="mt-8 p-6">
          <p className="text-base leading-relaxed">{review.summary.headline}</p>
        </Card>
      )}

      {/* ── Problem alignment ─────────────────────────────────── */}
      <Block
        title="Problem alignment"
        icon={review?.problem_alignment ? CheckCircle2 : Clock}
      >
        {review?.problem_alignment ? (
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="label-mono">
                {review.problem_alignment.status.replace(/_/g, " ")}
              </Badge>
              <span className="text-xs text-muted-foreground">
                confidence {review.problem_alignment.confidence}
              </span>
            </div>
            <p className="mt-2.5 max-w-3xl text-sm leading-relaxed">
              {review.problem_alignment.explanation}
            </p>
            <EvidenceList
              ids={review.problem_alignment.evidence_ids}
              evidence={evidence}
              className="mt-3"
            />
          </Card>
        ) : (
          <NoticeState
            title="Not reviewed yet"
            message="Your team's review has not been run."
          />
        )}
      </Block>

      {/* ── Requirement coverage ──────────────────────────────── */}
      <Block title="Requirement coverage">
        <CoverageMatrix rows={coverage} evidence={evidence} />
      </Block>

      {/* ── Strengths ─────────────────────────────────────────── */}
      <Block title="Strengths" icon={CheckCircle2}>
        <FindingsList
          findings={strengths}
          evidence={evidence}
          emptyMessage="No strengths were recorded with repository evidence."
        />
      </Block>

      {/* ── Potential improvements ─────────────────────────────── */}
      <Block title="Potential improvements" icon={AlertTriangle}>
        <FindingsList
          findings={improvements}
          evidence={evidence}
          emptyMessage="No issues were evidenced in your repository."
        />
      </Block>

      {/* ── Technical architecture ────────────────────────────── */}
      <Block title="Technical architecture">
        <ProjectMapSummary map={projectMap} />
      </Block>

      {/* ── Security, database, testing ───────────────────────── */}
      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <SmallBlock
          title="Security"
          value={
            projectMap?.security.hardcoded_secrets.length
              ? `${projectMap.security.hardcoded_secrets.length} hard-coded secret(s) found`
              : "No hard-coded secrets detected"
          }
          tone={
            projectMap?.security.hardcoded_secrets.length ? "warning" : "ok"
          }
        />
        <SmallBlock
          title="Database"
          value={
            projectMap?.database.technologies.length
              ? projectMap.database.technologies.join(", ")
              : "No database detected"
          }
        />
        <SmallBlock
          title="Testing"
          value={
            projectMap
              ? `${projectMap.testing.test_file_count} test file(s) detected`
              : "—"
          }
          tone={
            projectMap && projectMap.testing.test_file_count === 0
              ? "warning"
              : "ok"
          }
        />
      </div>

      {/* ── Contribution evidence ─────────────────────────────── */}
      <Block title="Your contribution">
        <ContributionSection analysis={data} evidence={evidence} />
      </Block>

      {/* ── Defence preparation ───────────────────────────────── */}
      <Block title="What to be ready to defend">
        <p className="mb-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          These are topics from your own submission, not questions. Preparing
          them is the point.
        </p>
        <DefenseTargetList targets={data.defense_targets} />
      </Block>

      <Card className="mt-8 flex items-start gap-3 border-dashed p-5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-relaxed text-muted-foreground">
          &ldquo;Not evidenced&rdquo; means the analysed repository did not give
          us enough to decide. It is not a claim that the feature is missing —
          it may simply be somewhere the scanner could not see.
        </p>
      </Card>

      <p className="mt-6">
        <Link
          to="/dashboard"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          Back to dashboard
        </Link>
      </p>
    </StudentLayout>
  );
}

function Block({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="flex items-center gap-2.5 border-b border-border pb-3">
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SmallBlock({
  title,
  value,
  tone,
}: {
  title: string;
  value: string;
  tone?: "ok" | "warning";
}) {
  return (
    <Card className="p-5">
      <p className="label-mono text-[10px] text-muted-foreground">{title}</p>
      <p
        className={cn(
          "mt-1.5 text-sm font-medium leading-relaxed",
          tone === "warning" && "text-stage-submit",
        )}
      >
        {value}
      </p>
    </Card>
  );
}

function ContributionSection({
  analysis,
  evidence,
}: {
  analysis: Awaited<ReturnType<typeof getSubmissionAnalysis>>;
  evidence: Evidence[];
}) {
  const contributions = (analysis.review?.contributions ?? {}) as Record<
    string,
    {
      status: string;
      confidence: string;
      evidence_ids: string[];
      matched_files: string[];
      explanation: string;
    }
  >;

  const members = analysis.contributions as {
    id: string;
    user_id: string;
    full_name?: string | null;
    email?: string | null;
    contribution_description: string;
    contribution_areas: string[];
  }[];

  if (members.length === 0) {
    return (
      <NoticeState
        title="No contributions recorded"
        message="Nobody on the team added a contribution description."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {members.map((member) => {
        const check = contributions[member.user_id];
        return (
          <Card key={member.id} className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">
                {member.full_name || member.email || "Team member"}
              </p>
              {check ? (
                <Badge variant="outline" className="label-mono text-[10px]">
                  {check.status.replace(/_/g, " ")}
                </Badge>
              ) : (
                <RequirementStatusPill status="unable_to_determine" />
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {member.contribution_description || "No description provided."}
            </p>
            {member.contribution_areas?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {member.contribution_areas.map((area) => (
                  <Badge key={area} variant="outline" className="text-[10px]">
                    {area}
                  </Badge>
                ))}
              </div>
            )}
            {check?.explanation && (
              <p className="mt-2.5 text-sm leading-relaxed">
                {check.explanation}
              </p>
            )}
            {check && (
              <EvidenceList
                ids={check.evidence_ids}
                evidence={evidence}
                className="mt-3"
              />
            )}
          </Card>
        );
      })}
    </div>
  );
}
