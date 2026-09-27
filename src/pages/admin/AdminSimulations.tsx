import { AdminLayout } from "@/layouts/AdminLayout";
import { SessionStatusPill } from "@/components/StatusPill";
import { ErrorState, LoadingState } from "@/components/States";
import { Card } from "@/components/ui/card";
import { useSessionClock } from "@/hooks/use-session-clock";
import { useAsync } from "@/hooks/use-async";
import { formatDateTime, formatDuration } from "@/lib/format";
import {
  getAdminWindowSnapshot,
  listSessionsForAdmin,
  type AdminWindowSnapshot,
} from "@/services/sessions";
import { useState } from "react";
import { ChevronLeft, Timer } from "lucide-react";
import { isLive } from "@/types";
import type { AdminSessionRow } from "@/services/sessions";

export default function AdminSimulations() {
  const sessions = useAsync<AdminSessionRow[]>(() => listSessionsForAdmin(), []);
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    return (
      <SimulationDetail
        sessionId={selected}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          Simulations
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every run students have started. Timers here are read-only.
        </p>
      </div>

      <div className="mt-8">
        {sessions.isLoading ? (
          <LoadingState label="Loading simulations" />
        ) : sessions.error ? (
          <ErrorState message={sessions.error} />
        ) : (sessions.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Timer className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">No simulations yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              A run appears here the moment a team starts one.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Team
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Hackathon
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Status
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Started
                    </th>
                    <th className="label-mono px-5 py-3 text-muted-foreground">
                      Time remaining
                    </th>
                  </tr>
                </thead>
                <tbody>                    {(sessions.data ?? []).map((session) => (
                    <tr
                      key={session.id}
                      onClick={() => setSelected(session.id)}
                      className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-secondary/50"
                    >
                      <td className="px-5 py-3.5 font-medium">
                        {session.team_name}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {session.hackathon_name}
                      </td>
                      <td className="px-5 py-3.5">
                        <SessionStatusPill status={session.status} />
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground">
                        {formatDateTime(session.started_at)}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs">
                        {isLive(session.status) ? (
                          <SessionCountdown sessionId={session.id} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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

/** Read-only countdown for the admin table. */
function SessionCountdown({ sessionId }: { sessionId: string }) {
  const { remaining } = useSessionClock(sessionId);
  return <span>{formatDuration(remaining)}</span>;
}

function SimulationDetail({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const sessions = useAsync<AdminSessionRow[]>(() => listSessionsForAdmin(), []);
  const clock = useSessionClock(sessionId);
  const windowInfo = useAsync<AdminWindowSnapshot | null>(
    () => getAdminWindowSnapshot(sessionId),
    [sessionId],
  );

  const session = sessions.data?.find((row) => row.id === sessionId);

  return (
    <AdminLayout>
      <button
        type="button"
        onClick={onBack}
        className="label-mono mb-4 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Back to simulations
      </button>

      <h1 className="text-3xl font-semibold tracking-[-0.03em]">
        {session?.team_name ?? "Simulation"}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {session && <SessionStatusPill status={session.status} />}
        <span className="text-sm text-muted-foreground">
          {session?.hackathon_name}
        </span>
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <p className="label-mono text-muted-foreground">Started by</p>
          <p className="mt-2 text-sm font-medium">
            {session?.started_by_name ?? "—"}
          </p>
        </Card>
        <Card className="p-5">
          <p className="label-mono text-muted-foreground">Start time</p>
          <p className="mt-2 text-sm font-medium">
            {session ? formatDateTime(session.started_at) : "—"}
          </p>
        </Card>
        <Card className="p-5">
          <p className="label-mono text-muted-foreground">Time remaining</p>
          <p className="mt-2 font-mono text-lg font-semibold">
            {isLive(session?.status ?? "not_started")
              ? formatDuration(clock.remaining)
              : "—"}
          </p>
        </Card>
      </div>

      <Card className="mt-4 p-5">
        <p className="label-mono text-muted-foreground">
          Submission window (snapshotted when this run started)
        </p>
        {windowInfo.isLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : windowInfo.error ? (
          <p className="mt-2 text-sm text-destructive">{windowInfo.error}</p>
        ) : windowInfo.data?.github_submission_window_enabled ? (
          <>
            <p className="mt-2 text-sm font-medium">
              Enabled — {windowInfo.data.github_submission_window_minutes}{' '}
              {(windowInfo.data.github_submission_window_minutes ?? 0) === 1 ? 'minute' : 'minutes'}{' '}
              after the build end
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Opens{' '}
              {(windowInfo.data.build_ends_at ?? windowInfo.data.ends_at) &&
                formatDateTime(
                  (windowInfo.data.build_ends_at ?? windowInfo.data.ends_at)!,
                )}
              {windowInfo.data.github_submission_ends_at &&
                ` · closes ${formatDateTime(windowInfo.data.github_submission_ends_at)}`}
            </p>
          </>
        ) : (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-destructive">
            Disabled on this session — it expires with no GitHub upload phase.
            The snapshot was taken at start, so enabling the window on the
            hackathon now only affects runs started afterwards.
          </p>
        )}
      </Card>
    </AdminLayout>
  );
}
