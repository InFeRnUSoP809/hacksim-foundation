import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/**
 * A single dashboard module. Every module is an honest empty state for now —
 * the shape is built, the behaviour arrives in later builds.
 */
export function ModuleCard({
  step,
  title,
  description,
  icon: Icon,
}: {
  step: string;
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="group flex flex-col gap-4 p-6 transition-colors hover:border-foreground/20">
      <div className="flex items-center justify-between">
        <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
          <Icon className="size-4 text-foreground" />
        </div>
        <span className="label-mono text-muted-foreground">{step}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
          {title}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>

      <div
        className={cn(
          "mt-auto flex items-center gap-2 border-t border-border pt-4",
        )}
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-signal opacity-40" />
          <span className="relative inline-flex size-1.5 rounded-full bg-signal" />
        </span>
        <span className="label-mono text-muted-foreground">Coming soon</span>
      </div>
    </Card>
  );
}
