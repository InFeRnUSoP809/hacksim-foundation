import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { isAdmin } from "@/types";
import { Loader2, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";

/**
 * Wraps a route that requires the `admin` role.
 *
 * The role comes from the caller's own `users` row, which Row Level Security
 * locks down to that user — so a signed-in student cannot read or fake an
 * admin role from the browser.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isLoading, isProfileLoading, isAuthenticated, profile, user } =
    useAuth();
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

  if (!isAuthenticated) {
    return <Navigate to={signInHref} replace />;
  }

  if (!isAdmin(profile)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
        <Card className="w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="mb-2 grid size-11 place-items-center rounded-full bg-muted">
              <ShieldAlert className="size-4 text-muted-foreground" />
            </div>
            <CardTitle className="text-lg tracking-[-0.01em]">
              Admin access required
            </CardTitle>
            <CardDescription>
              This area is limited to HackSim administrators.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            You&rsquo;re signed in as{" "}
            <span className="font-medium text-foreground">
              {user?.email ?? "this account"}
            </span>
            , which doesn&rsquo;t have the admin role.
          </CardContent>
          <CardFooter className="flex-col gap-2">
            <Button className="w-full" asChild>
              <Link to="/dashboard">Back to dashboard</Link>
            </Button>
            <Button variant="ghost" className="w-full" asChild>
              <Link to="/">Back to home</Link>
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return children;
}
