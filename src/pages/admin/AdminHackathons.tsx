import { AdminLayout } from "@/layouts/AdminLayout";
import { ErrorState, LoadingState } from "@/components/States";
import { HackathonStatusPill } from "@/components/StatusPill";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useAsync } from "@/hooks/use-async";
import { useState } from "react";
import { formatDate, formatMinutes } from "@/lib/format";
import {
  archiveHackathon,
  createHackathon,
  getPracticeHackathon,
  listHackathons,
  setPracticeHackathon,
  updateHackathon,
} from "@/services/hackathons";
import { friendlyError } from "@/services/errors";
import { Archive, Loader2, Plus, Power, X } from "lucide-react";
import type { Hackathon, HackathonDraft } from "@/types";

const EMPTY_DRAFT: HackathonDraft = {
  name: "",
  problem_statement: "",
  requirements: "",
  constraints: "",
  expected_outcome: "",
  evaluation_criteria: "",
  simulation_duration_minutes: 60,
  status: "draft",
};

const LONG_FIELDS = [
  { key: "problem_statement", label: "Problem statement", rows: 7 },
  { key: "requirements", label: "Requirements", rows: 5 },
  { key: "constraints", label: "Constraints", rows: 4 },
  { key: "expected_outcome", label: "Expected outcome", rows: 4 },
  { key: "evaluation_criteria", label: "Evaluation criteria", rows: 5 },
] as const;

export default function AdminHackathons() {
  const hackathons = useAsync<Hackathon[]>(() => listHackathons(), []);
  const practice = useAsync<Hackathon | null>(() => getPracticeHackathon(), []);

  const [editing, setEditing] = useState<Hackathon | "new" | null>(null);
  const [viewing, setViewing] = useState<Hackathon | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirm = useConfirmDialog();

  const practiceId = practice.data?.id ?? null;

  async function handlePracticeToggle(hackathon: Hackathon) {
    setActionError(null);
    const turningOn = !hackathon.practice_enabled;

    // Turning on while another is live needs an explicit confirmation, because
    // it silently withdraws practice from the hackathon currently running.
    if (turningOn && practiceId && practiceId !== hackathon.id) {
      const confirmed = await confirm.ask({
        title: "Replace the current practice hackathon?",
        message: `“${practice.data?.name}” is currently the practice hackathon. Enabling “${hackathon.name}” will turn practice off for the other one. Simulations already running are not affected.`,
        confirmLabel: "Enable this hackathon",
        cancelLabel: "Cancel",
        tone: "warning",
      });
      if (!confirmed) return;
    }

    setBusyId(hackathon.id);
    try {
      await setPracticeHackathon(turningOn ? hackathon.id : null);
      practice.reload();
      hackathons.reload();
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleArchive(hackathon: Hackathon) {
    const confirmed = await confirm.ask({
      title: `Archive “${hackathon.name}”?`,
      message:
        "Archiving hides it from students. It is never deleted, and any simulation already running stays attached to it.",
      confirmLabel: "Archive",
      cancelLabel: "Cancel",
      tone: "danger",
    });
    if (!confirmed) return;

    setActionError(null);
    setBusyId(hackathon.id);
    try {
      await archiveHackathon(hackathon.id);
      practice.reload();
      hackathons.reload();
    } catch (err) {
      setActionError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (editing) {
    return (
      <HackathonForm
        hackathon={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          hackathons.reload();
          practice.reload();
        }}
      />
    );
  }

  if (viewing) {
    return <HackathonView hackathon={viewing} onBack={() => setViewing(null)} />;
  }

  return (
    <AdminLayout>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="label-mono text-brand">Control</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
            Hackathons
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Author the brief students will build against. Exactly one hackathon
            can be open for practice at a time.
          </p>
        </div>
        <Button onClick={() => setEditing("new")} className="shrink-0">
          <Plus className="size-4" />
          New hackathon
        </Button>
      </div>

      {actionError && (
        <div className="mt-6">
          <ErrorState title="Action failed" message={actionError} />
        </div>
      )}

      <div className="mt-8">
        {hackathons.isLoading ? (
          <LoadingState label="Loading hackathons" />
        ) : hackathons.error ? (
          <ErrorState message={hackathons.error} />
        ) : (hackathons.data ?? []).length === 0 ? (
          <Card className="flex flex-col items-start gap-4 border-dashed p-8">
            <div>
              <p className="text-base font-semibold">No hackathons yet</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Create one to describe the problem students will work on. Nothing
                is hardcoded in the app — every student sees exactly what you
                write here.
              </p>
            </div>
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-4" />
              Create the first hackathon
            </Button>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {(hackathons.data ?? []).map((hackathon) => {
              const isPractice = practiceId === hackathon.id;
              const isBusy = busyId === hackathon.id;

              return (
                <Card key={hackathon.id} className="p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold tracking-[-0.02em]">
                          {hackathon.name}
                        </h2>
                        <HackathonStatusPill status={hackathon.status} />
                        {isPractice && (
                          <span className="label-mono inline-flex items-center gap-1.5 rounded-full border border-stage-report/35 bg-stage-report/10 px-2.5 py-1 text-stage-report">
                            <span className="size-1.5 rounded-full bg-stage-report" />
                            Practice
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                        {hackathon.problem_statement || "No problem statement yet."}
                      </p>
                      <p className="label-mono mt-2 text-muted-foreground">
                        {formatMinutes(hackathon.simulation_duration_minutes)} ·{" "}
                        created {formatDate(hackathon.created_at)}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setViewing(hackathon)}
                      >
                        View
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(hackathon)}
                      >
                        Edit
                      </Button>
                      {hackathon.status !== "archived" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleArchive(hackathon)}
                          disabled={isBusy}
                        >
                          <Archive className="size-3.5" />
                          Archive
                        </Button>
                      )}

                      <div className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2">
                        <span className="label-mono text-muted-foreground">
                          Practice
                        </span>
                        <Switch
                          checked={hackathon.practice_enabled}
                          disabled={isBusy || hackathon.status === "archived"}
                          onCheckedChange={() =>
                            void handlePracticeToggle(hackathon)
                          }
                          aria-label={`Enable practice for ${hackathon.name}`}
                        />
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

// ── Form ────────────────────────────────────────────────────────────────────

function HackathonForm({
  hackathon,
  onCancel,
  onSaved,
}: {
  hackathon: Hackathon | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<HackathonDraft>(
    hackathon
      ? {
          name: hackathon.name,
          problem_statement: hackathon.problem_statement,
          requirements: hackathon.requirements,
          constraints: hackathon.constraints,
          expected_outcome: hackathon.expected_outcome,
          evaluation_criteria: hackathon.evaluation_criteria,
          simulation_duration_minutes: hackathon.simulation_duration_minutes,
          status: hackathon.status,
        }
      : EMPTY_DRAFT,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof HackathonDraft>(
    key: K,
    value: HackathonDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      if (hackathon) {
        await updateHackathon(hackathon.id, draft);
      } else {
        await createHackathon(draft);
      }
      onSaved();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AdminLayout>
      <button
        type="button"
        onClick={onCancel}
        className="label-mono mb-4 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
        Back to hackathons
      </button>

      <h1 className="text-3xl font-semibold tracking-[-0.03em]">
        {hackathon ? "Edit hackathon" : "New hackathon"}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Students see this text exactly as written. The duration and practice
        availability are stored here too — never in the app code.
      </p>

      {error && (
        <div className="mt-6">
          <ErrorState title="Couldn't save" message={error} />
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-8 flex max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Hackathon name</Label>
          <Input
            id="name"
            required
            minLength={2}
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="MediStock"
          />
        </div>

        {LONG_FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-2">
            <Label htmlFor={field.key}>{field.label}</Label>
            <Textarea
              id={field.key}
              rows={field.rows}
              value={draft[field.key]}
              onChange={(event) =>
                set(field.key, event.target.value as never)
              }
              placeholder={
                field.key === "problem_statement"
                  ? "Describe the problem students must solve…"
                  : undefined
              }
            />
          </div>
        ))}

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="duration">Simulation duration (minutes)</Label>
            <Input
              id="duration"
              type="number"
              min={1}
              max={10080}
              required
              value={draft.simulation_duration_minutes}
              onChange={(event) =>
                set("simulation_duration_minutes", Number(event.target.value))
              }
            />
            <p className="text-xs text-muted-foreground">
              {formatMinutes(draft.simulation_duration_minutes || 0)} of build
              time. Controls the simulation timer.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              value={draft.status}
              onChange={(event) =>
                set("status", event.target.value as HackathonDraft["status"])
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Only an active hackathon can be opened for practice.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <Button type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="size-4 animate-spin" />}
            {hackathon ? "Save changes" : "Create hackathon"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </AdminLayout>
  );
}

// ── View ────────────────────────────────────────────────────────────────────

function HackathonView({
  hackathon,
  onBack,
}: {
  hackathon: Hackathon;
  onBack: () => void;
}) {
  const sections = [
    { label: "Problem statement", value: hackathon.problem_statement },
    { label: "Requirements", value: hackathon.requirements },
    { label: "Constraints", value: hackathon.constraints },
    { label: "Expected outcome", value: hackathon.expected_outcome },
    { label: "Evaluation criteria", value: hackathon.evaluation_criteria },
  ];

  return (
    <AdminLayout>
      <button
        type="button"
        onClick={onBack}
        className="label-mono mb-4 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
        Back to hackathons
      </button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">
          {hackathon.name}
        </h1>
        <HackathonStatusPill status={hackathon.status} />
        {hackathon.practice_enabled && (
          <span className="label-mono inline-flex items-center gap-1.5 rounded-full border border-stage-report/35 bg-stage-report/10 px-2.5 py-1 text-stage-report">
            <Power className="size-3" />
            Practice
          </span>
        )}
      </div>

      <p className="label-mono mt-3 text-muted-foreground">
        {formatMinutes(hackathon.simulation_duration_minutes)} build window
      </p>

      <div className="mt-8 grid max-w-3xl gap-6">
        {sections.map((section) => (
          <Card key={section.label} className="p-6">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">
              {section.label}
            </h2>
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {section.value || "—"}
            </p>
          </Card>
        ))}
      </div>
    </AdminLayout>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────────
// The dialog itself is mounted once by AdminLayout, which wraps every admin
// page in <ConfirmDialogProvider>. Pages only call `useConfirmDialog()`.
