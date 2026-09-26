import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { getAdminRepositories } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { GitBranch, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { AdminRepositoryRow, AnalysisStatus } from "@/types/analysis";

/** §78 — the repository inventory, with the documented status filters. */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "scanning", label: "Scanning" },
  { key: "completed", label: "Completed" },
  { key: "limited", label: "Limited" },
  { key: "failed", label: "Failed" },
  { key: "stale", label: "Stale" },
] as const;

const STATUS_TONE: Record<AnalysisStatus, string> = {
  completed: "border-stage-report/35 bg-stage-report/10 text-stage-report",
  limited: "border-stage-build/35 bg-stage-build/10 text-stage-build",
  scanning: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  pending: "border-border bg-muted text-muted-foreground",
  stale: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  failed: "border-destructive/35 bg-destructive/10 text-destructive",
};

export default function AdminRepositories() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [query, setQuery] = useState("");

  const rows = useAsync<AdminRepositoryRow[]>(
    () => getAdminRepositories() as Promise<AdminRepositoryRow[]>,
    [],
  );

  const filtered = useMemo(() => {
    const all = rows.data ?? [];
    return all.filter((row) => {
      if (filter !== "all" && row.analysis_status !== filter) return false;
      if (!query.trim()) return true;
      const haystack = `${row.project_name ?? ""} ${row.owner ?? ""} ${
        row.repo_name ?? ""
      } ${row.team_name}`.toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    });
  }, [rows.data, filter, query]);

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Phase 5</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          Repositories
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Deterministic analysis of every submitted GitHub repository. This
          stage uses no AI tokens — the evidence it produces is what the AI
          review later reasons about.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setFilter(option.key)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                filter === option.key
                  ? "border-brand text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {countFor(rows.data ?? [], option.key)}
              </span>
            </button>
          ))}
        </div>

        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search project, team or repo"
            className="h-9 w-64 rounded-md border border-input bg-background pl-9 pr-3 text-sm"
          />
        </div>
      </div>

      <div className="mt-6">
        {rows.isLoading ? (
          <LoadingState label="Loading repositories" />
        ) : rows.error ? (
          <ErrorState
            title="Couldn't load repositories"
            message={rows.error}
            action={
              <Button size="sm" variant="outline" onClick={rows.reload}>
                Try again
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <GitBranch className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">
              {rows.data && rows.data.length > 0
                ? "Nothing matches those filters"
                : "No repositories analysed yet"}
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {rows.data && rows.data.length > 0
                ? "Try a different status or clear the search."
                : "Open a submission and run repository analysis to create the first one."}
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Project
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Repository
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Commit
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Scanner
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      AI review
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Analysed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => (
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
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {row.team_name}
                        </p>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs">
                        {row.owner ? `${row.owner}/${row.repo_name}` : "—"}
                        {row.secret_count > 0 && (
                          <p className="mt-0.5 text-stage-submit">
                            {row.secret_count} secret finding
                            {row.secret_count === 1 ? "" : "s"}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">
                        {row.commit_sha ? row.commit_sha.slice(0, 8) : "—"}
                        <p className="mt-0.5">{row.file_count} files</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={cn(
                            "label-mono inline-flex rounded-full border px-2.5 py-1",
                            STATUS_TONE[row.analysis_status] ??
                              STATUS_TONE.pending,
                          )}
                        >
                          {row.analysis_status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">
                        {row.review_status ?? "—"}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-muted-foreground">
                        {row.last_analyzed_at
                          ? formatDate(row.last_analyzed_at)
                          : "—"}
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

function countFor(rows: AdminRepositoryRow[], key: string): number {
  if (key === "all") return rows.length;
  return rows.filter((row) => row.analysis_status === key).length;
}
