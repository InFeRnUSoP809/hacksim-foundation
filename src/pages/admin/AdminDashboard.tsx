import { AdminLayout } from "@/layouts/AdminLayout";
import { StatCard } from "@/components/StatCard";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { getPracticeHackathon } from "@/services/hackathons";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import { formatMinutes } from "@/lib/format";
import {
  Activity,
  Boxes,
  CheckCircle2,
  FileText,
  Users,
  UsersRound,
} from "lucide-react";
import { Link } from "react-router";
import type { Hackathon } from "@/types";

interface AdminStats {
  users: number;
  teams: number;
  active_sessions: number;
  completed_sessions: number;
  submissions: number;
}

/** Counts come from a database function, so the overview is one round trip. */
async function loadStats(): Promise<AdminStats> {
  const { data, error } = await supabase.rpc("admin_stats");
  if (error) throw new Error(friendlyError(error));
  return data as AdminStats;
}

export default function AdminDashboard() {
  const practice = useAsync<Hackathon | null>(
    () => getPracticeHackathon(),
    [],
  );
  const counts = useAsync<AdminStats>(() => loadStats(), []);

  const current = practice.data;
  const practiceOn = Boolean(current);

  return (
    <AdminLayout>
      <div className="flex flex-col gap-2">
        <p className="label-mono text-brand">Control</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">
          Practice overview
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Whether practice is open, what is running, and how many teams are
          taking part.
        </p>
      </div>

      {counts.error && (
        <div className="mt-8">
          <ErrorState
            title="Couldn't load counts"
            message={counts.error}
            action={
              <Button size="sm" variant="outline" onClick={counts.reload}>
                Try again
              </Button>
            }
          />
        </div>
      )}

      {counts.isLoading && !counts.error ? (
        <LoadingState label="Loading overview" />
      ) : (
        <>
          {/* ── Practice status ─────────────────────────────────── */}
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <Card
              className={
                practiceOn
                  ? "flex flex-col gap-3 border-stage-report/40 p-6"
                  : "flex flex-col gap-3 p-6"
              }
            >
              <p className="label-mono text-muted-foreground">
                Practice hackathon
              </p>
              <p className="flex items-center gap-3 text-3xl font-semibold tracking-[-0.03em]">
                <span
                  aria-hidden
                  className={
                    practiceOn
                      ? "size-3 rounded-full bg-stage-report"
                      : "size-3 rounded-full border-2 border-muted-foreground"
                  }
                />
                {practiceOn ? "ON" : "OFF"}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {practiceOn
                  ? "Students can see the brief and start a new simulation."
                  : "No hackathon is open for practice. Students cannot start a new simulation."}
              </p>
              <Button size="sm" variant="outline" asChild className="w-fit">
                <Link to="/admin/hackathons">
                  {practiceOn ? "Change practice hackathon" : "Open practice"}
                </Link>
              </Button>
            </Card>

            <Card className="flex flex-col gap-3 p-6">
              <p className="label-mono text-muted-foreground">
                Current practice hackathon
              </p>
              {practice.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : current ? (
                <>
                  <p className="text-2xl font-semibold tracking-[-0.02em]">
                    {current.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatMinutes(current.simulation_duration_minutes)} build window
                  </p>
                </>
              ) : (
                <p className="text-lg font-medium text-muted-foreground">
                  None active
                </p>
              )}
            </Card>
          </div>

          {/* ── Counts ─────────────────────────────────────────── */}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatCard
              label="Active simulations"
              value={counts.data?.active_sessions ?? 0}
              icon={Activity}
            />
            <StatCard
              label="Completed simulations"
              value={counts.data?.completed_sessions ?? 0}
              icon={CheckCircle2}
            />
            <StatCard
              label="Teams"
              value={counts.data?.teams ?? 0}
              icon={UsersRound}
            />
            <StatCard
              label="Submissions"
              value={counts.data?.submissions ?? 0}
              icon={FileText}
            />
            <StatCard
              label="Users"
              value={counts.data?.users ?? 0}
              icon={Users}
            />
          </div>

          <Card className="mt-4 flex items-start gap-3 border-dashed p-5">
            <Boxes className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Switching practice off stops new simulations immediately. Any
              simulation already running continues untouched and keeps its brief.
            </p>
          </Card>
        </>
      )}
    </AdminLayout>
  );
}
