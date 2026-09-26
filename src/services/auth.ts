import { supabase } from "@/lib/supabase";
import type { Profile, Role } from "@/types";

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
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    if (/invalid login credentials/i.test(message)) {
      return "Incorrect email or password.";
    }
    if (/user already registered/i.test(message)) {
      return "An account with this email already exists.";
    }
    if (/password should be at least/i.test(message)) {
      return "Password must be at least 6 characters.";
    }
    if (/rate limit|too many/i.test(message)) {
      return "Too many attempts. Please wait a moment and try again.";
    }
    return message;
  }
  return "Something went wrong. Please try again.";
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

  // The profile row is normally created by the `on_auth_user_created` trigger
  // in supabase/schema.sql, which runs with elevated privileges. This insert is
  // only a best-effort fallback, and RLS deliberately blocks it in the normal
  // case — so a failure here is expected and harmless.
  if (data.user && data.session) {
    const { error: profileError } = await supabase.from("users").upsert(
      { id: data.user.id, email, name, role: "student" as Role },
      { onConflict: "id" },
    );
    if (profileError) {
      console.warn(
        "[hacksim] profile fallback insert skipped (the DB trigger handles this):",
        profileError.message,
      );
    }
  }

  return { needsEmailConfirmation: !data.session };
}

export async function signIn({
  email,
  password,
}: SignInInput): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, email, name, role, created_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("[hacksim] failed to load profile:", error.message);
    return null;
  }
  return data as Profile | null;
}
