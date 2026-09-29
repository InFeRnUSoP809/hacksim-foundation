import { Card } from "@/components/ui/card";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { V2RunStatus } from "@/types/v2-analysis";

const STAGES: { key: V2RunStatus; label: string }[] = [
  { key: "scanning_repository", label: "Repository connected" },
  { key: "building_code_graph", label: "Code structure analyzed" },
  { key: "discovering_features", label: "Understanding project workflows" },
  { key: "mapping_requirements", label: "Checking requirements" },
  { key: "verifying", label: "Verifying implementation" },
  { key: "finalizing", label: "Preparing your review" },
];

function stageIndex(status: V2RunStatus | undefined): number {
  if (!status) return -1;
  const order = STAGES.map((s) => s.key);
  return order.indexOf(status);
}

export function V2ReviewProgress(props: {
  status?: V2RunStatus;
  progressPercent?: number;
}) {
  const active = stageIndex(props.status);
  return (
    <Card className="p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Your project is being reviewed</h2>
        <p className="text-sm text-muted-foreground mt-1">
          HackSim is analyzing your repository in the background. You can leave this page — your
          review will continue and be saved automatically.
        </p>
      </div>
      <ul className="space-y-2">
        {STAGES.map((stage, index) => {
          const done = active > index;
          const current = active === index;
          return (
            <li key={stage.key} className="flex items-center gap-2 text-sm">
              {done ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : current ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground" />
              )}
              <span className={current ? "font-medium" : ""}>{stage.label}</span>
            </li>
          );
        })}
      </ul>
      {typeof props.progressPercent === "number" && (
        <p className="text-xs text-muted-foreground">Progress: {props.progressPercent}%</p>
      )}
    </Card>
  );
}
