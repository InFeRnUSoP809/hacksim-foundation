import { StudentLayout } from "@/layouts/StudentLayout";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAsync } from "@/hooks/use-async";
import { useFormatEngine } from "@/hooks/use-format-engine";
import { formatCountdown, lockSubmission } from "@/lib/format-engine";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/services/errors";
import {
  ensureDraft,
  getSubmission,
  isLocked,
  saveDraft,
  validateGithubUrl,
  validateHttpUrl,
} from "@/services/submissions";
import { getSession } from "@/services/sessions";
import { ArrowRight, FileText, Loader2, Lock, Send } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  type BuildSession,
  type Submission,
} from "@/types";

export default function SubmissionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();

  const session = useAsync<BuildSession | null>(
    () => (sessionId ? getSession(sessionId) : Promise.resolve(null)),
    [sessionId],
  );
  const submission = useAsync<Submission | null>(
    () => (sessionId ? getSubmission(sessionId) : Promise.resolve(null)),
    [sessionId],
  );

  // The phase comes from the server's clock (§13.3, §26), re-synced on an
  // interval and on tab focus. The UI renders it; it never decides it.
  const engine = useFormatEngine(sessionId);
  const windowMinutes = engine.brief?.clock.github_submission_window_minutes ?? 0;

  if (!sessionId) {
    return (
      <StudentLayout>
        <div className="mx-auto w-full max-w-4xl px-5 py-12 sm:px-8">
          <ErrorState message="No submission was specified." />
        </div>
      </StudentLayout>
    );
  }

  if (session.isLoading || submission.isLoading) {
    return (
      <StudentLayout>
        <div className="mx-auto w-full max-w-4xl px-5 py-12 sm:px-8">
          <LoadingState label="Loading your submission" />
        </div>
      </StudentLayout>
    );
  }

  if (session.error || submission.error) {
    return (
      <StudentLayout>
        <div className="mx-auto w-full max-w-4xl px-5 py-12 sm:px-8">
          <ErrorState message={session.error ?? submission.error ?? ""} />
        </div>
      </StudentLayout>
    );
  }

  const current = submission.data;
  const locked = current ? isLocked(current.status) : false;

  return (
    <StudentLayout>
      <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8 sm:py-12">
        <Link
          to={`/simulation/${sessionId}`}
          className="label-mono mb-6 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          Back to simulation
        </Link>

        <div className="flex flex-col gap-3">
          <p className="label-mono text-brand">Phase 4</p>
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">
            Project submission
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Record what your team built and where to find it.
            Nothing is scored here — this is the record the defence phase will
            use later.
          </p>
        </div>

        {engine.error && !engine.brief && (
          <p className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-destructive">
            Scenario engine unavailable — {engine.error} You can still fill in the form below,
            but the submission deadline needs the 006 and 007 database functions.
          </p>
        )}

        {locked ? (
          <LockedNotice submission={current!} />
        ) : engine.phase === "closed" ? (
          // §31 — late is late. However the countdown on a stale tab looked,
          // the server has closed the window and nothing here is editable.
          <WindowClosedNotice />
        ) : (
          <StartDraft
            sessionId={sessionId}
            existing={current}
            onReady={() => submission.reload()}
          />
        )}

        {current && (
          <div className="mt-8 flex flex-col gap-8">
            <ProjectForm
              sessionId={sessionId}
              submission={current}
              locked={locked}
              onSaved={() => submission.reload()}
            />

            {!locked && engine.phase !== "closed" && (
              // Two submission phases, one deadline rule: before the build ends
              // a team that finishes early may submit; after it, only if the
              // admin-configured window is open. The server enforces the same
              // deadline in both cases.
              <SubmissionWindowSection
                submission={current}
                duringWindow={engine.phase === "window"}
                windowMinutes={windowMinutes}
                windowRemaining={engine.phase === "window" ? engine.windowRemaining : engine.buildRemaining}
                onSubmitted={() => submission.reload()}
              />
            )}
          </div>
        )}
      </div>
    </StudentLayout>
  );
}

// ── Start a draft ───────────────────────────────────────────────────────────

function StartDraft({
  sessionId,
  existing,
  onReady,
}: {
  sessionId: string;
  existing: Submission | null;
  onReady: () => void;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (existing) return null;

  async function handleStart() {
    setError(null);
    setIsSaving(true);
    try {
      await ensureDraft(sessionId);
      onReady();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="mt-8 flex flex-col items-start gap-4 border-dashed p-6">
      <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
        <FileText className="size-4 text-muted-foreground" />
      </div>
      <div>
        <p className="text-base font-semibold">Your project has not been submitted yet.</p>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Start a draft to record your project details. You can save and return
          as often as you like before the final step.
        </p>
      </div>
      {error && <ErrorState title="Couldn't start" message={error} />}
      <Button onClick={() => void handleStart()} disabled={isSaving}>
        {isSaving && <Loader2 className="size-4 animate-spin" />}
        Start a draft
      </Button>
    </Card>
  );
}

// ── Project details ─────────────────────────────────────────────────────────

function ProjectForm({
  sessionId,
  submission,
  locked,
  onSaved,
}: {
  sessionId: string;
  submission: Submission;
  locked: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    projectName: submission.project_name ?? "",
    projectDescription: submission.project_description ?? "",
    githubUrl: submission.github_url ?? "",
    liveDemoUrl: submission.live_demo_url ?? "",
    techStack: submission.tech_stack ?? "",
    keyFeatures: submission.key_features ?? "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  }

  // Validate as the user types, but only once a value is present.
  const githubError = validateGithubUrl(form.githubUrl);
  const demoError = validateHttpUrl(form.liveDemoUrl);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      await saveDraft(sessionId, form);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold tracking-[-0.02em]">Project</h2>

      <form onSubmit={handleSave} className="mt-5 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            id="project-name"
            required
            disabled={locked}
            value={form.projectName}
            onChange={(event) => set("projectName", event.target.value)}
            placeholder="What did your team build?"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="project-description">Project description</Label>
          <Textarea
            id="project-description"
            rows={4}
            disabled={locked}
            value={form.projectDescription}
            onChange={(event) => set("projectDescription", event.target.value)}
            placeholder="What does it do, and who is it for?"
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="github-url">GitHub repository URL</Label>
            <Input
              id="github-url"
              disabled={locked}
              value={form.githubUrl}
              onChange={(event) => set("githubUrl", event.target.value)}
              placeholder="https://github.com/user/repo"
              aria-invalid={Boolean(githubError)}
            />
            {githubError && (
              <p className="text-xs text-destructive">{githubError}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="demo-url">Live demo URL</Label>
            <Input
              id="demo-url"
              disabled={locked}
              value={form.liveDemoUrl}
              onChange={(event) => set("liveDemoUrl", event.target.value)}
              placeholder="https://your-demo.example.com"
              aria-invalid={Boolean(demoError)}
            />
            {demoError && (
              <p className="text-xs text-destructive">{demoError}</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="tech-stack">Tech stack</Label>
          <Textarea
            id="tech-stack"
            rows={2}
            disabled={locked}
            value={form.techStack}
            onChange={(event) => set("techStack", event.target.value)}
            placeholder="React, FastAPI, Python, Supabase, PostgreSQL"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="key-features">Key features</Label>
          <Textarea
            id="key-features"
            rows={4}
            disabled={locked}
            value={form.keyFeatures}
            onChange={(event) => set("keyFeatures", event.target.value)}
            placeholder="One line per feature."
          />
        </div>

        {error && <ErrorState title="Couldn't save" message={error} />}
        {saved && !error && (
          <p className="text-xs text-stage-report">Draft saved.</p>
        )}

        {!locked && (
          <div className="flex justify-end">
            <Button type="submit" disabled={isSaving}>
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Save draft
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// ── Submission window (§20–§35) ───────────────────────────────────────────

function WindowClosedNotice() {
  return (
    <Card className="mt-8 flex flex-col items-start gap-3 border-destructive/40 bg-destructive/5 p-6">
      <div className="grid size-9 place-items-center rounded-lg bg-background">
        <Lock className="size-4 text-destructive" />
      </div>
      <div>
        <h2 className="text-base font-semibold">The submission window has closed</h2>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
          The deadline is set on the server and cannot be extended. This
          submission can no longer be accepted.
        </p>
      </div>
    </Card>
  );
}

/**
 * The window's only job: GitHub URL in, submission locked — fast. Analysis is
 * deliberately not started here (§29/§36): the deadline exists so the team
 * doesn't lose their work, not to babysit a scanner.
 */
function SubmissionWindowSection({
  submission,
  duringWindow,
  windowMinutes,
  windowRemaining,
  onSubmitted,
}: {
  submission: Submission;
  duringWindow: boolean;
  windowMinutes: number;
  windowRemaining: number;
  onSubmitted: () => void;
}) {
  const confirm = useConfirmDialog();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const githubError = validateGithubUrl(submission.github_url ?? "");
  const urgent = duringWindow && windowRemaining <= 60;

  async function handleSubmit() {
    const confirmed = await confirm.ask({
      title: "Submit your project?",
      message:
        "This locks the project, the repository URL and every contribution. The window cannot be reopened afterwards.",
      confirmLabel: "Submit project",
      cancelLabel: "Keep editing",
      tone: "warning",
    });
    if (!confirmed) return;

    setError(null);
    setIsSubmitting(true);
    try {
      // §30 — the only submission path. The database re-checks the window
      // with its own clock, so a click at 00:00:01 still fails server-side.
      const result = await lockSubmission(submission.id);
      if (result.ok) {
        onSubmitted();
        window.location.reload();
      } else {
        setError("The submission was not accepted.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card
      className={cn(
        "flex flex-col items-start gap-4 border-stage-report/50 bg-stage-report/5 p-6",
        urgent && "border-destructive/50 bg-destructive/5",
      )}
    >
      <div className="flex w-full flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">Final submission</h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {duringWindow
              ? `You have ${windowMinutes} ${windowMinutes === 1 ? "minute" : "minutes"} after the build's end. Add or confirm your repository URL below — nothing else can be changed after this.`
              : "Submitting locks the project, the repository and every contribution. Teams that finish early can submit before the build ends."}
          </p>
        </div>
        <div className="text-right">
          <p className="label-mono text-muted-foreground">
            {duringWindow ? "Time remaining" : "Build time remaining"}
          </p>
          <p
            className={cn(
              "font-mono text-3xl font-semibold tabular-nums tracking-tight",
              urgent ? "text-destructive" : "text-stage-report",
            )}
          >
            {formatCountdown(windowRemaining)}
          </p>
        </div>
      </div>

      {githubError && (
        <p className="text-xs text-destructive">
          Add a valid GitHub repository URL in the project form below before submitting.
        </p>
      )}
      {error && <ErrorState title="Couldn't submit" message={error} />}

      <Button onClick={() => void handleSubmit()} disabled={isSubmitting || Boolean(githubError)}>
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        Submit project
      </Button>
    </Card>
  );
}

// ── Locked ──────────────────────────────────────────────────────────────────

function LockedNotice({ submission }: { submission: Submission }) {
  return (
    <Card className="mt-8 flex flex-col items-start gap-3 border-stage-defend/40 bg-stage-defend/5 p-6">
      <div className="grid size-9 place-items-center rounded-lg bg-background">
        <Lock className="size-4 text-stage-defend" />
      </div>
      <div>
        <h2 className="text-base font-semibold">Submission finalized</h2>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Your project and contributions are read-only.
          {submission.submitted_at && (
            <>
              {" "}
              Submitted{" "}
              {new Date(submission.submitted_at).toLocaleString()}.
            </>
          )}
        </p>
        {submission.github_url && (
          <Button variant="outline" size="sm" asChild className="mt-4 w-fit">
            <Link to={`/review/${submission.id}`}>
              View your project review
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        )}
      </div>
    </Card>
  );
}
