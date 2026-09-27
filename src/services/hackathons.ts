import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import type { Hackathon, HackathonDraft } from "@/types";

/**
 * The single practice hackathon students may currently start, or null when
 * practice mode is off. Nothing about it is hardcoded in the client — the row
 * itself decides.
 *
 * Row Level Security already limits students to exactly this row, so a
 * signed-out or student caller can never read a different hackathon.
 */
export async function getPracticeHackathon(): Promise<Hackathon | null> {
  const { data, error } = await supabase
    .from("hackathons")
    .select(
      "id, name, problem_statement, requirements, constraints, expected_outcome, evaluation_criteria, simulation_duration_minutes, status, practice_enabled, created_at, updated_at",
    )
    .eq("practice_enabled", true)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(friendlyError(error, "Couldn't load the hackathon."));
  return (data as Hackathon | null) ?? null;
}

/** Every hackathon. Admin only — RLS rejects this for students. */
export async function listHackathons(): Promise<Hackathon[]> {
  const { data, error } = await supabase
    .from("hackathons")
    .select(
      "id, name, problem_statement, requirements, constraints, expected_outcome, evaluation_criteria, simulation_duration_minutes, status, practice_enabled, created_at, updated_at",
    )
    .order("created_at", { ascending: false });

  if (error) throw new Error(friendlyError(error, "Couldn't load hackathons."));
  return (data as Hackathon[]) ?? [];
}

export async function getHackathon(id: string): Promise<Hackathon | null> {
  const { data, error } = await supabase
    .from("hackathons")
    .select(
      "id, name, problem_statement, requirements, constraints, expected_outcome, evaluation_criteria, simulation_duration_minutes, status, practice_enabled, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(friendlyError(error, "Couldn't load the hackathon."));
  return (data as Hackathon | null) ?? null;
}

export async function createHackathon(
  draft: HackathonDraft,
): Promise<Hackathon> {
  const { data, error } = await supabase
    .from("hackathons")
    .insert({ ...draft, practice_enabled: false })
    .select(
      "id, name, problem_statement, requirements, constraints, expected_outcome, evaluation_criteria, simulation_duration_minutes, github_submission_window_enabled, github_submission_window_minutes, status, practice_enabled, created_at, updated_at",
    )
    .single();

  if (error) throw new Error(friendlyError(error, "Couldn't create the hackathon."));
  return data as Hackathon;
}

export async function updateHackathon(
  id: string,
  draft: HackathonDraft,
): Promise<Hackathon> {
  const { data, error } = await supabase
    .from("hackathons")
    .update(draft)
    .eq("id", id)
    .select(
      "id, name, problem_statement, requirements, constraints, expected_outcome, evaluation_criteria, simulation_duration_minutes, github_submission_window_enabled, github_submission_window_minutes, status, practice_enabled, created_at, updated_at",
    )
    .single();

  if (error) throw new Error(friendlyError(error, "Couldn't save the hackathon."));
  return data as Hackathon;
}

/** Archive, never delete — running sessions reference this row. */
export async function archiveHackathon(id: string): Promise<void> {
  const { error } = await supabase
    .from("hackathons")
    .update({ status: "archived" })
    .eq("id", id);

  if (error) throw new Error(friendlyError(error, "Couldn't archive the hackathon."));
}

/**
 * Turns practice mode on for exactly one hackathon and off for the rest.
 * Pass null to switch practice off entirely.
 *
 * The database performs the swap, so this is safe against a double-click and
 * can never leave two practice hackathons enabled.
 */
export async function setPracticeHackathon(
  hackathonId: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_practice_hackathon", {
    p_hackathon_id: hackathonId,
  });

  if (error) throw new Error(friendlyError(error, "Couldn't change practice mode."));
}
