import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/services/auth";
import { Loader2, LogOut } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import type { ReactNode } from "react";
import { isAdmin } from "@/types";
import { cn } from "@/lib/utils";

/**
 * Chrome for every signed-in screen: a single quiet top bar with the wordmark,
 * the two real destinations, and sign-out. Kept deliberately flat — no sidebar
 * until there is enough navigation to justify one.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { profile, user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const displayName = profile?.name || user?.email || "Account";

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut();
      navigate("/", { replace: true });
    } catch {
      setIsSigningOut(false);
    }
  }

  const links = [
    { to: "/dashboard", label: "Dashboard" },
    ...(isAdmin(profile)
      ? [{ to: "/admin", label: "Admin" }]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link to="/dashboard" className="shrink-0">
            <Wordmark />
          </Link>

          <nav className="flex items-center gap-1">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="max-w-[14ch] truncate text-sm font-medium leading-tight">
                {isLoading ? "…" : displayName}
              </p>
              <p className="label-mono mt-0.5 text-muted-foreground">
                {profile?.role ?? "—"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              {isSigningOut ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogOut className="size-3.5" />
              )}
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-5 py-6 sm:flex-row sm:px-8">
          <p className="label-mono text-muted-foreground">
            HackSim · Practice. Build. Defend. Improve.
          </p>
          <p className="text-xs text-muted-foreground">
            Foundation build · v0.1
          </p>
        </div>
      </footer>
    </div>
  );
}
