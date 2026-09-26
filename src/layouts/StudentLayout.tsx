import { ThemeToggle } from "@/components/ThemeToggle";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { getMyActiveSession } from "@/services/sessions";
import { signOut } from "@/services/auth";
import { cn } from "@/lib/utils";
import { FileText, LayoutGrid, LogOut, ScrollText, Timer, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import type { ReactNode } from "react";

/**
 * Student chrome. The Simulation entry only appears once there is a live run —
 * there is nothing to link to before then.
 */
export function StudentLayout({ children }: { children: ReactNode }) {
  const { profile, user } = useAuth();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getMyActiveSession()
      .then((session) => {
        if (active) setActiveSessionId(session?.id ?? null);
      })
      .catch(() => {
        if (active) setActiveSessionId(null);
      });
    return () => {
      active = false;
    };
  }, []);

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
    { to: "/dashboard", label: "Dashboard", icon: LayoutGrid },
    { to: "/hackathon", label: "Hackathon", icon: ScrollText },
    { to: "/team", label: "My Team", icon: Users },
    ...(activeSessionId
      ? [
          {
            to: `/simulation/${activeSessionId}`,
            label: "Simulation",
            icon: Timer,
          },
          {
            to: `/submission/${activeSessionId}`,
            label: "Submission",
            icon: FileText,
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link to="/dashboard" className="shrink-0">
            <Wordmark />
          </Link>

          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSignOut}
              disabled={isSigningOut}
              aria-label="Sign out"
            >
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>

        <nav className="border-t border-border bg-card/40">
          <div className="mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-5 sm:px-8">
            {links.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                    isActive
                      ? "border-brand text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )
                }
              >
                <Icon className="size-3.5" />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-2 px-5 py-6 sm:flex-row sm:px-8">
          <p className="label-mono text-muted-foreground">
            HackSim · Practice. Build. Defend. Improve.
          </p>
          <p className="text-xs text-muted-foreground">
            {profile?.full_name || user?.email || "—"}
          </p>
        </div>
      </footer>
    </div>
  );
}
