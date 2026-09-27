import { ThemeToggle } from "@/components/ThemeToggle";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { signOut } from "@/services/auth";
import { cn } from "@/lib/utils";
import {
  FileText,
  LayoutGrid,
  LogOut,
  Settings2,
  Users,
  Boxes,
  Timer,
  GitBranch,
  Brain,
  Database,
  FlaskConical,
  Receipt,
  ScrollText,
} from "lucide-react";
import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import type { ReactNode } from "react";

/**
 * Admin navigation. Deliberately its own shell — the admin surface should not
 * look like the student one, and it carries no student-only sections.
 */
const ADMIN_NAV = [
  { to: "/admin", label: "Dashboard", icon: LayoutGrid, end: true },
  { to: "/admin/hackathons", label: "Hackathons", icon: Boxes },
  { to: "/admin/teams", label: "Teams", icon: Users },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/simulations", label: "Simulations", icon: Timer },
  { to: "/admin/submissions", label: "Submissions", icon: FileText },
  { to: "/admin/repositories", label: "Repositories", icon: GitBranch },
  { to: "/admin/project-reviews", label: "Project Reviews", icon: Brain },
  { to: "/admin/ai", label: "AI Operations", icon: Receipt },
  { to: "/admin/playground", label: "Analysis Playground", icon: FlaskConical },
  { to: "/admin/data-management", label: "Data Management", icon: Database },
  { to: "/admin/audit-log", label: "Audit Log", icon: ScrollText },
  { to: "/admin/settings", label: "Settings", icon: Settings2 },
];

export function AdminLayout({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut();
      navigate("/", { replace: true });
    } catch {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="shrink-0">
              <Wordmark />
            </Link>
            <span className="label-mono hidden rounded border border-border px-2 py-1 text-muted-foreground sm:inline-block">
              Admin
            </span>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>

        {/* Admin sub-navigation */}
        <nav className="border-t border-border bg-card/40">
          <div className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-5 sm:px-8">
            {ADMIN_NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
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

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl px-5 py-10 sm:px-8 sm:py-12">
          {children}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 sm:px-8">
          <p className="label-mono text-muted-foreground">HackSim · Control</p>
          <p className="text-xs text-muted-foreground">
            {profile?.email ?? "—"}
          </p>
        </div>
      </footer>
    </div>
  );
}
