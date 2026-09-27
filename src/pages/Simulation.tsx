import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useSessionClock } from "@/hooks/use-session-clock";
import { useFormatEngine } from "@/hooks/use-format-engine";
import {
  formatCountdown,
  lockProblemDiscovery,
  revealWildcard,
  saveProblemDiscovery,
  syncSessionPhase,
  type ProblemDiscovery,
  type WildcardReveal,
} from "@/lib/format-engine";
import { useAsync } from "@/hooks/use-async";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Wordmark } from "@/components/Wordmark";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import {
  getHackathonForSession,
  getSession,
  getTeamName,
  setSessionStatus,
} from "@/services/sessions";
import { getTeamRoster } from "@/services/teams";
import { friendlyError } from "@/services/errors";
import { Check, Loader2, Sparkles, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
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

  const [isMutating, setIsMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The scenario/format engine: brief per hackathon type (§1), server clock,
  // and the derived phase. Syncs the session through build-expiry on load.
  const engine = useFormatEngine(sessionId);
  useEffect(() => {
    if (sessionId) void syncSessionPhase(sessionId).then(() => engine.refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setIsMutating(false);
    }
  }

  const isLive = clock.status === "running";

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
        {actionError && (
          <div className="mb-6">
            <ErrorState title="Action failed" message={actionError} />
          </div>
        )}

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

              <ProblemDiscoveryPanel
                sessionId={sessionId}
                required={engine.brief?.hackathon.problem_discovery_required ?? false}
                disabled={!isLive}
              />

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

// ── Problem discovery (§1.3) ───────────────────────────────────────────────

interface DiscoveryDraft {
  problem_statement: string;
  why_it_matters: string;
  target_users: string;
  pain_point: string;
  proposed_solution: string;
  expected_outcome: string;
}

const DISCOVERY_FIELDS: {
  key: keyof DiscoveryDraft;
  label: string;
  placeholder: string;
}[] = [
  {
    key: "problem_statement",
    label: "Identified problem",
    placeholder: "What problem did you choose to solve?",
  },
  {
    key: "why_it_matters",
    label: "Why it matters",
    placeholder: "Who feels this problem, and what does it cost them?",
  },
  {
    key: "target_users",
    label: "Target users",
    placeholder: "Who exactly is this for?",
  },
  {
    key: "pain_point",
    label: "Current pain point",
    placeholder: "How do they cope today, and why does it fall short?",
  },
  {
    key: "proposed_solution",
    label: "Proposed solution",
    placeholder: "What will your team build?",
  },
  {
    key: "expected_outcome",
    label: "Expected outcome",
    placeholder: "What should be true when you are done?",
  },
];

function ProblemDiscoveryPanel({
  sessionId,
  required,
  disabled,
}: {
  sessionId: string;
  required: boolean;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<DiscoveryDraft>({
    problem_statement: "",
    why_it_matters: "",
    target_users: "",
    pain_point: "",
    proposed_solution: "",
    expected_outcome: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);

  // Load the team's existing draft, if one has been started. RLS scopes the
  // read to this team, and only the current draft is editable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("problem_discoveries")
        .select(
          "id, problem_statement, why_it_matters, target_users, pain_point, " +
            "proposed_solution, expected_outcome, status",
        )
        .eq("session_id", sessionId)
        .neq("status", "locked")
        .order("created_at", { ascending: false })
        .limit(1);
      if (!cancelled && data && data.length > 0) {
        const row = data[0] as unknown as Record<string, string>;
        setDraft({
          problem_statement: row.problem_statement ?? "",
          why_it_matters: row.why_it_matters ?? "",
          target_users: row.target_users ?? "",
          pain_point: row.pain_point ?? "",
          proposed_solution: row.proposed_solution ?? "",
          expected_outcome: row.expected_outcome ?? "",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function handleSave() {
    setIsSaving(true);
    setError(null);
    setMissing(null);
    try {
      await saveProblemDiscovery(sessionId, {
        problemStatement: draft.problem_statement,
        whyItMatters: draft.why_it_matters,
        targetUsers: draft.target_users,
        painPoint: draft.pain_point,
        proposedSolution: draft.proposed_solution,
        expectedOutcome: draft.expected_outcome,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLock() {
    setError(null);
    setMissing(null);
    try {
      const result = await lockProblemDiscovery(sessionId);
      if (!result.ok) {
        setMissing(result.missingFields);
        return;
      }
      setSaved(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't lock.");
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Problem discovery</h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {required
              ? "Identify the problem your team will solve. There is no single right answer — what matters is that you can defend the one you chose."
              : "Optional here — your hackathon does not require a discovered problem, but recording one sharpens the build."}
          </p>
        </div>
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {DISCOVERY_FIELDS.map((field) => (
          <div
            key={field.key}
            className={cn(
              "flex flex-col gap-1.5",
              field.key === "problem_statement" && "sm:col-span-2",
            )}
          >
            <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
            <Textarea
              rows={2}
              disabled={disabled}
              value={draft[field.key]}
              onChange={(e) => {
                setDraft((d) => ({ ...d, [field.key]: e.target.value }));
                setSaved(false);
              }}
              placeholder={field.placeholder}
            />
          </div>
        ))}
      </div>

      {missing && missing.length > 0 && (
        <p className="mt-3 text-xs text-destructive">
          Fill in {missing.length} more {missing.length === 1 ? "field" : "fields"} before locking:
          "" {missing.map((m) => m.replace(/_/g, " ")).join(", ")}.
        </p>
      )}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      {saved && !error && <p className="mt-3 text-xs text-stage-report">Draft saved.</p>}

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => void handleSave()} disabled={disabled || isSaving}>
          {isSaving && <Loader2 className="size-3.5 animate-spin" />}
          Save draft
        </Button>
        <Button size="sm" onClick={() => void handleLock()} disabled={disabled}>
          <Check className="size-3.5" />
          Lock problem
        </Button>
      </div>
    </Card>
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

