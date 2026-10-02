# HackSim Analysis — deployment vs runtime audit

## Production rule (authoritative)

**The main production deployment file for the `analysis` Edge Function is:**

```text
supabase/functions/bundle/analysis.ts
```

It is generated from `supabase/functions/analysis/index.ts` + `_shared/**` (including `engine/`).  
**Do not edit the bundle by hand.**

```text
SOURCE:     supabase/functions/analysis/index.ts  →  _shared/engine/**
ARTIFACT:   supabase/functions/bundle/analysis.ts
FUNCTION:   analysis
CLIENT:     supabase.functions.invoke("analysis")
```

Supabase CLI deploy (`supabase functions deploy analysis`) may bundle from the entry file server-side; **HackSim’s documented production path is: build artifact → deploy/paste `bundle/analysis.ts`.** Both paths must reflect the same source; the **checked-in / released artifact** is the bundle.

## Layer A — Source

- Entry: `analysis/index.ts` → `engine/index.ts`
- Identity: `HACKSIM_ENGINE_ID` / `ENGINE_SCAN_VERSION` (`new-engine-v1`)
- Legacy `scanner.ts`, `review.ts`, `planner.ts` are not imported by the production entry or `engine/**`

## Layer B — Production bundle

| Check | Pass criteria |
|-------|----------------|
| Generated | `npm run bundle:functions` |
| v1 identity | Contains `hacksim-analysis-v1` and `new-engine-v1` |
| Not legacy | No inlined `// _shared/scanner.ts` / `SCANNER_VERSION = "p5-3"`, no legacy orchestrator execution |
| Gate | `npm run test:bundle` |

Stale bundle (legacy scanner chunk inlined) = **production-blocking** until regenerated.

## Layer C — Live runtime

After deploying **`bundle/analysis.ts`**:

1. POST `repository` → `engine_id`, `runtime`
2. GET analysis → `runtime.handler`, `runtime.engine_id`, `runtime.analysis_version`, `runtime_scan_matches`
3. DB: `repositories.analysis_version`, `project_map->engine_id`
4. DB: `project_reviews`, `project_review_findings` (via `project_review_id`)

## Findings table

**`project_review_findings`** + **`project_review_id`** — canonical (engine persistence uses this).

## Migrations

`004_analysis_ai.sql`, `010_analysis_v3.sql`, `011_analysis_graph.sql` — apply on Supabase before relying on graph/symbol persistence.

## Deployment matrix

| Layer | Expected | Status |
|-------|----------|--------|
| Source | `engine/` v1 | Verified in repo |
| Production artifact | Regenerated v1 bundle | **Run `npm run predeploy:analysis` locally** |
| Deployed function | Paste/deploy bundle | **Your Supabase project** |
| Live runtime | v1 identity in responses/DB | **After deploy + re-analyse** |
