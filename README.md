# HackSim

**Practice. Build. Defend. Improve.**

HackSim runs a complete simulated hackathon: a team takes a brief, builds against
the clock, submits real work, presents it in five minutes, defends it against an
AI panel, and leaves with an honest written read on the whole run.

HackSim has two clearly separated surfaces:

- **Admin — Control.** Manage hackathons, practice availability, teams, users,
  and simulations.
- **Student — Experience.** See the open practice hackathon, form a team, define
  your contribution, and run the timed build.

---

## Tech stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Frontend   | React 19, TypeScript, Vite, Tailwind CSS v4        |
| Database   | Supabase PostgreSQL                                |
| Auth       | Supabase Auth (email + password)                   |
| Storage    | Supabase Storage — reserved for the workspace      |
| PWA        | Web app manifest + service worker, installable      |

---

## 1. Environment variables

Set these through your host's environment UI, or a local `.env.local`:

```bash
VITE_SUPABASE_URL=https://ntkuqpuqxtdohgtmhemt.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

If they are absent, `src/lib/supabase-config.ts` falls back to committed values so
the app still connects. Environment variables always take precedence.

Only the **anon** key belongs in the frontend. It is safe to ship solely because
every table has Row Level Security enabled. The **service-role** key must never
appear in any module that ships to the browser.

---

## 2. Supabase setup

Run these two files in order, in **Supabase Dashboard → SQL Editor → New query**.
Both are idempotent, so re-running is safe.

1. [`supabase/schema.sql`](./supabase/schema.sql) — the `users` table, the signup
   trigger, and the first RLS policies.
2. [`supabase/phase2.sql`](./supabase/phase2.sql) — hackathons, teams, sessions,
   checkpoints, the RPCs, and all Phase 2/3 RLS policies.

Then promote yourself to admin:

```sql
update public.users set role = 'admin' where email = 'you@example.com';
```

Verify everything is in place without touching the app:

```bash
node --experimental-strip-types scripts/check-supabase.mjs
```

This is read-only — it creates no users, sessions, or data.

---

## 3. Run the project

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

| Route                  | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `/`                    | Landing page (public)                                    |
| `/login` `/signup`     | Authentication (public)                                  |
| `/dashboard`           | Practice status, hackathon preview, start/continue      |
| `/hackathon`           | The full brief, and the start-simulation confirmation   |
| `/team`                | Create or join a team, edit your contribution           |
| `/simulation/:id`      | The build workspace: timer, brief, team, checkpoints    |

### Admin

| Route                | Purpose                                     |
| -------------------- | ------------------------------------------- |
| `/admin`             | Practice ON/OFF, current hackathon, counts   |
| `/admin/hackathons`  | Create, edit, view, archive, toggle practice |
| `/admin/teams`       | Team list and per-team roster               |
| `/admin/users`       | Everyone with an account                    |
| `/admin/simulations` | Every run, with read-only countdowns        |
| `/admin/settings`    | Theme and break length                      |

The two surfaces use separate layouts and separate navigation. Student-only and
admin-only routes are guarded independently.

---

## 5. How the rules are enforced

The browser only ever holds the anon key, so the database is the only place a
rule can actually be trusted. Every "the backend must verify" requirement is
enforced in Postgres, not in React:

| Rule | Enforced by |
| --- | --- |
| Only one practice hackathon | A partial unique index, plus `set_practice_hackathon()` |
| Students can't manage hackathons | RLS on `hackathons` — no write policy for non-admins |
| Problem statement hidden when practice is off | The `hackathons` SELECT policy only matches `practice_enabled and status = 'active'` |
| Only valid teams can start a run | `start_build_session()` re-checks membership |
| Practice must be on to start | `start_build_session()` re-checks `practice_enabled` |
| No conflicting simultaneous run | `start_build_session()` checks the team for a live session |
| Timer cannot be extended | Students have no INSERT/UPDATE policy on `build_sessions`; only the RPCs write |
| Timer cannot be reset by refresh | `session_state()` computes the countdown from `now()` in Postgres |
| Changing the device clock does nothing | Remaining time is derived from the server clock, then corrected locally |
| Checkpoints freeze at expiry | The checkpoint policy requires the session to be `active` |
| Teammates can see each other | `team_roster()` — a `SECURITY DEFINER` function scoped to one team |
| Users cannot be enumerated | Invite by email through `add_team_member()`, not by browsing a directory |

Turning practice off stops **new** simulations. A run already in progress keeps
its `hackathon_id` and continues, and can still read its brief through
`hackathon_for_session()`. Nothing is ever deleted — hackathons archive, and
sessions persist.

---

## 6. Theme

Light and dark are both first-class. The choice is read from `localStorage`, and
falls back to the operating system setting when the user has not chosen. An
inline script in `index.html` applies the theme before React boots, so there is
no flash of the wrong colours. The preference is device-local and is never sent
to Supabase.

---

## 7. Project structure

```
src/
  components/     UI building blocks (guards, dialogs, cards, states)
  hooks/          useAuth, useAsync, useSessionClock
  layouts/        AdminLayout, StudentLayout, AppShell, AuthShell
  lib/            supabase client, theme, formatting helpers
  pages/          student routes
  pages/admin/    admin routes
  services/       Supabase data access, one module per domain
  types/          shared domain types and constants
supabase/
  schema.sql      phase 1
  phase2.sql      phase 2 + 3
scripts/
  check-supabase.mjs   read-only connectivity + schema check
  generate-icons.mjs
```

---

## Not built yet (by design)

Project submission, GitHub analysis, AI project review, contribution analysis,
presentation recording, screen sharing, camera, microphone, speech-to-text, AI
voice output, AI defense questions, adaptive follow-ups, and the final training
report. Those belong to Phase 4 and later.
