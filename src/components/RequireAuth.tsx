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
import { Loader2, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";

/**
 * Wraps a route that requires a signed-in user.
 *
 * Signed-out visitors get a clear explanation on the page they asked for, and
 * signing in returns them to it via `returnTo`. Pass `redirectImmediately` for
 * a route where the bounce straight to the sign-in screen is the right call.
 */
export function RequireAuth({
  children,
  title = "Sign in to continue",
  description = "This page is only available to signed-in users.",
  redirectImmediately = false,
}: {
  children: ReactNode;
  title?: string;
  description?: string;
  redirectImmediately?: boolean;
}) {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  const returnTo = `${location.pathname}${location.search}`;
  const signInHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!isAuthenticated) {
    if (redirectImmediately) {
      return <Navigate to={signInHref} replace />;
    }
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
        <Card className="w-full max-w-md">
          <CardHeader className="items-center text-center">
            <div className="mb-2 grid size-11 place-items-center rounded-full bg-muted">
              <Lock className="size-4 text-muted-foreground" />
            </div>
            <CardTitle className="text-lg tracking-[-0.01em]">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="text-center text-sm text-muted-foreground">
            You&rsquo;ll come straight back to this page once you&rsquo;re
            signed in.
          </CardContent>
          <CardFooter className="flex-col gap-2">
            <Button className="w-full" asChild>
              <Link to={signInHref}>Sign in</Link>
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
