import { StudentLayout } from "@/layouts/StudentLayout";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useAsync } from "@/hooks/use-async";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/services/errors";
import {
  ensureDraft,
  finalizeSubmission,
  getSubmission,
  getSubmissionMembers,
  isLocked,
  saveDraft,
  saveMyContribution,
  validateGithubUrl,
  validateHttpUrl,
} from "@/services/submissions";
import { getSession } from "@/services/sessions";
import { ArrowRight, FileText, Loader2, Lock, Send } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  CONTRIBUTION_AREAS,
  type BuildSession,
  type Submission,
  type SubmissionMemberWithProfile,
} from "@/types";

export default function SubmissionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { user } = useAuth();

  const session = useAsync<BuildSession | null>(
    () => (sessionId ? getSession(sessionId) : Promise.resolve(null)),
    [sessionId],
  );
  const submission = useAsync<Submission | null>(
    () => (sessionId ? getSubmission(sessionId) : Promise.resolve(null)),
    [sessionId],
  );

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
            Record what your team built and what each of you contributed.
            Nothing is scored here — this is the record the defence phase will
            use later.
          </p>
        </div>

        {locked ? (
          <LockedNotice submission={current!} />
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

            <ContributionsSection
              submission={current}
              currentUserId={user?.id ?? null}
              locked={locked}
            />

            {!locked && <FinaliseSection submission={current} />}
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

// ── Contributions ───────────────────────────────────────────────────────────

function ContributionsSection({
  submission,
  currentUserId,
  locked,
}: {
  submission: Submission;
  currentUserId: string | null;
  locked: boolean;
}) {
  const roster = useAsync<SubmissionMemberWithProfile[]>(
    () => getSubmissionMembers(submission.id),
    [submission.id],
  );

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-[-0.02em]">
        Individual contributions
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        AI use is not treated as cheating. It is recorded so a later defence
        phase can check you understand and can defend what you claim to have
        built.
      </p>

      {roster.isLoading ? (
        <LoadingState label="Loading contributions" />
      ) : roster.error ? (
        <div className="mt-4">
          <ErrorState message={roster.error} />
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {roster.data?.map((member) => (
            <ContributionCard
              key={member.id}
              member={member}
              isMine={member.user_id === currentUserId}
              locked={locked}
              onSaved={roster.reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContributionCard({
  member,
  isMine,
  locked,
  onSaved,
}: {
  member: SubmissionMemberWithProfile;
  isMine: boolean;
  locked: boolean;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(member.contribution_description);
  const [areas, setAreas] = useState<string[]>(member.contribution_areas);
  const [responsibilities, setResponsibilities] = useState(
    member.planned_responsibilities,
  );
  const [aiTools, setAiTools] = useState(member.ai_tools_used);
  const [aiUsage, setAiUsage] = useState(member.ai_usage_description);
  const [usedAi, setUsedAi] = useState(Boolean(member.ai_tools_used.trim()));

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const editable = isMine && !locked;

  function toggleArea(area: string) {
    setSaved(false);
    setAreas((current) =>
      current.includes(area)
        ? current.filter((item) => item !== area)
        : [...current, area],
    );
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      await saveMyContribution(member.submission_id, {
        contributionDescription: description,
        contributionAreas: areas,
        plannedResponsibilities: responsibilities,
        aiToolsUsed: usedAi ? aiTools : "",
        aiUsageDescription: usedAi ? aiUsage : "",
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className={cn("p-6", isMine && "border-brand/30")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[15px] font-semibold tracking-[-0.01em]">
            {member.full_name || member.email}
          </p>
          <p className="label-mono mt-0.5 text-muted-foreground">
            {member.team_role}
          </p>
        </div>
        {!editable && (
          <span className="label-mono rounded-full border border-border px-2.5 py-1 text-muted-foreground">
            {locked ? "Locked" : isMine ? "Read only" : "Another member"}
          </span>
        )}
      </div>

      <form onSubmit={handleSave} className="mt-5 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`contrib-${member.id}`}>
            Contribution description
          </Label>
          <Textarea
            id={`contrib-${member.id}`}
            rows={3}
            disabled={!editable}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setSaved(false);
            }}
            placeholder="I will build the inventory prediction API."
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Contribution areas</Label>
          <div className="flex flex-wrap gap-2">
            {CONTRIBUTION_AREAS.map((area) => {
              const selected = areas.includes(area);
              return (
                <button
                  key={area}
                  type="button"
                  disabled={!editable}
                  onClick={() => toggleArea(area)}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed",
                    selected
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {area}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`resp-${member.id}`}>
            Planned responsibilities
          </Label>
          <Textarea
            id={`resp-${member.id}`}
            rows={2}
            disabled={!editable}
            value={responsibilities}
            onChange={(event) => {
              setResponsibilities(event.target.value);
              setSaved(false);
            }}
          />
        </div>

        {/* ── AI disclosure ─────────────────────────────────────── */}
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm font-semibold">AI usage disclosure</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Did you use AI tools while building this project?
          </p>

          <div className="mt-3 flex flex-col gap-2">
            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="radio"
                name={`ai-${member.id}`}
                checked={!usedAi}
                disabled={!editable}
                onChange={() => {
                  setUsedAi(false);
                  setSaved(false);
                }}
                className="size-4 accent-[var(--brand)]"
              />
              No
            </label>
            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="radio"
                name={`ai-${member.id}`}
                checked={usedAi}
                disabled={!editable}
                onChange={() => {
                  setUsedAi(true);
                  setSaved(false);
                }}
                className="size-4 accent-[var(--brand)]"
              />
              Yes
            </label>
          </div>

          {usedAi && (
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`tools-${member.id}`}>Which AI tools?</Label>
                <Input
                  id={`tools-${member.id}`}
                  disabled={!editable}
                  value={aiTools}
                  onChange={(event) => {
                    setAiTools(event.target.value);
                    setSaved(false);
                  }}
                  placeholder="Gemini, GitHub Copilot"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`usage-${member.id}`}>
                  How were they used?
                </Label>
                <Textarea
                  id={`usage-${member.id}`}
                  rows={2}
                  disabled={!editable}
                  value={aiUsage}
                  onChange={(event) => {
                    setAiUsage(event.target.value);
                    setSaved(false);
                  }}
                  placeholder="Used AI for debugging and code suggestions."
                />
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-xs text-stage-report">Saved.</p>
        )}

        {editable && (
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="outline" disabled={isSaving}>
              {isSaving && <Loader2 className="size-3.5 animate-spin" />}
              Save contribution
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// ── Finalise ────────────────────────────────────────────────────────────────

function FinaliseSection({ submission }: { submission: Submission }) {
  const confirm = useConfirmDialog();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleFinalise() {
    const confirmed = await confirm.ask({
      title: "Are you sure you want to submit?",
      message:
        "After submission, your project details and contribution information will become read-only.",
      confirmLabel: "Confirm Submission",
      cancelLabel: "Cancel",
      tone: "warning",
    });
    if (!confirmed) return;

    setError(null);
    setIsSubmitting(true);
    try {
      await finalizeSubmission(submission.session_id);
      setDone(true);
      // Reload so the page switches to its read-only state.
      window.location.reload();
    } catch (err) {
      setError(friendlyError(err));
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="flex flex-col items-start gap-4 p-6">
      <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
        <Send className="size-4" />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-[-0.02em]">
          Final submission
        </h2>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Submitting locks the project and every member&rsquo;s contribution. The
          database refuses further edits, so this cannot be undone.
        </p>
      </div>

      {error && <ErrorState title="Couldn't submit" message={error} />}
      {done && (
        <p className="text-sm text-stage-report">Submitted. Reloading…</p>
      )}

      <Button onClick={() => void handleFinalise()} disabled={isSubmitting}>
        {isSubmitting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Send className="size-4" />
        )}
        Submit Project
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
