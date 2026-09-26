import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import {
  CoverageMatrix,
  DefenseTargetList,
  EvidenceList,
  FindingsList,
  NoticeState,
  ProjectMapSummary,
} from "@/components/analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useAsync } from "@/hooks/use-async";
import {
  analyzeRepository,
  getSubmissionAnalysis,
  isApiConfigured,
  runReview,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Brain,
  CircleDollarSign,
  GitBranch,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import type { CoverageRow, Evidence, RequirementItem } from "@/types/analysis";

/**
 * §80 — the central analysis page.
 *
 * The section order is deliberate and matches the spec exactly: the original
 * challenge comes first, the AI's conclusions come last. An admin should never
 * read an AI verdict before reading the brief it was judged against (§81).
 */
export default function AdminSubmissionAnalysis() {
  const { id = "" } = useParams<{ id: string }>();
  const confirm = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const analysis = useAsync(() => getSubmissionAnalysis(id), [id]);

  async function run(step: "repository" | "review") {
    setBusy(step);
    setActionError(null);
    try {
      if (step === "repository") {
        await analyzeRepository(id);
      } else {
        await runReview(id);
      }
      analysis.reload();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The action failed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function runWithConfirmation(step: "repository" | "review") {
    const confirmed = await confirm.ask({
      title:
        step === "repository" ? "Re-analyse repository?" : "Run AI review?",
      message:
        step === "repository"
          ? "This re-reads the repository from GitHub. The same commit is not scanned twice."
          : "This spends AI tokens for this submission, within the budget already set.",
      confirmLabel: step === "repository" ? "Re-analyse" : "Run review",
      tone: "warning",
    });
    if (confirmed) await run(step);
  }

  if (analysis.isLoading) {
    return (
      <AdminLayout>
        <LoadingState label="Loading analysis" />
      </AdminLayout>
    );
  }

  if (analysis.error || !analysis.data) {
    return (
      <AdminLayout>
        <ErrorState
          title="Couldn't load this analysis"
          message={analysis.error ?? "Not found."}
        />
      </AdminLayout>
    );
  }

  const data = analysis.data;
  const repository = data.repository;
  const evidence: Evidence[] = data.evidence ?? [];
  const brief = data.hackathon as Record<string, string>;
  const submission = data.submission as Record<string, string>;
  const projectMap = data.project_map;
  const review = data.review;

  const canReview =
    repository?.analysis_status === "completed" ||
    repository?.analysis_status === "limited";

  // §34 — join the brief's requirements to their evaluations.
  const coverage: CoverageRow[] = (
    (data.requirement_map?.requirements ?? []) as RequirementItem[]
  ).map((requirement) => ({
    requirement,
    evaluation:
      data.requirements.find((row) => row.requirement_id === requirement.id) ??
      null,
  }));

  return (
    <AdminLayout>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="label-mono text-brand">Submission analysis</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
            {submission.project_name || "Untitled project"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {(data.team as { name?: string })?.name} ·{" "}
            {brief.name ?? "No hackathon"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {isApiConfigured && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runWithConfirmation("repository")}
                disabled={busy !== null || !submission.github_url}
              >
                {busy === "repository" ? (
                  <RefreshCw className="size-3.5 animate-spin" />
                ) : (
                  <GitBranch className="size-3.5" />
                )}
                {repository ? "Re-analyse" : "Analyse repository"}
              </Button>
              <Button
                size="sm"
                onClick={() => void runWithConfirmation("review")}
                disabled={busy !== null || !canReview}
              >
                {busy === "review" ? (
                  <RefreshCw className="size-3.5 animate-spin" />
                ) : (
                  <Brain className="size-3.5" />
                )}
                Run AI review
              </Button>
            </>
          )}
        </div>
      </div>

      {!isApiConfigured && (
        <Card className="mt-6 border-dashed p-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Supabase is not configured, so analysis and review cannot be
            started from here. Everything below is read from the database and
            works regardless.
          </p>
        </Card>
      )}

      {actionError && (
        <div className="mt-6">
          <ErrorState title="Action failed" message={actionError} />
        </div>
      )}

      <div className="mt-8 flex flex-col gap-8">
        {/* ── 1. Project ──────────────────────────────────────── */}
        <Section step={1} title="Project">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Project name"
              value={submission.project_name || "—"}
            />
            <Field label="Tech stack" value={submission.tech_stack || "—"} />
          </dl>
          <div className="mt-4">
            <p className="label-mono text-[10px] text-muted-foreground">
              Description
            </p>
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed">
              {submission.project_description || "—"}
            </p>
          </div>
          <div className="mt-4">
            <p className="label-mono text-[10px] text-muted-foreground">
              Key features
            </p>
            <p className="mt-1.5 whitespace-pre-line max-w-3xl text-sm leading-relaxed">
              {submission.key_features || "—"}
            </p>
          </div>
        </Section>

        {/* ── 2. Hackathon brief, before any AI conclusion (§81) ─ */}
        <Section
          step={2}
          title="Hackathon"
          icon={ScrollText}
          note="The original challenge. This is what every conclusion below is measured against."
        >
          <div className="flex flex-col gap-4">
            <BriefBlock
              title="Problem statement"
              body={brief.problem_statement}
            />
            <BriefBlock title="Requirements" body={brief.requirements} />
            <BriefBlock title="Constraints" body={brief.constraints} />
            <BriefBlock
              title="Expected outcome"
              body={brief.expected_outcome}
            />
            <BriefBlock
              title="Evaluation criteria"
              body={brief.evaluation_criteria}
            />
          </div>
        </Section>

        {/* ── 3. Submission details ───────────────────────────── */}
        <Section step={3} title="Submission">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Status" value={submission.status} />
            <Field
              label="Repository"
              value={submission.github_url || "Not provided"}
            />
            <Field
              label="Live demo"
              value={submission.live_demo_url || "Not provided"}
            />
          </dl>
        </Section>

        {/* ── 4. GitHub repository ────────────────────────────── */}
        <Section step={4} title="GitHub repository" icon={GitBranch}>
          {!repository ? (
            <NoticeState
              title="No repository analysis yet"
              message="Run repository analysis to extract deterministic evidence. This step uses no AI tokens."
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "label-mono",
                    repository.analysis_status === "failed"
                      ? "border-destructive/40 text-destructive"
                      : "border-stage-report/40 text-stage-report",
                  )}
                >
                  {repository.analysis_status}
                </Badge>
                {repository.owner && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {repository.owner}/{repository.repo_name} @{" "}
                    {repository.analyzed_commit_sha?.slice(0, 8)}
                  </span>
                )}
              </div>
              {repository.error_message && (
                <ErrorState
                  title="Analysis failed"
                  message={repository.error_message}
                />
              )}
            </div>
          )}
        </Section>

        {/* ── 5. Repository evidence ──────────────────────────── */}
        <Section
          step={5}
          title="Repository evidence"
          note="The source of truth. Every AI conclusion below cites these."
        >
          {evidence.length === 0 ? (
            <NoticeState
              title="No evidence extracted"
              message="Repository analysis has not produced evidence yet."
            />
          ) : (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                {evidence.length} evidence items.{" "}
                <ProjectMapSummary map={projectMap} />
              </p>
              <EvidenceList
                ids={evidence.map((e) => e.id)}
                evidence={evidence}
              />
            </>
          )}
        </Section>

        {/* ── 6. Requirement coverage ─────────────────────────── */}
        <Section step={6} title="Requirement coverage">
          <CoverageMatrix rows={coverage} evidence={evidence} />
        </Section>

        {/* ── 7. Constraints ──────────────────────────────────── */}
        <Section step={7} title="Constraint review">
          {data.requirement_map?.constraints?.length ? (
            <ul className="flex flex-col gap-2">
              {data.requirement_map.constraints.map((constraint) => {
                const evaluation = data.requirements.find(
                  (row) => row.requirement_id === constraint.id,
                );
                return (
                  <li
                    key={constraint.id}
                    className="rounded-md border border-border p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="label-mono text-[10px] text-brand">
                        {constraint.id}
                      </span>
                      {evaluation ? (
                        <Badge
                          variant="outline"
                          className="label-mono text-[10px]"
                        >
                          {evaluation.status.replace(/_/g, " ")}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-muted-foreground"
                        >
                          not checked
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed">
                      {constraint.text}
                    </p>
                    {evaluation?.explanation && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {evaluation.explanation}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <NoticeState
              title="No constraints defined"
              message="This hackathon's brief does not list any constraints."
            />
          )}
        </Section>

        {/* ── 8. Problem alignment ────────────────────────────── */}
        <Section step={8} title="Problem alignment" icon={ShieldCheck}>
          {review?.problem_alignment ? (
            <Card className="p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="label-mono">
                  {review.problem_alignment.status.replace(/_/g, " ")}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  confidence {review.problem_alignment.confidence}
                  {review.problem_alignment.source === "deterministic" &&
                    " · answered without AI tokens"}
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
              title="No alignment analysis yet"
              message="Run the AI review to see how this project relates to the brief."
            />
          )}
        </Section>

        {/* ── 9. AI project review ────────────────────────────── */}
        <Section step={9} title="AI project review" icon={Brain}>
          {review?.summary ? (
            <Card className="p-5">
              <p className="text-sm leading-relaxed">
                {review.summary.headline}
              </p>
              {review.summary.strengths.length > 0 && (
                <List label="Strengths" items={review.summary.strengths} />
              )}
              {review.summary.areas_to_clarify.length > 0 && (
                <List
                  label="Areas to clarify"
                  items={review.summary.areas_to_clarify}
                />
              )}
            </Card>
          ) : (
            <NoticeState
              title="No review yet"
              message="Run the AI review after the repository has been analysed."
            />
          )}

          <div className="mt-4">
            <p className="label-mono mb-3 text-muted-foreground">Findings</p>
            <FindingsList
              findings={data.findings}
              evidence={evidence}
              emptyMessage="No findings cite repository evidence yet."
            />
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ReviewStat
              label="Testing"
              value={
                review?.testing
                  ? String(
                      (review.testing as { test_file_count?: number })
                        .test_file_count ?? 0,
                    )
                  : "—"
              }
              hint={review?.testing ? "test files detected" : undefined}
            />
            <ReviewStat
              label="Endpoints"
              value={projectMap?.backend.endpoint_count ?? 0}
            />
            <ReviewStat
              label="Auth"
              value={
                projectMap?.authentication.detected.length
                  ? projectMap.authentication.detected.join(", ")
                  : "Not detected"
              }
            />
            <ReviewStat
              label="Database"
              value={
                projectMap?.database.technologies.length
                  ? projectMap.database.technologies.join(", ")
                  : "Not detected"
              }
            />
          </div>
        </Section>

        {/* ── 10. Contribution evidence ───────────────────────── */}
        <Section step={10} title="Contribution evidence" icon={Users}>
          <ContributionTable analysis={data} evidence={evidence} />
        </Section>

        {/* ── 11. Defence targets ─────────────────────────────── */}
        <Section
          step={11}
          title="Defence targets"
          note="Topics to prepare for, not questions. Questions arrive in a later phase."
        >
          <DefenseTargetList targets={data.defense_targets} />
        </Section>

        {/* ── 12. AI usage (admin only) ──────────────────────── */}
        {data.ai_usage && (
          <Section
            step={12}
            title="AI usage"
            icon={CircleDollarSign}
            note="Admin only. Students never see token counts or cost."
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <ReviewStat label="Requests" value={data.ai_usage.requests} />
              <ReviewStat
                label="Input tokens"
                value={data.ai_usage.input_tokens.toLocaleString()}
              />
              <ReviewStat
                label="Output tokens"
                value={data.ai_usage.output_tokens.toLocaleString()}
              />
              <ReviewStat
                label="Cost"
                value={`$${Number(data.ai_usage.cost_usd).toFixed(4)}`}
              />
            </div>
          </Section>
        )}
      </div>
    </AdminLayout>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Section({
  step,
  title,
  note,
  icon: Icon,
  children,
}: {
  step: number;
  title: string;
  note?: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-3 border-b border-border pb-3">
        <span className="label-mono text-[10px] text-muted-foreground">
          {String(step).padStart(2, "0")}
        </span>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
      </div>
      {note && (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
          {note}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function BriefBlock({ title, body }: { title: string; body?: string }) {
  return (
    <div>
      <p className="label-mono text-[10px] text-muted-foreground">{title}</p>
      <div className="mt-1.5 max-w-3xl whitespace-pre-line rounded-md border border-border bg-card/40 p-4 text-sm leading-relaxed">
        {body || "Not provided in the brief."}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-mono text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-sm">{value}</dd>
    </div>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="mt-3">
      <p className="label-mono text-[10px] text-muted-foreground">{label}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm leading-relaxed">
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <p className="label-mono text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
        {value}
      </p>
      {hint && (
        <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
      )}
    </Card>
  );
}

function ContributionTable({
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
    contribution_description: string;
    contribution_areas: string[];
    planned_responsibilities: string;
  }[];

  if (members.length === 0) {
    return (
      <NoticeState
        title="No contributions recorded"
        message="Nobody added a contribution description to this submission."
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
              {check ? (
                <Badge variant="outline" className="label-mono text-[10px]">
                  {check.status.replace(/_/g, " ")}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="label-mono text-[10px] text-muted-foreground"
                >
                  not checked
                </Badge>
              )}
              {check && (
                <span className="text-[10px] text-muted-foreground">
                  confidence {check.confidence}
                </span>
              )}
            </div>

            <p className="mt-2.5 text-sm leading-relaxed">
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
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                {check.explanation}
              </p>
            )}

            {check && check.matched_files.length > 0 && (
              <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                {check.matched_files.slice(0, 5).join(" · ")}
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
