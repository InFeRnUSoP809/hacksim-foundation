import { Wordmark } from "@/components/Wordmark";
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
              Practice the complete hackathon experience before the real
              event.
            </p>
            <p className="mt-5 text-base leading-relaxed text-muted-foreground">
              Practice. Build. Defend. Improve. Every stage of a hackathon,
              rehearsed end to end.
            </p>
          </div>

          <div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border">
            {[
              ["01", "Practice"],
              ["02", "Build"],
              ["03", "Defend"],
              ["04", "Improve"],
            ].map(([step, label]) => (
              <div key={step} className="bg-background px-4 py-3">
                <p className="label-mono text-muted-foreground">{step}</p>
                <p className="mt-1 text-xs font-medium">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
