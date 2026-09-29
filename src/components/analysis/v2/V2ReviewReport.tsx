import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { V2AnalysisSummary, V2Feature } from "@/types/v2-analysis";
import { useState } from "react";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  partially_confirmed: "Partially confirmed",
  weakly_evidenced: "Weakly evidenced",
  not_evidenced: "Not evidenced",
  unable_to_determine: "Unable to determine",
  contradicted: "Contradicted",
};

function WorkflowSteps(props: { feature: V2Feature; onStep?: (step: string) => void }) {
  return (
    <ol className="relative border-l pl-4 space-y-3 text-sm">
      {props.feature.workflow.map((step, i) => (
        <li key={`${props.feature.feature_key}-${i}`}>
          <button
            type="button"
            className="text-left hover:text-primary transition-colors"
            onClick={() => props.onStep?.(step.step)}
          >
            {step.step.replace(/_/g, " ")}
          </button>
        </li>
      ))}
    </ol>
  );
}

export function V2ReviewReport(props: { data: V2AnalysisSummary; admin?: boolean }) {
  const { data } = props;
  const summary = data.summary;
  const [activeStep, setActiveStep] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Tabs defaultValue="overview">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="how">How it works</TabsTrigger>
          <TabsTrigger value="requirements">Requirements</TabsTrigger>
          <TabsTrigger value="features">Features</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="uncertainty">Uncertainty</TabsTrigger>
          <TabsTrigger value="defense">Defense prep</TabsTrigger>
          {props.admin && <TabsTrigger value="coverage">Coverage</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <Card className="p-5">
            <h3 className="font-medium">What HackSim found</h3>
            <p className="text-sm mt-2 leading-relaxed">{summary?.implementation_summary}</p>
          </Card>
          {summary?.strong_points?.length ? (
            <Card className="p-5">
              <h3 className="font-medium">Strongly supported areas</h3>
              <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
                {summary.strong_points.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="how" className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">How your project works — traced from code relationships.</p>
          {(data.features ?? []).map((feature) => (
            <Card key={feature.feature_key} className="p-5">
              <h3 className="font-medium">{feature.name}</h3>
              <div className="mt-3">
                <WorkflowSteps feature={feature} onStep={setActiveStep} />
              </div>
              {activeStep && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Selected step: {activeStep.replace(/_/g, " ")}
                  {props.admin ? " — open Evidence tab for technical IDs." : ""}
                </p>
              )}
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="requirements" className="mt-4 space-y-3">
          {(data.requirements ?? []).map((req) => (
            <Card key={req.requirement_id} className="p-4">
              <div className="flex flex-wrap gap-2 justify-between items-start">
                <p className="text-sm font-medium">{req.requirement_id}</p>
                <Badge variant="outline">{STATUS_LABEL[req.status] ?? req.status}</Badge>
              </div>
              <p className="text-sm mt-2 text-muted-foreground">{req.explanation}</p>
              {!props.admin && (req.evidence_ids?.length ?? 0) > 0 && (
                <Button variant="link" className="px-0 h-auto text-xs mt-2" type="button">
                  View evidence ({req.evidence_ids?.length})
                </Button>
              )}
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="features" className="mt-4 space-y-3">
          {(data.features ?? []).map((f) => (
            <Card key={f.feature_key} className="p-4">
              <h3 className="font-medium">{f.name}</h3>
              <p className="text-xs text-muted-foreground mt-1">Confidence: {f.confidence ?? "medium"}</p>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="evidence" className="mt-4">
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              {props.admin
                ? "Use the admin Evidence explorer for paginated inspection."
                : "Evidence is tied to specific files and behaviors in your repository. Expand technical details in admin view if needed."}
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="uncertainty" className="mt-4 space-y-3">
          {(summary?.uncertainties ?? []).map((u, i) => (
            <Card key={i} className="p-4">
              <h3 className="text-sm font-medium">{u.title ?? "Something HackSim could not fully verify"}</h3>
              <p className="text-sm text-muted-foreground mt-1">{u.detail}</p>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="defense" className="mt-4">
          <Card className="p-5">
            <h3 className="font-medium">What you should be ready to explain</h3>
            <ul className="list-disc pl-5 text-sm mt-3 space-y-2">
              {(summary?.defense_questions ?? []).map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </Card>
        </TabsContent>

        {props.admin && (
          <TabsContent value="coverage" className="mt-4">
            <Card className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              {data.coverage &&
                Object.entries(data.coverage).map(([key, value]) => (
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
