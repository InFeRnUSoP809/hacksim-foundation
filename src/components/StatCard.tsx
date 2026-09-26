import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

/** A single number in the admin overview. */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "positive" | "muted";
}) {
  return (
    <Card
      className={cn(
        "flex flex-col gap-3 p-5",
        tone === "positive" && "border-stage-report/40",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="label-mono text-muted-foreground">{label}</p>
        {Icon && (
          <Icon
            className={cn(
              "size-4 shrink-0",
              tone === "positive"
                ? "text-stage-report"
                : tone === "muted"
                  ? "text-muted-foreground"
                  : "text-foreground",
            )}
          />
        )}
      </div>
      <p
        className={cn(
          "text-3xl font-semibold tracking-[-0.03em]",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
