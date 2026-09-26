import { StudentLayout } from "@/layouts/StudentLayout";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useAsync } from "@/hooks/use-async";
import { friendlyError } from "@/services/errors";
import { getMyActiveSession } from "@/services/sessions";
import {
  addTeamMember,
  createTeam,
  getMyTeam,
  getTeamRoster,
  leaveTeam,
  updateMemberRole,
} from "@/services/teams";
import { FileText, Loader2, LogOut, UserPlus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  CONTRIBUTION_AREAS,
  type Team,
  type TeamMemberWithProfile,
} from "@/types";

export default function MyTeam() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirmDialog();

  const team = useAsync<Team | null>(() => getMyTeam(), []);
  const roster = useAsync<TeamMemberWithProfile[]>(
    () => (team.data ? getTeamRoster(team.data.id) : Promise.resolve([])),
    [team.data?.id],
  );

  if (team.isLoading) {
    return (
      <StudentLayout>
        <div className="mx-auto w-full max-w-4xl px-5 py-12 sm:px-8">
          <LoadingState label="Loading your team" />
        </div>
      </StudentLayout>
    );
  }

  if (team.error) {
    return (
      <StudentLayout>
        <div className="mx-auto w-full max-w-4xl px-5 py-12 sm:px-8">
          <ErrorState message={team.error} />
        </div>
      </StudentLayout>
    );
  }

  return (
    <StudentLayout>
      <div className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-8 sm:py-12">
        {team.data ? (
          <TeamView
            team={team.data}
            roster={roster.data ?? []}
            isLoadingRoster={roster.isLoading}
            rosterError={roster.error}
            currentUserId={user?.id ?? null}
            onChanged={() => {
              roster.reload();
              team.reload();
            }}
            onLeave={async () => {
              await leaveTeam(team.data!.id);
              team.reload();
              navigate("/dashboard");
            }}
            confirm={confirm}
          />
        ) : (
          <CreateTeam
            onCreated={() => {
              team.reload();
              roster.reload();
            }}
          />
        )}
      </div>
    </StudentLayout>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreateTeam({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      await createTeam(name);
      onCreated();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <div>
        <p className="label-mono text-brand">Your team</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
          You haven't joined a team yet.
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
          A simulation is run by a team. Create one now, or ask somebody else to
          add you by email from their team page.
        </p>
      </div>

      {error && (
        <div className="mt-6">
          <ErrorState title="Couldn't create team" message={error} />
        </div>
      )}

      <Card className="mt-8 max-w-md p-6">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="team-name">Team name</Label>
            <Input
              id="team-name"
              required
              minLength={2}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Team Alpha"
            />
          </div>
          <Button type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            Create team
          </Button>
        </form>
      </Card>
    </>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

function TeamView({
  team,
  roster,
  isLoadingRoster,
  rosterError,
  currentUserId,
  onChanged,
  onLeave,
  confirm,
}: {
  team: Team;
  roster: TeamMemberWithProfile[];
  isLoadingRoster: boolean;
  rosterError: string | null;
  currentUserId: string | null;
  onChanged: () => void;
  onLeave: () => Promise<void>;
  confirm: ReturnType<typeof useConfirmDialog>;
}) {
  const session = useAsync(() => getMyActiveSession(), []);

  async function handleLeave() {
    const confirmed = await confirm.ask({
      title: `Leave ${team.name}?`,
      message:
        "You will need to join or create another team before you can take part in a simulation.",
      confirmLabel: "Leave team",
      cancelLabel: "Cancel",
      tone: "danger",
    });
    if (confirmed) await onLeave();
  }

  return (
    <>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="label-mono text-brand">Your team</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
            {team.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {roster.length} {roster.length === 1 ? "member" : "members"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void handleLeave()}>
          <LogOut className="size-3.5" />
          Leave team
        </Button>
      </div>

      {rosterError && (
        <div className="mt-6">
          <ErrorState message={rosterError} />
        </div>
      )}

      {/* Contribution lives with the submission, so it is edited there. */}
      <Card className="mt-8 flex flex-col items-start gap-3 p-6">
        <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
          <FileText className="size-4 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
            Your contribution
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Each member describes what they built, which areas they covered, and
            any AI tools they used. It is recorded on the submission, so nobody
            can change it after the team submits.
          </p>
        </div>
        {session.data ? (
          <Button size="sm" variant="outline" asChild>
            <Link to={`/submission/${session.data.id}`}>
              Open the submission
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            Available once your simulation starts
          </Button>
        )}
      </Card>

      <div className="mt-8">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Members</h2>
        {isLoadingRoster ? (
          <LoadingState label="Loading members" />
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {roster.map((member) => (
              <li key={member.id}>
                <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {member.full_name || member.email}
                      {member.user_id === currentUserId && (
                        <span className="label-mono ml-2 text-muted-foreground">
                          You
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {member.email}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <RoleSelect
                      teamId={team.id}
                      member={member}
                      onChanged={onChanged}
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

        <AddMember teamId={team.id} onAdded={onChanged} />
      </div>
    </>
  );
}

// ── Role ────────────────────────────────────────────────────────────────────

function RoleSelect({
  teamId,
  member,
  onChanged,
}: {
  teamId: string;
  member: TeamMemberWithProfile;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function handleChange(role: string) {
    setError(null);
    try {
      await updateMemberRole(teamId, member.user_id, role);
      onChanged();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Select value={member.role} onValueChange={(v) => void handleChange(v)}>
        <SelectTrigger className="w-[160px]" aria-label={`Role for ${member.email}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONTRIBUTION_AREAS.map((area) => (
            <SelectItem key={area} value={area}>
              {area}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ── Add member ──────────────────────────────────────────────────────────────

function AddMember({
  teamId,
  onAdded,
}: {
  teamId: string;
  onAdded: () => void;
}) {
  const [email, setEmail] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      await addTeamMember(teamId, email);
      setEmail("");
      setDone(true);
      onAdded();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="mt-4 p-5">
      <div className="flex items-center gap-2">
        <UserPlus className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold tracking-[-0.01em]">Add member</h3>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        They need a HackSim account already.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
        <Input
          type="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setDone(false);
          }}
          placeholder="teammate@example.com"
          aria-label="Teammate email"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {done && !error && (
          <p className="text-xs text-stage-report">Added to your team.</p>
        )}
        <Button type="submit" size="sm" variant="outline" disabled={isSaving}>
          {isSaving && <Loader2 className="size-3.5 animate-spin" />}
          Add to team
        </Button>
      </form>
    </Card>
  );
}
