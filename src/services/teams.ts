import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import { isLive, type SessionStatus, type Team, type TeamMemberWithProfile } from "@/types";

/** The team the signed-in student belongs to, or null if they have none. */
export async function getMyTeam(): Promise<Team | null> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;

  const { data: member, error: memberError } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (memberError) {
    throw new Error(friendlyError(memberError, "Couldn't load your team."));
  }
  if (!member) return null;

  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("id, name, created_by, created_at, updated_at")
    .eq("id", member.team_id)
    .maybeSingle();

  if (teamError) throw new Error(friendlyError(teamError, "Couldn't load your team."));
  return (team as Team | null) ?? null;
}

/** Everyone on a team, with their contribution details. */
export async function getTeamRoster(
  teamId: string,
): Promise<TeamMemberWithProfile[]> {
  const { data, error } = await supabase.rpc("team_roster", {
    p_team_id: teamId,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't load the team."));

  return ((data ?? []) as RosterRow[]).map((row) => ({
    id: row.member_id,
    team_id: teamId,
    user_id: row.user_id,
    role: row.role,
    contribution_description: row.contribution_description,
    contribution_areas: row.contribution_areas ?? [],
    planned_responsibilities: row.planned_responsibilities,
    ai_tools: row.ai_tools,
    joined_at: row.joined_at,
    name: row.name,
    email: row.email,
  }));
}

export async function createTeam(name: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_team", {
    p_name: name.trim(),
  });

  if (error) throw new Error(friendlyError(error, "Couldn't create the team."));
  return data as string;
}

export async function addTeamMember(
  teamId: string,
  email: string,
): Promise<void> {
  const { error } = await supabase.rpc("add_team_member", {
    p_team_id: teamId,
    p_email: email.trim(),
  });

  if (error) throw new Error(friendlyError(error, "Couldn't add that member."));
}

export async function leaveTeam(teamId: string): Promise<void> {
  const { error } = await supabase.rpc("leave_team", { p_team_id: teamId });

  if (error) throw new Error(friendlyError(error, "Couldn't leave the team."));
}

export interface ContributionInput {
  role: string;
  contributionDescription: string;
  contributionAreas: string[];
  plannedResponsibilities: string;
  aiTools: string;
}

/** Saves the signed-in member's own contribution. RLS blocks editing others. */
export async function updateMyContribution(
  teamId: string,
  input: ContributionInput,
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("You must be signed in.");

  const { error } = await supabase
    .from("team_members")
    .update({
      role: input.role,
      contribution_description: input.contributionDescription,
      contribution_areas: input.contributionAreas,
      planned_responsibilities: input.plannedResponsibilities,
      ai_tools: input.aiTools,
    })
    .eq("team_id", teamId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(friendlyError(error, "Couldn't save your contribution."));
  }
}

// ── Admin ───────────────────────────────────────────────────────────────────

/** Row shape returned by the `team_roster` SQL function. */
interface RosterRow {
  member_id: string;
  user_id: string;
  name: string | null;
  email: string;
  role: string;
  contribution_description: string;
  contribution_areas: string[] | null;
  planned_responsibilities: string;
  ai_tools: string;
  joined_at: string;
}

export interface AdminTeamRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  member_count: number;
  live_status: SessionStatus;
  session_id: string | null;
}

export async function listTeamsForAdmin(): Promise<AdminTeamRow[]> {
  const { data, error } = await supabase.rpc("admin_teams");
  if (error) throw new Error(friendlyError(error, "Couldn't load teams."));

  return ((data ?? []) as AdminTeamRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    member_count: Number(row.member_count ?? 0),
    live_status: (row.live_status ?? "not_started") as SessionStatus,
    session_id: row.session_id,
  }));
}

export function isTeamLive(status: SessionStatus): boolean {
  return isLive(status);
}
