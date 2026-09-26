import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import type { SessionStatus, Team, TeamMemberWithProfile } from "@/types";

/** Row shape returned by the `team_roster` SQL function. */
interface RosterRow {
  member_id: string;
  user_id: string;
  full_name: string | null;
  email: string;
  role: string;
  joined_at: string;
}

function toMember(teamId: string, row: RosterRow): TeamMemberWithProfile {
  return {
    id: row.member_id,
    team_id: teamId,
    user_id: row.user_id,
    role: row.role,
    joined_at: row.joined_at,
    full_name: row.full_name,
    email: row.email,
  };
}

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

/** Everyone on a team, with the profile fields the UI displays. */
export async function getTeamRoster(
  teamId: string,
): Promise<TeamMemberWithProfile[]> {
  const { data, error } = await supabase.rpc("team_roster", { p_team_id: teamId });
  if (error) throw new Error(friendlyError(error, "Couldn't load the team."));
  return ((data ?? []) as RosterRow[]).map((row) => toMember(teamId, row));
}

export async function createTeam(name: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_team", { p_name: name.trim() });
  if (error) throw new Error(friendlyError(error, "Couldn't create the team."));
  return data as string;
}

export async function addTeamMember(teamId: string, email: string): Promise<void> {
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

export async function updateMemberRole(
  teamId: string,
  userId: string,
  role: string,
): Promise<void> {
  const { error } = await supabase
    .from("team_members")
    .update({ role })
    .eq("team_id", teamId)
    .eq("user_id", userId);

  if (error) throw new Error(friendlyError(error, "Couldn't update the role."));
}

// ── Admin ───────────────────────────────────────────────────────────────────

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
    ...row,
    member_count: Number(row.member_count ?? 0),
  }));
}
