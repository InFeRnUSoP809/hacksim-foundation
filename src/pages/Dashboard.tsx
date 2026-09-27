import { StudentLayout } from "@/layouts/StudentLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { SessionStatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { useAuth } from "@/hooks/use-auth";
import { getPracticeHackathon } from "@/services/hackathons";
import { getMyActiveSession } from "@/services/sessions";
import { getMyTeam } from "@/services/teams";
import { formatDuration, formatMinutes } from "@/lib/format";
import { ArrowRight, CircleSlash, Clock, FileText, Play, Users } from "lucide-react";
import { Link } from "react-router";
import type { BuildSession, Hackathon, Team } from "@/types";

export default function StudentDashboard() {
  const { profile, user } = useAuth();
  const practice = useAsync<Hackathon | null>(() => getPracticeHackathon(), []);
  const team = useAsync<Team | null>(() => getMyTeam(), []);
  const session = useAsync<BuildSession | null>(() => getMyActiveSession(), []);

  const firstName = (profile?.full_name || user?.email || "there").split(" ")[0];
  const hackathon = practice.data ?? null;
  const activeSession = session.data ?? null;

  return (
    <StudentLayout>
      <div className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-12">
        <div>
          <p className="label-mono text-brand">Your dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
            Welcome, {firstName}
          </h1>
        </div>

        {practice.isLoading ? (
          <LoadingState label="Checking practice availability" />
        ) : practice.error ? (
          <div className="mt-8">
            <ErrorState message={practice.error} />
          </div>
        ) : !hackathon ? (
          <NoPracticeHackathon />
        ) : (
          <ActivePractice hackathon={hackathon} team={team.data} session={activeSession} />
        )}
      </div>
    </StudentLayout>
  );
}

/**
 * Shown whenever practice is switched off. Deliberately reveals nothing about
 * any brief — the database refuses to hand one over in this state anyway.
 */
function NoPracticeHackathon() {
  return (
    <Card className="mt-8 flex flex-col items-start gap-4 p-8">
      <div className="grid size-10 place-items-center rounded-lg border border-border bg-secondary/50">
        <CircleSlash className="size-4 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-[-0.02em]">
          No Practice Hackathon Available
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          There is currently no practice hackathon running. Check back later.
        </p>
      </div>
    </Card>
  );
}

function ActivePractice({
  hackathon,
  team,
  session,
}: {
  hackathon: Hackathon;
  team: Team | null;
  session: BuildSession | null;
}) {
  const preview = hackathon.problem_statement.trim().slice(0, 220);
  const truncated = hackathon.problem_statement.trim().length > 220;

  return (
    <>
      <Card className="mt-8 flex flex-col gap-6 p-6 sm:p-8">
        <div className="flex flex-col gap-2">
          <p className="label-mono text-muted-foreground">
            Current practice hackathon
          </p>
          <h2 className="text-2xl font-semibold tracking-[-0.025em]">
            {hackathon.name}
          </h2>
        </div>

        {preview ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {preview}
            {truncated && "…"}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            The brief has not been written yet. Check back shortly.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4" />
            {formatMinutes(hackathon.simulation_duration_minutes)} build window
          </span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="size-4" />
            {team ? `Team: ${team.name}` : "No team yet"}
          </span>
          {session && (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              Simulation
              <SessionStatusPill status={session.status} />
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link to="/hackathon">
              View Hackathon
              <ArrowRight className="size-4" />
            </Link>
          </Button>

          {session ? (
            <Button asChild>
              <Link to={`/simulation/${session.id}`}>
                <Play className="size-4" />
                Continue Simulation
              </Link>
            </Button>
          ) : (
            <Button asChild>
              <Link to={team ? "/hackathon" : "/team"}>
                <Play className="size-4" />
                {team ? "Start Simulation" : "Create a team to start"}
              </Link>
            </Button>
          )}
        </div>
      </Card>

      {!team && (
        <Card className="mt-4 flex flex-col items-start gap-3 border-dashed p-6">
          <p className="text-sm font-semibold">You need a team first</p>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            A simulation is run by a team, not an individual. Create one, or ask
            a teammate to add you by email.
          </p>
          <Button size="sm" variant="outline" asChild>
            <Link to="/team">Set up your team</Link>
          </Button>
        </Card>
      )}

      {team && !session && (
        <p className="label-mono mt-6 text-muted-foreground">
          Time limit {formatDuration(hackathon.simulation_duration_minutes * 60)}{" "}
          · starts the moment you begin
        </p>
      )}

      {session && (
        <Card className="mt-4 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-secondary/50">
              <FileText className="size-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
                Submission
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Record your project and the repository it lives in. Locked for
                good once you submit.
              </p>
            </div>
          </div>
          <Button size="sm" asChild className="shrink-0">
            <Link to={`/submission/${session.id}`}>Open submission</Link>
          </Button>
        </Card>
      )}
    </>
  );
}
