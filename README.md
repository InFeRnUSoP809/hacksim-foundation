# HackSim

**Practice. Build. Defend. Improve.**

HackSim simulates a real hackathon — from building and submission through to
presentation, AI questioning, and final performance feedback — so students can
practise the complete experience before the real event.

This repository covers **Phases 1–4**:

| Phase | What it delivers |
| --- | --- |
| 1 | Foundation: PWA, Supabase Auth, profiles, protected routes, theme |
| 2 | Hackathon configuration, practice toggle, teams, contribution info |
| 3 | Timed simulation, authoritative clock, checkpoints, breaks |
| 4 | Project submission, per-member contributions, AI disclosure, locking |

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, React Router |
| Backend | Supabase Edge Functions (Deno) — Phase 5 + 6, see [Server-side work](#6-server-side-work) |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth |
| Storage | Supabase Storage — reserved for the workspace |
| PWA | Web app manifest + service worker |

---

## 1. Environment variables

Set these in your host's environment UI, or a local `.env.local`:

```bash
VITE_SUPABASE_URL=https://ntkuqpuqxtdohgtmhemt.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

If they are absent, `src/lib/supabase-config.ts` falls back to committed values
so the app still connects. Environment variables always take precedence.

Only the **anon** key belongs in the frontend. It is safe to ship solely
because every table has Row Level Security enabled.

---

## 2. Database setup

Run these in order in **Supabase Dashboard → SQL Editor → New query**. Each file
is idempotent, so re-running is safe.

| Order | File | Creates |
| --- | --- | --- |
| 1 | `supabase/001_profiles.sql` | `profiles`, signup trigger, RLS |
| 2 | `supabase/002_hackathons_teams_sessions.sql` | `hackathons`, `teams`, `team_members`, `build_sessions`, `build_checkpoints`, RPCs, RLS |
| 3 | `supabase/003_submissions.sql` | `submissions`, `submission_members`, `submission_events`, RPCs, RLS |
| 4 | `supabase/004_analysis_ai.sql` | **Phase 5+6.** `repositories`, `repository_files`, `code_chunks`, `ai_analyses`, `ai_usage`, `ai_budgets`, `ai_model_configs`, `hackathon_requirement_maps`, `requirement_evaluations`, `project_reviews`, `project_review_findings`, `defense_targets` |
| 5 | `supabase/005_model_pricing.sql` | The `deepseek-flash` price row. Without it the budget gate refuses every call: a missing model is not a default, it is a refusal. |
| 6 | `supabase/006_scenario_engine.sql` | **Scenario/format engine.** `hackathon_type` + scenario fields, `hackathon_scenarios`, sealed wildcard payloads, `problem_discoveries`, versioned `project_knowledge`, `member_project_knowledge`, `question_targets`, `submission_claims`, `admin_audit_logs`, soft-delete columns, the build/submission-window timer columns, and the snapshotting `start_build_session`. Run **after** 005 and before 007. |
| 7 | `supabase/007_scenario_engine_rpcs.sql` | **The enforcement RPCs.** `session_clock`, `sync_session_phase`, `open_github_window`, `reveal_wildcard_scenario`, `session_brief`, `required_fields_for_type`, `save_problem_discovery`, `lock_problem_discovery`, `lock_submission`, `deletion_impact`, `manage_entity`, `write_audit_log`, `redact_secrets`. Backend-authoritative timer, configurable submission window, server-protected wildcards, dependency-aware deletion. |
| 8 | `supabase/008_admin_playground.sql` | **Admin analysis playground.** `create_admin_playground_submission`, `admin_playground_list`, `admin_playground_reset`. Builds a disposable session → submission harness for any GitHub URL so the scan + review pipeline can be tested without a hackathon. Admin-only; rows are named `ADMIN-PLAYGROUND-%` and cascade away in one call. |
| — | `supabase/seed.sql` | *Optional.* A MediStock practice hackathon at 8 hours |

For Phases 1–4 only, `supabase/00_all_in_one.sql` is the same content as
001 + 002 + 003 in one pasteable script. It does **not** include 004.

Then promote yourself to admin. There is deliberately no self-service path:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Verify everything landed — these are read-only and create nothing:

```bash
node --experimental-strip-types scripts/check-supabase.mjs  # schema + RPCs
node scripts/check-github.mjs                             # GitHub, DeepSeek, quota
npx deno run --allow-env scripts/smoke-deterministic.ts     # 76 scanner assertions
```

`smoke-deterministic.ts` is the only layer that can be fully verified without a
deploy. It asserts the deterministic guarantees the scanner rests on: URL
parsing refuses sub-paths and non-GitHub hosts, Spring route extraction joins
the class-level `@RequestMapping` prefix, dependency parsing survives a
malformed manifest, secret redaction never echoes a value, and evidence ids are
stable across runs (which is what makes the AI cache safe).

### Schema

```text
auth.users
     │
     ▼
profiles
     ├── teams ──► team_members
     └── hackathons
              │
              ▼
        build_sessions
              │
              ▼
       build_checkpoints
              │
              ▼
          submissions
              │
              ▼
      submission_members
```

---

## 3. Run the frontend

```bash
bun install
bun run dev      # http://localhost:5173
```

```bash
bun run build    # typecheck + production build
bun run preview  # serve the production build
bun run lint     # eslint
```

---

## 4. Routes

### Student

| Route | Purpose |
| --- | --- |
| `/` | Landing (public) |
| `/login` `/signup` | Authentication (public) |
| `/dashboard` | Practice status, hackathon preview, start or continue |
| `/hackathon` | The full brief and the start confirmation |
| `/team` | Create or join a team, set member roles |
| `/simulation/:sessionId` | Build workspace: timer, brief, team, checkpoints |
| `/submission/:sessionId` | Draft, contributions, AI disclosure, final submit |
| `/review/:id` | Your project review: alignment, coverage, findings, defence prep |
| `/workspace` | Personal material area |

### Admin

| Route | Purpose |
| --- | --- |
| `/admin` | Control centre: practice, sessions, submissions, alignment, AI today |
| `/admin/hackathons` | Create, edit, view, archive, toggle practice |
| `/admin/teams` | Team list and roster |
| `/admin/users` | Everyone with an account |
| `/admin/simulations` | Every run, with read-only countdowns |
| `/admin/submissions` | Every project, with per-member contributions |
| `/admin/submissions/:id` | The central analysis page, brief first, AI conclusions last |
| `/admin/repositories` | Phase 5 inventory, filters and commit hashes |
| `/admin/project-reviews` | Phase 6 reviews with requirements, findings and cost |
| `/admin/ai` | AI operations: overview, usage, errors, budgets, settings |
| `/admin/settings` | Theme |

The two surfaces use separate layouts and separate navigation, and admin routes
are denied to students at the route level.

---

## 5. How the rules are enforced

The browser only ever holds the anon key, so the database is the only place a
rule can be trusted. Every "the backend must verify" requirement lives in
Postgres — RLS policies and `SECURITY DEFINER` functions — not in React.

| Rule | Enforced by |
| --- | --- |
| Only one practice hackathon | A partial unique index, plus `set_practice_hackathon()` |
| Practice off stops **new** runs | `start_build_session()` re-checks `practice_enabled` |
| Practice off doesn't stop existing runs | Sessions keep their `hackathon_id`; `hackathon_for_session()` keeps the brief readable |
| Duration edits don't affect live sessions | `ends_at` is computed once at insert |
| Timer can't be extended or reset | Students have no INSERT/UPDATE policy on `build_sessions`; only RPCs write |
| Timer can't be beaten by changing the device clock | `session_state()` computes from `now()` in Postgres |
| Automatic expiry | `session_state()` self-heals an elapsed run to `expired` |
| Checkpoints freeze at expiry | The policy requires the session to be `running` |
| One submission per session | `unique (session_id)` |
| Submitted projects are read-only | A `BEFORE UPDATE` trigger rejects any change once `status = 'submitted'` |
| Nobody can self-promote to admin | Signup trigger hard-codes `student`; a second trigger strips role changes |
| Students can't enumerate users | Invites resolve by email inside `add_team_member()` |
| Teammates see each other | `team_roster()` / `submission_roster()`, scoped to one team |

---

## 6. Server-side work

Phase 5 (GitHub repository analysis) and Phase 6 (AI project review) cannot run
in a browser: the GitHub and DeepSeek credentials must never reach a client, and
the AI cache and budget counters are only trustworthy in one place. Everything
else in HackSim is a direct Supabase call from the browser, with Postgres as the
source of truth.

There are two implementations of that server-side layer. **The edge functions are
the supported path**; the FastAPI service is kept as a runnable reference.

### 6.1 Supabase Edge Functions (supported)

```
supabase/functions/
  analysis/          Phase 5 + Phase 6
  ai-admin/          §68–§77 AI operations, admin only
  _shared/
    http.ts          CORS, caller identity, team guards, service client
    ai.ts            the only reader of Deno.env: DeepSeek, cost, budgets,
                     cache identity, and the scanner's own limits
    github-api.ts    GitHub REST client (cache, retry, rate limit)
    github.ts        the deterministic scanner (Phase 5)
    scanner.ts       scan orchestration + persistence
    requirements.ts  the brief turned into stable REQ/CON/OUT/EVAL ids
    retrieval.ts     bounded context packets (≤ 6 files, ≤ 120 lines)
    modules.ts       the four review modules, prompts and validation
    review.ts        the Phase 6 orchestrator
```

Deploy — one command, after `supabase link` and after the secrets exist:

```bash
npx supabase functions deploy analysis ai-admin --use-api
```

`--use-api` bundles server-side instead of locally, so it needs no Docker. The
equivalent in the CLI proper is `supabase functions deploy analysis ai-admin`
when you have a working Docker daemon.

Secrets go in the dashboard, not in a `.env` file and never in
`config.toml` — **Project Settings → Edge Functions → Secrets → Add new secret**:

| Name | Required | Notes |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | for Phase 6 | Without it Phase 5 still runs in full; Phase 6 is refused with a reason |
| `GITHUB_TOKEN` | strongly recommended | A fine-grained token with public-repo read only. Without it GitHub allows 60 requests/hour per IP, which a real repository exhausts |
| `DEEPSEEK_MODEL` | no | Defaults to `deepseek-flash` |
| `GITHUB_API_BASE` | no | Defaults to `https://api.github.com` |

`Deno.env.get` reads secrets at function start, so **adding or changing a secret
requires a redeploy** for it to take effect. Set the secrets first, then run the
deploy command above once.

#### Deploying through the dashboard instead

The Supabase dashboard accepts one file per function, but both entry points
import nine modules from `_shared/`. Pasting `analysis/index.ts` on its own
fails immediately with an unresolved import, because the dashboard never
receives the files those imports point at.

`scripts/bundle-functions.sh` inlines all of them into one self-contained file
per function:

```bash
bash scripts/bundle-functions.sh
```

```
supabase/functions/bundle/analysis.ts   4998 lines
supabase/functions/bundle/ai-admin.ts    838 lines
```

Then in the dashboard, for each of `analysis` and `ai-admin`:

1. **Edge Functions → Functions → Deploy a new function**
2. Name it exactly `analysis` (or `ai-admin`)
3. Paste the corresponding bundle file
4. **Set “Verify JWT” to ON** — required, or every call fails
5. Deploy

The bundles are generated and gitignored. Edit the sources, re-run the script.
`scripts/verify-bundles.ts` boots each bundle and asserts it serves CORS
preflights, refuses unauthenticated calls with 401, and rejects a missing
submission id with 400 — 25 assertions, because a bundle that deploys and then
misroutes a request is worse than one that fails to build.

`verify_jwt = true` for both functions (see `supabase/config.toml`). The
platform verifies the caller's JWT before the function runs, and the function
re-checks team membership anyway — a valid token proves who you are, not what
you may touch.

| Function | Request | Purpose |
| --- | --- | --- |
| `analysis` | `GET ?submission_id=…` | The full analysis payload |
| `analysis` | `POST {action:"repository"}` | Run the deterministic scanner (0 AI tokens) |
| `analysis` | `POST {action:"review", only_module?}` | Run the AI modules |
| `analysis` | `POST {action:"reanalyze"}` | Force a fresh scan, bypassing the commit cache |
| `analysis` | `POST {action:"retry-module", module}` | Retry one failed module only |
| `ai-admin` | `GET ?view=…` | `overview` · `usage` · `errors` · `budgets` · `settings` · `forecast` · `cache-analytics` · `request` · `audit-log` · `preflight` · `budget-state` |
| `ai-admin` | `POST {view:…}` | `budget` · `budget-delete` · `model` · `kill-switch` |

Optional settings, all with sane defaults: `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL`,
`GITHUB_API_BASE`, `GITHUB_MAX_RETRIES`, `ANALYSIS_MAX_FILES`,
`ANALYSIS_LARGE_REPO_THRESHOLD`, `RETRIEVAL_MAX_FILES`.

Without `DEEPSEEK_API_KEY` Phase 5 still runs in full, and Phase 6 is refused
with an actionable message rather than failing quietly.

### 6.2 FastAPI service (optional reference)

A FastAPI implementation of the same contract lives in `backend/`. It exposes
`/api/analysis/*` and `/api/ai/*` with the same behaviour, and is useful as a
local reference, but it is not the deployed path — nothing in the frontend
depends on it, and there is no `VITE_API_URL` to set.

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Environment (a local `backend/.env`, never committed):

```text
APP_ENV=development
SUPABASE_URL=…
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…   # server-side only
CORS_ORIGINS=http://localhost:5173
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
GITHUB_TOKEN=            # optional, but without it GitHub allows 60 req/hour
```

`SUPABASE_SERVICE_ROLE_KEY` is read only by `app/core/security.py`. It is never
returned to a client and never bundled.

### Token discipline

The scanner itself costs **zero** AI tokens. The model is only asked about
things code cannot answer, receives a compact project map plus at most six
retrieved snippets, and its cache is keyed on
`commit + analysis type + prompt version + context hash + model`. Every request
records the token counts the provider reports — nothing is estimated — and the
budget gate runs before the call, so a request that would exceed a limit is
rejected and logged rather than made.

---

## 7. Project structure

```text
src/
  components/     guards, dialogs, cards, states, analysis views
  hooks/          useAuth, useAsync, useSessionClock
  layouts/        AdminLayout, StudentLayout, AppShell, AuthShell
  lib/            supabase client, edge-function client, theme, formatting
  pages/          student routes
  pages/admin/    admin routes
  services/       one module per domain
  types/          shared domain types and constants
supabase/         numbered migrations + seed
supabase/functions/
  analysis/       Phase 5 + Phase 6
  ai-admin/       AI operations
  _shared/        http guards, DeepSeek + all env config, GitHub client,
                  scanner, requirements, retrieval, modules, reviewer
backend/app/      optional FastAPI reference for the same contract
  routers/        analysis, ai_admin, and the Phase 1–4 routers
  services/
    github/       REST client, URL parsing, classification, parsers
    analysis/     scanner, evidence, project map, retrieval, pipeline
    ai/           DeepSeek client, cost/budget, modules, reviewer
scripts/          check-supabase.mjs, generate-icons.mjs
backend/tests/    deterministic-layer unit tests
```

---

## Not built yet (by design)

GitHub code analysis and AI project review (Phases 5–6) are now implemented:
deterministic repository scanning with evidence and a project map, then
requirement-aware AI interpretation with budgets, caching and a kill switch.

Still to come, and deliberately absent: presentation recording, screen sharing,
camera, microphone, speech-to-text, the AI defense engine and its adaptive
follow-up questions, AI voice, TTS, and the final training report. Phases 7+
build on the analysis already stored here without revisiting anything above.
