/** The two roles HackSim recognises today. */
export const ROLES = ["student", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Row shape of the public `users` table (see supabase/schema.sql). */
export interface Profile {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
}

export function isAdmin(profile: Profile | null): boolean {
  return profile?.role === "admin";
}
