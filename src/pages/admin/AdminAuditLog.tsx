import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { getAuditLog, type AuditLogRow } from "@/lib/format-engine";
import { formatDate } from "@/lib/format";
import { ScrollText } from "lucide-react";

const ACTION_TONES: Record<string, string> = {
  created: "text-emerald-600 dark:text-emerald-400",
  updated: "text-muted-foreground",
  archived: "text-stage-submit",
  restored: "text-emerald-600 dark:text-emerald-400",
  deleted: "text-amber-600 dark:text-amber-400",
  permanently_deleted: "text-destructive",
  enabled: "text-muted-foreground",
  disabled: "text-muted-foreground",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${formatDate(iso)} · ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * §15.12 — who did what to which record, and why.
 *
 * Read-only by design. An audit trail with edit buttons is a data set, not an
 * audit trail; the only way a row leaves this table is never.
 */
export default function AdminAuditLog() {
  const log = useAsync<Awaited<ReturnType<typeof getAuditLog>>>(
    () => getAuditLog({ days: 90, limit: 200 }),
    [],
  );

  return (
    <AdminLayout>
      <div>
        <p className="label-mono text-brand">Control</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">Audit log</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every destructive or administrative action, with the admin who took it
          and the reason they gave. Entries are immutable and never deleted.
        </p>
      </div>

      <div className="mt-8">
        {log.isLoading ? (
          <LoadingState label="Loading the audit log" />
        ) : log.error ? (
          <ErrorState message={log.error} />
        ) : (log.data?.rows ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-2 border-dashed p-8">
            <div className="grid size-9 place-items-center rounded-lg border border-border bg-secondary/50">
              <ScrollText className="size-4 text-muted-foreground" />
            </div>
            <p className="text-base font-semibold">No entries yet</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Actions appear here the moment an admin archives, deletes or
              restores a record.
            </p>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-mono px-5 py-3 text-muted-foreground">When</th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">Admin</th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">Action</th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">Entity</th>
                  <th className="label-mono px-5 py-3 text-muted-foreground">Reason</th>
                </tr>
              </thead>
              <tbody>
                {(log.data?.rows ?? []).map((row: AuditLogRow) => (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-5 py-3.5 text-xs text-muted-foreground">
                      {formatTime(row.created_at)}
                    </td>
                    <td className="px-5 py-3.5 text-xs">{row.admin_email ?? row.admin_user_id ?? "—"}</td>
                    <td className="px-5 py-3.5">
                      <span className={`label-mono ${ACTION_TONES[row.action] ?? "text-muted-foreground"}`}>
                        {row.action.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="capitalize">{row.entity_type.replace(/_/g, " ")}</p>
                      {row.entity_name && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{row.entity_name}</p>
                      )}
                    </td>
                    <td className="max-w-xs px-5 py-3.5 text-xs leading-relaxed text-muted-foreground">
                      {row.reason || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {(log.data?.count ?? 0) > (log.data?.rows?.length ?? 0) && (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing the {log.data?.rows.length} most recent of {log.data?.count} entries in the last
          90 days.
        </p>
      )}

      <div className="mt-6">
        <Button variant="ghost" size="sm" onClick={() => void log.reload()}>
          Refresh
        </Button>
      </div>
    </AdminLayout>
  );
}
