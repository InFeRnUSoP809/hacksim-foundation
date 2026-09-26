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
| Backend | FastAPI (Python) — optional, see [API](#api) |
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
| — | `supabase/seed.sql` | *Optional.* A MediStock practice hackathon at 8 hours |

Prefer a single paste? `supabase/00_all_in_one.sql` contains all four files
above, already concatenated in the correct order, in one self-contained script.
Run that one instead of the table below — the numbered files stay as the
readable source of truth and are what the sections map onto.

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
| `/workspace` | Personal material area |

### Admin

| Route | Purpose |
| --- | --- |
| `/admin` | Practice ON/OFF, current hackathon, counts |
| `/admin/hackathons` | Create, edit, view, archive, toggle practice |
| `/admin/teams` | Team list and roster |
| `/admin/users` | Everyone with an account |
| `/admin/simulations` | Every run, with read-only countdowns |
| `/admin/submissions` | Every project, with per-member contributions |
| `/admin/settings` | Theme and break length |

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

## 6. API

A FastAPI service lives in `backend/`. It is **optional** — the app works
entirely through the browser, and Postgres remains the source of truth.

```bash
cd backend
pip install -r requirements.txt
```

Create `backend/.env` with:

```bash
APP_ENV=development
SUPABASE_URL=https://ntkuqpuqxtdohgtmhemt.supabase.co
SUPABASE_ANON_KEY=<your anon key>
SUPABASE_SERVICE_ROLE_KEY=<server-side only>
CORS_ORIGINS=http://localhost:5173
RATE_LIMIT_PER_MINUTE=60
```

Then:

```bash
uvicorn app.main:app --reload
```

It exists for work that genuinely needs a server, and as the home for the
provider integrations coming in Phases 5–11. It never holds a user session:
each request is resolved from the caller's Supabase token and executed through
an RLS-scoped client, so database policies apply to API calls exactly as they
do to browser calls.

`SUPABASE_SERVICE_ROLE_KEY` is read only here, and only by
`app/core/security.py`. It is never returned to a client and never bundled.

---

## 7. Project structure

```text
src/
  components/     guards, dialogs, cards, states, theme toggle
  hooks/          useAuth, useAsync, useSessionClock
  layouts/        AdminLayout, StudentLayout, AppShell, AuthShell
  lib/            supabase client, theme, formatting
  pages/          student routes
  pages/admin/    admin routes
  services/       one module per domain
  types/          shared domain types and constants
supabase/         numbered migrations + seed
backend/app/      FastAPI service
scripts/          check-supabase.mjs, generate-icons.mjs
```

---

## Not built yet (by design)

GitHub code analysis, AI project review, AI contribution scoring, presentation
recording, screen sharing, camera, microphone, speech-to-text, AI defense, AI
voice, TTS, adaptive follow-up questions, and the final training report. Those
belong to Phases 5–11. The database and service layers are structured so each
can be added without revisiting Phases 1–4.
