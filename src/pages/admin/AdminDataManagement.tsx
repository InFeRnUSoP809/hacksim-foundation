import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAsync } from "@/hooks/use-async";
import { cn } from "@/lib/utils";
import {
  availableActions,
  confirmPhrase,
  getDeletionImpact,
  manageEntity,
  type DeletionImpact,
  type DeleteMode,
  type EntityType,
} from "@/lib/format-engine";
import { formatDate } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { friendlyError } from "@/services/errors";
import { Archive, Database, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

// ── Sections (Part 16) ──────────────────────────────────────────────────────

interface SectionConfig {
  key: EntityType;
  title: string;
  blurb: string;
  /** Table the section reads directly — RLS already scopes this to admins. */
  table: string;
  columns: string;
  /** Builds the display row from a raw record. */
  toRow: (raw: Record<string, unknown>) => DisplayRow;
}

interface DisplayRow {
  id: string;
  name: string;
  subtitle: string;
  status: string;
  deleted: boolean;
  raw: Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" && value ? value : "";
}

const SECTIONS: SectionConfig[] = [
  {
    key: "hackathon",
    title: "Hackathons",
    blurb:
      "Archiving keeps every simulation and submission intact. Deleting a hackathon with dependents is refused — archive instead.",
    table: "hackathons",
    columns: "id, name, status, difficulty, created_at, deleted_at",
    toRow: (raw) => ({
      id: str(raw.id),
      name: str(raw.name),
      subtitle: str(raw.difficulty),
      status: str(raw.status),
      deleted: Boolean(raw.deleted_at),
      raw,
    }),
  },
  {
    key: "team",
    title: "Teams",
    blurb: "Teams with a live simulation should be archived, not deleted.",
    table: "teams",
    columns: "id, name, created_at, deleted_at",
    toRow: (raw) => ({
      id: str(raw.id),
      name: str(raw.name),
      subtitle: `Created ${formatDate(str(raw.created_at))}`,
      status: "—",
      deleted: Boolean(raw.deleted_at),
      raw,
    }),
  },
  {
    key: "simulation",
    title: "Simulations",
    blurb:
      "Running, expired and completed runs. Deleting removes checkpoints, problem discoveries and the run itself.",
    table: "build_sessions",
    columns: "id, status, started_at, ends_at, deleted_at",
    toRow: (raw) => ({
      id: str(raw.id),
      name: `Session ${str(raw.id).slice(0, 8)}`,
      subtitle: `Started ${formatDate(str(raw.started_at))}`,
      status: str(raw.status),
      deleted: Boolean(raw.deleted_at),
      raw,
    }),
  },
  {
    key: "submission",
    title: "Submissions",
    blurb:
      "A submitted project carries its repository, evidence, knowledge and question targets. Soft delete keeps the history.",
    table: "submissions",
    columns: "id, project_name, status, submitted_at, deleted_at",
    toRow: (raw) => ({
      id: str(raw.id),
      name: str(raw.project_name) || "Unnamed project",
      subtitle: raw.submitted_at ? `Submitted ${formatDate(str(raw.submitted_at))}` : "Draft",
      status: str(raw.status),
      deleted: Boolean(raw.deleted_at),
      raw,
    }),
  },
  {
    key: "repository",
    title: "Repositories",
    blurb:
      "Scanned repositories with their files, chunks and evidence. Deleting purges the analysis record permanently.",
    table: "repositories",
    columns: "id, github_url, owner, repo_name, analysis_status, created_at, deleted_at",
    toRow: (raw) => ({
      id: str(raw.id),
      name: `${str(raw.owner)}/${str(raw.repo_name)}`.replace(/^\/+$/, str(raw.github_url)),
      subtitle: `Analysis: ${str(raw.analysis_status) || "pending"}`,
      status: str(raw.analysis_status),
      deleted: Boolean(raw.deleted_at),
      raw,
    }),
  },
];

const ACTION_META: Record<DeleteMode, { label: string; tone: "default" | "danger" }> = {
  archive: { label: "Archive", tone: "default" },
  delete: { label: "Delete", tone: "danger" },
  restore: { label: "Restore", tone: "default" },
  permanent: { label: "Delete permanently", tone: "danger" },
};

interface PendingAction {
  section: SectionConfig;
  row: DisplayRow;
  mode: DeleteMode;
  impact: DeletionImpact | null;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function AdminDataManagement() {
  const [sectionKey, setSectionKey] = useState<EntityType>("hackathon");
  const [filter, setFilter] = useState<"active" | "deleted">("active");
  const [pending, setPending] = useState<PendingAction | null>(null);

  const section = SECTIONS.find((s) => s.key === sectionKey) ?? SECTIONS[0];

  const load = useCallback(async () => {
    let query = supabase.from(section.table).select(section.columns);
    // §15.14 — the default view is live records; the Deleted tab reads the
    // rest. There is no "All": accidental exposure of a deleted row is the
    // thing the filter exists to prevent.
    query = filter === "deleted" ? query.not("deleted_at", "is", null) : query.is("deleted_at", null);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(friendlyError(error, `Couldn't load ${section.title.toLowerCase()}.`));
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(section.toRow);
  }, [section.table, section.columns, section.title, section.toRow, filter]);

  const rows = useAsync<DisplayRow[]>(load, [load]);

  async function openAction(row: DisplayRow, mode: DeleteMode) {
    if (mode === "restore") {
      setPending({ section, row, mode, impact: null });
      return;
    }
    // §15.5 — dependencies are fetched before the dialog opens, so the cost is
    // visible before the ask, not after it.
    try {
      const impact = await getDeletionImpact(section.key, row.id);
      setPending({ section, row, mode, impact });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't calculate the impact.");
    }
  }

  function switchSection(key: string) {
    setSectionKey(key as EntityType);
    setFilter("active");
  }

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">Data management</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          One deletion architecture for every entity: dependencies shown first,
          confirmation required, high-impact deletions typed in, and every action
          written to the audit log. Project knowledge is archived, never destroyed.
        </p>
      </div>

      <Tabs value={sectionKey} onValueChange={switchSection} className="mt-8">
        <TabsList className="flex flex-wrap">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.key} value={s.key}>
              {s.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{section.blurb}</p>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="deleted">Deleted</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="mt-5">
        {rows.isLoading ? (
          <LoadingState label={`Loading ${section.title.toLowerCase()}`} />
        ) : rows.error ? (
          <ErrorState message={rows.error} />
        ) : (rows.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <Database className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">
              {filter === "deleted" ? "Nothing deleted" : "Nothing here"}
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {filter === "deleted"
                ? "Deleted and archived records appear here and can be restored."
                : `No active ${section.title.toLowerCase()} right now.`}
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono px-5 py-3 text-muted-foreground">Record</th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">Status</th>
                  <th className="label-mono px-5 py-3 text-right text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {(rows.data ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <td className="px-5 py-3.5">
                      <p className="font-medium">{row.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.subtitle}</p>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={cn(
                          "label-mono rounded border px-2 py-0.5",
                          row.deleted
                            ? "border-destructive/40 text-destructive"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {row.deleted ? "deleted" : row.status || "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {availableActions(section.key, row.deleted).map((mode) =>
                          mode === "delete" || mode === "permanent" ? (
                            <Button
                              key={mode}
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void openAction(row, mode)}
                            >
                              <Trash2 className="size-3.5" />
                              {ACTION_META[mode].label}
                            </Button>
                          ) : mode === "restore" ? (
                            <Button
                              key={mode}
                              variant="ghost"
                              size="sm"
                              onClick={() => void openAction(row, mode)}
                            >
                              <RotateCcw className="size-3.5" />
                              Restore
                            </Button>
                          ) : (
                            <Button
                              key={mode}
                              variant="ghost"
                              size="sm"
                              onClick={() => void openAction(row, mode)}
                            >
                              <Archive className="size-3.5" />
                              Archive
                            </Button>
                          ),
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {pending && (
        <ActionDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            void rows.reload();
          }}
        />
      )}
    </AdminLayout>
  );
}

// ── The action dialog ───────────────────────────────────────────────────────

function ActionDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const { row, mode, impact, section } = pending;
  const needsConfirm = mode !== "restore" && section.key === "hackathon";
  const phrase = confirmPhrase(section.key, row.name);

  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dependentEntries = Object.entries(impact?.dependents ?? {}).filter(([, n]) => n > 0);
  const hasDependents = dependentEntries.length > 0;
  const destructive = mode === "delete" || mode === "permanent";
  const blocked = destructive && section.key === "hackathon" && hasDependents;

  const typedOk = !needsConfirm || typed.trim() === phrase;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const result = await manageEntity(section.key, row.id, mode, {
        reason: reason.trim() || undefined,
        confirm: needsConfirm ? typed.trim() : undefined,
      });
      if (!result.ok) {
        setError(
          result.blocked && typeof result.reason === "string"
            ? result.reason
            : Array.isArray(result.reason)
              ? "Type the name exactly to confirm."
              : "The operation was not applied.",
        );
        return;
      }
      toast.success(`${ACTION_META[mode].label} applied to "${row.name}".`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {ACTION_META[mode].label} {section.key.replace(/_/g, " ")}?
          </DialogTitle>
          <DialogDescription>
            {mode === "restore"
              ? `"${row.name}" returns to the active lists immediately.`
              : `"${row.name}" will be ${
                  mode === "archive" ? "archived — it stays restorable" : "marked deleted"
                }, and the action is written to the audit log.`}
          </DialogDescription>
        </DialogHeader>

        {destructive && hasDependents && (
          <div className="rounded-lg border border-border bg-secondary/40 p-3.5">
            <p className="text-sm font-medium">
              {blocked ? "This record still has dependents." : "This may also remove:"}
            </p>
            <ul className="mt-2 space-y-1">
              {dependentEntries.map(([key, count]) => (
                <li key={key} className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="capitalize">{key.replace(/_/g, " ")}</span>
                  <span className="label-mono">{count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
            {blocked && (
              <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                Archive the record instead — permanent deletion is refused while
                dependents exist.
              </p>
            )}
          </div>
        )}

        <div className="space-y-3">
          <div>
            <Label htmlFor="reason">Reason (recorded in the audit log)</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being done?"
              className="mt-1.5 min-h-16"
            />
          </div>
          {needsConfirm && (
            <div>
              <Label htmlFor="typed">
                Type <span className="font-semibold">{phrase}</span> to confirm
              </Label>
              <Input
                id="typed"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={phrase}
                className="mt-1.5"
                autoComplete="off"
              />
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={ACTION_META[mode].tone === "danger" ? "destructive" : "default"}
            onClick={() => void run()}
            disabled={busy || !typedOk}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {ACTION_META[mode].label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
