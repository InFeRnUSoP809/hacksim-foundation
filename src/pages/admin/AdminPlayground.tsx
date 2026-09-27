import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useAsync } from "@/hooks/use-async";
import {
  createPlayground,
  getPlaygroundAnalysis,
  listPlayground,
  resetPlayground,
  runPlaygroundReview,
  scanRepository,
  type PlaygroundEntry,
} from "@/services/playground";
import type { ReviewRunResult, SubmissionAnalysis } from "@/types/analysis";
import {
  FileSearch,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router";

/**
 * Analysis Playground (admin).
 *
 * The fastest way to see what the pipeline produces: paste any public GitHub
 * URL, press Scan, then Review. Everything reuses the production path — the
 * same deterministic scanner, the same DeepSeek modules, the same storage the
 * student flow uses — on a disposable submission that is deleted in one click.
 * No hackathon, no team signup, no timers.
 */
export default function AdminPlayground() {
  const confirm = useConfirmDialog();

  const list = useAsync<PlaygroundEntry[]>(() => listPlayground(), []);
  const [url, setUrl] = useState("https://github.com/supabase/supabase");
  const [name, setName] = useState("Playground Test");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "scanning" | "reviewing">("idle");
  const [error, setError] = useState<string | null>(null);
  // Bumped after every scan/review so the result panel refetches and shows the
  // freshly stored output instead of the state it loaded earlier.
  const [resultVersion, setResultVersion] = useState(0);
  const [reviewOutcome, setReviewOutcome] = useState<{
    submissionId: string;
    outcome: ReviewRunResult;
  } | null>(null);

  async function handleCreate() {
    setError(null);
    setPhase("scanning");
    try {
      const created = await createPlayground(url, name);
      setSubmissionId(created.submission_id);
      setReviewOutcome(null);
      await scanRepository(created.submission_id);
      setResultVersion((v) => v + 1);
      toast.success("Scan complete.");
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The scan failed.");
    } finally {
      setPhase("idle");
    }
  }

  async function handleReview() {
    if (!submissionId) return;
    setError(null);
    setPhase("reviewing");
    try {
      const outcome = await runPlaygroundReview(submissionId);
      setReviewOutcome({ submissionId, outcome });
      setResultVersion((v) => v + 1);
      toast.success(`Review finished (${outcome.modules?.length ?? 0} modules).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The review failed.");
    } finally {
      setPhase("idle");
    }
  }

  async function handleReset() {
    const ok = await confirm.ask({
      title: "Delete all playground data?",
      message:
        "Every playground submission, scan and analysis is removed. Real submissions are never touched.",
      confirmLabel: "Delete playground data",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const removed = await resetPlayground();
      setSubmissionId(null);
      list.reload();
      toast.success(`Removed ${removed} playground team${removed === 1 ? "" : "s"}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reset.");
    }
  }

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">Analysis playground</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Test the GitHub analysis pipeline on any public repository — no
          hackathon, no timers. Each test creates a disposable submission that is
          never visible to students and is deleted in one click.
        </p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <div className="flex flex-col gap-6">
          <Card className="p-6">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">New test</h2>

            <div className="mt-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="pg-url">GitHub repository URL</Label>
                <Input
                  id="pg-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/user/repo"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="pg-name">Project name (for the record)</Label>
                <Input
                  id="pg-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void handleCreate()} disabled={phase !== "idle"}>
                  {phase === "scanning" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FileSearch className="size-4" />
                  )}
                  Create & scan
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleReview()}
                  disabled={!submissionId || phase !== "idle"}
                >
                  {phase === "reviewing" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  Run AI review
                  {!submissionId && <span className="text-xs">(scan first)</span>}
                </Button>
              </div>

              {error && <ErrorState title="Pipeline error" message={error} />}
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold tracking-[-0.01em]">Playground submissions</h2>
              <Button variant="ghost" size="sm" onClick={handleReset}>
                <Trash2 className="size-3.5" />
                Reset all
              </Button>
            </div>
            {list.isLoading ? (
              <LoadingState label="Loading" />
            ) : (list.data ?? []).length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No playground submissions yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {(list.data ?? []).map((entry) => (
                  <li key={entry.submission_id}>
                    <button
                      type="button"
                      className="w-full rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-secondary/50"
                      onClick={() => setSubmissionId(entry.submission_id)}
                    >
                      <p className="text-sm font-medium">{entry.project_name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{entry.github_url}</p>
                    </button>
                    <Link to={`/admin/submissions/${entry.submission_id}`} className="label-mono mt-1 inline-block text-xs text-brand">
                      Open full analysis →
                      <Play className="ml-1 inline size-3" />
                    </Link>
                    <span className="hidden">{entry.created_at}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          {submissionId ? (
            <PlaygroundResult
              submissionId={submissionId}
              reloadKey={resultVersion}
              reviewOutcome={
                reviewOutcome?.submissionId === submissionId ? reviewOutcome.outcome : null
              }
            />
          ) : (
            <Card className="flex h-full flex-col items-start gap-3 border-dashed p-8">
              <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
                <FlaskConical className="size-4 text-muted-foreground" />
              </div>
              <p className="text-base font-semibold">No test selected</p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Create and scan a repository, or pick a previous one. The scan is
                deterministic and costs nothing; the review spends AI tokens and
                respects every budget and the kill switch.
              </p>
              <Button variant="ghost" size="sm" onClick={() => list.reload()}>
                <RefreshCw className="size-3.5" />
                Refresh list
              </Button>
            </Card>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}

function PlaygroundResult({
  submissionId,
  reloadKey,
  reviewOutcome,
}: {
  submissionId: string;
  reloadKey: number;
  reviewOutcome: ReviewRunResult | null;
}) {
  const analysis = useAsync<SubmissionAnalysis>(
    () => getPlaygroundAnalysis(submissionId),
    [submissionId, reloadKey],
  );

  if (analysis.isLoading) return <LoadingState label="Loading analysis" />;
  if (analysis.error) return <ErrorState title="Couldn't load the analysis" message={analysis.error} />;

  const data = analysis.data;
  const findings = [
    ...(data?.findings ?? []),
  ];

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Result</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{data?.repository?.analysis_status ?? "unknown"}</Badge>
          <Badge variant="outline">review: {data?.review?.status ?? "none"}</Badge>
          <Badge variant="outline">{data?.evidence?.length ?? 0} evidence</Badge>
          <Badge variant="outline">{findings.length} findings</Badge>
          <Link to={`/review/${submissionId}`} className="label-mono text-xs text-brand">
            Open full review →
          </Link>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        <section>
          <h3 className="label-mono text-muted-foreground">Project map</h3>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-relaxed">
            {JSON.stringify(data?.repository?.project_map ?? {}, null, 2)}
          </pre>
        </section>

        <section>
          <h3 className="label-mono text-muted-foreground">Evidence (first 12)</h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {(data?.evidence ?? []).slice(0, 12).map((ev: { id: string; claim: string }) => (
              <li key={ev.id} className="text-xs leading-relaxed">
                <span className="label-mono text-brand">{ev.id}</span>{" "}
                <span className="text-muted-foreground">{ev.claim}</span>
              </li>
            ))}
            {(data?.evidence ?? []).length === 0 && (
              <li className="text-xs text-muted-foreground">No evidence records yet.</li>
            )}
          </ul>
        </section>

        {data?.review?.summary && (
          <section>
            <h3 className="label-mono text-muted-foreground">AI summary</h3>
            <p className="mt-2 text-sm font-medium leading-relaxed">
              {data.review.summary.headline}
            </p>
            {(data.review.summary.strengths?.length ?? 0) > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium">Strengths</p>
                <ul className="mt-1 list-disc pl-4 text-xs leading-relaxed text-muted-foreground">
                  {data.review.summary.strengths.map((s, i) => (
                    <li key={`s-${i}`}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {(data.review.summary.areas_to_clarify?.length ?? 0) > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium">Areas to clarify</p>
                <ul className="mt-1 list-disc pl-4 text-xs leading-relaxed text-muted-foreground">
                  {data.review.summary.areas_to_clarify.map((s, i) => (
                    <li key={`c-${i}`}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.review.problem_alignment && (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                <Badge variant="outline" className="label-mono mr-2">
                  {data.review.problem_alignment.status}
                </Badge>
                {data.review.problem_alignment.explanation}
              </p>
            )}
          </section>
        )}

        {reviewOutcome && reviewOutcome.modules.length > 0 && (
          <section>
            <h3 className="label-mono text-muted-foreground">Review run (modules)</h3>
            <ul className="mt-2 flex flex-col gap-1.5">
              {reviewOutcome.modules.map((m) => (
                <li key={m.module} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="label-mono text-brand">{m.module}</span>
                  <Badge variant="outline">{m.status}</Badge>
                  <Badge variant="outline">{m.source}</Badge>
                  {m.input_tokens + m.output_tokens > 0 && (
                    <span className="text-muted-foreground">
                      {m.input_tokens + m.output_tokens} tokens
                    </span>
                  )}
                  {m.reason && <span className="text-muted-foreground">{m.reason}</span>}
                  {m.error && <span className="text-destructive">{m.error}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="label-mono text-muted-foreground">Review findings</h3>
          {findings.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No AI review yet — run it, or the scan alone was inconclusive.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {findings.slice(0, 10).map((f, i) => (
                <li key={f.id ?? `finding-${i}`} className="rounded-lg border border-border p-3">
                  <Badge variant="outline" className="label-mono">{f.finding_type}</Badge>
                  <p className="mt-1.5 text-sm font-medium">{f.title}</p>
                  {f.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.description}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
