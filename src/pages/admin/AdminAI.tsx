import { AdminLayout } from "@/layouts/AdminLayout";
import { StatCard } from "@/components/StatCard";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAsync } from "@/hooks/use-async";
import {
  getAiBudgets,
  getAiErrors,
  getAiOverview,
  getAiSettingsPage,
  getAiUsage,
  getCacheAnalytics,
  getCostForecast,
  isApiConfigured,
  saveAiBudget,
  saveAiModel,
  setAiEnabled,
} from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CircleDollarSign,
  Cpu,
  Gauge,
  Receipt,
  Save,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import type { AiUsageRow } from "@/types/analysis";

/**
 * §68 — the AI operations console.
 *
 * Six sections, one page. Every figure is the provider's own reported usage.
 * The kill switch here is the §55 control: turning AI off stops new requests
 * and leaves existing analysis untouched and readable.
 */
type Tab = "overview" | "usage" | "errors" | "budgets" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "usage", label: "Usage" },
  { key: "errors", label: "Errors" },
  { key: "budgets", label: "Budgets" },
  { key: "settings", label: "Settings" },
];

export default function AdminAI() {
  const [tab, setTab] = useState<Tab>("overview");

  if (!isApiConfigured) {
    return (
      <AdminLayout>
        <Header />
        <Card className="mt-8 flex items-start gap-3 border-dashed p-6">
          <Receipt className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-base font-semibold">
              Supabase is not configured
            </p>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              AI operations run in a Supabase edge function so the DeepSeek key
              never reaches a browser. Set{" "}
              <code className="font-mono">VITE_SUPABASE_URL</code> and{" "}
              <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> to enable
              this page. Repository analysis and review are unaffected in the
              meantime — nothing else in the admin surface depends on it.
            </p>
          </div>
        </Card>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <Header />

      <nav className="mt-6 flex flex-wrap gap-1.5 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
              tab === item.key
                ? "border-brand text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mt-8">
        {tab === "overview" && <OverviewTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "errors" && <ErrorsTab />}
        {tab === "budgets" && <BudgetsTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </AdminLayout>
  );
}

function Header() {
  return (
    <div>
      <p className="label-mono text-brand">Phase 6</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
        AI operations
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Every request, token, cost and failure. Token counts come from the
        provider's response, not an estimate, so these numbers are the ledger.
      </p>
    </div>
  );
}

// ── §69 Overview ───────────────────────────────────────────────────────────

function OverviewTab() {
  const overview = useAsync(() => getAiOverview(30), []);
  const forecast = useAsync(() => getCostForecast(), []);
  const cache = useAsync(() => getCacheAnalytics(30), []);

  if (overview.isLoading) return <LoadingState label="Loading AI overview" />;
  if (overview.error) {
    return (
      <ErrorState
        title="Couldn't load AI overview"
        message={overview.error}
        action={
          <Button size="sm" variant="outline" onClick={overview.reload}>
            Try again
          </Button>
        }
      />
    );
  }

  const data = overview.data;
  const budget = data?.global_budget;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total requests"
          value={data?.total_requests ?? 0}
          icon={Receipt}
        />
        <StatCard
          label="Total cost"
          value={formatCost(data?.total_cost_usd ?? 0)}
          icon={CircleDollarSign}
        />
        <StatCard
          label="Failed requests"
          value={(data?.failed ?? 0) + (data?.rejected ?? 0)}
          tone={(data?.failed ?? 0) > 0 ? "muted" : "default"}
        />
        <StatCard
          label="Cache hit rate"
          value={`${Math.round((data?.cache_hit_rate ?? 0) * 100)}%`}
          hint={`${(data?.cached_tokens ?? 0).toLocaleString()} cached tokens`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Input tokens"
          value={(data?.input_tokens ?? 0).toLocaleString()}
        />
        <StatCard
          label="Output tokens"
          value={(data?.output_tokens ?? 0).toLocaleString()}
        />
        <StatCard
          label="Average per submission"
          value={formatCost(data?.average_cost_per_submission ?? 0)}
        />
        <StatCard
          label="Successful analyses"
          value={data?.successful_analyses ?? 0}
        />
      </div>

      {budget && (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="label-mono text-muted-foreground">Global budget</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatCost(budget.used_cost_usd)}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  of {formatCost(budget.max_cost_usd ?? 0)}
                </span>
              </p>
            </div>
            <BudgetLevel level={budget.level} />
          </div>
          <Meter
            value={budget.utilization}
            level={budget.level}
            className="mt-4"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {budget.used_requests}
            {budget.max_requests ? ` of ${budget.max_requests}` : ""} requests ·{" "}
            {(budget.used_input_tokens ?? 0).toLocaleString()}
            {budget.max_input_tokens
              ? ` of ${budget.max_input_tokens.toLocaleString()}`
              : ""}{" "}
            input tokens
          </p>
        </Card>
      )}

      {/* §77 */}
      <div>
        <h2 className="text-lg font-semibold tracking-[-0.02em]">
          Cache analytics
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          The stable half of every prompt is cached by the provider, so repeated
          analysis of the same repository costs far less.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Cached tokens"
            value={(cache.data?.cached_tokens ?? 0).toLocaleString()}
            icon={Cpu}
          />
          <StatCard
            label="Uncached tokens"
            value={(cache.data?.uncached_tokens ?? 0).toLocaleString()}
          />
          <StatCard
            label="Cache hit rate"
            value={`${Math.round((cache.data?.cache_hit_rate ?? 0) * 100)}%`}
            icon={Gauge}
          />
          <StatCard
            label="Estimated savings"
            value={formatCost(cache.data?.estimated_cache_savings_usd ?? 0)}
            hint="from cache pricing"
          />
        </div>
      </div>

      {/* §76 */}
      <div>
        <h2 className="text-lg font-semibold tracking-[-0.02em]">
          Cost forecast
        </h2>
        <p className="mt-1 flex items-center gap-2 text-sm leading-relaxed text-muted-foreground">
          <TrendingUp className="size-3.5" />
          Estimated from the actual average cost of{" "}
          {forecast.data?.analyzed_submissions ?? 0} analysed submissions. These
          are projections, not actual spending.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {(forecast.data?.projections ?? []).map((row) => (
            <Card key={row.submissions} className="p-5">
              <p className="label-mono text-muted-foreground">
                {row.submissions} submissions
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums">
                {formatCost(row.estimated_cost_usd)}
              </p>
              <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Estimated
              </p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── §70 Usage ──────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, string> = {
  success: "border-stage-report/35 bg-stage-report/10 text-stage-report",
  failed: "border-destructive/35 bg-destructive/10 text-destructive",
  rejected: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
  pending: "border-border bg-muted text-muted-foreground",
};

function UsageTab() {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState("");
  const [operation, setOperation] = useState("");

  const usage = useAsync(
    () =>
      getAiUsage({
        days,
        status: status || undefined,
        operation: operation || undefined,
        limit: 200,
      }),
    [days, status, operation],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="rejected">Rejected</option>
        </select>
        <input
          value={operation}
          onChange={(event) => setOperation(event.target.value)}
          placeholder="Filter by operation"
          className="h-9 w-56 rounded-md border border-input bg-background px-3 text-sm"
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {usage.data?.count ?? 0} requests
        </span>
      </div>

      {usage.isLoading ? (
        <LoadingState label="Loading usage" />
      ) : usage.error ? (
        <ErrorState title="Couldn't load usage" message={usage.error} />
      ) : (usage.data?.rows ?? []).length === 0 ? (
        <Card className="border-dashed p-8">
          <p className="text-sm text-muted-foreground">
            No AI requests recorded for these filters.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {[
                    "Timestamp",
                    "User",
                    "Project",
                    "Operation",
                    "Model",
                    "Input",
                    "Output",
                    "Cached",
                    "Cost",
                    "Status",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="label-mono px-4 py-3 text-muted-foreground"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(usage.data?.rows ?? []).map((row: AiUsageRow) => (
                  <tr
                    key={row.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatDate(row.created_at)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {row.user_email ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {row.project_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">
                      {row.operation}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                      {row.model}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">
                      {row.input_tokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">
                      {row.output_tokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">
                      {row.cached_tokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums">
                      {formatCost(row.estimated_cost_usd)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "label-mono inline-flex rounded-full border px-2 py-0.5",
                          STATUS_TONE[row.status] ?? STATUS_TONE.pending,
                        )}
                      >
                        {row.status}
                      </span>
                      {row.error_code && (
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {row.error_code}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── §72 Errors ─────────────────────────────────────────────────────────────

function ErrorsTab() {
  const errors = useAsync(() => getAiErrors(30), []);

  if (errors.isLoading) return <LoadingState label="Loading errors" />;
  if (errors.error)
    return <ErrorState title="Couldn't load errors" message={errors.error} />;

  const counts = errors.data?.counts ?? {};
  const known: [string, string][] = [
    ["rate_limited", "Rate limit errors"],
    ["timeout", "Timeouts"],
    ["invalid_json", "Invalid JSON"],
    ["provider_error", "Provider errors"],
    ["budget_exceeded:stop", "Budget exceeded"],
    ["budget_would_be_exceeded", "Budget would be exceeded"],
    ["not_configured", "AI not configured"],
  ];
  const knownCodes = new Set(known.map(([code]) => code));
  const otherCodes = Object.entries(counts).filter(
    ([code]) => !knownCodes.has(code),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {known.map(([code, label]) => (
          <Card key={code} className="p-4">
            <p className="label-mono text-[10px] text-muted-foreground">
              {label}
            </p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {counts[code] ?? 0}
            </p>
          </Card>
        ))}
      </div>

      {otherCodes.length > 0 && (
        <Card className="p-5">
          <p className="label-mono text-muted-foreground">Other codes</p>
          <ul className="mt-2 flex flex-col gap-1">
            {otherCodes.map(([code, count]) => (
              <li key={code} className="font-mono text-xs">
                {code}: {count}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(errors.data?.rows ?? []).length === 0 ? (
        <Card className="border-dashed p-8">
          <p className="text-sm text-muted-foreground">
            No failed requests in the last 30 days.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {["Timestamp", "Operation", "Model", "Code", "Message"].map(
                    (heading) => (
                      <th
                        key={heading}
                        className="label-mono px-4 py-3 text-muted-foreground"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {(errors.data?.rows ?? []).map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border align-top last:border-0"
                  >
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatDate(row.created_at)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">
                      {row.operation}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                      {row.model}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-stage-submit">
                      {row.error_code ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.error_message ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── §73 Budgets ────────────────────────────────────────────────────────────

function BudgetsTab() {
  const budgets = useAsync(() => getAiBudgets(), []);
  const [draft, setDraft] = useState({
    max_cost_usd: "0.25",
    max_requests: "30",
    max_input_tokens: "100000",
    max_output_tokens: "20000",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await saveAiBudget({
        scope: "global",
        max_cost_usd: Number(draft.max_cost_usd),
        max_requests: Number(draft.max_requests),
        max_input_tokens: Number(draft.max_input_tokens),
        max_output_tokens: Number(draft.max_output_tokens),
        enabled: true,
      });
      setMessage("Saved. The new limits apply to the next AI request.");
      budgets.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (budgets.isLoading) return <LoadingState label="Loading budgets" />;
  if (budgets.error)
    return <ErrorState title="Couldn't load budgets" message={budgets.error} />;

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {[
                  "Scope",
                  "Target",
                  "Used / Limit",
                  "Requests",
                  "Utilization",
                  "State",
                  "",
                ].map((heading) => (
                  <th
                    key={heading}
                    className="label-mono px-4 py-3 text-muted-foreground"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(budgets.data?.budgets ?? []).map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-3">
                    <span className="label-mono">{row.scope}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {row.project_name ?? row.user_email ?? "All"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums">
                    {formatCost(row.used_cost_usd)}
                    {row.max_cost_usd
                      ? ` / ${formatCost(row.max_cost_usd)}`
                      : ""}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs tabular-nums">
                    {row.used_requests}
                    {row.max_requests ? ` / ${row.max_requests}` : ""}
                  </td>
                  <td className="px-4 py-3">
                    <Meter value={row.utilization} level={row.level} />
                  </td>
                  <td className="px-4 py-3">
                    <BudgetLevel level={row.level} />
                    {!row.enabled && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        disabled
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.scope !== "global" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          saveAiBudget({
                            id: row.id,
                            scope: row.scope,
                            enabled: false,
                          })
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div>
        <h2 className="text-lg font-semibold tracking-[-0.02em]">
          Global limits
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Checked before every AI request. When a limit would be exceeded the
          request is rejected and recorded, rather than made and left unpaid.
        </p>
        <Card className="mt-4 p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Max cost (USD)">
              <Input
                type="number"
                step="0.01"
                value={draft.max_cost_usd}
                onChange={(event) =>
                  setDraft({ ...draft, max_cost_usd: event.target.value })
                }
              />
            </Field>
            <Field label="Max requests">
              <Input
                type="number"
                value={draft.max_requests}
                onChange={(event) =>
                  setDraft({ ...draft, max_requests: event.target.value })
                }
              />
            </Field>
            <Field label="Max input tokens">
              <Input
                type="number"
                value={draft.max_input_tokens}
                onChange={(event) =>
                  setDraft({ ...draft, max_input_tokens: event.target.value })
                }
              />
            </Field>
            <Field label="Max output tokens">
              <Input
                type="number"
                value={draft.max_output_tokens}
                onChange={(event) =>
                  setDraft({ ...draft, max_output_tokens: event.target.value })
                }
              />
            </Field>
          </div>
          <Button className="mt-5" onClick={save} disabled={saving}>
            <Save className="size-4" />
            {saving ? "Saving…" : "Save global limits"}
          </Button>
          {message && (
            <p className="mt-3 text-sm text-muted-foreground">{message}</p>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── §74 Settings + §55 kill switch ────────────────────────────────────────

function SettingsTab() {
  const settings = useAsync(() => getAiSettingsPage(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function saveModel() {
    setMessage(null);
    try {
      await saveAiModel({
        provider: "deepseek",
        model_name: "deepseek-flash",
        enabled: true,
        is_default: true,
        input_price_per_million_cache_hit: Number(draft.cache_hit ?? "0.028"),
        input_price_per_million_cache_miss: Number(draft.cache_miss ?? "0.28"),
        output_price_per_million: Number(draft.output ?? "0.42"),
        max_input_tokens: Number(draft.max_input ?? "32000"),
        max_output_tokens: Number(draft.max_output ?? "4000"),
        reasoning_mode: "off",
      });
      setMessage("Saved. The new pricing applies to the next request.");
      settings.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
    }
  }

  if (settings.isLoading) return <LoadingState label="Loading AI settings" />;
  if (settings.error) {
    return (
      <ErrorState title="Couldn't load settings" message={settings.error} />
    );
  }

  const enabled = settings.data?.kill_switch.ai_enabled ?? true;
  const model = settings.data?.models?.[0];

  return (
    <div className="flex flex-col gap-8">
      <Card
        className={cn(
          "flex flex-wrap items-center justify-between gap-4 p-6",
          !enabled && "border-destructive/40",
        )}
      >
        <div className="flex items-start gap-3">
          {enabled ? (
            <Receipt className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <div>
            <p className="text-sm font-semibold">AI enabled</p>
            <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
              {enabled
                ? "New AI requests are allowed. Existing analysis stays readable either way."
                : "No new AI requests will be made. Repository analysis and every existing review remain available."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="label-mono text-xs text-muted-foreground">
            {enabled ? "ON" : "OFF"}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={async (next) => {
              await setAiEnabled(next);
              settings.reload();
            }}
          />
        </div>
      </Card>

      <div>
        <h2 className="text-lg font-semibold tracking-[-0.02em]">
          Model and pricing
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Pricing lives in the database so it can change without a deploy. Cost
          is calculated from the token counts the provider reports.
        </p>
        <Card className="mt-4 p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Provider / model">
              <Input
                value={
                  model
                    ? `${model.provider} / ${model.model_name}`
                    : "deepseek / deepseek-flash"
                }
                disabled
              />
            </Field>
            <Field label="Input $ / 1M (cache hit)">
              <Input
                type="number"
                step="0.001"
                value={
                  draft.cache_hit ??
                  String(model?.input_price_per_million_cache_hit ?? 0.028)
                }
                onChange={(event) =>
                  setDraft({ ...draft, cache_hit: event.target.value })
                }
              />
            </Field>
            <Field label="Input $ / 1M (cache miss)">
              <Input
                type="number"
                step="0.001"
                value={
                  draft.cache_miss ??
                  String(model?.input_price_per_million_cache_miss ?? 0.28)
                }
                onChange={(event) =>
                  setDraft({ ...draft, cache_miss: event.target.value })
                }
              />
            </Field>
            <Field label="Output $ / 1M">
              <Input
                type="number"
                step="0.001"
                value={
                  draft.output ??
                  String(model?.output_price_per_million ?? 0.42)
                }
                onChange={(event) =>
                  setDraft({ ...draft, output: event.target.value })
                }
              />
            </Field>
            <Field label="Max input tokens">
              <Input
                type="number"
                value={
                  draft.max_input ?? String(model?.max_input_tokens ?? 32000)
                }
                onChange={(event) =>
                  setDraft({ ...draft, max_input: event.target.value })
                }
              />
            </Field>
            <Field label="Max output tokens">
              <Input
                type="number"
                value={
                  draft.max_output ?? String(model?.max_output_tokens ?? 4000)
                }
                onChange={(event) =>
                  setDraft({ ...draft, max_output: event.target.value })
                }
              />
            </Field>
          </div>
          <Button className="mt-5" onClick={saveModel}>
            <Save className="size-4" />
            Save model settings
          </Button>
          {message && (
            <p className="mt-3 text-sm text-muted-foreground">{message}</p>
          )}
        </Card>
      </div>

      <Card className="p-5">
        <p className="text-sm font-semibold">Alert thresholds</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          A budget is marked as a warning at 50% of its cost limit, critical at
          80%, and stops new requests at 100%. Utilisation is shown on the
          overview and budgets pages.
        </p>
      </Card>
    </div>
  );
}

// ── Small shared bits ──────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="label-mono text-[10px] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function BudgetLevel({ level }: { level: string }) {
  const tone: Record<string, string> = {
    normal: "border-stage-report/35 bg-stage-report/10 text-stage-report",
    warning: "border-stage-build/35 bg-stage-build/10 text-stage-build",
    critical: "border-stage-submit/35 bg-stage-submit/10 text-stage-submit",
    stop: "border-destructive/35 bg-destructive/10 text-destructive",
  };
  return (
    <span
      className={cn(
        "label-mono inline-flex rounded-full border px-2.5 py-1",
        tone[level] ?? tone.normal,
      )}
    >
      {level}
    </span>
  );
}

function Meter({
  value,
  level,
  className,
}: {
  value: number;
  level: string;
  className?: string;
}) {
  const pct = Math.min(100, Math.round(value * 100));
  const tone: Record<string, string> = {
    normal: "bg-stage-report",
    warning: "bg-stage-build",
    critical: "bg-stage-submit",
    stop: "bg-destructive",
  };
  return (
    <div className={cn("h-1.5 w-full rounded-full bg-muted", className)}>
      <div
        className={cn(
          "h-1.5 rounded-full transition-all",
          tone[level] ?? tone.normal,
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function formatCost(value: number): string {
  if (!value) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
