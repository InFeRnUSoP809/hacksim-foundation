import { StudentLayout } from "@/layouts/StudentLayout";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { formatMinutes } from "@/lib/format";
import { getPracticeHackathon } from "@/services/hackathons";
import { getMyActiveSession, startBuildSession } from "@/services/sessions";
import { getMyTeam } from "@/services/teams";
import { friendlyError } from "@/services/errors";
import { ArrowLeft, CircleSlash, Clock, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { BuildSession, Hackathon, Team } from "@/types";

const SECTIONS = [
  { key: "problem_statement", label: "Problem Statement" },
  { key: "requirements", label: "Requirements" },
  { key: "constraints", label: "Constraints" },
  { key: "expected_outcome", label: "Expected Outcome" },
  { key: "evaluation_criteria", label: "Evaluation Criteria" },
] as const;

export default function HackathonPage() {
  const confirm = useConfirmDialog();
  const navigate = useNavigate();

  const practice = useAsync<Hackathon | null>(() => getPracticeHackathon(), []);
  const team = useAsync<Team | null>(() => getMyTeam(), []);
  const session = useAsync<BuildSession | null>(() => getMyActiveSession(), []);

  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const hackathon = practice.data ?? null;

  async function handleStart() {
    if (!hackathon) return;

    const confirmed = await confirm.ask({
      title: "Start your hackathon timer?",
      message:
        "You are about to start your hackathon timer. The timer will begin immediately and runs against the database clock, so it cannot be paused or reset.",
      confirmLabel: "Start Simulation",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    setStartError(null);
    setIsStarting(true);
    try {
      const sessionId = await startBuildSession(hackathon.id);
      navigate(`/simulation/${sessionId}`);
    } catch (err) {
      setStartError(friendlyError(err));
      setIsStarting(false);
    }
  }

  return (
    <StudentLayout>
      <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8 sm:py-12">
        <Link
          to="/dashboard"
          className="label-mono mb-6 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Dashboard
        </Link>

        {practice.isLoading ? (
          <LoadingState label="Loading the brief" />
        ) : practice.error ? (
          <ErrorState message={practice.error} />
        ) : !hackathon ? (
          <Card className="flex flex-col items-start gap-4 p-8">
            <div className="grid size-10 place-items-center rounded-lg border border-border bg-secondary/50">
              <CircleSlash className="size-4 text-muted-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-[-0.02em]">
                No Practice Hackathon Available
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                There is currently no practice hackathon running. Check back
                later.
              </p>
            </div>
          </Card>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <p className="label-mono text-brand">Practice hackathon</p>
              <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                {hackathon.name}
              </h1>
              <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="size-4" />
                Time limit: {formatMinutes(hackathon.simulation_duration_minutes)}
              </p>
            </div>

            {startError && (
              <div className="mt-6">
                <ErrorState title="Couldn't start" message={startError} />
              </div>
            )}

            <div className="mt-8 flex flex-col gap-8">
              {SECTIONS.map((section) => {
                const value = hackathon[section.key];
                return (
                  <section key={section.key}>
                    <h2 className="text-sm font-semibold tracking-[-0.01em]">
                      {section.label}
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                      {value || "Not specified for this hackathon."}
                    </p>
                  </section>
                );
              })}
            </div>

            <div className="mt-10 border-t border-border pt-8">
              {session.data ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    Your team already has a run in progress.
                  </p>
                  <Button asChild>
                    <Link to={`/simulation/${session.data.id}`}>
                      Continue Simulation
                    </Link>
                  </Button>
                </div>
              ) : !team.data ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    You need a team before you can start a simulation.
                  </p>
                  <Button asChild>
                    <Link to="/team">Set up your team</Link>
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    Starting as <span className="font-medium text-foreground">{team.data.name}</span>.
                  </p>
                  <Button onClick={() => void handleStart()} disabled={isStarting}>
                    {isStarting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Play className="size-4" />
                    )}
                    Start Simulation
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </StudentLayout>
  );
}
