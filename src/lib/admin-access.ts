/**
 * Decision for an admin route, independent of React.
 *
 * A student who types /admin must be sent back to the dashboard. The role
 * comes from the profiles row, not from the URL and not from client-supplied
 * metadata.
 */
export type AdminAccess = "allow" | "login" | "dashboard";

export function adminAccessDecision(input: {
  authenticated: boolean;
  role: string | null | undefined;
}): AdminAccess {
  if (!input.authenticated) return "login";
  if (input.role !== "admin") return "dashboard";
  return "allow";
}
