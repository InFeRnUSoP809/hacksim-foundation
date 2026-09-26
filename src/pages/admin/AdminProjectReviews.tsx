import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { getAdminProjectReviews } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Brain } from "lucide-react";
import { Link } from "react-router";
import type { AdminProjectReviewRow } from "@/types/analysis";

/** §79 — every AI review, with its requirement count, findings and cost. */
const STATUS_TONE: Record<string, string> = {
  completed: "border-stage-report/35 bg-stage-report/10 text-stage-report",
  partial: "border-stage-build/35 bg-stage-build/10 text-stage-build",
  running: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  pending: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/35 bg-destructive/10 text-destructive",
};

export default function AdminProjectReviews() {
  const rows = useAsync<AdminProjectReviewRow[]>(
    () => getAdminProjectReviews() as Promise<AdminProjectReviewRow[]>,
    [],
  );

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Phase 6</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          Project reviews
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Requirement-aware AI reviews. A review only exists once the
          deterministic repository analysis has run — the AI interprets
          evidence, it never replaces it.
        </p>
      </div>

      <div className="mt-8">
        {rows.isLoading ? (
          <LoadingState label="Loading reviews" />
        ) : rows.error ? (
          <ErrorState
            title="Couldn't load reviews"
            message={rows.error}
            action={
              <Button size="sm" variant="outline" onClick={rows.reload}>
                Try again
              </Button>
            }
          />
        ) : (rows.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Brain className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">No reviews yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Open a submission, run repository analysis, then run the AI
              review.
            </p>
            <Button size="sm" variant="outline" asChild className="mt-2 w-fit">
              <Link to="/admin/submissions">Go to submissions</Link>
            </Button>
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
                      Status
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Requirements
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Findings
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      AI cost
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(rows.data ?? []).map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          to={`/admin/submissions/${row.submission_id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {row.project_name || "Untitled project"}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {row.team_name}
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={`label-mono inline-flex rounded-full border px-2.5 py-1 ${
                            STATUS_TONE[row.status] ?? STATUS_TONE.pending
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 font-mono tabular-nums">
                        {row.requirements_done}
                      </td>
                      <td className="px-5 py-3.5 font-mono tabular-nums">
                        {row.findings}
                      </td>
                      <td className="px-5 py-3.5 font-mono tabular-nums text-xs">
                        ${Number(row.cost_usd ?? 0).toFixed(4)}
                        <p className="mt-0.5 text-muted-foreground">
                          {row.total_tokens.toLocaleString()} tokens
                        </p>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">
                        {formatDate(row.updated_at)}
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
