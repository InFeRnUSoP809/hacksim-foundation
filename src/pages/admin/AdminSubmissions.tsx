import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { formatDateTime } from "@/lib/format";
import {
  getSubmissionById,
  listSubmissionsForAdmin,
} from "@/services/submissions";
import type { AdminSubmissionRow } from "@/services/submissions";
import { ChevronLeft, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Submission } from "@/types";

function statusPill(status: "draft" | "submitted") {
  return status === "submitted"
    ? "border-stage-defend/35 bg-stage-defend/10 text-stage-defend"
    : "border-stage-submit/35 bg-stage-submit/10 text-stage-submit";
}

export default function AdminSubmissions() {
  const submissions = useAsync<AdminSubmissionRow[]>(
    () => listSubmissionsForAdmin(),
    [],
  );
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    return (
      <SubmissionDetail
        submissionId={selected}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          Submissions
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every project a team has recorded, with what each member claims to
          have contributed.
        </p>
      </div>

      <div className="mt-8">
        {submissions.isLoading ? (
          <LoadingState label="Loading submissions" />
        ) : submissions.error ? (
          <ErrorState message={submissions.error} />
        ) : (submissions.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <FileText className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">No submissions yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Projects appear here once a team starts a draft.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Project
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Team
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Hackathon
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Status
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Submitted
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Links
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(submissions.data ?? []).map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => setSelected(row.id)}
                      className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-secondary/50"
                    >
                      <td className="px-5 py-3.5 font-medium">
                        {row.project_name || "Untitled draft"}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {row.team_name}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {row.hackathon_name}
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={cn(
                            "label-mono inline-flex rounded-full border px-2.5 py-1 capitalize",
                            statusPill(row.status),
                          )}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {row.submitted_at
                          ? formatDateTime(row.submitted_at)
                          : "—"}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {row.github_url ? "GitHub" : "—"}
                        {row.live_demo_url ? " · Demo" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}

function SubmissionDetail({
  submissionId,
  onBack,
}: {
  submissionId: string;
  onBack: () => void;
}) {
  const detail = useAsync<Submission | null>(
    () => getSubmissionById(submissionId),
    [submissionId],
  );
  const submission = detail.data;

  return (
    <AdminLayout>
      <button
        type="button"
        onClick={onBack}
        className="label-mono mb-4 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Back to submissions
      </button>

      {detail.isLoading ? (
        <LoadingState label="Loading submission" />
      ) : detail.error ? (
        <ErrorState message={detail.error} />
      ) : !submission ? (
        <ErrorState message="That submission could not be found." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-[-0.03em]">
              {submission.project_name || "Untitled draft"}
            </h1>
            <span
              className={cn(
                "label-mono inline-flex rounded-full border px-2.5 py-1 capitalize",
                statusPill(submission.status),
              )}
            >
              {submission.status}
            </span>
          </div>
          {submission.submitted_at && (
            <p className="label-mono mt-3 text-muted-foreground">
              Submitted {formatDateTime(submission.submitted_at)}
            </p>
          )}

          {/* Project */}
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <Card className="p-6">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">
                Description
              </h2>
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {submission.project_description || "—"}
              </p>
            </Card>

            <Card className="p-6">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">
                Tech stack
              </h2>
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {submission.tech_stack || "—"}
              </p>
            </Card>

            <Card className="p-6">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">
                Key features
              </h2>
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {submission.key_features || "—"}
              </p>
            </Card>

            <Card className="p-6">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">Links</h2>
              <div className="mt-2 flex flex-col gap-2">
                {submission.github_url ? (
                  <a
                    href={submission.github_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 text-sm text-brand underline underline-offset-4"
                  >
                    <ExternalLink className="size-3.5" />
                    {submission.github_url}
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No GitHub link
                  </p>
                )}

                {submission.live_demo_url ? (
                  <a
                    href={submission.live_demo_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 text-sm text-brand underline underline-offset-4"
                  >
                    <ExternalLink className="size-3.5" />
                    {submission.live_demo_url}
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No live demo link
                  </p>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
