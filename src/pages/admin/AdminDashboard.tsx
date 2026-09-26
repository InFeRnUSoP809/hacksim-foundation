import { AdminLayout } from "@/layouts/AdminLayout";
import { StatCard } from "@/components/StatCard";
import { ErrorState, LoadingState } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAsync } from "@/hooks/use-async";
import { getPracticeHackathon } from "@/services/hackathons";
import {
  getAdminAnalysisStats,
  getAiOverview,
  isApiConfigured,
} from "@/lib/api";
import { formatMinutes } from "@/lib/format";
import {
  Activity,
  Boxes,
  Brain,
  CheckCircle2,
  CircleDollarSign,
  FileText,
  GitBranch,
  Receipt,
  Target,
  Users,
  UsersRound,
} from "lucide-react";
import { Link } from "react-router";
import type { Hackathon } from "@/types";
import type { AdminAnalysisStats, AiOverview } from "@/types/analysis";

/**
 * The admin control centre.
 *
 * Every figure here comes from a database function rather than a client-side
 * count, so the dashboard cannot drift from the data. The AI figures are
 * optional: when the API is not deployed the rest of the page still works.
 */
export default function AdminDashboard() {
  const practice = useAsync<Hackathon | null>(() => getPracticeHackathon(), []);
  const stats = useAsync<AdminAnalysisStats>(() => getAdminAnalysisStats(), []);
  const ai = useAsync<AiOverview | null>(
    () => (isApiConfigured ? getAiOverview(1) : Promise.resolve(null)),
    [],
  );

  const current = practice.data;
  const practiceOn = Boolean(current);
  const s = stats.data;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-2">
        <p className="label-mono text-brand">Control</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">
          Practice overview
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Whether practice is open, what is running, how teams are doing against
          the brief, and what the AI pipeline has cost so far today.
        </p>
      </div>

      {stats.error && (
        <div className="mt-8">
          <ErrorState
            title="Couldn't load counts"
            message={stats.error}
            action={
              <Button size="sm" variant="outline" onClick={stats.reload}>
                Try again
              </Button>
            }
          />
        </div>
      )}

      {(stats.isLoading || practice.isLoading) && !stats.error ? (
        <LoadingState label="Loading overview" />
      ) : (
        <>
          {/* ── §62 headline cards ─────────────────────────────── */}
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total users" value={s?.users ?? 0} icon={Users} />
            <StatCard
              label="Total teams"
              value={s?.teams ?? 0}
              icon={UsersRound}
            />
            <StatCard
              label="Active simulations"
              value={s?.active_sessions ?? 0}
              icon={Activity}
              tone={(s?.active_sessions ?? 0) > 0 ? "positive" : "muted"}
            />
            <StatCard
              label="Total submissions"
              value={(s?.submissions_draft ?? 0) + (s?.submissions_final ?? 0)}
              icon={FileText}
            />
          </div>

          {/* ── §63 + §64 ──────────────────────────────────────── */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card
              className={
                practiceOn
                  ? "flex flex-col gap-3 border-stage-report/40 p-6"
                  : "flex flex-col gap-3 p-6"
              }
            >
              <p className="label-mono text-muted-foreground">
                Practice hackathon
              </p>
              <p className="flex items-center gap-3 text-3xl font-semibold tracking-[-0.03em]">
                <span
                  aria-hidden
                  className={
                    practiceOn
                      ? "size-3 rounded-full bg-stage-report"
                      : "size-3 rounded-full border-2 border-muted-foreground"
                  }
                />
                {practiceOn ? "ON" : "OFF"}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {practiceOn
                  ? "Students can see the brief and start a new simulation."
                  : "No hackathon is open for practice. Students cannot start a new simulation."}
              </p>
              <Button size="sm" variant="outline" asChild className="w-fit">
                <Link to="/admin/hackathons">
                  {practiceOn ? "Change practice hackathon" : "Open practice"}
                </Link>
              </Button>
            </Card>

            <Card className="flex flex-col gap-3 p-6">
              <p className="label-mono text-muted-foreground">
                Current practice hackathon
              </p>
              {current ? (
                <>
                  <p className="text-2xl font-semibold tracking-[-0.02em]">
                    {current.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatMinutes(current.simulation_duration_minutes)} build
                    window
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-mono tabular-nums">
                      {s?.active_sessions ?? 0}
                    </span>{" "}
                    simulations running now
                  </p>
                </>
              ) : (
                <p className="text-lg font-medium text-muted-foreground">
                  None active
                </p>
              )}

              <div className="mt-2 grid grid-cols-3 gap-3 border-t border-border pt-4">
                <MiniCount
                  label="Completed"
                  value={s?.completed_sessions ?? 0}
                />
                <MiniCount label="Expired" value={s?.expired_sessions ?? 0} />
                <MiniCount
                  label="Submitted"
                  value={s?.submitted_sessions ?? 0}
                />
              </div>
            </Card>
          </div>

          {/* ── §65 submission overview ────────────────────────── */}
          <Section
            title="Submissions"
            action={
              <Button size="sm" variant="outline" asChild>
                <Link to="/admin/submissions">Open submissions</Link>
              </Button>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Draft" value={s?.submissions_draft ?? 0} />
              <StatCard
                label="Submitted"
                value={s?.submissions_final ?? 0}
                icon={CheckCircle2}
              />
              <StatCard
                label="GitHub analysed"
                value={s?.analyzed ?? 0}
                icon={GitBranch}
              />
              <StatCard
                label="AI reviewed"
                value={s?.reviews ?? 0}
                icon={Brain}
              />
            </div>
            {(s?.analysis_failed ?? 0) > 0 && (
              <p className="mt-3 text-sm text-destructive">
                {s?.analysis_failed} repository analyses failed.{" "}
                <Link
                  to="/admin/repositories"
                  className="underline underline-offset-4"
                >
                  Review them
                </Link>
                .
              </p>
            )}
          </Section>

          {/* ── §66 challenge alignment ────────────────────────── */}
          <Section
            title="Challenge alignment"
            description="How submitted repositories line up with the requirements in the brief. Counts, not a score."
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard
                label="Projects analysed"
                value={s?.analyzed ?? 0}
                icon={GitBranch}
              />
              <StatCard
                label="Requirements checked"
                value={s?.requirements_checked ?? 0}
                icon={Target}
              />
              <StatCard
                label="Evidence found"
                value={s?.evidence_found ?? 0}
                tone="positive"
              />
              <StatCard
                label="Partial evidence"
                value={s?.partial_evidence ?? 0}
              />
              <StatCard label="Not evidenced" value={s?.not_evidenced ?? 0} />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              &ldquo;Not evidenced&rdquo; means the analysed repository did not
              provide enough evidence to decide. It is not a statement that the
              feature is missing.
            </p>
          </Section>

          {/* ── §67 AI overview ─────────────────────────────────── */}
          <Section
            title="AI today"
            description="Token and cost figures reported by the provider, not estimated."
          >
            {!isApiConfigured ? (
              <Card className="flex items-start gap-3 border-dashed p-5">
                <Receipt className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  The HackSim API is not configured, so repository analysis and
                  AI review are unavailable. Everything else on this page is
                  read directly from the database and keeps working.
                </p>
              </Card>
            ) : ai.error ? (
              <Card className="p-5">
                <p className="text-sm text-muted-foreground">
                  Could not load AI usage: {ai.error}
                </p>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="AI requests today"
                  value={ai.data?.total_requests ?? 0}
                  icon={Receipt}
                />
                <StatCard
                  label="AI cost today"
                  value={formatCost(ai.data?.total_cost_usd ?? 0)}
                  icon={CircleDollarSign}
                />
                <StatCard
                  label="Input tokens"
                  value={(ai.data?.input_tokens ?? 0).toLocaleString()}
                />
                <StatCard
                  label="Cached tokens"
                  value={(ai.data?.cached_tokens ?? 0).toLocaleString()}
                  hint={
                    ai.data
                      ? `${Math.round(ai.data.cache_hit_rate * 100)}% cache hit rate`
                      : undefined
                  }
                />
              </div>
            )}
            {isApiConfigured && (
              <Button
                size="sm"
                variant="outline"
                asChild
                className="mt-4 w-fit"
              >
                <Link to="/admin/ai">Open AI operations</Link>
              </Button>
            )}
          </Section>

          <Card className="mt-4 flex items-start gap-3 border-dashed p-5">
            <Boxes className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Switching practice off stops new simulations immediately. Any
              simulation already running continues untouched and keeps its
              brief.
            </p>
          </Card>
        </>
      )}
    </AdminLayout>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.02em]">{title}</h2>
          {description && (
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function MiniCount({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="label-mono text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
