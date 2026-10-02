import { useAuth } from "@/hooks/use-auth";
import { adminAccessDecision } from "@/lib/admin-access";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

/**
 * Wraps a route that requires the `admin` role.
 *
 * The role comes from the caller's own `users` row, which Row Level Security
 * locks down to that user — so a signed-in student cannot read or fake an
 * admin role from the browser.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isLoading, isProfileLoading, isAuthenticated, profile } = useAuth();
  const location = useLocation();

  const returnTo = `${location.pathname}${location.search}`;
  const signInHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;

  // Wait for the profile round-trip too, so a real admin is never shown the
  // "access required" screen just because their role hadn't loaded yet.
  if (isLoading || (isAuthenticated && isProfileLoading)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const decision = adminAccessDecision({
    authenticated: isAuthenticated,
    role: profile?.role,
  });

  if (decision === "login") {
    return <Navigate to={signInHref} replace />;
  }

  // A signed-in student who types /admin (or any nested admin URL) is sent
  // back to their own dashboard. The admin tree is not rendered.
  if (decision === "dashboard") {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
