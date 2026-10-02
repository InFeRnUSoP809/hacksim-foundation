/**
 * Reconstruct implementation workflows from behaviors + graph (generic, no repo names).
 */

import type { Flow, RepoGraph } from "../graph/build.ts";
import type { ImplementationBehavior } from "../behavior/extract.ts";

export type WorkflowStepKind =
  | "frontend_request"
  | "backend_entry"
  | "prompt"
  | "ai_request"
  | "structured_response"
  | "parse_response"
  | "transform_limit"
  | "database_write"
  | "database_read"
  | "http_request"
  | "return_output"
  | "unresolved";

export interface WorkflowStep {
  kind: WorkflowStepKind;
  label: string;
  file: string;
  symbol: string | null;
  start_line: number;
  end_line: number;
  behavior_id: string | null;
  evidence_level: string;
  confidence: "high" | "medium" | "low";
}

export interface ImplementationWorkflow {
  id: string;
  label: string;
  closed: boolean;
  missing_links: string[];
  steps: WorkflowStep[];
  flow_id: string | null;
  files: string[];
}

const STEP_ORDER: WorkflowStepKind[] = [
  "frontend_request",
  "backend_entry",
  "prompt",
  "ai_request",
  "structured_response",
  "parse_response",
  "transform_limit",
  "database_write",
  "return_output",
];

function behaviorToStep(b: ImplementationBehavior): WorkflowStep | null {
  const conf = b.level === "L3" ? "high" : "medium";
  switch (b.kind) {
    case "prompt_construction":
      return {
        kind: "prompt",
        label: "Prompt retrieved or constructed",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    case "ai_api_call":
      return {
        kind: "ai_request",
        label: "AI provider HTTP/API request",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    case "structured_json_expected":
      return {
        kind: "structured_response",
        label: "Structured JSON response requested or validated",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    case "parse_json":
      return {
        kind: "parse_response",
        label: "Parses JSON response",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    case "limit_collection":
      return {
        kind: "transform_limit",
        label: b.claim,
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence:
          (b.detail as { interpretation?: string } | undefined)?.interpretation ===
            "ui_display_only"
            ? "low"
            : conf,
      };
    case "database_write":
      return {
        kind: "database_write",
        label: "Persists processed data",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    case "database_read":
      return {
        kind: "database_read",
        label: "Reads persisted data",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    case "http_request":
      return {
        kind: "http_request",
        label: "HTTP client request",
        file: b.file,
        symbol: b.symbol,
        start_line: b.start_line,
        end_line: b.end_line,
        behavior_id: b.id,
        evidence_level: b.level,
        confidence: conf,
      };
    default:
      return null;
  }
}

function workflowFromSymbolBehaviors(
  symbolName: string,
  file: string,
  behaviors: ImplementationBehavior[],
  workflowIndex: number,
): ImplementationWorkflow | null {
  const inSymbol = behaviors
    .filter((b) => b.file === file && b.symbol === symbolName)
    .sort((a, b) => a.start_line - b.start_line);
  if (inSymbol.length < 2) return null;

  const steps: WorkflowStep[] = [];
  for (const b of inSymbol) {
    const step = behaviorToStep(b);
    if (step) steps.push(step);
  }
  const hasAi = steps.some((s) => s.kind === "ai_request");
  const hasParse = steps.some((s) => s.kind === "parse_response");
  if (!hasAi && !hasParse) return null;

  const missing: string[] = [];
  if (!steps.some((s) => s.kind === "prompt")) missing.push("prompt source not traced in this symbol");
  if (!steps.some((s) => s.kind === "database_write")) {
    missing.push("persistence not traced in this symbol");
  }

  const ordered = [...steps].sort(
    (a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind) || a.start_line - b.start_line,
  );

  return {
    id: `IWF-${String(workflowIndex).padStart(3, "0")}`,
    label: `AI processing in \`${symbolName}\``,
    closed: missing.length === 0 && hasAi && hasParse,
    missing_links: missing,
    steps: ordered,
    flow_id: null,
    files: [file],
  };
}

function frontendStepFromGraph(flow: Flow): WorkflowStep | null {
  const hop = flow.hops.find((h) => h.relation === "client_request");
  if (!hop) return null;
  return {
    kind: "frontend_request",
    label: "Frontend HTTP request to backend route",
    file: hop.file,
    symbol: hop.symbol,
    start_line: hop.line,
    end_line: hop.line,
    behavior_id: null,
    evidence_level: "L2",
    confidence: "high",
  };
}

export function discoverImplementationWorkflows(input: {
  behaviors: ImplementationBehavior[];
  graph: RepoGraph;
  flows: Flow[];
}): ImplementationWorkflow[] {
  const workflows: ImplementationWorkflow[] = [];
  let n = 1;

  const bySymbol = new Map<string, ImplementationBehavior[]>();
  for (const b of input.behaviors) {
    if (!b.symbol) continue;
    const key = `${b.file}::${b.symbol}`;
    const list = bySymbol.get(key) ?? [];
    list.push(b);
    bySymbol.set(key, list);
  }

  for (const [key, list] of bySymbol) {
    const [file, symbol] = key.split("::");
    const wf = workflowFromSymbolBehaviors(symbol, file, list, n);
    if (wf) {
      workflows.push(wf);
      n += 1;
    }
  }

  for (const flow of input.flows) {
    const fe = frontendStepFromGraph(flow);
    if (!fe) continue;
    const backendFiles = flow.files.filter((f) => f !== fe.file);
    const backendBehaviors = input.behaviors.filter((b) => backendFiles.includes(b.file));
    const steps: WorkflowStep[] = [fe];
    for (const b of backendBehaviors.sort((a, c) => a.start_line - c.start_line).slice(0, 12)) {
      const step = behaviorToStep(b);
      if (step) steps.push(step);
    }
    if (steps.length < 3) continue;
    const missing: string[] = [];
    if (!steps.some((s) => s.kind === "ai_request")) missing.push("AI request not established on backend path");
    if (!steps.some((s) => s.kind === "parse_response")) missing.push("response parsing not established");
    workflows.push({
      id: `IWF-${String(n).padStart(3, "0")}`,
      label: `Cross-layer flow ${flow.id}`,
      closed: flow.closed && missing.length === 0,
      missing_links: missing,
      steps,
      flow_id: flow.id,
      files: flow.files,
    });
    n += 1;
  }

  return workflows.slice(0, 16);
}

/** Register workflow hops as traceable evidence (links to behavior ids when present). */
export type WorkflowEvidenceClaim = {
  claim: string;
  file: string | null;
  symbol: string | null;
  lines: string;
  detail: Record<string, unknown>;
};

export function workflowEvidenceClaims(
  workflows: ImplementationWorkflow[],
): WorkflowEvidenceClaim[] {
  const out: WorkflowEvidenceClaim[] = [];
  for (const wf of workflows) {
    for (const step of wf.steps) {
      out.push({
        claim: `[${wf.id}] ${step.label}`,
        file: step.file,
        symbol: step.symbol,
        lines: `${step.start_line}-${step.end_line}`,
        detail: {
          workflow_id: wf.id,
          step_kind: step.kind,
          behavior_id: step.behavior_id,
          level: step.evidence_level,
          confidence: step.confidence,
        },
      });
    }
  }
  return out;
}
