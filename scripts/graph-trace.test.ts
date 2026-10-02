/**
 * Generic graph checks. No repository name is special-cased.
 * Run: npx tsx scripts/graph-trace.test.ts
 */
import assert from "node:assert/strict";
import { buildRepositoryGraph, closedFlowFor, flowIsClosed } from "../supabase/functions/_shared/engine/graph/build.ts";
import { extractImplementationBehaviors } from "../supabase/functions/_shared/engine/behavior/extract.ts";
import { adminAccessDecision } from "../src/lib/admin-access.ts";

const crossLayer = buildRepositoryGraph({
  files: [
    {
      path: "src/pages/Home.tsx",
      language: "TypeScript",
      content: [
        "export function Home() {",
        "  const submit = () => fetch('/api/analyze', { method: 'POST', body: '{}' });",
        "  return null;",
        "}",
      ].join("\n"),
    },
    {
      path: "src/api/analyze.ts",
      language: "TypeScript",
      content: [
        "export function analyzeHandler() {",
        "  return fetch('https://api.deepseek.com/v1/chat');",
        "}",
      ].join("\n"),
    },
  ],
  symbols: [
    { name: "Home", symbol_type: "function", line: 1, file: "src/pages/Home.tsx" },
    { name: "analyzeHandler", symbol_type: "function", line: 1, file: "src/api/analyze.ts" },
  ],
  routes: [
    { method: "POST", path: "/api/analyze", file: "src/api/analyze.ts", line: 1, framework: "Express" },
  ],
});
assert.ok(
  crossLayer.relationships.some((edge) => edge.relation === "client_request"),
  "frontend fetch should link to backend route file",
);

const graph = buildRepositoryGraph({
  files: [
    {
      path: "src/api/orders.ts",
      language: "TypeScript",
      content: [
        "import { loadOrders } from '../data/orders';",
        "export function listOrders() {",
        "  const rows = loadOrders();",
        "  return rows;",
        "}",
      ].join("\n"),
    },
    {
      path: "src/data/orders.ts",
      language: "TypeScript",
      content: [
        "export function loadOrders() {",
        "  return fetch('/data/orders.csv');",
        "}",
      ].join("\n"),
    },
  ],
  symbols: [
    { name: "listOrders", symbol_type: "function", line: 2, file: "src/api/orders.ts" },
    { name: "loadOrders", symbol_type: "function", line: 1, file: "src/data/orders.ts" },
  ],
  routes: [
    { method: "GET", path: "/orders", file: "src/api/orders.ts", line: 2, framework: "Express" },
  ],
});

assert.ok(graph.relationships.some((edge) => edge.relation === "imports" && edge.to_file === "src/data/orders.ts"));
assert.ok(graph.relationships.some((edge) => edge.relation === "calls" && edge.to_symbol === "loadOrders"));
assert.ok(graph.relationships.some((edge) => edge.relation === "reads"));
const closed = graph.flows.filter((flow) => flow.closed);
assert.ok(closed.length >= 1, "expected a closed entry → call → read flow");
assert.equal(flowIsClosed(closed[0].hops), true);

const matched = closedFlowFor(["order", "orders", "list"], graph.flows);
assert.ok(matched, "a closed flow should be selectable when its own symbols overlap");
const unrelated = closedFlowFor(["forecast", "medicine", "demand"], graph.flows);
assert.equal(unrelated, null, "unrelated requirement words must not confirm this flow");

assert.equal(adminAccessDecision({ authenticated: false, role: null }), "login");
assert.equal(adminAccessDecision({ authenticated: true, role: "student" }), "dashboard");
assert.equal(adminAccessDecision({ authenticated: true, role: "admin" }), "allow");

const sliceBehaviors = extractImplementationBehaviors({
  files: [
    {
      path: "src/handler.ts",
      language: "TypeScript",
      content: [
        "export function normalize(ai: { causes: string[]; fixes: string[] }) {",
        "  const causes = ai.causes.slice(0, 3);",
        "  const fixes = ai.fixes.slice(0, 5);",
        "  return { causes, fixes };",
        "}",
      ].join("\n"),
    },
  ],
  symbols: [
    {
      name: "normalize",
      symbol_type: "function",
      file: "src/handler.ts",
      start_line: 1,
      end_line: 5,
      language: "TypeScript",
    },
  ],
});
assert.ok(
  sliceBehaviors.some((b) => b.kind === "limit_collection" && /3/.test(b.claim)),
  "should detect slice(0, 3) limit generically",
);
assert.ok(
  sliceBehaviors.some((b) => b.kind === "limit_collection" && /5/.test(b.claim)),
  "should detect slice(0, 5) limit generically",
);

console.log("graph-trace: ok");
