import { supabase } from "@/lib/supabase";
import { getProfile } from "@/services/auth";
import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import type { Profile } from "@/types";

/**
 * Single source of truth for the current session.
 *
 * Supabase restores the session from localStorage on load, so we start in a
 * loading state and resolve it once `getSession` settles. This is what makes
 * session persistence (and refreshing protected routes) work.
 */
export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // Which user id the current `profile` belongs to. Deriving the loading flag
  // from this keeps the effect free of synchronous setState calls.
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setIsLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
        setUser(nextSession?.user ?? null);
        setProfile(null);
        setProfileFor(null);
        setIsLoading(false);
      },
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // Load the profile row for the signed-in identity.
  useEffect(() => {
    if (!user) return;
    const userId = user.id;

    let active = true;

    getProfile(userId).then((next) => {
      if (!active) return;
      setProfile(next);
      setProfileFor(userId);
    });

    return () => {
      active = false;
    };
  }, [user]);

  // The profile is a second, slower round-trip than the session. Role-gated
  // routes must wait for it, otherwise a real admin briefly looks like a student.
  const isProfileLoading = user !== null && profileFor !== user.id;

  return {
    isLoading,
    isProfileLoading,
    session,
    user,
    profile,
    isAuthenticated: Boolean(session),
  };
}
