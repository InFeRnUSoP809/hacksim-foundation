import { getSessionBrief, type SessionBrief } from "@/lib/format-engine";
import { friendlyError } from "@/services/errors";
import { useCallback, useEffect, useReducer, useState } from "react";

export type SimulationPhase = "build" | "window" | "closed" | "done";

/**
 * Where the session is in time, from server-derived seconds corrected by the
 * time since the last fetch.
 *
 * The boundary values themselves are never computed here — only decremented
 * between syncs. The poll and the visibility resync keep that correction
 * within a couple of seconds of the database's own clock, and a page refresh
 * refetches rather than resetting anything.
 */
function derivePhase(clock: SessionBrief["clock"], elapsedSeconds: number): SimulationPhase {
  if (clock.status === "submitted" || clock.status === "cancelled") return "done";
  if (clock.status === "github_submission_expired") return "closed";

  const buildOver = clock.build_seconds_remaining - elapsedSeconds <= 0;
  const windowEnabled = clock.github_submission_window_enabled && clock.github_submission_window_minutes > 0;
  const windowSecondsLeft = clock.github_window_seconds_remaining - elapsedSeconds;
  if (!buildOver) return "build";
  if (windowEnabled && windowSecondsLeft > 0) return "window";
  return "closed";
}

/**
 * The scenario/format engine, as a hook.
 *
 * One fetch carries the brief (what the participant may see of the hackathon,
 * per §1.4), the required fields for the format, and the server clock. The
 * clock is re-polled on an interval and whenever the tab regains focus, so a
 * backgrounded timer or a doctored device clock cannot drift the phase.
 */
export function useFormatEngine(sessionId: string | undefined) {
  const [brief, setBrief] = useState<SessionBrief | null>(null);
  const [syncedAt, setSyncedAt] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-render once a second so the countdowns move. Nothing else in the hook
  // recomputes on this tick — the values below are cheap arithmetic off the
  // last sync.
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await getSessionBrief(sessionId);
      setBrief(data);
      setSyncedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : friendlyError(err, "Couldn't load the brief."));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const poll = setInterval(() => void load(), 20_000);
    return () => clearInterval(poll);
  }, [load]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void load();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  useEffect(() => {
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  const elapsed = syncedAt ? Math.max(0, Math.floor((Date.now() - syncedAt) / 1000)) : 0;

  return {
    brief,
    phase: brief ? derivePhase(brief.clock, elapsed) : ("build" as SimulationPhase),
    buildRemaining: Math.max(0, (brief?.clock.build_seconds_remaining ?? 0) - elapsed),
    windowRemaining: Math.max(0, (brief?.clock.github_window_seconds_remaining ?? 0) - elapsed),
    isLoading,
    error,
    refresh: load,
  };
}
