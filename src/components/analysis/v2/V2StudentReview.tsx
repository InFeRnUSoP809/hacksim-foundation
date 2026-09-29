import { V2ReviewProgress } from "@/components/analysis/v2/V2ReviewProgress";
import { V2ReviewReport } from "@/components/analysis/v2/V2ReviewReport";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  getV2AnalysisStatusRpc,
  getV2AnalysisSummaryRpc,
  isApiConfigured,
  retryV2Analysis,
} from "@/lib/api";
import { friendlyError } from "@/services/errors";
import type { V2AnalysisStatus, V2AnalysisSummary, V2RunStatus } from "@/types/v2-analysis";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

const TERMINAL: V2RunStatus[] = ["completed", "partial", "failed"];

export function V2StudentReview(props: {
  submissionId: string;
  projectName: string;
  githubUrl?: string;
}) {
  const [status, setStatus] = useState<V2AnalysisStatus | null>(null);
  const [summary, setSummary] = useState<V2AnalysisSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explore, setExplore] = useState(false);

  useEffect(() => {
    if (!isApiConfigured) return;
    let cancelled = false;
    let delay = 5000;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const st = await getV2AnalysisStatusRpc(props.submissionId);
        if (cancelled) return;
        setStatus(st);
        const s = st?.status as V2RunStatus | undefined;
        if (s === "completed" || s === "partial") {
          const sum = await getV2AnalysisSummaryRpc(props.submissionId);
          if (!cancelled) setSummary(sum);
          return;
        }
        if (s === "failed") {
          setError(st?.error_message ?? "Review could not be completed.");
          return;
        }
        delay = Math.min(delay + 5000, 30000);
        timer = setTimeout(tick, delay);
      } catch (err) {
        if (!cancelled) setError(friendlyError(err));
      }
    }

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.submissionId]);

  const runStatus = status?.status as V2RunStatus | undefined;
  const ready = summary?.ready === true;

  return (
    <div className="mt-8 space-y-6">
      <Card className="p-6">
        <p className="label-mono text-brand">Project Review</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{props.projectName}</h2>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
          HackSim analyzed your repository and traced the important implementation workflows.
        </p>
        {ready && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Review complete
            </span>
            {!explore && (
              <Button size="sm" onClick={() => setExplore(true)}>
                Explore review
              </Button>
            )}
          </div>
        )}
        {runStatus === "partial" && ready && (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            Review partially completed — some details could not be verified from the inspected source.
          </p>
        )}
      </Card>

      {!ready && !error && (
        <V2ReviewProgress status={runStatus} progressPercent={status?.progress_percent} />
      )}

      {error && (
        <Card className="p-6 border-destructive/40">
          <p className="font-medium text-sm">We couldn&apos;t complete your project review.</p>
          <p className="text-sm text-muted-foreground mt-1">Your submission is safe.</p>
          <p className="text-sm mt-2">{error}</p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              void retryV2Analysis(props.submissionId);
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry review
          </Button>
        </Card>
      )}

      {ready && explore && summary && <V2ReviewReport data={summary} />}
    </div>
  );
}
