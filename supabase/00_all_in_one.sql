-- ============================================================================
-- HackSim — complete database schema
-- ============================================================================
-- Paste this entire file into the Supabase SQL Editor → SQL Editor → New query
-- → Run. It creates all nine tables, every function, trigger, index and RLS
-- policy. Nothing here is destructive to existing data: every statement is
-- written to be safe to run more than once.
--
-- Sections, in the order they must run:
--   1. profiles
--   2. hackathons, teams, build sessions, checkpoints
--   3. submissions, submission members, submission events
--   4. (optional) MediStock practice hackathon — remove this block if you
--      would rather create your own challenge in /admin/hackathons
--
-- After it runs, promote yourself to admin (also in the SQL Editor):
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- The signup trigger only ever creates a 'student', and a trigger strips role
-- changes made through the app, so this one statement is the only way to grant
-- admin — by design.
-- ============================================================================


-- ############################################################################
-- 1. profiles
-- ############################################################################
-- HackSim's mirror of `auth.users`. One row per registered account, created
-- automatically on signup. Authentication itself is handled entirely by
-- Supabase Auth; no credential is ever stored here.

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  email      text        not null,
  role       text        not null default 'student'
                         check (role in ('student', 'admin')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile for each auth.users account. Never stores credentials.';

create index if not exists profiles_role_idx  on public.profiles (role);
create index if not exists profiles_email_idx on public.profiles (email);

-- Shared helpers ----------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- SECURITY DEFINER so an RLS check on profiles cannot recurse into itself.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Signup trigger ----------------------------------------------------------------
-- A profile is created for every new auth user, always with role = 'student'.
-- The role is never taken from client input, so nobody can self-promote to
-- admin during signup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    'student'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- Row Level Security ------------------------------------------------------------
-- A user reads and edits their own row. Admins read and edit all rows.
-- `role` is protected by a trigger below so nobody can escalate their own
-- privilege through the generic update policy.

alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert
  with check (id = auth.uid() and role = 'student');

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Strip any attempt to change a role or an id through a normal profile update.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.id <> old.id then
      new.id = old.id;
    end if;
    if new.role <> old.role then
      new.role = old.role;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect
  before update on public.profiles
  for each row execute function public.protect_profile_columns();


-- ############################################################################
-- 2. hackathons, teams, build sessions, checkpoints
-- ############################################################################
-- Every "the backend must verify" rule in the product spec is enforced HERE,
-- in Postgres. The browser only ever holds the anon key, so the database is
-- the only place a rule can actually be trusted — hiding a button in React is
-- never sufficient.

-- NOTE ON ORDERING — Postgres validates the body of a `language sql` function
-- when it is created, so `is_team_member()` further down is deliberately
-- defined *after* public.team_members, and the first admin_stats() is defined
-- without the submissions count (section 3 adds it). Reordering either one
-- breaks the run.


-- hackathons — the single source of truth for the challenge ---------------------
create table if not exists public.hackathons (
  id                           uuid primary key default gen_random_uuid(),
  name                         text        not null check (length(trim(name)) between 2 and 120),
  problem_statement            text        not null,
  requirements                 text,
  constraints                  text,
  expected_outcome             text,
  evaluation_criteria          text,
  simulation_duration_minutes  integer     not null
                                           check (simulation_duration_minutes between 1 and 10080),
  status                       text        not null default 'draft'
                                           check (status in ('draft', 'active', 'archived')),
  practice_enabled             boolean     not null default false,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

comment on table public.hackathons is
  'The practice hackathon challenge. The app never hardcodes a problem statement.';

create index if not exists hackathons_practice_idx on public.hackathons (practice_enabled);
create index if not exists hackathons_status_idx   on public.hackathons (status);

-- BUSINESS RULE 1 — at most one practice hackathon may exist. This holds even
-- if the admin UI is bypassed or double-clicked.
create unique index if not exists hackathons_single_practice
  on public.hackathons ((practice_enabled))
  where practice_enabled = true;

drop trigger if exists hackathons_touch on public.hackathons;
create trigger hackathons_touch
  before update on public.hackathons
  for each row execute function public.touch_updated_at();


-- teams + team_members ----------------------------------------------------------
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null check (length(trim(name)) between 2 and 60),
  created_by uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teams_created_by_idx on public.teams (created_by);

-- `role` is free text on purpose. A member may contribute across many areas,
-- so it is not constrained to frontend/backend style values.
create table if not exists public.team_members (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid        not null references public.teams (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  role       text        not null default 'Other',
  joined_at  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A student cannot be added to the same team twice.
  unique (team_id, user_id)
);

create index if not exists team_members_team_idx on public.team_members (team_id);
create index if not exists team_members_user_idx on public.team_members (user_id);

-- One team per student, which keeps "does this student already have a run?"
-- unambiguous. Join a second team only after leaving the first.
create unique index if not exists team_members_one_team_per_user
  on public.team_members (user_id);

drop trigger if exists team_members_touch on public.team_members;
create trigger team_members_touch
  before update on public.team_members
  for each row execute function public.touch_updated_at();

drop trigger if exists teams_touch on public.teams;
create trigger teams_touch
  before update on public.teams
  for each row execute function public.touch_updated_at();


-- build_sessions ----------------------------------------------------------------
create table if not exists public.build_sessions (
  id            uuid primary key default gen_random_uuid(),
  hackathon_id  uuid        not null references public.hackathons (id) on delete restrict,
  team_id       uuid        not null references public.teams (id) on delete cascade,
  started_by    uuid        not null references public.profiles (id) on delete cascade,
  started_at    timestamptz not null default now(),
  ends_at       timestamptz not null,
  break_ends_at timestamptz,
  status        text        not null default 'not_started'
                          check (status in ('not_started', 'running', 'break',
                                            'completed', 'expired', 'submitted')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- BUSINESS RULE 4/5 — `ends_at` is computed once, at insert, from the duration
-- that was configured *at that moment*. Editing the hackathon later can never
-- reach in and move an existing session's deadline.
create index if not exists build_sessions_hackathon_idx on public.build_sessions (hackathon_id);
create index if not exists build_sessions_team_idx      on public.build_sessions (team_id);
create index if not exists build_sessions_started_by_idx on public.build_sessions (started_by);
create index if not exists build_sessions_status_idx    on public.build_sessions (status);
create index if not exists build_sessions_ends_at_idx   on public.build_sessions (ends_at);

drop trigger if exists build_sessions_touch on public.build_sessions;
create trigger build_sessions_touch
  before update on public.build_sessions
  for each row execute function public.touch_updated_at();


-- build_checkpoints -------------------------------------------------------------
-- `checkpoint_type` is a CHECK rather than an enum type, so later phases can
-- add checkpoint kinds without a type migration.
create table if not exists public.build_checkpoints (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid        not null references public.build_sessions (id) on delete cascade,
  checkpoint_type text        not null check (checkpoint_type in
                        ('planning', 'building', 'progress',
                         'remaining_work', 'final_preparation')),
  response        text        not null default '',
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (session_id, checkpoint_type)
);

create index if not exists build_checkpoints_session_idx on public.build_checkpoints (session_id);

drop trigger if exists build_checkpoints_touch on public.build_checkpoints;
create trigger build_checkpoints_touch
  before update on public.build_checkpoints
  for each row execute function public.touch_updated_at();


-- Team RPCs ---------------------------------------------------------------------
-- Declared after public.team_members exists: a `language sql` body is checked at
-- creation time, not only when it is first called.
create or replace function public.is_team_member(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = p_team_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.create_team(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a team.';
  end if;

  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You already belong to a team. Leave it first to start a new one.';
  end if;

  insert into public.teams (name, created_by)
  values (trim(p_name), auth.uid())
  returning id into v_team_id;

  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, auth.uid(), 'Other');

  return v_team_id;
end;
$$;

-- Invite by email. SECURITY DEFINER lets us resolve the address from
-- auth.users without ever exposing a browsable user directory to the client.
create or replace function public.add_team_member(p_team_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_member  uuid;
begin
  if not public.is_team_member(p_team_id) and not public.is_admin() then
    raise exception 'Only members of a team can add people to it.';
  end if;

  select p.id into v_user_id
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'No HackSim account uses that email address.';
  end if;

  if v_user_id = auth.uid() then
    raise exception 'You are already a member of this team.';
  end if;

  if exists (select 1 from public.team_members where user_id = v_user_id) then
    raise exception 'That person is already in a team.';
  end if;

  insert into public.team_members (team_id, user_id, role)
  values (p_team_id, v_user_id, 'Other')
  returning id into v_member;

  return v_member;
end;
$$;

create or replace function public.leave_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team_member(p_team_id) and not public.is_admin() then
    raise exception 'You are not a member of that team.';
  end if;

  delete from public.team_members
  where team_id = p_team_id and user_id = auth.uid();

  if not exists (select 1 from public.team_members where team_id = p_team_id) then
    delete from public.teams where id = p_team_id;
  end if;
end;
$$;

-- The roster for one team. SECURITY DEFINER is required: teammates must see
-- each other's names, but a profile row is otherwise only visible to its owner.
create or replace function public.team_roster(p_team_id uuid)
returns table (
  member_id uuid,
  user_id   uuid,
  full_name text,
  email     text,
  role      text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, p.full_name, p.email, m.role, m.joined_at
  from public.team_members m
  join public.profiles p on p.id = m.user_id
  where m.team_id = p_team_id
    and (public.is_team_member(p_team_id) or public.is_admin())
  order by m.joined_at;
$$;


-- Practice hackathon control (admin only) ----------------------------------------
-- Turns practice on for exactly one hackathon and off for every other.
-- Nothing is deleted, so historical sessions keep pointing at the hackathon
-- they were started against. Pass null to switch practice off entirely.
create or replace function public.set_practice_hackathon(p_hackathon_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change practice mode.';
  end if;

  if p_hackathon_id is not null and not exists (
    select 1 from public.hackathons where id = p_hackathon_id
  ) then
    raise exception 'That hackathon does not exist.';
  end if;

  -- Turn the others off first so the partial unique index never trips.
  update public.hackathons
     set practice_enabled = false
   where practice_enabled = true
     and (p_hackathon_id is null or id <> p_hackathon_id);

  if p_hackathon_id is not null then
    update public.hackathons
       set practice_enabled = true
     where id = p_hackathon_id;
  end if;
end;
$$;


-- Starting a simulation ----------------------------------------------------------
create or replace function public.start_build_session(p_hackathon_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_duration integer;
  v_enabled  boolean;
  v_status   text;
  v_existing uuid;
  v_new      uuid;
begin
  -- 1. authenticated
  if auth.uid() is null then
    raise exception 'You must be signed in to start a simulation.';
  end if;

  -- 2. belongs to a valid team
  select tm.team_id into v_team_id
  from public.team_members tm
  where tm.user_id = auth.uid()
  limit 1;

  if v_team_id is null then
    raise exception 'Create or join a team before starting a simulation.';
  end if;

  -- 3/4. hackathon valid, 5. practice currently enabled
  select simulation_duration_minutes, practice_enabled, status
    into v_duration, v_enabled, v_status
  from public.hackathons
  where id = p_hackathon_id;

  if v_duration is null then
    raise exception 'That hackathon does not exist.';
  end if;

  if not v_enabled then
    raise exception 'No active practice hackathon.';
  end if;

  if v_status <> 'active' then
    raise exception 'That hackathon is not open for participation.';
  end if;

  -- 6. no conflicting live run for this team
  select id into v_existing
  from public.build_sessions
  where team_id = v_team_id
    and status in ('running', 'break')
  limit 1;

  if v_existing is not null then
    raise exception 'Your team already has a simulation in progress.';
  end if;

  -- Timestamps come from the database, never from the client.
  insert into public.build_sessions
    (hackathon_id, team_id, started_by, started_at, ends_at, status)
  values
    (p_hackathon_id, v_team_id, auth.uid(), now(),
     now() + make_interval(mins => v_duration), 'running')
  returning id into v_new;

  return v_new;
end;
$$;


-- Authoritative clock -------------------------------------------------------------
-- Remaining time is computed from now() in Postgres. A changed device clock
-- therefore cannot extend a simulation, and a refresh cannot reset it.
--
-- This also self-heals time-based transitions: an elapsed build becomes
-- 'expired' and an elapsed break resumes to 'running'. That keeps the stored
-- status honest without needing a background worker.
create or replace function public.session_state(p_session_id uuid)
returns table (
  status                  text,
  remaining_seconds       bigint,
  break_remaining_seconds bigint,
  server_now              timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.build_sessions;
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  if s.status = 'running' and s.ends_at <= now() then
    update public.build_sessions
       set status = 'expired', break_ends_at = null
     where id = s.id;
    s.status := 'expired';
  end if;

  if s.status = 'break' and s.break_ends_at is not null
     and s.break_ends_at <= now() then
    update public.build_sessions
       set status = 'running', break_ends_at = null
     where id = s.id;
    s.status := 'running';
  end if;

  return query
  select
    s.status::text,
    greatest(0, floor(extract(epoch from (s.ends_at - now()))))::bigint,
    case
      when s.status = 'break' and s.break_ends_at is not null
        then greatest(0, floor(extract(epoch from (s.break_ends_at - now()))))::bigint
      else 0
    end,
    now();
end;
$$;

-- A run keeps its brief even if the admin later switches practice off.
-- BUSINESS RULE 3 — turning practice off must not blind anyone mid-run.
create or replace function public.hackathon_for_session(p_session_id uuid)
returns setof public.hackathons
language sql
stable
security definer
set search_path = public
as $$
  select h.*
  from public.hackathons h
  join public.build_sessions s on s.hackathon_id = h.id
  where s.id = p_session_id
    and (public.is_team_member(s.team_id) or public.is_admin());
$$;

-- Deliberately narrow: a student may only move a live run into break, back to
-- running, or to completed. Nothing here can move ends_at.
create or replace function public.set_session_status(
  p_session_id    uuid,
  p_status        text,
  p_break_minutes integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.build_sessions;
  v_break integer := coalesce(p_break_minutes, 10);
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  if s.status in ('completed', 'expired', 'submitted') then
    raise exception 'This simulation has already finished.';
  end if;

  if s.ends_at <= now() then
    raise exception 'Simulation has expired.';
  end if;

  if p_status = 'break' and s.status = 'running' then
    update public.build_sessions
       set status = 'break',
           break_ends_at = now() + make_interval(mins => v_break)
     where id = s.id;
    return;
  end if;

  if p_status = 'running' and s.status = 'break' then
    update public.build_sessions
       set status = 'running', break_ends_at = null
     where id = s.id;
    return;
  end if;

  if p_status = 'completed' and s.status in ('running', 'break') then
    update public.build_sessions
       set status = 'completed', break_ends_at = null
     where id = s.id;
    return;
  end if;

  raise exception 'That status change is not allowed.';
end;
$$;


-- Admin reporting ------------------------------------------------------------------
create or replace function public.admin_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users',              (select count(*) from public.profiles),
    'teams',              (select count(*) from public.teams),
    'active_sessions',    (select count(*) from public.build_sessions
                            where status in ('running', 'break')),
    'completed_sessions', (select count(*) from public.build_sessions
                            where status in ('completed', 'expired', 'submitted'))
  );
$$;

-- The 'submissions' count is added in section 3, which owns that table: a
-- `language sql` body cannot reference a table that does not exist yet.

create or replace function public.admin_teams()
returns table (
  id           uuid,
  name         text,
  created_by   uuid,
  created_at   timestamptz,
  member_count bigint,
  live_status  text,
  session_id   uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.name, t.created_by, t.created_at,
         (select count(*) from public.team_members m where m.team_id = t.id),
         coalesce((
           select s.status::text from public.build_sessions s
           where s.team_id = t.id
           order by s.created_at desc limit 1
         ), 'not_started'),
         (
           select s.id from public.build_sessions s
           where s.team_id = t.id
           order by s.created_at desc limit 1
         )
  from public.teams t
  where public.is_admin()
  order by t.created_at desc;
$$;

create or replace function public.admin_sessions()
returns table (
  id              uuid,
  team_id         uuid,
  team_name       text,
  hackathon_id    uuid,
  hackathon_name  text,
  started_by      uuid,
  started_by_name text,
  started_at      timestamptz,
  ends_at         timestamptz,
  status          text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.team_id, t.name, s.hackathon_id, h.name,
         s.started_by, coalesce(p.full_name, p.email, 'Unknown'),
         s.started_at, s.ends_at, s.status::text
  from public.build_sessions s
  join public.teams t       on t.id = s.team_id
  join public.hackathons h on h.id = s.hackathon_id
  left join public.profiles p on p.id = s.started_by
  where public.is_admin()
  order by s.created_at desc;
$$;


-- Row Level Security (teams, sessions, checkpoints) --------------------------------

-- hackathons ----------------------------------------------------------------
alter table public.hackathons enable row level security;

drop policy if exists hackathons_read on public.hackathons;
create policy hackathons_read on public.hackathons
  for select
  using (
    public.is_admin()
    -- A student reads exactly one row: the live practice hackathon. When
    -- practice is off this matches nothing, so the brief is genuinely
    -- unreachable rather than merely hidden.
    or (practice_enabled = true and status = 'active')
  );

drop policy if exists hackathons_write on public.hackathons;
create policy hackathons_write on public.hackathons
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- teams --------------------------------------------------------------------
alter table public.teams enable row level security;

drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select
  using (public.is_admin() or public.is_team_member(id));

drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams
  for all
  using (public.is_admin() or created_by = auth.uid())
  with check (public.is_admin() or created_by = auth.uid());

-- team_members -----------------------------------------------------------
alter table public.team_members enable row level security;

drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members
  for select
  using (public.is_admin() or public.is_team_member(team_id));

drop policy if exists team_members_write on public.team_members;
create policy team_members_write on public.team_members
  for all
  using (public.is_admin() or public.is_team_member(team_id))
  with check (public.is_admin() or public.is_team_member(team_id));

-- build_sessions --------------------------------------------------------
-- Students get read-only access. There is deliberately no INSERT or UPDATE
-- policy, so a student cannot hand-edit ends_at to buy more time. Every write
-- goes through the RPCs above.
alter table public.build_sessions enable row level security;

drop policy if exists build_sessions_read on public.build_sessions;
create policy build_sessions_read on public.build_sessions
  for select
  using (public.is_admin() or public.is_team_member(team_id));

-- build_checkpoints -----------------------------------------------------
alter table public.build_checkpoints enable row level security;

drop policy if exists build_checkpoints_read on public.build_checkpoints;
create policy build_checkpoints_read on public.build_checkpoints
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and public.is_team_member(s.team_id)
    )
  );

-- Writes require the session to be genuinely running. Once the database has
-- marked it expired this stops matching and the row is frozen — no client-side
-- check is relied upon.
drop policy if exists build_checkpoints_write on public.build_checkpoints;
create policy build_checkpoints_write on public.build_checkpoints
  for all
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and s.status = 'running'
        and public.is_team_member(s.team_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and s.status = 'running'
        and public.is_team_member(s.team_id)
    )
  );


-- ############################################################################
-- 3. submissions, submission members, submission events
-- ############################################################################
-- Two invariants are enforced here rather than in React:
--   BUSINESS RULE 7 — one submission per build session (unique index)
--   BUSINESS RULE 8 — a submitted project is read-only (a BEFORE UPDATE
--                      trigger rejects any change to a 'submitted' row)

-- submissions ---------------------------------------------------------------------
create table if not exists public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid        not null references public.build_sessions (id) on delete cascade,
  hackathon_id         uuid        not null references public.hackathons (id) on delete restrict,
  team_id              uuid        not null references public.teams (id) on delete cascade,
  submitted_by         uuid        not null references public.profiles (id) on delete cascade,

  project_name         text        not null default '',
  project_description  text        not null default '',
  github_url           text,
  live_demo_url        text,
  tech_stack           text        not null default '',
  key_features         text        not null default '',

  status               text        not null default 'draft'
                                 check (status in ('draft', 'submitted')),

  submitted_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- BUSINESS RULE 7: exactly one official submission per build session.
  unique (session_id)
);

create index if not exists submissions_session_idx    on public.submissions (session_id);
create index if not exists submissions_hackathon_idx on public.submissions (hackathon_id);
create index if not exists submissions_team_idx      on public.submissions (team_id);
create index if not exists submissions_submitter_idx on public.submissions (submitted_by);
create index if not exists submissions_status_idx    on public.submissions (status);

drop trigger if exists submissions_touch on public.submissions;
create trigger submissions_touch
  before update on public.submissions
  for each row execute function public.touch_updated_at();


-- submission_members — per-person contribution and AI disclosure -------------------
create table if not exists public.submission_members (
  id                       uuid primary key default gen_random_uuid(),
  submission_id            uuid        not null references public.submissions (id) on delete cascade,
  user_id                  uuid        not null references public.profiles (id) on delete cascade,

  contribution_description text        not null default '',
  contribution_areas       text[]      not null default '{}',
  planned_responsibilities text        not null default '',
  ai_tools_used            text        not null default '',
  ai_usage_description     text        not null default '',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (submission_id, user_id)
);

create index if not exists submission_members_submission_idx on public.submission_members (submission_id);
create index if not exists submission_members_user_idx       on public.submission_members (user_id);

drop trigger if exists submission_members_touch on public.submission_members;
create trigger submission_members_touch
  before update on public.submission_members
  for each row execute function public.touch_updated_at();


-- submission_events — a light audit trail -----------------------------------------
create table if not exists public.submission_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid        not null references public.submissions (id) on delete cascade,
  event_type    text        not null check (event_type in
                      ('draft_created', 'draft_updated', 'submitted')),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists submission_events_submission_idx
  on public.submission_events (submission_id);


-- Submission lock -------------------------------------------------------------------
-- BUSINESS RULE 8. Once a submission is 'submitted' the row is frozen. The
-- trigger runs below RLS, so no policy or client call can route around it, and
-- no admin override exists in this phase.
create or replace function public.lock_submitted_row()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;
  return new;
end;
$$;

drop trigger if exists submissions_lock on public.submissions;
create trigger submissions_lock
  before update on public.submissions
  for each row execute function public.lock_submitted_row();

-- The same freeze applies to each member's contribution row, so a student
-- cannot edit their disclosure after the team has submitted. The lookup lives
-- inside the function body because a trigger WHEN clause may not contain a
-- subquery.
create or replace function public.lock_submission_member_row()
returns trigger
language plpgsql
as $$
begin
  if (select s.status from public.submissions s where s.id = old.submission_id)
       = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;
  return new;
end;
$$;

drop trigger if exists submission_members_lock on public.submission_members;
create trigger submission_members_lock
  before update on public.submission_members
  for each row execute function public.lock_submission_member_row();


-- URL validation --------------------------------------------------------------------
-- Phase 4 validates shape only. No repository is fetched or analysed.
create or replace function public.is_github_repo_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$';
$$;

create or replace function public.is_http_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url ~ '^https?://[^\s/$.?#].[^\s]*$';
$$;


-- RPC — create or fetch the draft ----------------------------------------------------
-- A student can hold exactly one draft per session. Creating it also creates a
-- submission_members row for every current team member, so each person has
-- somewhere to describe their own contribution.
create or replace function public.ensure_draft_submission(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s          public.build_sessions;
  v_sub_id   uuid;
  v_sub_status text;
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not a member of this team.';
  end if;

  select id, status into v_sub_id, v_sub_status
  from public.submissions where session_id = p_session_id;

  if v_sub_id is not null then
    -- Already exists. Re-running is safe and never resurrects a finalised one.
    return v_sub_id;
  end if;

  if s.status = 'expired' then
    raise exception 'Simulation has expired.';
  end if;

  insert into public.submissions
    (session_id, hackathon_id, team_id, submitted_by)
  values (s.id, s.hackathon_id, s.team_id, auth.uid())
  returning id into v_sub_id;

  insert into public.submission_members (submission_id, user_id)
  select v_sub_id, tm.user_id
  from public.team_members tm
  where tm.team_id = s.team_id
  on conflict do nothing;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (v_sub_id, 'draft_created', auth.uid());

  return v_sub_id;
end;
$$;

-- Save the draft. Refuses once the submission is finalised.
create or replace function public.save_submission_draft(
  p_session_id           uuid,
  p_project_name         text,
  p_project_description  text,
  p_github_url           text,
  p_live_demo_url        text,
  p_tech_stack           text,
  p_key_features         text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.build_sessions;
  v_sub_id uuid;
  v_status text;
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not a member of this team.';
  end if;

  v_sub_id := public.ensure_draft_submission(p_session_id);

  select status into v_status from public.submissions where id = v_sub_id;
  if v_status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;

  -- Shape-only validation, same rules the client enforces.
  if p_github_url is not null and length(trim(p_github_url)) > 0
     and not public.is_github_repo_url(trim(p_github_url)) then
    raise exception 'Invalid GitHub URL.';
  end if;

  if p_live_demo_url is not null and length(trim(p_live_demo_url)) > 0
     and not public.is_http_url(trim(p_live_demo_url)) then
    raise exception 'Invalid live demo URL.';
  end if;

  if length(trim(coalesce(p_project_name, ''))) < 1 then
    raise exception 'Project name is required.';
  end if;

  update public.submissions
     set project_name    = trim(p_project_name),
         project_description = coalesce(p_project_description, ''),
         github_url      = nullif(trim(coalesce(p_github_url, '')), ''),
         live_demo_url   = nullif(trim(coalesce(p_live_demo_url, '')), ''),
         tech_stack      = coalesce(p_tech_stack, ''),
         key_features    = coalesce(p_key_features, '')
   where id = v_sub_id;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (v_sub_id, 'draft_updated', auth.uid());

  return v_sub_id;
end;
$$;

-- Save only the caller's own contribution. A student can never write another
-- member's row: the user_id is always auth.uid().
create or replace function public.save_my_contribution(
  p_submission_id            uuid,
  p_contribution_description text,
  p_contribution_areas       text[],
  p_planned_responsibilities text,
  p_ai_tools_used            text,
  p_ai_usage_description     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_team   uuid;
begin
  select s.status, sess.team_id into v_status, v_team
  from public.submissions s
  join public.build_sessions sess on sess.id = s.session_id
  where s.id = p_submission_id;

  if v_status is null then
    raise exception 'Submission not found.';
  end if;

  if not public.is_team_member(v_team) then
    raise exception 'You are not a member of this team.';
  end if;

  if v_status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;

  update public.submission_members
     set contribution_description = coalesce(p_contribution_description, ''),
         contribution_areas       = coalesce(p_contribution_areas, '{}'),
         planned_responsibilities = coalesce(p_planned_responsibilities, ''),
         ai_tools_used            = coalesce(p_ai_tools_used, ''),
         ai_usage_description     = coalesce(p_ai_usage_description, '')
   where submission_id = p_submission_id
     and user_id = auth.uid();
end;
$$;

-- Final submission. Requires every member to have recorded a contribution, so
-- the AI contribution analysis in a later phase has real data to work with.
create or replace function public.finalize_submission(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub_id   uuid;
  v_status   text;
  v_missing  bigint;
  v_sess     public.build_sessions;
begin
  select * into v_sess from public.build_sessions where id = p_session_id;

  if v_sess.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not public.is_team_member(v_sess.team_id) then
    raise exception 'You are not a member of this team.';
  end if;

  select id, status into v_sub_id, v_status
  from public.submissions where session_id = p_session_id;

  if v_sub_id is null then
    raise exception 'Save a draft before submitting.';
  end if;

  if v_status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;

  if length(trim(coalesce((select project_name from public.submissions
                           where id = v_sub_id), ''))) = 0 then
    raise exception 'Project name is required.';
  end if;

  select count(*) into v_missing
  from public.team_members tm
  left join public.submission_members sm
    on sm.submission_id = v_sub_id and sm.user_id = tm.user_id
  where tm.team_id = v_sess.team_id
    and length(trim(coalesce(sm.contribution_description, ''))) = 0;

  if v_missing > 0 then
    raise exception 'Every team member must add a contribution description before submitting.';
  end if;

  -- submitted_at is a server timestamp. After this the row is frozen by the
  -- lock trigger, and the session moves to 'submitted'.
  update public.submissions
     set status       = 'submitted',
         submitted_at = now(),
         submitted_by = auth.uid()
   where id = v_sub_id;

  update public.build_sessions set status = 'submitted' where id = p_session_id;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (v_sub_id, 'submitted', auth.uid());

  return v_sub_id;
end;
$$;

-- Per-person contribution for a submission, joined to profiles and the
-- member's team role. SECURITY DEFINER is required: teammates must see each
-- other's names and disclosures, but a profile row is otherwise only visible
-- to its own owner.
create or replace function public.submission_roster(p_submission_id uuid)
returns table (
  member_id                uuid,
  user_id                  uuid,
  full_name                text,
  email                    text,
  team_role                text,
  contribution_description text,
  contribution_areas       text[],
  planned_responsibilities text,
  ai_tools_used            text,
  ai_usage_description     text
)
language sql
stable
security definer
set search_path = public
as $$
  select sm.id, sm.user_id, p.full_name, p.email,
         coalesce(tm.role, 'Other'),
         sm.contribution_description, sm.contribution_areas,
         sm.planned_responsibilities, sm.ai_tools_used, sm.ai_usage_description
  from public.submission_members sm
  join public.submissions sub  on sub.id = sm.submission_id
  join public.build_sessions s on s.id = sub.session_id
  join public.profiles p       on p.id = sm.user_id
  left join public.team_members tm
         on tm.team_id = s.team_id and tm.user_id = sm.user_id
  where sm.submission_id = p_submission_id
    and (public.is_team_member(s.team_id) or public.is_admin())
  order by sm.created_at;
$$;

-- Admin listing for /admin/submissions.
create or replace function public.admin_submissions()
returns table (
  id            uuid,
  session_id    uuid,
  project_name  text,
  team_name     text,
  hackathon_name text,
  status        text,
  github_url    text,
  live_demo_url text,
  submitted_at  timestamptz,
  member_count  bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select sub.id, sub.session_id, sub.project_name,
         t.name, h.name, sub.status::text, sub.github_url, sub.live_demo_url,
         sub.submitted_at,
         (select count(*) from public.submission_members sm
          where sm.submission_id = sub.id)
  from public.submissions sub
  join public.teams t       on t.id = sub.team_id
  join public.hackathons h on h.id = sub.hackathon_id
  where public.is_admin()
  order by sub.created_at desc;
$$;


-- Row Level Security (submissions) ----------------------------------------------------

-- submissions ----------------------------------------------------------------
alter table public.submissions enable row level security;

drop policy if exists submissions_read on public.submissions;
create policy submissions_read on public.submissions
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = submissions.session_id
        and public.is_team_member(s.team_id)
    )
  );

-- Writes happen only through the RPCs above, which perform the same checks and
-- additionally enforce the finalisation lock.
drop policy if exists submissions_write on public.submissions;
create policy submissions_write on public.submissions
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- submission_members ------------------------------------------------------
alter table public.submission_members enable row level security;

drop policy if exists submission_members_read on public.submission_members;
create policy submission_members_read on public.submission_members
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.submissions sub
      join public.build_sessions s on s.id = sub.session_id
      where sub.id = submission_members.submission_id
        and public.is_team_member(s.team_id)
    )
  );

-- A member may edit only their own contribution row.
drop policy if exists submission_members_write on public.submission_members;
create policy submission_members_write on public.submission_members
  for all
  using (public.is_admin() or user_id = auth.uid())
  with check (public.is_admin() or user_id = auth.uid());

-- submission_events ------------------------------------------------------
alter table public.submission_events enable row level security;

drop policy if exists submission_events_read on public.submission_events;
create policy submission_events_read on public.submission_events
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.submissions sub
      join public.build_sessions s on s.id = sub.session_id
      where sub.id = submission_events.submission_id
        and public.is_team_member(s.team_id)
    )
  );


-- Admin reporting — final version ------------------------------------------------------
-- Section 2 created admin_stats() before public.submissions existed. This
-- re-creation makes the submissions count available regardless of which
-- section was applied first.
create or replace function public.admin_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users',              (select count(*) from public.profiles),
    'teams',              (select count(*) from public.teams),
    'active_sessions',    (select count(*) from public.build_sessions
                            where status in ('running', 'break')),
    'completed_sessions', (select count(*) from public.build_sessions
                            where status in ('completed', 'expired', 'submitted')),
    'submissions',        (select count(*) from public.submissions)
  );
$$;


-- ############################################################################
-- 4. Optional seed data
-- ############################################################################
-- Strictly optional. The application does NOT depend on any of this existing:
-- you can create entirely different hackathons from /admin/hackathons, and the
-- app never references "MediStock" anywhere in its code. Safe to run more than
-- once — the hackathon is matched on its name.
--
-- After this runs, open /admin/hackathons and flip Practice on for it.

do $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.hackathons where name = 'MediStock Practice Hackathon') then
    raise notice 'MediStock Practice Hackathon already exists — skipping.';
    return;
  end if;

  insert into public.hackathons (
    name,
    problem_statement,
    requirements,
    constraints,
    expected_outcome,
    evaluation_criteria,
    simulation_duration_minutes,
    status
  )
  values (
    'MediStock Practice Hackathon',
    'Build a pharmacy inventory and medicine demand prediction solution.

Small and mid-size pharmacies hold stock they do not need and run out of the medicines their patients actually ask for. Demand swings with seasonality, local demographics, weather, and prescribing patterns, yet most orders are still placed by hand.

Design and build a system that helps a pharmacy decide what to reorder, when, and how much — and that tells a pharmacist what it does not know.',
    E'## Requirements

- Ingest a historical purchase and stock dataset of your choosing (public or synthetic).
- Produce a demand forecast per medicine for a configurable future window.
- Recommend a reorder quantity and a reorder date per medicine.
- Surface low-stock risk so a pharmacist can act before a stockout.
- Expose a clear confidence or data-quality signal alongside every recommendation.
- Provide an interface a pharmacist can use in a few seconds per item.

## Optional, if you have the time

- Scenario planning: model the effect of a lead-time change or a sudden demand spike.
- An explanation of why a given medicine was flagged.',
    E'## Constraints

- The system must run without paid third-party data services.
- Recommendations must be explainable — a pharmacist should be able to see the reason, not just a number.
- The solution must degrade honestly: when data is thin or missing, say so rather than guessing silently.
- Do not require manual entry of the entire historical dataset.
- Nothing you build may include real patient-identifiable data.',
    E'## Expected outcome

A working prototype in which a pharmacist can open a dashboard, see which medicines are at risk of stocking out, understand why, and either accept the suggested reorder or adjust it.

The goal is not perfect forecast accuracy. It is a credible, explainable decision tool that a real pharmacist would trust enough to act on.',
    E'## Evaluation criteria

1. **Forecast quality** — are the predictions defensible, and is the method appropriate for the data?
2. **Explainability** — can a user understand why an item was flagged?
3. **Honesty about uncertainty** — does the system surface what it does not know?
4. **Usability** — can a pharmacist act on the output quickly?
5. **Engineering quality** — structure, testing, and the handling of edge cases.
6. **Judgement** — were the right trade-offs made under a time limit?'
  )
  returning id into v_id;

  -- 8 hours, stored as minutes. The admin can change this later without
  -- affecting any session that has already started.
  update public.hackathons
     set simulation_duration_minutes = 480
   where id = v_id;

  raise notice 'Created MediStock Practice Hackathon (%).', v_id;
  raise notice 'Enable practice from /admin/hackathons when you are ready.';
end
$$;


-- ============================================================================
-- After this script finishes, run the promotion statement below as a second
-- statement in the same editor (replace the email with your own):
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- Then verify everything is live by running this query:
--
--   select
--     (select count(*) from pg_tables
--       where schemaname = 'public'
--         and tablename in ('profiles','hackathons','teams','team_members',
--                            'build_sessions','build_checkpoints',
--                            'submissions','submission_members','submission_events')
--       ) as hacksim_tables;
--
-- It should return 9.
-- ============================================================================
