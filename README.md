# HackSim

**Practice. Build. Defend. Improve.**

HackSim runs a complete simulated hackathon: a team takes a brief, builds
against the clock, submits real work, presents it in five minutes, defends it
against an AI panel that follows up on the weakest answers, and leaves with an
honest written read on the whole run.

This repository is the **foundation build (v0.1)** — an installable PWA with
working Supabase authentication, a personal dashboard, a workspace, and a
role-gated admin area. The simulation stages ship in later builds, one at a time.

---

## The five stages

Colour is the stage identity throughout the product. Each stage owns one flat,
confident hue on a neutral ink-on-paper base — colourful, but never noisy.

| Stage        | What happens                                            |
| ------------ | ------------------------------------------------------- |
| **Build**    | A live brief, a build window, and real checkpoints.      |
| **Submit**   | A repository and a write-up, handed in before the deadline. |
| **Present**  | A five-minute pitch with screen, camera, and microphone. |
| **Defend**   | A live AI panel that presses on whatever sounds weakest.  |
| **Report**   | A written read on the run: what held, what didn't, what to fix. |

---

## Tech stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Frontend   | React 19, TypeScript, Vite, Tailwind CSS v4        |
| Database   | Supabase PostgreSQL                                |
| Auth       | Supabase Auth (email + password)                   |
| Storage    | Supabase Storage — reserved for the workspace      |
| Backend    | FastAPI — prepared for, not wired up yet           |
| PWA        | Web app manifest + service worker, installable      |

---

## 1. Environment variables

Add these through your host's environment UI (or a local `.env.local`):

```bash
VITE_SUPABASE_URL=https://ntkuqpuqxtdohgtmhemt.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

If they are not set, `src/lib/supabase-config.ts` falls back to the project's
committed values so the app still connects. Environment variables always win —
set them here and delete the fallback constants.

Only the **anon** key belongs in the frontend. It is safe to ship solely because
every table has Row Level Security enabled. The **service-role** key must never
be referenced from client code.

To confirm the connection without touching the app:

```bash
node --experimental-strip-types scripts/check-supabase.mjs
```

If the variables are missing the app still runs — the landing page and dashboard
show a clear "Supabase isn't connected" notice instead of failing blank.

---

## 2. Supabase setup

### a) Apply the schema

Open **Supabase Dashboard → SQL Editor → New query** and run
[`supabase/schema.sql`](./supabase/schema.sql). It creates:

- the `public.users` table (`id`, `email`, `name`, `role`, `created_at`)
- an `on_auth_user_created` trigger that inserts a profile row on signup
- `is_admin()` / `current_user_role()` helper functions
- RLS policies: a student can only read and update their own row

### b) Auth settings

Under **Authentication → Providers → Email**, enable the Email provider.
Turning *Confirm email* off is fine locally; leaving it on also works — the
signup screen shows a "check your inbox" state.

### c) Make yourself an admin

Everyone signs up as a `student`. To promote an account, run this in the SQL
Editor (not from the browser):

```sql
update public.users set role = 'admin' where email = 'you@example.com';
```

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

| Route        | Access       | Purpose                                     |
| ------------ | ------------ | ------------------------------------------- |
| `/`          | Public       | Landing page                                |
| `/signup`    | Public       | Create an account                           |
| `/login`     | Public       | Sign in                                     |
| `/dashboard` | Signed in    | Your runs, progress, and feedback (protected) |
| `/workspace` | Signed in    | Your own submissions and material (protected) |
| `/admin`     | `admin` role | Control room (role-gated)                   |

Refreshing any protected route is safe: Supabase restores the session from
`localStorage` before the route renders.

---

## 5. PWA

- `public/manifest.webmanifest` — name, theme/background colours, `standalone`
  display, and a 192/512/maskable icon set
- `public/sw.js` — network-first for navigations (falls back to the cached
  shell), stale-while-revalidate for same-origin assets, and a strict passthrough
  for Supabase and other cross-origin requests so API responses are never cached
- `src/main.tsx` registers the service worker after `load`

To install: serve over HTTPS (or `localhost`), then use your browser's *Install
app* / *Add to Home Screen* action.

Icons are generated by `node scripts/generate-icons.mjs` — re-run it if you
change the brand mark.

---

## 6. Project structure

```
src/
  components/     UI building blocks (guards, stage chips, cards, states)
  layouts/        AppShell (app chrome) and AuthShell
  pages/          Landing, Login, Signup, Dashboard, Workspace, Admin
  services/       auth calls (Supabase)
  hooks/          useAuth
  lib/            supabase client, config check, cn helper
  types/          Profile, Role, Stage
supabase/
  schema.sql      users table, trigger, and RLS policies
scripts/
  generate-icons.mjs
  check-supabase.mjs   read-only connectivity check
```

---

## Not built yet (by design)

The build/submit/present/defend/report stages, the simulation clock, scenario
enrolment, team management, GitHub analysis, AI review and questioning, screen
recording, speech-to-text, and workspace uploads. Every surface is an honest
empty state — nothing is stubbed to look finished.
