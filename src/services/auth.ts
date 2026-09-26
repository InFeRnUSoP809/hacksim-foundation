import { supabase } from "@/lib/supabase";
import type { Profile } from "@/types";

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

/** Turns a Supabase error into a message that is safe to show in the UI. */
export function authErrorMessage(error: unknown): string {
  if (!error) return "Something went wrong. Please try again.";

  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : "";

  // A failed fetch never reaches Supabase, so the raw "Failed to fetch" is
  // meaningless to a user. Name the actual cause instead.
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return (
      "Couldn't reach the HackSim server. Check your connection, then reload " +
      "the page. If this keeps happening, the Supabase settings may be wrong."
    );
  }

  if (/invalid login credentials/i.test(message)) {
    return "Incorrect email or password.";
  }
  if (/user already registered|already been registered/i.test(message)) {
    return "An account with this email already exists. Try signing in instead.";
  }
  if (/password should be at least|too short/i.test(message)) {
    return "Password must be at least 6 characters.";
  }
  if (/rate limit|too many|security purposes/i.test(message)) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Confirm your email address first, then sign in.";
  }

  return message || "Something went wrong. Please try again.";
}

export async function signUp({
  email,
  password,
  name,
}: SignUpInput): Promise<{ needsEmailConfirmation: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name },
    },
  });

  if (error) throw error;

  // The profile row is created by the `on_auth_user_created` trigger in
  // supabase/001_profiles.sql, which runs with elevated privileges and always
  // sets role = 'student'. Nothing to do here — inserting from the browser
  // would only ever be blocked by RLS.
  return { needsEmailConfirmation: !data.session };
}

export async function signIn({ email, password }: SignInInput): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, avatar_url, created_at, updated_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("[hacksim] failed to load profile:", error.message);
    return null;
  }
  return data as Profile | null;
}
