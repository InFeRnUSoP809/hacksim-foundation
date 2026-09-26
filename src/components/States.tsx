import { AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Inline, non-blocking loading row. */
export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}…
    </div>
  );
}

/** Inline error panel for recoverable failures (e.g. profile not loaded). */
export function ErrorState({
  title = "Something went wrong",
  message,
  action,
}: {
  title?: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-5"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 text-destructive" />
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

/** Neutral notice used for "check your inbox" style confirmations. */
export function NoticeState({
  title,
  message,
  className,
}: {
  title: string;
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-lg border border-border bg-secondary/40 p-4",
        className,
      )}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
    </div>
  );
}
