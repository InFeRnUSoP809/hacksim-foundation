import { Wordmark } from "@/components/Wordmark";
import { STAGES } from "@/types";
import { Link } from "react-router";
import type { ReactNode } from "react";

/**
 * Centred, distraction-free frame for the sign-in and sign-up screens.
 * A plain panel on the left, a quiet product statement on the right.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Form */}
      <div className="flex flex-col px-5 py-10 sm:px-8">
        <Link to="/" className="self-start">
          <Wordmark />
        </Link>

        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-[-0.03em]">
              {title}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {subtitle}
            </p>
            <div className="mt-8">{children}</div>
          </div>
        </div>

        <div className="text-sm text-muted-foreground">{footer}</div>
      </div>

      {/* Context panel */}
      <aside className="relative hidden overflow-hidden border-l border-border bg-secondary/30 lg:block">
        <div
          aria-hidden
          className="grid-backdrop pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_80%_70%_at_70%_20%,#000,transparent)]"
        />
        <div className="relative flex h-full flex-col justify-between p-14">
          <p className="label-mono text-muted-foreground">HackSim</p>

          <div className="max-w-md">
            <p className="text-3xl font-semibold leading-tight tracking-[-0.03em] text-balance">
              Run the whole hackathon before it counts.
            </p>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground">
              Build. Submit. Present. Defend. Get an honest read on the whole
              run — every time, before anyone is judging.
            </p>
          </div>

          <ol className="grid grid-cols-5 gap-px overflow-hidden rounded-lg border border-border bg-border">
            {STAGES.map((stage, index) => (
              <li key={stage.id} className="bg-background px-3 py-3">
                <span
                  aria-hidden
                  className="mb-2 block h-1 w-5 rounded-full"
                  style={{ backgroundColor: stage.hue }}
                />
                <p className="label-mono text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <p className="mt-1 text-xs font-medium">{stage.label}</p>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
