# Production deploy — `analysis` Edge Function

## Architecture (required)

```text
SOURCE (edit here only)
  supabase/functions/analysis/index.ts
        ↓ imports
  supabase/functions/_shared/engine/**
        ↓
  npm run bundle:functions
        ↓
PRODUCTION ARTIFACT (deploy this)
  supabase/functions/bundle/analysis.ts
        ↓
  Supabase Dashboard → Edge Functions → analysis → paste/deploy
        ↓
RUNTIME
  HackSim → supabase.functions.invoke("analysis")
```

There is **one** implementation. The bundle is **generated output** — never hand-edit `bundle/analysis.ts`.

## Release steps

```bash
npm install
npm run predeploy:analysis
```

(`predeploy:analysis` = `bundle:functions` + `test:bundle` — bundle generation and consistency gate.)

1. Open Supabase → **Edge Functions** → **`analysis`**
2. Paste the full contents of **`supabase/functions/bundle/analysis.ts`**
3. **Verify JWT = ON**
4. Redeploy after secret changes (`DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, …)

Optional local smoke (Deno): `npx deno run --allow-all scripts/verify-bundles.ts`

## Verify v1 before deploy

The bundle **must** contain string literals:

- `hacksim-analysis-v1`
- `new-engine-v1`

The bundle **must not** include legacy **inlined modules**, e.g.:

- `// _shared/scanner.ts` with `SCANNER_VERSION = "p5-3"`
- Legacy orchestrator paths (`runModuleReview`, `executeAnalysisPlan`, …)

`npm run test:bundle` encodes these rules.

## Runtime proof (after deploy)

Invoke analysis and confirm the **server-generated** runtime block (clients cannot set these):

```json
{
  "runtime": {
    "handler": "analysis-v1",
    "engine_id": "hacksim-analysis-v1",
    "analysis_version": "new-engine-v1"
  }
}
```

Also check DB: `repositories.analysis_version`, `repositories.project_map.engine_id`, `project_reviews.analysis_version`, findings in `project_review_findings` via `project_review_id`.

See [DEPLOYMENT-RUNTIME-AUDIT.md](./DEPLOYMENT-RUNTIME-AUDIT.md) for the full checklist.
