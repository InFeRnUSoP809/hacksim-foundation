# HackSim Analysis Engine v1

Production analysis lives under this directory only.

- **Identity:** `hacksim-analysis-v1` / scan version `new-engine-v1`
- **Entry:** `index.ts` — `analyzeSubmission`, `runVerification`
- **Legacy:** `_shared/scanner.ts`, `_shared/review.ts`, `_shared/planner.ts` are reference-only and must not be imported by deployed handlers.

Pipeline:

```text
DISCOVER → CLASSIFY → READ (budgeted) → STRUCTURE → GRAPH → BEHAVIOR → WORKFLOWS → EVIDENCE → VERIFY → PERSIST
```

Implementation depth:

- `behavior/extract.ts` — L2–L3 patterns (HTTP/AI, parse, limits with context, persistence).
- `behavior/context.ts` — distinguishes UI-only limits vs post-AI/processing limits.
- `workflows/discover.ts` — symbol- and cross-layer workflow hops linked to behavior IDs.

Regression: `scripts/engine-acceptance.test.ts` (generic AI + slice limits + false positives).

**Production deploy:** `npm run bundle:functions` → deploy/paste `supabase/functions/bundle/analysis.ts`
to Supabase function `analysis`. Must contain `hacksim-analysis-v1` / `new-engine-v1`. See `docs/PRODUCTION-DEPLOY.md`.

Verification (`engine/verify/`):

- `tasks.ts` — adaptive plan (brief / implementation / engineering / claims).
- `context.ts` — compact evidence packets per group.
- `retrieval.ts` — indexed-file-only follow-up retrieval (max 2 rounds).
- `validation.ts` — post-AI schema and citation checks.
- `cache.ts` — `ai_analyses` cache keyed by commit, engine, task, evidence/workflow fingerprints.
- `orchestrator.ts` — executes 2–4 DeepSeek calls; supports `onlyTasks` / retry-task.
