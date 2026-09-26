import { AppShell } from "@/layouts/AppShell";
import { StageRail } from "@/components/StageChip";
import { ErrorState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { isSupabaseConfigured } from "@/lib/supabase-config";
import { Search, Sparkles, Upload } from "lucide-react";
import { Link } from "react-router";
import { STAGES, isAdmin } from "@/types";

/**
 * Stages the participant will walk through, in order. Progress is not tracked
 * yet, so every stage renders as an honest "not started" — no fake numbers.
 */
const STAGE_DETAIL: Record<string, string> = {
  build: "A live brief, a build window, and checkpoints to keep the team honest.",
  submit: "Hand in a repository and a write-up before the deadline closes.",
  present: "Rehearse a five-minute pitch with screen, camera, and microphone.",
  defend: "Answer a live AI panel that follows up on whatever sounds weakest.",
  report: "Read the whole run back: what held, what didn't, what to fix next.",
};

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
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="label-mono text-brand">Your dashboard</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
              {isLoading ? "Welcome to HackSim" : `Welcome, ${firstName}`}
            </h1>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
              This is where your runs, submissions, and feedback will collect.
              Nothing has started yet.
            </p>
          </div>

          {isAdmin(profile) && (
            <Button variant="outline" asChild className="shrink-0">
              <Link to="/admin">Open admin</Link>
            </Button>
          )}
        </div>

        {!isSupabaseConfigured && (
          <div className="mt-8">
            <ErrorState
              title="Supabase isn't connected"
              message="Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the project environment variables, then reload. Your account data can't load until then."
            />
          </div>
        )}

        {/* ── Progress through the arc ──────────────────────────────── */}
        <div className="mt-10">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold tracking-[-0.02em]">
              Your run
            </h2>
            <span className="label-mono text-muted-foreground">
              0 of {STAGES.length} complete
            </span>
          </div>

          <Card className="mt-5 p-6 sm:p-8">
            <StageRail active={[]} className="mb-8" />

            <ol className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
              {STAGES.map((stage, index) => (
                <li
                  key={stage.id}
                  className="flex flex-col gap-2 bg-background p-5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: stage.hue }}
                    />
                    <span className="label-mono text-muted-foreground">
                      Stage {index + 1}
                    </span>
                  </div>
                  <p className="text-sm font-semibold tracking-[-0.01em]">
                    {stage.label}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {STAGE_DETAIL[stage.id]}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        {/* ── Account ───────────────────────────────────────────────── */}
        <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          {[
            { label: "Email", value: user?.email ?? "—" },
            { label: "Access", value: profile?.role ?? "—" },
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

        {/* ── Next actions ──────────────────────────────────────────── */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Card className="flex flex-col items-start gap-4 p-6">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Search className="size-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
                Find a scenario
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Browse the catalog and pick a brief. Enrolment opens with the
                build stage.
              </p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/catalog">Open the catalog</Link>
            </Button>
          </Card>

          <Card className="flex flex-col items-start gap-4 p-6">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Upload className="size-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
                Bring your own work
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Repositories, write-ups, and attachments live in your workspace.
                Uploads arrive with Storage.
              </p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/workspace">Open workspace</Link>
            </Button>
          </Card>
        </div>

        {/* ── Honest status ─────────────────────────────────────────── */}
        <Card className="mt-8 flex flex-col items-start gap-3 border-dashed p-6">
          <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
            <Sparkles className="size-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold">No runs yet</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Your account, session, and permissions are all live. The
              simulation itself lands in the next release — so every card above
              is real, and none of it is faked.
            </p>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
