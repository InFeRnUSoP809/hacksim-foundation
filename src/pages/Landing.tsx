import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Wordmark } from "@/components/Wordmark";
import { StageRail } from "@/components/StageChip";
import { isSupabaseConfigured } from "@/lib/supabase-config";
import {
  ArrowRight,
  BarChart3,
  Check,
  Layers,
  Mic,
  ShieldQuestion,
  Sparkles,
  SquareArrowOutUpRight,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router";

const CAPABILITIES = [
  {
    title: "Run the whole event",
    body: "Brief, build window, checkpoints, and a hard deadline — the shape of a real weekend, compressed.",
    icon: Layers,
  },
  {
    title: "Submit your actual work",
    body: "Bring a repository and a write-up. The review reads what you shipped, not a mock-up.",
    icon: SquareArrowOutUpRight,
  },
  {
    title: "Present for five minutes",
    body: "Screen, camera, and microphone. Rehearse the pitch until the timing is automatic.",
    icon: Mic,
  },
  {
    title: "Defend it under pressure",
    body: "An AI panel that follows up on your weakest answers instead of reading a script.",
    icon: ShieldQuestion,
  },
  {
    title: "Leave with the truth",
    body: "A written read on the whole run: what held, what didn't, and what to fix before the next one.",
    icon: BarChart3,
  },
];

const FOR_BUSINESS = [
  "Give every cohort the same rigorous practice",
  "Spot who struggles where, before demo day",
  "Keep practice off your own infrastructure",
];

export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── Navigation ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link to="/" className="shrink-0">
            <Wordmark />
          </Link>
          <nav className="hidden items-center gap-1 md:flex">
            <a
              href="#how"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              How it works
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link to="/login">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/signup">Get started</Link>
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
                <span className="size-1.5 rounded-full bg-stage-report" />
                The full simulation is coming online
              </span>

              <h1 className="mt-7 text-5xl font-semibold tracking-[-0.04em] text-balance sm:text-6xl lg:text-7xl">
                Run the whole hackathon
                <br />
                <span className="text-brand">before it counts.</span>
              </h1>

              <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed tracking-[-0.01em] text-muted-foreground sm:text-xl">
                HackSim takes a team from a raw brief all the way to standing in
                front of judges — build, submit, present, defend, and get an
                honest read on the whole thing.
              </p>

              <p className="mx-auto mt-4 text-base font-medium tracking-[-0.01em]">
                Practice. Build. Defend. Improve.
              </p>

              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button size="lg" className="w-full sm:w-auto" asChild>
                  <Link to="/signup">
                    Start your first run
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto"
                  asChild
                >
                  <a href="#how">See how it works</a>
                </Button>
              </div>

              {/* The arc, as a colour key */}
              <div className="mx-auto mt-14 max-w-2xl">
                <StageRail
                  active={["build", "submit", "present", "defend", "report"]}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── How it works ──────────────────────────────────────────── */}
        <section id="how" className="border-b border-border">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="max-w-2xl">
              <p className="label-mono text-brand">What a run looks like</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">
                Not a quiz. A simulation.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                You bring a problem, a clock, and a team. HackSim runs the parts
                that usually decide how a hackathon goes.
              </p>
            </div>

            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(({ title, body, icon: Icon }, index) => (
                <Card
                  key={title}
                  className="flex flex-col gap-4 p-6 transition-colors hover:border-foreground/20"
                >
                  <div className="flex items-center justify-between">
                    <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
                      <Icon className="size-4" />
                    </div>
                    <span className="label-mono text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
                    {title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {body}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* ── For businesses ───────────────────────────────────────── */}
        <section className="border-b border-border bg-foreground text-background">
          <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-2 lg:gap-20">
            <div>
              <p className="label-mono text-background/50">
                For teams and programmes
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
                Give your people the practice they never get.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-background/70">
                Most people go into a hackathon having never been questioned on
                their own work under time pressure. HackSim is where that
                happens safely, repeatedly, and with a record of what actually
                needs work.
              </p>
            </div>

            <ul className="flex flex-col gap-5">
              {FOR_BUSINESS.map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-background/15">
                    <Check className="size-3 text-background" />
                  </span>
                  <span className="text-base leading-relaxed">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Closing CTA ───────────────────────────────────────────── */}
        <section>
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <Card className="flex flex-col items-start gap-6 p-8 sm:p-12">
              <div className="grid size-10 place-items-center rounded-lg border border-border bg-secondary/50">
                <Sparkles className="size-4" />
              </div>
              <div className="max-w-xl">
                <h2 className="text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
                  Your first run starts here.
                </h2>
                <p className="mt-3 text-base leading-relaxed text-muted-foreground">
                  Create an account to lock in your place. The simulation opens
                  as each stage ships.
                </p>
              </div>

              {!isSupabaseConfigured && (
                <div className="flex w-full items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-4">
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
                    to enable accounts and sign-in.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button size="lg" asChild>
                  <Link to="/signup">
                    Get started
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link to="/login">Sign in</Link>
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
