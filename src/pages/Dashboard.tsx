import { AppShell } from "@/layouts/AppShell";
import { ModuleCard } from "@/components/ModuleCard";
import { ErrorState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { isSupabaseConfigured } from "@/lib/supabase-config";
import {
  Blocks,
  FileText,
  Gauge,
  MessageSquareQuote,
  Presentation,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";
import { isAdmin } from "@/types";

const MODULES = [
  {
    step: "01",
    title: "Current Training",
    description:
      "Your active session — problem statement, elapsed time, and current checkpoint.",
    icon: Gauge,
  },
  {
    step: "02",
    title: "Hackathon",
    description:
      "The full simulation: timer, breaks, checkpoints, and your team’s workspace.",
    icon: Blocks,
  },
  {
    step: "03",
    title: "Presentation",
    description:
      "Rehearse a five-minute pitch with screen, camera, and microphone capture.",
    icon: Presentation,
  },
  {
    step: "04",
    title: "AI Defense",
    description:
      "Face an adaptive AI judge that asks dynamic questions and follows up.",
    icon: MessageSquareQuote,
  },
  {
    step: "05",
    title: "Training Report",
    description:
      "A final breakdown of every stage — what landed, what didn’t, what to fix next.",
    icon: FileText,
  },
];

export default function Dashboard() {
  const { profile, user, isLoading } = useAuth();

  const firstName = (profile?.name || user?.email || "there").split(" ")[0];
  const joined = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        {/* ── Welcome ───────────────────────────────────────────────── */}
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-10 sm:flex-row sm:items-end">
          <div>
            <p className="label-mono text-muted-foreground">Student dashboard</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
              Welcome to HackSim{isLoading ? "" : `, ${firstName}`}
            </h1>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
              Your training modules are being built one at a time. Here&rsquo;s
              what the full run will look like.
            </p>
          </div>

          {isAdmin(profile) && (
            <Button variant="outline" asChild className="shrink-0">
              <Link to="/admin">Open admin</Link>
            </Button>
          )}
        </div>

        {/* ── Account summary ───────────────────────────────────────── */}
        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          {[
            { label: "Email", value: user?.email ?? "—" },
            { label: "Role", value: profile?.role ?? "—" },
            { label: "Member since", value: joined ?? "—" },
          ].map((item) => (
            <div key={item.label} className="bg-background px-6 py-5">
              <p className="label-mono text-muted-foreground">{item.label}</p>
              <p className="mt-2 truncate text-sm font-medium capitalize">
                {item.value}
              </p>
            </div>
          ))}
        </div>

        {!isSupabaseConfigured && (
          <div className="mt-10">
            <ErrorState
              title="Supabase isn't connected"
              message="Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the project environment variables, then reload. Your account data can't load until then."
            />
          </div>
        )}

        {/* ── Modules ───────────────────────────────────────────────── */}
        <div className="mt-12">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold tracking-[-0.02em]">
              Training modules
            </h2>
            <span className="label-mono text-muted-foreground">
              0 of {MODULES.length} available
            </span>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((module) => (
              <ModuleCard key={module.title} {...module} />
            ))}
          </div>
        </div>

        {/* ── Honest status ─────────────────────────────────────────── */}
        <Card className="mt-8 flex flex-col items-start gap-3 border-dashed p-6">
          <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
            <Sparkles className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold">Nothing to train yet</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              This is the HackSim foundation build. Your account, session, and
              permissions are all live — the simulation itself lands in the next
              release.
            </p>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
