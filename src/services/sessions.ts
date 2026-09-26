import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import {
  isLive,
  type BuildSession,
  type Hackathon,
  type SessionState,
  type SessionStatus,
} from "@/types";

/**
 * Starts a simulation. The database re-validates authentication, team
 * membership, practice availability, and session conflicts — this call cannot
 * bypass any of those rules even if the UI is manipulated.
 */
export async function startBuildSession(
  hackathonId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("start_build_session", {
    p_hackathon_id: hackathonId,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't start the simulation."));
  return data as string;
}

/**
 * The authoritative clock. `remaining_seconds` and `server_now` both come from
 * the database, so the timer is immune to a changed device clock and survives
 * any refresh.
 */
export async function getSessionState(
  sessionId: string,
): Promise<SessionState> {
  const { data, error } = await supabase.rpc("session_state", {
    p_session_id: sessionId,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't load the simulation."));

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Simulation not found.");

  return {
    status: row.status as SessionStatus,
    remaining_seconds: Number(row.remaining_seconds ?? 0),
    break_remaining_seconds: Number(row.break_remaining_seconds ?? 0),
    server_now: row.server_now,
  };
}

/**
 * The hackathon a session belongs to. Stays readable for that session's team
 * even after the admin switches practice mode off, so nobody mid-run loses the
 * brief they are working from.
 */
export async function getHackathonForSession(
  sessionId: string,
): Promise<Hackathon | null> {
  const { data, error } = await supabase.rpc("hackathon_for_session", {
    p_session_id: sessionId,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't load the brief."));

  const row = Array.isArray(data) ? data[0] : data;
  return (row as Hackathon | null) ?? null;
}

export async function getSession(
  sessionId: string,
): Promise<BuildSession | null> {
  const { data, error } = await supabase
    .from("build_sessions")
    .select(
      "id, hackathon_id, team_id, started_by, started_at, ends_at, break_ends_at, status, created_at, updated_at",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw new Error(friendlyError(error, "Couldn't load the simulation."));
  return (data as BuildSession | null) ?? null;
}

/** The signed-in student's most recent live session, if there is one. */
export async function getMyActiveSession(): Promise<BuildSession | null> {
  const { data, error } = await supabase
    .from("build_sessions")
    .select(
      "id, hackathon_id, team_id, started_by, started_at, ends_at, break_ends_at, status, created_at, updated_at",
    )
    .in("status", ["running", "break"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  const session = data as BuildSession | null;
  return session && isLive(session.status) ? session : null;
}

/**
 * Moves a live session between active, break, and completed. The database
 * refuses anything else, so a student cannot extend a timer or resurrect an
 * expired session.
 */
export async function setSessionStatus(
  sessionId: string,
  status: "running" | "break" | "completed",
  breakMinutes?: number,
): Promise<void> {
  const { error } = await supabase.rpc("set_session_status", {
    p_session_id: sessionId,
    p_status: status,
    p_break_minutes: breakMinutes ?? null,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't update the simulation."));
}

/** A team's name, for the simulation header. */
export async function getTeamName(teamId: string): Promise<string> {
  const { data, error } = await supabase
    .from("teams")
    .select("name")
    .eq("id", teamId)
    .maybeSingle();

  if (error) return "—";
  return (data?.name as string | undefined) ?? "—";
}

// ── Admin ───────────────────────────────────────────────────────────────────

export interface AdminSessionRow {
  id: string;
  team_id: string;
  team_name: string;
  hackathon_id: string;
  hackathon_name: string;
  started_by: string;
  started_by_name: string;
  started_at: string;
  ends_at: string;
  status: SessionStatus;
}

export async function listSessionsForAdmin(): Promise<AdminSessionRow[]> {
  const { data, error } = await supabase.rpc("admin_sessions");
  if (error) throw new Error(friendlyError(error, "Couldn't load simulations."));

  return ((data ?? []) as AdminSessionRow[]).map((row) => ({
    id: row.id,
    team_id: row.team_id,
    team_name: row.team_name,
    hackathon_id: row.hackathon_id,
    hackathon_name: row.hackathon_name,
    started_by: row.started_by,
    started_by_name: row.started_by_name,
    started_at: row.started_at,
    ends_at: row.ends_at,
    status: row.status as SessionStatus,
  }));
}
