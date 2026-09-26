import { AppShell } from "@/layouts/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { SCENARIOS, TRACKS } from "@/services/catalog";
import {
  Bot,
  FolderGit2,
  LayoutGrid,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Link } from "react-router";

/** The four areas an admin will manage, with what each will eventually do. */
const SECTIONS = [
  {
    title: "Scenarios",
    body: "Author briefs, set the clock, weight the stages, and control enrolment.",
    icon: LayoutGrid,
    meta: `${SCENARIOS.length} published · ${TRACKS.length} tracks`,
  },
  {
    title: "People",
    body: "Invite cohorts, assign access, and move accounts between student and admin.",
    icon: Users,
    meta: "Access control",
  },
  {
    title: "Submitted work",
    body: "Review what participants upload, and moderate anything flagged.",
    icon: FolderGit2,
    meta: "Storage-backed",
  },
  {
    title: "AI settings",
    body: "Choose the models behind project review, questioning, and feedback.",
    icon: Bot,
    meta: "Not configured",
  },
];

export default function Admin() {
  const { profile } = useAuth();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="label-mono text-brand">Admin</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
              Control room
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
              Signed in as{" "}
              <span className="font-medium text-foreground">
                {profile?.email ?? "an administrator"}
              </span>
              . Everything HackSim runs is managed from here.
            </p>
          </div>

          <Button variant="outline" asChild className="shrink-0">
            <Link to="/dashboard">Back to dashboard</Link>
          </Button>
        </div>

        {/* ── Management areas ──────────────────────────────────────── */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {SECTIONS.map(({ title, body, icon: Icon, meta }) => (
            <Card
              key={title}
              className="flex flex-col gap-4 p-6 transition-colors hover:border-foreground/20"
            >
              <div className="flex items-center justify-between">
                <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
                  <Icon className="size-4" />
                </div>
                <span className="label-mono text-muted-foreground">{meta}</span>
              </div>
              <div>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                  {title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {body}
                </p>
              </div>
              <div className="mt-auto border-t border-border pt-4">
                <span className="label-mono text-muted-foreground">
                  Coming soon
                </span>
              </div>
            </Card>
          ))}
        </div>

        {/* ── What's already enforced ──────────────────────────────── */}
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3 p-6">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <ShieldCheck className="size-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold tracking-[-0.01em]">
                Access control is live
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                You reached this page because your account holds the admin role.
                That role is read from your own row, and Row Level Security
                blocks everyone else from reading it or changing it.
              </p>
            </div>
          </Card>

          <Card className="flex flex-col gap-3 p-6">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Settings2 className="size-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold tracking-[-0.01em]">
                The controls are not
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Nothing on this page can change data yet. Each area above is a
                real surface for a feature that has not been built — no actions
                are stubbed out to look finished.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
