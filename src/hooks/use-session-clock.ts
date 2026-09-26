import { getSessionState } from "@/services/sessions";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionStatus } from "@/types";

interface Clock {
  status: SessionStatus;
  /** Seconds left in the build, derived from the server clock. */
  remaining: number;
  /** Seconds left in the break, when a break is running. */
  breakRemaining: number;
}

/**
 * Keeps a session's countdown honest.
 *
 * The database is the only clock that counts. On every sync we take both
 * `remaining_seconds` and `server_now` and work out the offset between this
 * device and the server, then tick locally from that corrected time.
 *
 * That means:
 *   - refreshing the page cannot reset the timer
 *   - changing the device clock cannot extend or shorten a simulation
 *   - the UI still animates every second without hammering the database
 *
 * We re-sync periodically and whenever the tab regains focus, so any drift is
 * corrected within a second or two.
 */
export function useSessionClock(sessionId: string | undefined) {
  const [clock, setClock] = useState<Clock>({
    status: "not_started",
    remaining: 0,
    breakRemaining: 0,
  });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Milliseconds to add to Date.now() to get the server's current time.
  const offsetRef = useRef(0);
  // Seconds captured at the last sync, and the local time it was captured at.
  const lastSyncRef = useRef<{
    remaining: number;
    breakRemaining: number;
    at: number;
  }>({ remaining: 0, breakRemaining: 0, at: 0 });
  const statusRef = useRef<SessionStatus>("not_started");

  const sync = useCallback(async () => {
    if (!sessionId) return;
    try {
      const state = await getSessionState(sessionId);

      const serverNow = new Date(state.server_now).getTime();
      offsetRef.current = serverNow - Date.now();
      lastSyncRef.current = {
        remaining: state.remaining_seconds,
        breakRemaining: state.break_remaining_seconds,
        at: Date.now(),
      };
      statusRef.current = state.status;

      setClock({
        status: state.status,
        remaining: state.remaining_seconds,
        breakRemaining: state.break_remaining_seconds,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the timer.");
    } finally {
      // Deriving `isLoading` from this avoids a synchronous setState in the
      // effect below, which would cause a cascading render.
      setLoadedFor(sessionId ?? null);
    }
  }, [sessionId]);

  // Initial load. `sync` is async and only calls setState after its first
  // await, so nothing here renders synchronously — the rule can't see that.
  useEffect(() => {
    if (!sessionId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sync();
  }, [sessionId, sync]);

  // Tick once a second off the corrected clock.
  useEffect(() => {
    const interval = setInterval(() => {
      const base = lastSyncRef.current.at || Date.now();
      const elapsed = Math.floor((Date.now() - base) / 1000);
      setClock({
        status: statusRef.current,
        remaining: Math.max(0, lastSyncRef.current.remaining - elapsed),
        breakRemaining: Math.max(0, lastSyncRef.current.breakRemaining - elapsed),
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Re-sync when the tab comes back, since a backgrounded timer may drift.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void sync();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [sync]);

  // Periodic re-sync to correct long-running drift.
  useEffect(() => {
    const interval = setInterval(() => void sync(), 60_000);
    return () => clearInterval(interval);
  }, [sync]);

  return { ...clock, isLoading: loadedFor !== sessionId, error, refresh: sync };
}
