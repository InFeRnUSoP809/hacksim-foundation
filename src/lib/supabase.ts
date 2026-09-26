import { createClient } from "@supabase/supabase-js";
import { isSupabaseConfigured } from "@/lib/supabase-config";

export { isSupabaseConfigured };

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * The anon key is designed to be public — it is only ever paired with Row
 * Level Security on the Supabase side. The service-role key must never be
 * referenced from this file (or any other frontend module).
 */
if (!isSupabaseConfigured) {
  console.error(
    "[hacksim] Supabase is not configured. Set VITE_SUPABASE_URL and " +
      "VITE_SUPABASE_ANON_KEY in the project environment variables.",
  );
}

/**
 * Single shared client for the whole app. Supabase persists the session in
 * localStorage, so auth survives refreshes and app restarts without any extra
 * work from us.
 */
export const supabase = createClient(
  url ?? "http://localhost:54321",
  anonKey ?? "public-anon-key-placeholder",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);
