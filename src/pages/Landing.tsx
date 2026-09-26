import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Wordmark } from "@/components/Wordmark";
import { isSupabaseConfigured } from "@/lib/supabase-config";
import {
  ArrowRight,
  Blocks,
  CheckCircle2,
  Gauge,
  LayoutGrid,
  Lock,
  MessageSquareQuote,
  MonitorPlay,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router";

const TRAINING_LOOP = [
  {
    step: "01",
    title: "Practice",
    body: "Run a full hackathon simulation on a real problem statement, with the clock and the pressure you’ll actually face.",
    icon: Gauge,
  },
  {
    step: "02",
    title: "Build",
    body: "Work in teams, checkpoint your progress, and submit a project the way the real event will judge it.",
    icon: Blocks,
  },
  {
    step: "03",
    title: "Defend",
    body: "Present for five minutes, then face an adaptive AI panel that follows up on your weakest answers.",
    icon: MessageSquareQuote,
  },
  {
    step: "04",
    title: "Improve",
    body: "End every session with a training report that tells you exactly what to fix before the next round.",
    icon: LayoutGrid,
  },
];

const FOUNDATION = [
  "Installable PWA — desktop and mobile",
  "Supabase email & password authentication",
  "Persistent sessions across refreshes",
  "Protected student dashboard",
  "Role-gated admin area",
  "Row Level Security on every table",
];

export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── Navigation ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Wordmark />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link to="/login">Login</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/signup">Create account</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* ── Hero ──────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden border-b border-border">
          <div
            aria-hidden
            className="grid-backdrop pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000,transparent)]"
          />
          <div className="relative mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="mx-auto max-w-3xl text-center">
              <span className="label-mono inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-muted-foreground">
                <span className="size-1.5 rounded-full bg-signal" />
                Foundation build · now in private beta
              </span>

              <h1 className="mt-7 text-5xl font-semibold tracking-[-0.035em] text-balance sm:text-6xl lg:text-7xl">
                HackSim
              </h1>

              <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed tracking-[-0.01em] text-muted-foreground sm:text-xl">
                Practice. Build. Defend. Improve.
              </p>

              <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-muted-foreground">
                Practice the complete hackathon experience before the real
                event.
              </p>

              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button size="lg" className="w-full sm:w-auto" asChild>
                  <Link to="/signup">
                    Start Training
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto"
                  asChild
                >
                  <Link to="/login">Login</Link>
                </Button>
              </div>

              <p className="label-mono mt-6 text-muted-foreground">
                No credit card · Runs in your browser · Installable
              </p>
            </div>
          </div>
        </section>

        {/* ── The training loop ─────────────────────────────────────── */}
        <section className="border-b border-border">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="max-w-2xl">
              <p className="label-mono text-muted-foreground">
                The training loop
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                Four stages, one continuous run.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                HackSim walks a team through the same arc a real hackathon
                does — from the first idea all the way to standing in front of
                judges and defending the work.
              </p>
            </div>

            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {TRAINING_LOOP.map(({ step, title, body, icon: Icon }) => (
                <div
                  key={step}
                  className="flex flex-col gap-4 bg-background p-7 transition-colors hover:bg-secondary/40"
                >
                  <div className="flex items-center justify-between">
                    <Icon className="size-5 text-foreground" />
                    <span className="label-mono text-muted-foreground">
                      {step}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold tracking-[-0.01em]">
                    {title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── What ships today ──────────────────────────────────────── */}
        <section className="border-b border-border bg-secondary/25">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
              <div>
                <p className="label-mono text-muted-foreground">
                  What you can do right now
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                  The foundation is live.
                </h2>
                <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                  This first build is deliberately small. Everything below
                  already works today — the training modules land one at a time
                  after it.
                </p>

                {!isSupabaseConfigured && (
                  <div className="mt-6 flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-4">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Supabase isn&rsquo;t configured yet. Add{" "}
                      <code className="font-mono text-xs text-foreground">
                        VITE_SUPABASE_URL
                      </code>{" "}
                      and{" "}
                      <code className="font-mono text-xs text-foreground">
                        VITE_SUPABASE_ANON_KEY
                      </code>{" "}
                      to enable sign up and login.
                    </p>
                  </div>
                )}
              </div>

              <Card className="p-7">
                <ul className="flex flex-col gap-4">
                  {FOUNDATION.map((item) => (
                    <li key={item} className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-signal" />
                      <span className="text-sm leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-7 flex items-start gap-3 border-t border-border pt-6">
                  <MonitorPlay className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    HackSim installs to your desktop or home screen, so your
                    next session opens like a real app — even offline on the
                    shell.
                  </p>
                </div>
              </Card>
            </div>
          </div>
        </section>

        {/* ── Roadmap preview ───────────────────────────────────────── */}
        <section className="border-b border-border">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="max-w-2xl">
              <p className="label-mono text-muted-foreground">Next up</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                Built one module at a time.
              </h2>
            </div>

            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: Timer, title: "Hackathon simulation timer" },
                { icon: Blocks, title: "Project submission" },
                { icon: MessageSquareQuote, title: "AI project review" },
                { icon: MonitorPlay, title: "5-minute presentation" },
                { icon: MessageSquareQuote, title: "Adaptive AI defense" },
                { icon: LayoutGrid, title: "Training report" },
              ].map(({ icon: Icon, title }) => (
                <div
                  key={title}
                  className="flex items-center gap-3 bg-background px-6 py-5"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium">{title}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Closing CTA ───────────────────────────────────────────── */}
        <section>
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <Card className="flex flex-col items-start gap-6 p-8 sm:p-12">
              <div className="grid size-10 place-items-center rounded-lg border border-border bg-secondary/50">
                <Lock className="size-4" />
              </div>
              <div className="max-w-xl">
                <h2 className="text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
                  Your first run starts here.
                </h2>
                <p className="mt-3 text-base leading-relaxed text-muted-foreground">
                  Create an account to lock in your place. Training sessions
                  open as each module ships.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button size="lg" asChild>
                  <Link to="/signup">
                    Start Training
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link to="/login">Login</Link>
                </Button>
              </div>
            </Card>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 sm:flex-row sm:px-8">
          <Wordmark showTagline />
          <p className="label-mono text-muted-foreground">
            Foundation build · v0.1
          </p>
        </div>
      </footer>
    </div>
  );
}
