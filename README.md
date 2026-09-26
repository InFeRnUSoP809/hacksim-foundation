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
| — | `supabase/seed.sql` | *Optional.* A MediStock practice hackathon at 8 hours |

For Phases 1–4 only, `supabase/00_all_in_one.sql` is the same content as
001 + 002 + 003 in one pasteable script. It does **not** include 004.

Then promote yourself to admin. There is deliberately no self-service path:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Verify everything landed — this is read-only and creates nothing:

```bash
node --experimental-strip-types scripts/check-supabase.mjs
```

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
    config.ts        environment-driven settings and hashing
    github-api.ts    GitHub REST client (cache, retry, rate limit)
    github.ts        the deterministic scanner (Phase 5)
    scanner.ts       scan orchestration + persistence
    requirements.ts  the brief turned into stable REQ/CON/OUT/EVAL ids
    retrieval.ts     bounded context packets (≤ 6 files, ≤ 120 lines)
    ai.ts            DeepSeek client + cost, budget and cache gate
    modules.ts       the four review modules, prompts and validation
    review.ts        the Phase 6 orchestrator
```

Deploy:

```bash
supabase link --project-ref <your-project-ref>

# Secrets live in Supabase, not in a .env file.
supabase secrets set DEEPSEEK_API_KEY=sk-... GITHUB_TOKEN=ghp_...

supabase functions deploy analysis ai-admin
```

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
| `ai-admin` | `GET ?view=…` | `overview` · `usage` · `errors` · `budgets` · `settings` · `forecast` · `cache-analytics` · `request` |
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
  _shared/        http guards, config, GitHub client, scanner,
                  requirements, retrieval, DeepSeek client, modules, reviewer
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
