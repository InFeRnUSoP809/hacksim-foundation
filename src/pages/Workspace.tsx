import { AppShell } from "@/layouts/AppShell";
import { StageRail } from "@/components/StageChip";
import { ErrorState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { isSupabaseConfigured } from "@/lib/supabase-config";
import { FileUp, FolderOpen, Link2, Sparkles } from "lucide-react";

/**
 * A participant's own material: project descriptions, repository links, and
 * anything they attach to a run.
 *
 * Storage is not connected yet, so this page is an honest shell — the layout
 * and copy are final, the upload path lands with Supabase Storage in the next
 * build. Nothing here pretends to have saved anything.
 */
export default function Workspace() {
  const { profile, user } = useAuth();

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="flex flex-col justify-between gap-6 border-b border-border pb-8 sm:flex-row sm:items-end">
          <div>
            <p className="label-mono text-brand">Your material</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
              Workspace
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
              Everything you bring into a run lives here — the brief you
              worked from, your repository, and the write-up that gets
              submitted. Only you can see it.
            </p>
          </div>
          <p className="label-mono shrink-0 text-muted-foreground">
            {profile?.email ?? user?.email ?? "—"}
          </p>
        </div>

        {!isSupabaseConfigured && (
          <div className="mt-8">
            <ErrorState
              title="Supabase isn't connected"
              message="Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to load your material."
            />
          </div>
        )}

        {/* ── What a submission carries ───────────────────────────── */}
        <div className="mt-10">
          <h2 className="text-lg font-semibold tracking-[-0.02em]">
            What a submission carries
          </h2>
          <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
            {[
              {
                title: "The project",
                body: "A short write-up of what you built, the problem it solves, and who it is for.",
                icon: FolderOpen,
              },
              {
                title: "The repository",
                body: "A link to the code, plus the commit history the AI review will read.",
                icon: Link2,
              },
              {
                title: "Your attachments",
                body: "Screenshots, slides, or anything else worth carrying into the defence.",
                icon: FileUp,
              },
            ].map(({ title, body, icon: Icon }) => (
              <div key={title} className="flex flex-col gap-3 bg-background p-6">
                <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
                  <Icon className="size-4" />
                </div>
                <h3 className="text-sm font-semibold tracking-[-0.01em]">
                  {title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Empty state ─────────────────────────────────────────── */}
        <Card className="mt-8 flex flex-col items-start gap-5 border-dashed p-8">
          <div className="grid size-10 place-items-center rounded-lg border border-border bg-secondary/50">
            <Sparkles className="size-4 text-muted-foreground" />
          </div>
          <div className="max-w-xl">
            <p className="text-base font-semibold">Nothing here yet</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Your submissions will appear here once you start a run. Uploads
              switch on with Supabase Storage in the next build — until then
              this stays empty rather than pretending to work.
            </p>
          </div>
          <Button disabled>Add your first submission</Button>
        </Card>

        {/* ── Where it fits in a run ──────────────────────────────── */}
        <div className="mt-8 rounded-xl border border-border p-6">
          <p className="label-mono text-muted-foreground">
            Where this feeds into a run
          </p>
          <StageRail
            active={["build", "submit", "defend"]}
            className="mt-5"
          />
        </div>
      </div>
    </AppShell>
  );
}
