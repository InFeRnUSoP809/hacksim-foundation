import { StageRail } from "@/components/StageChip";
import { cn } from "@/lib/utils";
import { Clock, Users } from "lucide-react";
import type { Scenario } from "@/types";

/** One scenario in the catalog grid. */
export function ScenarioCard({
  scenario,
  className,
}: {
  scenario: Scenario;
  className?: string;
}) {
  const seats =
    scenario.seatsLeft === null
      ? "Open entry"
      : scenario.seatsLeft === 0
        ? "Full"
        : `${scenario.seatsLeft} seat${scenario.seatsLeft === 1 ? "" : "s"} left`;

  const isFull = scenario.seatsLeft === 0;

  return (
    <article
      className={cn(
        "group flex flex-col gap-5 rounded-xl border border-border bg-card p-6 transition-all",
        "hover:border-foreground/20 hover:shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {scenario.featured && (
            <span className="label-mono mb-2 inline-block text-brand">
              Featured
            </span>
          )}
          <h3 className="text-[17px] font-semibold leading-snug tracking-[-0.02em]">
            {scenario.title}
          </h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {scenario.sponsor} · {scenario.track}
          </p>
        </div>
        <span
          className={cn(
            "label-mono shrink-0 rounded-full border px-2.5 py-1",
            scenario.difficulty === "Advanced" &&
              "border-stage-defend/30 bg-stage-defend/10 text-stage-defend",
            scenario.difficulty === "Intermediate" &&
              "border-stage-submit/30 bg-stage-submit/10 text-stage-submit",
            scenario.difficulty === "Open" &&
              "border-stage-report/30 bg-stage-report/10 text-stage-report",
          )}
        >
          {scenario.difficulty}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        {scenario.summary}
      </p>

      <StageRail active={scenario.focus} className="mt-auto" />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          {scenario.durationHours}h
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="size-3.5" />
          Team of {scenario.teamSize}
        </span>
        <span
          className={cn(
            "label-mono ml-auto",
            isFull ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {seats}
        </span>
      </div>
    </article>
  );
}
