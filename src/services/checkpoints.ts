import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import { CHECKPOINTS, type BuildCheckpoint, type CheckpointType } from "@/types";

const COLUMNS =
  "id, session_id, checkpoint_type, response, completed_at, created_at, updated_at";

/** Every checkpoint for a session, whether answered or not. */
export async function getCheckpoints(
  sessionId: string,
): Promise<BuildCheckpoint[]> {
  const { data, error } = await supabase
    .from("build_checkpoints")
    .select(COLUMNS)
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(friendlyError(error, "Couldn't load the checkpoints."));
  }
  return (data as BuildCheckpoint[]) ?? [];
}

export function checkpointByType(
  checkpoints: BuildCheckpoint[],
  type: CheckpointType,
): BuildCheckpoint | undefined {
  return checkpoints.find((checkpoint) => checkpoint.checkpoint_type === type);
}

/**
 * Saves an answer and marks the checkpoint complete.
 *
 * Row Level Security allows this only while the session is genuinely `active`,
 * so once the database marks it expired the write simply stops being allowed —
 * no client-side check is relied upon.
 */
export async function saveCheckpoint(
  sessionId: string,
  type: CheckpointType,
  response: string,
): Promise<void> {
  const trimmed = response.trim();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("build_checkpoints")
    .upsert(
      {
        session_id: sessionId,
        checkpoint_type: type,
        response: trimmed,
        completed_at: now,
      },
      { onConflict: "session_id,checkpoint_type" },
    );

  if (error) {
    throw new Error(
      friendlyError(
        error,
        "Couldn't save the checkpoint. It may be locked because the simulation isn't running.",
      ),
    );
  }
}

/** The first checkpoint that has not been completed yet. */
export function nextCheckpointType(
  checkpoints: BuildCheckpoint[],
): CheckpointType | null {
  const done = new Set(
    checkpoints.filter((c) => c.completed_at).map((c) => c.checkpoint_type),
  );
  return CHECKPOINTS.find((c) => !done.has(c.type))?.type ?? null;
}
