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
  addTeamMember,
  createTeam,
  getMyTeam,
  getTeamRoster,
  leaveTeam,
  updateMyContribution,
} from "@/services/teams";
import { UserPlus, Loader2, LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  CONTRIBUTION_AREAS,
  type ContributionArea,
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
          Create your team
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
  const me = roster.find((member) => member.user_id === currentUserId);

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

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        {/* Members */}
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Members</h2>
          {isLoadingRoster ? (
            <LoadingState label="Loading members" />
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {roster.map((member) => (
                <li key={member.id}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {member.name || member.email}
                          {member.user_id === currentUserId && (
                            <span className="label-mono ml-2 text-muted-foreground">
                              You
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {member.role}
                        </p>
                      </div>
                    </div>
                    {member.contribution_description && (
                      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                        {member.contribution_description}
                      </p>
                    )}
                    {member.contribution_areas.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {member.contribution_areas.map((area) => (
                          <span
                            key={area}
                            className="label-mono rounded border border-border px-1.5 py-0.5 text-muted-foreground"
                          >
                            {area}
                          </span>
                        ))}
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}

          <AddMember teamId={team.id} onAdded={onChanged} />
        </div>

        {/* Own contribution */}
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em]">
            Your contribution
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Tell the team what you are taking on. Nothing here is scored yet.
          </p>
          <div className="mt-4">
            {me ? (
              <ContributionForm
                teamId={team.id}
                member={me}
                onSaved={onChanged}
              />
            ) : (
              <Card className="p-5">
                <p className="text-sm text-muted-foreground">
                  Loading your details…
                </p>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
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

// ── Contribution ────────────────────────────────────────────────────────────

function ContributionForm({
  teamId,
  member,
  onSaved,
}: {
  teamId: string;
  member: TeamMemberWithProfile;
  onSaved: () => void;
}) {
  const [role, setRole] = useState(member.role);
  const [description, setDescription] = useState(member.contribution_description);
  const [areas, setAreas] = useState<string[]>(member.contribution_areas);
  const [responsibilities, setResponsibilities] = useState(
    member.planned_responsibilities,
  );
  const [aiTools, setAiTools] = useState(member.ai_tools);

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggleArea(area: ContributionArea) {
    setSaved(false);
    setAreas((current) =>
      current.includes(area)
        ? current.filter((item) => item !== area)
        : [...current, area],
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      await updateMyContribution(teamId, {
        role,
        contributionDescription: description,
        contributionAreas: areas,
        plannedResponsibilities: responsibilities,
        aiTools,
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
    <Card className="p-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="role">Role</Label>
          <select
            id="role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
              setSaved(false);
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {CONTRIBUTION_AREAS.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="description">Contribution description</Label>
          <Textarea
            id="description"
            rows={3}
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
                  onClick={() => toggleArea(area)}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
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
          <Label htmlFor="responsibilities">Planned responsibilities</Label>
          <Textarea
            id="responsibilities"
            rows={3}
            value={responsibilities}
            onChange={(event) => {
              setResponsibilities(event.target.value);
              setSaved(false);
            }}
            placeholder="Model training, the prediction service, and integration with the dashboard."
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ai-tools">AI tools used or expected</Label>
          <Input
            id="ai-tools"
            value={aiTools}
            onChange={(event) => {
              setAiTools(event.target.value);
              setSaved(false);
            }}
            placeholder="Gemini, GitHub Copilot"
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && !error && (
          <p className="text-xs text-stage-report">Saved.</p>
        )}

        <Button type="submit" size="sm" disabled={isSaving}>
          {isSaving && <Loader2 className="size-3.5 animate-spin" />}
          Save contribution
        </Button>
      </form>
    </Card>
  );
}
