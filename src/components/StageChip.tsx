import { STAGES, stageById, type StageId } from "@/types";
import { cn } from "@/lib/utils";

/** A small pill showing one stage in its own colour. */
export function StageChip({
  stage,
  className,
}: {
  stage: StageId;
  className?: string;
}) {
  const { label, hue } = stageById(stage);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
      style={{
        color: hue,
        borderColor: `color-mix(in oklch, ${hue} 30%, transparent)`,
        backgroundColor: `color-mix(in oklch, ${hue} 9%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: hue }}
      />
      {label}
    </span>
  );
}

/**
 * The full five-stage arc, with the emphasised stages lit in their own colour
 * and the rest left muted. This is the recurring visual that ties a session and
 * a report together.
 */
export function StageRail({
  active,
  className,
}: {
  /** Stage ids this session emphasises. */
  active: StageId[];
  className?: string;
}) {
  const activeSet = new Set(active);

  return (
    <ol className={cn("flex items-center gap-1.5", className)}>
      {STAGES.map((stage) => {
        const isActive = activeSet.has(stage.id);
        return (
          <li
            key={stage.id}
            className="flex-1"
            title={`${stage.label} — ${stage.summary}`}
          >
            <span
              className="block h-1.5 rounded-full"
              style={{
                backgroundColor: isActive
                  ? stage.hue
                  : "color-mix(in oklch, currentColor 12%, transparent)",
              }}
            />
            <span
              className={cn(
                "label-mono mt-2 block truncate",
                isActive ? "text-foreground" : "text-muted-foreground/50",
              )}
            >
              {stage.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
