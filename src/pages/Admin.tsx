import { AppShell } from "@/layouts/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  Bot,
  FolderGit2,
  LayoutGrid,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Link } from "react-router";

const FUTURE_CONTROLS = [
  {
    title: "Hackathons",
    description:
      "Create problem statements, schedules, checkpoints, and simulation rules.",
    icon: LayoutGrid,
  },
  {
    title: "Users",
    description: "View accounts, assign roles, and manage access across the platform.",
    icon: Users,
  },
  {
    title: "Teams",
    description: "Oversee team formation, membership, and participation.",
    icon: FolderGit2,
  },
  {
    title: "Submissions",
    description: "Review project submissions, repository links, and review status.",
    icon: Settings2,
  },
  {
    title: "AI settings",
    description: "Configure the review, defense, and question-generation models.",
    icon: Bot,
  },
  {
    title: "Roles & access",
    description: "Assign the admin role. RLS policies already restrict every table.",
    icon: ShieldCheck,
  },
];

export default function Admin() {
  const { profile } = useAuth();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-10 sm:flex-row sm:items-end">
          <div>
            <p className="label-mono text-muted-foreground">Restricted area</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
              HackSim Admin
            </h1>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
              Signed in as{" "}
              <span className="font-medium text-foreground">
                {profile?.email ?? "an administrator"}
              </span>
              . These controls are being built and are not active yet.
            </p>
          </div>

          <Button variant="outline" asChild className="shrink-0">
            <Link to="/dashboard">Back to dashboard</Link>
          </Button>
        </div>

        <div className="mt-10">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold tracking-[-0.02em]">
              Future controls
            </h2>
            <span className="label-mono text-muted-foreground">Not implemented</span>
          </div>

          <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {FUTURE_CONTROLS.map(({ title, description, icon: Icon }) => (
              <div
                key={title}
                className="flex flex-col gap-3 bg-background p-6"
              >
                <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
                  <Icon className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold tracking-[-0.01em]">
                    {title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                </div>
                <p className="label-mono mt-auto border-t border-border pt-4 text-muted-foreground">
                  Coming soon
                </p>
              </div>
            ))}
          </div>
        </div>

        <Card className="mt-8 border-dashed p-6">
          <p className="text-sm font-semibold">Admin controls are locked</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Nothing on this page can change data yet. The role check and Row
            Level Security policies are already live, so access is enforced
            before any feature exists.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
