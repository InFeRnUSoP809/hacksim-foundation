import { cn } from "@/lib/utils";
import type { HackathonStatus, SessionStatus } from "@/types";

const SESSION_TONE: Record<SessionStatus, string> = {
  not_started:
    "border-border bg-muted text-muted-foreground",
  active: "border-stage-report/35 bg-stage-report/10 text-stage-report",
  paused: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  break: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  completed: "border-stage-build/35 bg-stage-build/10 text-stage-build",
  expired: "border-destructive/35 bg-destructive/10 text-destructive",
};

const SESSION_LABEL: Record<SessionStatus, string> = {
  not_started: "Not started",
  active: "Active",
  paused: "Paused",
  break: "On break",
  completed: "Completed",
  expired: "Expired",
};

const HACKATHON_TONE: Record<HackathonStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-stage-build/35 bg-stage-build/10 text-stage-build",
  archived: "border-border bg-muted text-muted-foreground",
};

export function SessionStatusPill({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "label-mono inline-flex items-center rounded-full border px-2.5 py-1",
        SESSION_TONE[status] ?? SESSION_TONE.not_started,
        className,
      )}
    >
      {SESSION_LABEL[status] ?? status}
    </span>
  );
}

export function HackathonStatusPill({
  status,
  className,
}: {
  status: HackathonStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "label-mono inline-flex items-center rounded-full border px-2.5 py-1 capitalize",
        HACKATHON_TONE[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
