/**
 * Supabase configuration.
 *
 * The intended source of truth is the environment — set `VITE_SUPABASE_URL` and
 * `VITE_SUPABASE_ANON_KEY` through the project's Keys / API keys panel and
 * delete the fallback below. Environment variables always take precedence.
 *
 * The fallback exists because the anon key is, by Supabase's own design, a
 * PUBLIC credential: it is only ever paired with Row Level Security, which is
 * enabled on every table in supabase/schema.sql. It is not a secret, and it
 * cannot read or write anything a signed-in user could not already do.
 *
 * The service-role key must never appear in this file, or any other module
 * that ships to the browser.
 */

const FALLBACK_URL = "https://ntkuqpuqxtdohgtmhemt.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50a3VxcHVxeHRkb2hndG1oZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MzIxMzAsImV4cCI6MjEwNjAwODEzMH0.Ol_vBhFWjCeITgSMHWiCs4pEarRyx0PB3Y--xn-EoCI";

/** `import.meta.env` only exists under Vite — guard so plain Node can read this. */
const env =
  typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env
    ? ((import.meta as { env: Record<string, string> }).env ?? {})
    : {};

export const SUPABASE_URL =
  (env.VITE_SUPABASE_URL as string | undefined)?.trim() || FALLBACK_URL;

export const SUPABASE_ANON_KEY =
  (env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ||
  FALLBACK_ANON_KEY;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
