import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { V2AnalysisSummary } from "@/types/v2-analysis";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  partially_confirmed: "Partially confirmed",
  weakly_evidenced: "Weakly evidenced",
  not_evidenced: "Not evidenced",
  unable_to_determine: "Unable to determine",
  contradicted: "Contradicted",
};

export function V2ReviewReport(props: { data: V2AnalysisSummary; admin?: boolean }) {
  const { data } = props;
  const summary = data.summary;
  const coverage = data.coverage;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-wrap items-center gap-2 gap-y-2 justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Project Review</h1>
            <p className="text-muted-foreground mt-1">{summary?.headline}</p>
          </div>
          <Badge variant="secondary">{String(data.run?.status ?? "completed")}</Badge>
        </div>
        <p className="mt-4 text-sm leading-relaxed">{summary?.implementation_summary}</p>
      </Card>

      <Tabs defaultValue="overview">
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="requirements">Requirements</TabsTrigger>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="uncertainty">Uncertainty</TabsTrigger>
          {props.admin && <TabsTrigger value="coverage">Coverage</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          {summary?.strong_points?.length ? (
            <Card className="p-4">
              <h3 className="font-medium mb-2">Strongly evidenced areas</h3>
              <ul className="list-disc pl-5 text-sm space-y-1">
                {summary.strong_points.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Card>
          ) : null}
          {summary?.defense_questions?.length ? (
            <Card className="p-4">
              <h3 className="font-medium mb-2">Defense preparation</h3>
              <ul className="list-disc pl-5 text-sm space-y-1">
                {summary.defense_questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="requirements" className="mt-4 space-y-3">
          {(data.requirements ?? []).map((req) => (
            <Card key={req.requirement_id} className="p-4">
              <div className="flex flex-wrap gap-2 items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">{req.requirement_id}</span>
                <Badge variant="outline">{STATUS_LABEL[req.status] ?? req.status}</Badge>
              </div>
              <p className="text-sm mt-2">{req.explanation}</p>
              {!props.admin && (req.evidence_ids?.length ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Based on {req.evidence_ids?.length} evidence item(s) in your codebase.
                </p>
              )}
              {props.admin && (
                <p className="text-xs font-mono mt-2 text-muted-foreground">
                  Evidence: {(req.evidence_ids ?? []).join(", ")}
                </p>
              )}
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="workflows" className="mt-4 space-y-3">
          {(data.features ?? []).map((feature) => (
            <Card key={feature.feature_key} className="p-4">
              <h3 className="font-medium">{feature.name}</h3>
              <ol className="mt-3 space-y-2 border-l pl-4 text-sm">
                {feature.workflow.map((step, i) => (
                  <li key={`${feature.feature_key}-${i}`}>
                    <span className="font-medium">{step.step}</span>
                    {props.admin && step.evidenceId && (
                      <span className="text-muted-foreground font-mono text-xs ml-2">
                        {step.evidenceId}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="uncertainty" className="mt-4 space-y-3">
          {(summary?.uncertainties ?? []).map((u, i) => (
            <Card key={i} className="p-4">
              <h3 className="font-medium text-sm">{u.title ?? "Uncertain area"}</h3>
              <p className="text-sm text-muted-foreground mt-1">{u.detail}</p>
            </Card>
          ))}
        </TabsContent>

        {props.admin && (
          <TabsContent value="coverage" className="mt-4">
            <Card className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              {coverage &&
                Object.entries(coverage).map(([key, value]) => (
                  <div key={key}>
                    <p className="text-muted-foreground text-xs">{key.replace(/_/g, " ")}</p>
                    <p className="font-medium">{value}</p>
                  </div>
                ))}
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
