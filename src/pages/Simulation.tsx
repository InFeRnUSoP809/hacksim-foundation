import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useSessionClock } from "@/hooks/use-session-clock";
import { useAsync } from "@/hooks/use-async";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Wordmark } from "@/components/Wordmark";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { getCheckpoints, saveCheckpoint } from "@/services/checkpoints";
import {
  getHackathonForSession,
  getSession,
  getTeamName,
  setSessionStatus,
} from "@/services/sessions";
import { getTeamRoster } from "@/services/teams";
import { friendlyError } from "@/services/errors";
import { Check, Loader2, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  CHECKPOINTS,
  type BuildCheckpoint,
  type BuildSession,
  type Hackathon,
  type TeamMemberWithProfile,
} from "@/types";

export default function Simulation() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const confirm = useConfirmDialog();

  const clock = useSessionClock(sessionId);

  const session = useAsync<BuildSession | null>(
    () => (sessionId ? getSession(sessionId) : Promise.resolve(null)),
    [sessionId],
  );
  const hackathon = useAsync<Hackathon | null>(
    () =>
      sessionId ? getHackathonForSession(sessionId) : Promise.resolve(null),
    [sessionId],
  );
  const teamName = useAsync<string>(
    () =>
      session.data ? getTeamName(session.data.team_id) : Promise.resolve("—"),
    [session.data?.team_id],
  );
  const roster = useAsync<TeamMemberWithProfile[]>(
    () =>
      session.data ? getTeamRoster(session.data.team_id) : Promise.resolve([]),
    [session.data?.team_id],
  );
  const checkpoints = useAsync<BuildCheckpoint[]>(
    () => (sessionId ? getCheckpoints(sessionId) : Promise.resolve([])),
    [sessionId],
  );

  const [isMutating, setIsMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!sessionId) {
    return (
      <Shell>
        <ErrorState message="No simulation was specified." />
      </Shell>
    );
  }

  async function handleFinish() {
    if (!sessionId) return;
    setActionError(null);

    const confirmed = await confirm.ask({
      title: "Finish this simulation?",
      message: "This ends the run for your whole team. It cannot be undone.",
      confirmLabel: "Finish simulation",
      cancelLabel: "Keep working",
      tone: "warning",
    });
    if (!confirmed) return;

    setIsMutating(true);
    try {
      await setSessionStatus(sessionId, "completed");
      await clock.refresh();
      session.reload();
      checkpoints.reload();
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setIsMutating(false);
    }
  }

  const isLive = clock.status === "running";
  const finished = clock.status === "completed" || clock.status === "expired";

  if (clock.isLoading) {
    return (
      <Shell>
        <LoadingState label="Loading your simulation" />
      </Shell>
    );
  }

  if (clock.error) {
    return (
      <Shell>
        <ErrorState
          title="Couldn't load the simulation"
          message={clock.error}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void clock.refresh()}
            >
              Try again
            </Button>
          }
        />
      </Shell>
    );
  }

  return (
    <Shell>
      {/* ── Top bar: identity, team, and the clock ─────────────── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-3 sm:px-8 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <Link to="/dashboard" className="shrink-0">
              <Wordmark />
            </Link>
            <div className="hidden min-w-0 border-l border-border pl-4 sm:block">
              <p className="label-mono text-muted-foreground">Hackathon</p>
              <p className="truncate text-sm font-medium">
                {hackathon.data?.name ?? "—"}
              </p>
            </div>
            <div className="hidden min-w-0 border-l border-border pl-4 md:block">
              <p className="label-mono text-muted-foreground">Team</p>
              <p className="truncate text-sm font-medium">
                {teamName.data ?? "—"}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 md:justify-end">
            <ThemeToggle />
            <div
              className={cn(
                "rounded-lg border px-4 py-2 text-center",
                finished
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-stage-report/40 bg-stage-report/10",
              )}
            >
              <p className="label-mono text-muted-foreground">
                {finished ? "Finished" : "Time remaining"}
              </p>
              <p
                className={cn(
                  "font-mono text-2xl font-semibold tracking-tight tabular-nums",
                  finished ? "text-destructive" : "text-stage-report",
                )}
              >
                {finished ? "00:00:00" : formatDuration(clock.remaining)}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8">
        {actionError && (
          <div className="mb-6">
            <ErrorState title="Action failed" message={actionError} />
          </div>
        )}

        {finished ? (
          <Card className="flex flex-col items-start gap-4 p-8">
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">
              {clock.status === "expired"
                ? "Time's Up"
                : "Simulation Completed"}
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {clock.status === "expired"
                ? "The build window closed and checkpoints are now locked. Submission arrives in the next phase."
                : "Your team finished this run. Everything you recorded during the checkpoints stays here."}
            </p>
            <div className="flex gap-3">
              <Button variant="outline" asChild>
                <Link to="/dashboard">Back to dashboard</Link>
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/team">View your team</Link>
              </Button>
            </div>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div className="flex flex-col gap-6">
              <ProblemPanel hackathon={hackathon.data} />

              <div>
                <h2 className="text-lg font-semibold tracking-[-0.02em]">
                  Checkpoints
                </h2>
                <div className="mt-4 flex flex-col gap-3">
                  {CHECKPOINTS.map((checkpoint) => (
                    <CheckpointCard
                      key={checkpoint.type}
                      sessionId={sessionId}
                      checkpoint={checkpoint}
                      record={checkpoints.data?.find(
                        (row) => row.checkpoint_type === checkpoint.type,
                      )}
                      disabled={!isLive || isMutating}
                      onSaved={checkpoints.reload}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <Card className="p-5">
                <div className="flex items-center gap-2">
                  <Users className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold tracking-[-0.01em]">
                    Your team
                  </h2>
                </div>

                {roster.isLoading ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Loading members…
                  </p>
                ) : (
                  <ul className="mt-4 flex flex-col gap-3">
                    {roster.data?.map((member) => (
                      <li
                        key={member.id}
                        className="border-b border-border pb-3 last:border-0 last:pb-0"
                      >
                        <p className="text-sm font-medium">
                          {member.full_name || member.email}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {member.role}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="flex flex-col gap-3 p-5">
                <h2 className="text-sm font-semibold tracking-[-0.01em]">
                  Session controls
                </h2>
                <Button
                  variant="outline"
                  onClick={() => void handleFinish()}
                  disabled={isMutating || !isLive}
                >
                  <Check className="size-4" />
                  Finish simulation
                </Button>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The timer runs on the server clock. Refreshing the page, or
                  changing your device time, will not extend it.
                </p>
              </Card>
            </div>
          </div>
        )}
      </main>
    </Shell>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  // The simulation uses its own chrome rather than StudentLayout. The confirm
  // dialog itself is provided once at the app root.
  return (
    <div className="flex min-h-screen flex-col bg-background">{children}</div>
  );
}

// ── Problem ─────────────────────────────────────────────────────────────────

const PROBLEM_SECTIONS = [
  { key: "problem_statement", label: "Problem Statement" },
  { key: "requirements", label: "Requirements" },
  { key: "constraints", label: "Constraints" },
  { key: "expected_outcome", label: "Expected Outcome" },
] as const;

function ProblemPanel({ hackathon }: { hackathon: Hackathon | null }) {
  const [open, setOpen] = useState<string[]>(["problem_statement"]);

  if (!hackathon) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Loading the brief…</p>
      </Card>
    );
  }

  function toggle(key: string) {
    setOpen((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      {PROBLEM_SECTIONS.map((section) => {
        const isOpen = open.includes(section.key);
        return (
          <div
            key={section.key}
            className="border-b border-border last:border-0"
          >
            <button
              type="button"
              onClick={() => toggle(section.key)}
              className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-secondary/50"
              aria-expanded={isOpen}
            >
              <span className="text-sm font-semibold tracking-[-0.01em]">
                {section.label}
              </span>
              <span className="label-mono text-muted-foreground">
                {isOpen ? "Hide" : "Show"}
              </span>
            </button>
            {isOpen && (
              <p className="px-5 pb-5 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {hackathon[section.key] || "Not specified for this hackathon."}
              </p>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ── Checkpoint ──────────────────────────────────────────────────────────────

function CheckpointCard({
  sessionId,
  checkpoint,
  record,
  disabled,
  onSaved,
}: {
  sessionId: string;
  checkpoint: (typeof CHECKPOINTS)[number];
  record: BuildCheckpoint | undefined;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [response, setResponse] = useState(record?.response ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = Boolean(record?.completed_at);

  async function handleSave() {
    setError(null);
    setIsSaving(true);
    try {
      await saveCheckpoint(sessionId, checkpoint.type, response);
      onSaved();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className={cn("p-5", done && "border-stage-report/40")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-sm leading-none",
                done ? "text-stage-report" : "text-muted-foreground/50",
              )}
            >
              {done ? "✓" : "○"}
            </span>
            <h3 className="text-sm font-semibold tracking-[-0.01em]">
              {checkpoint.label}
            </h3>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {checkpoint.question}
          </p>
        </div>
        {done && (
          <span className="label-mono shrink-0 text-stage-report">
            Complete
          </span>
        )}
      </div>

      <Textarea
        rows={3}
        value={response}
        onChange={(event) => setResponse(event.target.value)}
        disabled={disabled}
        placeholder="Keep it short — one or two sentences."
        className="mt-3"
        aria-label={checkpoint.question}
      />

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant={done ? "outline" : "default"}
          onClick={() => void handleSave()}
          disabled={disabled || isSaving || !response.trim()}
        >
          {isSaving && <Loader2 className="size-3.5 animate-spin" />}
          {done ? "Update" : "Save & complete"}
        </Button>
      </div>
    </Card>
  );
}
