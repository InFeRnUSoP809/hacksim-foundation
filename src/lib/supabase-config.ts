/**
 * Supabase configuration check, kept free of any Supabase imports.
 *
 * The public landing page only needs to know whether the env vars are present,
 * so it must not pull `@supabase/supabase-js` (~220 kB) into its bundle.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);
