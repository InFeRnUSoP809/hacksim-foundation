import { cn } from "@/lib/utils";

/**
 * The HackSim mark: a terminal-style prompt caret in the signal colour, paired
 * with the wordmark. Used in the top navigation and on auth screens.
 */
export function Wordmark({
  className,
  showTagline = false,
}: {
  className?: string;
  showTagline?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-md bg-foreground font-mono text-[13px] font-bold leading-none text-background"
      >
        <span className="text-signal">▍</span>
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-[-0.02em]">
          HackSim
        </span>
        {showTagline && (
          <span className="label-mono mt-1 text-muted-foreground">
            Build. Submit. Defend.
          </span>
        )}
      </span>
    </span>
  );
}
