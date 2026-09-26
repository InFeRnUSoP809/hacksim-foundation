-- ============================================================================
-- HackSim — Phase 2 (hackathon setup) + Phase 3 (student experience)
-- ============================================================================
-- Run this AFTER supabase/schema.sql. It is idempotent, so re-running is safe.
--
-- Design note: every "backend must verify" rule is enforced HERE, in Postgres,
-- rather than in React. The browser only ever holds the anon key, so the
-- database is the only place that can be trusted. Students therefore cannot
-- forge a session, extend a timer, or read a problem statement that the admin
-- has withdrawn.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 0. Prerequisites (re-declared so this file runs standalone)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text        not null,
  name       text,
  role       text        not null default 'student'
                         check (role in ('student', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Enums are plain text + CHECK so the app never depends on Postgres enum types.
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


-- ────────────────────────────────────────────────────────────────────────────
-- 1. hackathons
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.hackathons (
  id                           uuid primary key default gen_random_uuid(),
  name                         text        not null check (length(trim(name)) between 2 and 120),
  problem_statement            text        not null default '',
  requirements                 text        not null default '',
  constraints                  text        not null default '',
  expected_outcome             text        not null default '',
  evaluation_criteria          text        not null default '',
  simulation_duration_minutes  integer     not null default 60
                                           check (simulation_duration_minutes between 1 and 10080),
  status                       text        not null default 'draft'
                                           check (status in ('draft', 'active', 'archived')),
  practice_enabled             boolean     not null default false,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

comment on table public.hackathons is
  'A practice hackathon. Exactly one may have practice_enabled = true.';

-- HARD GUARANTEE: at most one practice hackathon can exist. The admin UI asks
-- for confirmation first, but the database refuses the race even if it is
-- bypassed.
create unique index if not exists hackathons_single_practice
  on public.hackathons ((practice_enabled))
  where practice_enabled = true;

drop trigger if exists hackathons_touch on public.hackathons;
create trigger hackathons_touch
  before update on public.hackathons
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 2. teams + team_members
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null check (length(trim(name)) between 2 and 60),
  created_by uuid        not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_members (
  id                       uuid primary key default gen_random_uuid(),
  team_id                  uuid        not null references public.teams (id) on delete cascade,
  user_id                  uuid        not null references auth.users (id) on delete cascade,
  role                     text        not null default 'Other',
  contribution_description text        not null default '',
  contribution_areas       text[]      not null default '{}',
  planned_responsibilities text        not null default '',
  ai_tools                 text        not null default '',
  joined_at                timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (team_id, user_id)
);

-- One team per student keeps "does this student already have a session?"
-- unambiguous.
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


-- ────────────────────────────────────────────────────────────────────────────
-- 3. build_sessions
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.build_sessions (
  id            uuid primary key default gen_random_uuid(),
  hackathon_id  uuid        not null references public.hackathons (id) on delete restrict,
  team_id       uuid        not null references public.teams (id) on delete cascade,
  started_by    uuid        not null references auth.users (id) on delete cascade,
  started_at    timestamptz not null default now(),
  ends_at       timestamptz not null,
  break_ends_at timestamptz,
  status        text        not null default 'not_started'
                          check (status in ('not_started', 'active', 'paused',
                                            'break', 'completed', 'expired')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The "which sessions are still running" query, used by both dashboards.
create index if not exists build_sessions_team_idx  on public.build_sessions (team_id);
create index if not exists build_sessions_status_idx on public.build_sessions (status);

drop trigger if exists build_sessions_touch on public.build_sessions;
create trigger build_sessions_touch
  before update on public.build_sessions
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 4. build_checkpoints
-- ────────────────────────────────────────────────────────────────────────────
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

drop trigger if exists build_checkpoints_touch on public.build_checkpoints;
create trigger build_checkpoints_touch
  before update on public.build_checkpoints
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 5. RPC — team management
-- ────────────────────────────────────────────────────────────────────────────

-- Create a team and become its first member. One team per user.
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

-- Add someone by email. SECURITY DEFINER is what lets us resolve the address
-- from auth.users without ever exposing the user directory to the browser.
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

  select u.id into v_user_id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
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

-- Leave a team. The last member leaving removes the team, which cascades its
-- sessions — this is the only way a team disappears, and it is always a
-- deliberate act by its final member.
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


-- ────────────────────────────────────────────────────────────────────────────
-- 6. RPC — practice hackathon control (admin only)
-- ────────────────────────────────────────────────────────────────────────────
-- Turns practice mode on for exactly one hackathon and off for every other.
-- Never deletes anything, so historical sessions stay attached to the
-- hackathon they were started against.
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

  -- Turn every other one off first, so the partial unique index never trips.
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


-- ────────────────────────────────────────────────────────────────────────────
-- 7. RPC — starting a simulation
-- ────────────────────────────────────────────────────────────────────────────
-- Validates, in the database, the full list from the spec:
--   1. authenticated            5. no conflicting active session
--   2. belongs to a valid team  6. practice is currently enabled
--   3. hackathon is valid
create or replace function public.start_build_session(p_hackathon_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id    uuid;
  v_duration   integer;
  v_enabled    boolean;
  v_status     text;
  v_existing   uuid;
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to start a simulation.';
  end if;

  select tm.team_id into v_team_id
  from public.team_members tm
  where tm.user_id = auth.uid()
  limit 1;

  if v_team_id is null then
    raise exception 'Create or join a team before starting a simulation.';
  end if;

  select simulation_duration_minutes, practice_enabled, status
    into v_duration, v_enabled, v_status
  from public.hackathons
  where id = p_hackathon_id;

  if v_duration is null then
    raise exception 'That hackathon does not exist.';
  end if;

  if not v_enabled then
    raise exception 'Practice is not currently available. No new simulation can be started.';
  end if;

  if v_status <> 'active' then
    raise exception 'That hackathon is not open for participation.';
  end if;

  select id into v_existing
  from public.build_sessions
  where team_id = v_team_id
    and status in ('active', 'paused', 'break')
  limit 1;

  if v_existing is not null then
    raise exception 'Your team already has a simulation in progress.';
  end if;

  insert into public.build_sessions
    (hackathon_id, team_id, started_by, started_at, ends_at, status)
  values
    (p_hackathon_id, v_team_id, auth.uid(), now(),
     now() + make_interval(mins => v_duration), 'active')
  returning id into v_session_id;

  return v_session_id;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 8. RPC — authoritative session clock
-- ────────────────────────────────────────────────────────────────────────────
-- The timer is computed from the DATABASE clock, never from the browser.
-- Changing the device clock therefore cannot extend a simulation.
--
-- This function also self-heals time-based transitions: an elapsed build
-- becomes 'expired', and an elapsed break resumes to 'active'. That keeps the
-- stored status honest without needing a background worker.
create or replace function public.session_state(p_session_id uuid)
returns table (
  status                   text,
  remaining_seconds        bigint,
  break_remaining_seconds  bigint,
  server_now               timestamptz
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
    raise exception 'Session not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You do not have access to that simulation.';
  end if;

  -- Self-heal: a build whose time is up becomes expired.
  if s.status = 'active' and s.ends_at <= now() then
    update public.build_sessions
       set status = 'expired', break_ends_at = null
     where id = s.id;
    s.status := 'expired';
  end if;

  -- Self-heal: a break whose time is up resumes automatically.
  if s.status = 'break' and s.break_ends_at is not null and s.break_ends_at <= now() then
    update public.build_sessions
       set status = 'active', break_ends_at = null
     where id = s.id;
    s.status := 'active';
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

-- The hackathon a session belongs to, readable by that session's team even if
-- practice mode has since been switched off. Turning practice off must stop
-- NEW simulations without blinding people already mid-run.
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

-- Status transitions. Deliberately narrow: a student may only move a live
-- session into break, back to active, or to completed. They can never set
-- ends_at, started_at, or extend anything.
create or replace function public.set_session_status(
  p_session_id uuid,
  p_status     text,
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
    raise exception 'Session not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You do not have access to that simulation.';
  end if;

  if s.status in ('completed', 'expired') then
    raise exception 'This simulation has already finished.';
  end if;

  if s.ends_at <= now() then
    raise exception 'Time is up for this simulation.';
  end if;

  if p_status = 'break' and s.status = 'active' then
    update public.build_sessions
       set status = 'break',
           break_ends_at = now() + make_interval(mins => v_break)
     where id = s.id;
    return;
  end if;

  if p_status = 'active' and s.status in ('break', 'paused') then
    update public.build_sessions
       set status = 'active', break_ends_at = null
     where id = s.id;
    return;
  end if;

  if p_status = 'completed' and s.status in ('active', 'break', 'paused') then
    update public.build_sessions
       set status = 'completed', break_ends_at = null
     where id = s.id;
    return;
  end if;

  raise exception 'That status change is not allowed.';
end;
$$;

-- Admin reporting helper: counts for the admin dashboard.
create or replace function public.admin_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users',            (select count(*) from public.users),
    'teams',            (select count(*) from public.teams),
    'active_sessions',  (select count(*) from public.build_sessions
                          where status in ('active', 'break', 'paused')),
    'completed_sessions', (select count(*) from public.build_sessions
                          where status in ('completed', 'expired'))
  );
$$;

-- The roster for one team. SECURITY DEFINER is required here: teammates must
-- see each other's names, but the users table only ever exposes a row to its
-- owner. The guard below keeps it to genuine members of that one team.
create or replace function public.team_roster(p_team_id uuid)
returns table (
  member_id                uuid,
  user_id                  uuid,
  name                     text,
  email                    text,
  role                     text,
  contribution_description text,
  contribution_areas       text[],
  planned_responsibilities text,
  ai_tools                 text,
  joined_at                timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, u.name, u.email, m.role,
         m.contribution_description, m.contribution_areas,
         m.planned_responsibilities, m.ai_tools, m.joined_at
  from public.team_members m
  join public.users u on u.id = m.user_id
  where m.team_id = p_team_id
    and (public.is_team_member(p_team_id) or public.is_admin())
  order by m.joined_at;
$$;

-- Admin team list: membership count and whether a run is under way.
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

-- Admin simulation list, with the names each table column needs.
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
         s.started_by, coalesce(u.name, u.email, 'Unknown'),
         s.started_at, s.ends_at, s.status::text
  from public.build_sessions s
  join public.teams t       on t.id = s.team_id
  join public.hackathons h on h.id = s.hackathon_id
  left join public.users u on u.id = s.started_by
  where public.is_admin()
  order by s.created_at desc;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- 9. Row Level Security
-- ────────────────────────────────────────────────────────────────────────────

-- hackathons -------------------------------------------------------------
alter table public.hackathons enable row level security;

drop policy if exists hackathons_read on public.hackathons;
create policy hackathons_read on public.hackathons
  for select
  using (
    public.is_admin()
    -- A student may read exactly one row: the live practice hackathon.
    or (practice_enabled = true and status = 'active')
  );

drop policy if exists hackathons_write on public.hackathons;
create policy hackathons_write on public.hackathons
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- teams ------------------------------------------------------------------
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

-- build_sessions ---------------------------------------------------------
-- Students get read-only access. Every write goes through the RPCs above, so
-- a student can never hand-edit ends_at to buy themselves more time.
alter table public.build_sessions enable row level security;

drop policy if exists build_sessions_read on public.build_sessions;
create policy build_sessions_read on public.build_sessions
  for select
  using (public.is_admin() or public.is_team_member(team_id));

-- No INSERT/UPDATE/DELETE policy exists for students, by design.

-- build_checkpoints ------------------------------------------------------
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

-- Writes are only permitted while the session is genuinely running. Once the
-- database has marked it expired, this stops matching and the row is frozen.
drop policy if exists build_checkpoints_write on public.build_checkpoints;
create policy build_checkpoints_write on public.build_checkpoints
  for all
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and s.status = 'active'
        and public.is_team_member(s.team_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and s.status = 'active'
        and public.is_team_member(s.team_id)
    )
  );


-- ────────────────────────────────────────────────────────────────────────────
-- 10. Promote your first admin
-- ────────────────────────────────────────────────────────────────────────────
--   update public.users set role = 'admin' where email = 'you@example.com';
-- ────────────────────────────────────────────────────────────────────────────
