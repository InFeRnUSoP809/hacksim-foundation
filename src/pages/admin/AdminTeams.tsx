import { AdminLayout } from "@/layouts/AdminLayout";
import { SessionStatusPill } from "@/components/StatusPill";
import { ErrorState, LoadingState } from "@/components/States";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { useState } from "react";
import { formatDate } from "@/lib/format";
import { getTeamRoster, listTeamsForAdmin } from "@/services/teams";
import type { AdminTeamRow } from "@/services/teams";
import type { TeamMemberWithProfile } from "@/types";
import { ChevronLeft, Users } from "lucide-react";

export default function AdminTeams() {
  const teams = useAsync<AdminTeamRow[]>(() => listTeamsForAdmin(), []);
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    return <TeamDetail teamId={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">Teams</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every team students have created, with who is on it and where its run
          has got to.
        </p>
      </div>

      <div className="mt-8">
        {teams.isLoading ? (
          <LoadingState label="Loading teams" />
        ) : teams.error ? (
          <ErrorState message={teams.error} />
        ) : (teams.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Users className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">No teams yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Teams appear here as soon as a student creates one.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono px-5 py-3 text-muted-foreground">
                    Team
                  </th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">
                    Members
                  </th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">
                    Simulation
                  </th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {(teams.data ?? []).map((team) => (
                  <tr
                    key={team.id}
                    onClick={() => setSelected(team.id)}
                    className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-secondary/50"
                  >
                    <td className="px-5 py-3.5 font-medium">{team.name}</td>
                    <td className="px-5 py-3.5 text-muted-foreground">
                      {team.member_count}{" "}
                      {team.member_count === 1 ? "member" : "members"}
                    </td>
                    <td className="px-5 py-3.5">
                      <SessionStatusPill status={team.live_status} />
                    </td>
                    <td className="px-5 py-3.5 text-muted-foreground">
                      {formatDate(team.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}

function TeamDetail({
  teamId,
  onBack,
}: {
  teamId: string;
  onBack: () => void;
}) {
  const teams = useAsync<AdminTeamRow[]>(() => listTeamsForAdmin(), []);
  const roster = useAsync<TeamMemberWithProfile[]>(
    () => getTeamRoster(teamId),
    [teamId],
  );

  const team = teams.data?.find((row) => row.id === teamId);

  return (
    <AdminLayout>
      <button
        type="button"
        onClick={onBack}
        className="label-mono mb-4 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        Back to teams
      </button>

      <h1 className="text-3xl font-semibold tracking-[-0.03em]">
        {team?.name ?? "Team"}
      </h1>
      {team && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SessionStatusPill status={team.live_status} />
          <span className="label-mono text-muted-foreground">
            {team.member_count}{" "}
            {team.member_count === 1 ? "member" : "members"}
          </span>
        </div>
      )}

      <div className="mt-8">
        {roster.isLoading ? (
          <LoadingState label="Loading members" />
        ) : roster.error ? (
          <ErrorState message={roster.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {roster.data?.map((member) => (
              <Card key={member.id} className="flex flex-col gap-3 p-5">
                <div>
                  <p className="text-base font-semibold tracking-[-0.01em]">
                    {member.full_name || member.email}
                  </p>
                  <p className="text-sm text-muted-foreground">{member.email}</p>
                </div>

                <div>
                  <p className="label-mono text-muted-foreground">Role</p>
                  <p className="mt-1.5 text-sm">{member.role}</p>
                </div>

                <p className="text-xs text-muted-foreground">
                  Contribution detail is recorded on the team&rsquo;s submission.
                </p>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
