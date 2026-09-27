import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSessionClock } from "@/hooks/use-session-clock";
import { useFormatEngine } from "@/hooks/use-format-engine";
import {
  formatCountdown,
  revealWildcard,
  syncSessionPhase,
  type WildcardReveal,
} from "@/lib/format-engine";
import { useAsync } from "@/hooks/use-async";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Wordmark } from "@/components/Wordmark";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";import {
  getHackathonForSession,
  getSession,
  getTeamName,
} from "@/services/sessions";
import { getTeamRoster } from "@/services/teams";

import { Loader2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  type BuildSession,
  type Hackathon,
  type TeamMemberWithProfile,
} from "@/types";

export default function Simulation() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

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

  // The scenario/format engine: brief per hackathon type (§1), server clock,
  // and the derived phase. Syncs the session through build-expiry on load.
  const engine = useFormatEngine(sessionId);
  useEffect(() => {
    if (sessionId) void syncSessionPhase(sessionId).then(() => engine.refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // When the build ends, the page moves itself to the GitHub submission. The
  // window is short and its only job is the repository URL, so there is no
  // "finish" step to confirm and nothing to do on this view once time is up —
  // the timer crossing zero is the finish. The ref keeps the redirect a
  // one-shot even while the phase re-derives every second.
  const redirectedRef = useRef(false);
  useEffect(() => {
    if (engine.phase === "window" && sessionId && !redirectedRef.current) {
      redirectedRef.current = true;
      navigate(`/submission/${sessionId}`);
    }
  }, [engine.phase, sessionId, navigate]);

  if (!sessionId) {
    return (
      <Shell>
        <ErrorState message="No simulation was specified." />
      </Shell>
    );
  }

  // Server-derived phase (§13) drives the page state, not the legacy status
  // string: `session_state` self-heals an elapsed build to 'expired', which
  // would otherwise mask the submission window entirely. "window" shows the
  // submission banner, "closed" and "done" show the end-of-run cards, and
  // "build" is the working view.
  const phase = engine.phase;
  const finished = phase === "closed" || phase === "done";
  const inSubmissionWindow = phase === "window";
  const buildOver = phase === "window" || phase === "closed";
  const windowMinutes = engine.brief?.clock.github_submission_window_minutes ?? 0;
  const windowEnabled = engine.brief?.clock.github_submission_window_enabled ?? false;

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
                {finished ? "Finished" : inSubmissionWindow ? "Submission window" : "Time remaining"}
              </p>
              <p
                className={cn(
                  "font-mono text-2xl font-semibold tracking-tight tabular-nums",
                  finished || inSubmissionWindow ? "text-destructive" : "text-stage-report",
                )}
              >
                {finished
                  ? "00:00:00"
                  : inSubmissionWindow
                    ? formatCountdown(engine.windowRemaining)
                    : formatDuration(clock.remaining)}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8">
        {finished ? (
          <Card className="flex flex-col items-start gap-4 p-8">
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">
              {phase === "closed" ? "Time's Up" : "Simulation Completed"}
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {phase === "closed"
                ? windowEnabled
                  ? "The submission window has closed. Nothing further can be submitted for this run."
                  : "The build window closed — no submission window was configured for this hackathon."
                : "Your team finished this run. Your work is saved and ready for submission review."}
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
        ) : inSubmissionWindow ? (
          // §13.2 — the window is submission-only. The checkpoint panel is
          // replaced, not merely disabled: there is nothing to edit any more.
          <Card className="flex flex-col items-start gap-4 border-stage-report/50 bg-stage-report/5 p-8">
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">Build complete</h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              You have {windowMinutes} {windowMinutes === 1 ? "minute" : "minutes"} to submit your
              GitHub repository. This window is for submission only — coding has ended.
            </p>
            <Button asChild>
              <Link to={`/submission/${sessionId}`}>Go to submission</Link>
            </Button>
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div className="flex flex-col gap-6">
              <ProblemPanel hackathon={hackathon.data} />

              {engine.brief?.wildcard_scenario_id && (
                <WildcardCard
                  scenarioId={engine.brief.wildcard_scenario_id}
                  canReveal={buildOver}
                />
              )}
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
            </div>
          </div>
        )}
      </main>
    </Shell>
  );
}

// ── Wildcard reveal (§3.7) ─────────────────────────────────────────────────

function WildcardCard({ scenarioId, canReveal }: { scenarioId: string; canReveal: boolean }) {
  const [reveal, setReveal] = useState<WildcardReveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleReveal() {
    setIsLoading(true);
    setError(null);
    try {
      setReveal(await revealWildcard(scenarioId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not available yet.");
    } finally {
      setIsLoading(false);
    }
  }

  if (reveal) {
    const payload = reveal.payload as { scenario_text?: string; context?: string } | null;
    return (
      <Card className="border-stage-report/40 bg-stage-report/5 p-5">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">{reveal.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {payload?.scenario_text || "The scenario has been revealed."}
        </p>
        {payload?.context && (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {payload.context}
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card className="border-dashed p-5">
      <h2 className="text-sm font-semibold tracking-[-0.01em]">Wildcard scenario</h2>
      <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {canReveal
          ? "The build has ended — the wildcard is unlocked."
          : "This hackathon's scenario is sealed until the build ends. It cannot be viewed early — not by anyone, from any client."}
      </p>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <Button
        size="sm"
        variant="outline"
        className="mt-4"
        onClick={() => void handleReveal()}
        disabled={!canReveal || isLoading}
      >
        {isLoading && <Loader2 className="size-3.5 animate-spin" />}
        {canReveal ? "Reveal scenario" : "Locked until the build ends"}
      </Button>
    </Card>
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

