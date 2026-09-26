import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TriangleAlert } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "warning" | "danger";
}

type Resolver = (confirmed: boolean) => void;

interface ConfirmContextValue {
  ask: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/**
 * Confirmation for actions that change state an admin can't trivially undo —
 * replacing the practice hackathon, archiving a brief.
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  const ask = useCallback((next: ConfirmOptions) => {
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const value = useMemo(() => ({ ask }), [ask]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmDialogSurface options={options} onSettle={settle} />
    </ConfirmContext.Provider>
  );
}

function ConfirmDialogSurface({
  options,
  onSettle,
}: {
  options: ConfirmOptions | null;
  onSettle: (confirmed: boolean) => void;
}) {
  return (
    <Dialog open={options !== null} onOpenChange={(open) => !open && onSettle(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2.5">
            {options?.tone && options.tone !== "default" && (
              <TriangleAlert
                className={
                  options.tone === "danger"
                    ? "mt-0.5 size-4 shrink-0 text-destructive"
                    : "mt-0.5 size-4 shrink-0 text-stage-submit"
                }
              />
            )}
            {options?.title}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {options?.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onSettle(false)}>
            {options?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={options?.tone === "danger" ? "destructive" : "default"}
            onClick={() => onSettle(true)}
          >
            {options?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useConfirmDialog(): ConfirmContextValue {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error(
      "useConfirmDialog must be used inside <ConfirmDialogProvider>",
    );
  }
  return context;
}
