import { analyzeRepository, getSubmissionAnalysis, runReview } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";

/**
 * The admin analysis playground.
 *
 * Reuses the production pipeline unchanged — same scan, same review, same
 * storage — on a disposable submission created just for the test. Nothing here
 * calls a different endpoint than the student flow does; the only new code is
 * the creation and cleanup of the throwaway rows.
 */

export interface PlaygroundEntry {
  submission_id: string;
  project_name: string;
  github_url: string;
  created_at: string;
}

export async function listPlayground(): Promise<PlaygroundEntry[]> {
  const { data, error } = await supabase.rpc("admin_playground_list");
  if (error) throw new Error(friendlyError(error, "Couldn't load playground submissions."));
  return (data as PlaygroundEntry[]) ?? [];
}

export async function createPlayground(githubUrl: string, projectName: string): Promise<{
  submission_id: string;
  project_name: string;
}> {
  const { data, error } = await supabase.rpc("create_admin_playground_submission", {
    p_github_url: githubUrl,
    p_project_name: projectName,
  });
  if (error) throw new Error(friendlyError(error, "Couldn't create the test submission."));
  return data as { submission_id: string; project_name: string };
}

/** Deletes every playground team; the FK cascades clear everything under them. */
export async function resetPlayground(): Promise<number> {
  const { data, error } = await supabase.rpc("admin_playground_reset");
  if (error) throw new Error(friendlyError(error, "Couldn't reset the playground."));
  return Number(data ?? 0);
}

export {
  analyzeRepository as scanRepository,
  runReview as runPlaygroundReview,
  getSubmissionAnalysis as getPlaygroundAnalysis,
};
